package events

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"agente-go/internal/discovery"
)

// State es lo que el motor necesita recordar entre reinicios del agente (se guarda en state.json).
type State struct {
	// Alarmas activas: clave "externalId|regla" -> desde cuando.
	Active map[string]time.Time `json:"active"`
	// Ultimo valor visto de contadores (ej. transferencias del ATS) para detectar incrementos.
	Counters map[string]float64 `json:"counters"`
	// LoRaWAN: ultima vez que llego un uplink NUEVO de cada sensor, y su huella (fCnt/hora).
	LastSeen    map[string]time.Time `json:"lastSeen"`
	Fingerprint map[string]string    `json:"fingerprint"`
	// Puertas: desde cuando esta abierta.
	OpenSince map[string]time.Time `json:"openSince"`
}

func NewState() State {
	return State{
		Active:      map[string]time.Time{},
		Counters:    map[string]float64{},
		LastSeen:    map[string]time.Time{},
		Fingerprint: map[string]string{},
		OpenSince:   map[string]time.Time{},
	}
}

func (s *State) ensure() {
	if s.Active == nil {
		s.Active = map[string]time.Time{}
	}
	if s.Counters == nil {
		s.Counters = map[string]float64{}
	}
	if s.LastSeen == nil {
		s.LastSeen = map[string]time.Time{}
	}
	if s.Fingerprint == nil {
		s.Fingerprint = map[string]string{}
	}
	if s.OpenSince == nil {
		s.OpenSince = map[string]time.Time{}
	}
}

const siteKey = "__site__"

type Engine struct {
	th Thresholds

	mu   sync.Mutex
	st   State
	prev map[string]discovery.Device
}

func NewEngine(th Thresholds, st State) *Engine {
	st.ensure()
	return &Engine{th: th.Merge(), st: st, prev: map[string]discovery.Device{}}
}

// Snapshot devuelve una copia del estado para guardarlo en disco.
func (e *Engine) Snapshot() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := NewState()
	for k, v := range e.st.Active {
		c.Active[k] = v
	}
	for k, v := range e.st.Counters {
		c.Counters[k] = v
	}
	for k, v := range e.st.LastSeen {
		c.LastSeen[k] = v
	}
	for k, v := range e.st.Fingerprint {
		c.Fingerprint[k] = v
	}
	for k, v := range e.st.OpenSince {
		c.OpenSince[k] = v
	}
	return c
}

// ---------- helpers de lectura ----------

func num(m map[string]interface{}, key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, !math.IsNaN(v)
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func text(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func label(d discovery.Device) string {
	area := text(d.Attributes, "area")
	if area == "" {
		area = text(d.Attributes, "tag_area")
	}
	if area != "" && !strings.Contains(d.Name, area) {
		return fmt.Sprintf("%s (%s)", d.Name, area)
	}
	return d.Name
}

type category string

const (
	catGenerator category = "generator"
	catPower     category = "power_meter"
	catCircuit   category = "circuit_meter"
	catDoor      category = "door"
	catSensor    category = "sensor"
	catGateway   category = "gateway"    // gateway LoRa recibido directo (gatewaysource)
	catRadio     category = "lora_radio" // dispositivo escuchado por radio sin llaves
)

func categoryOf(d discovery.Device) category {
	switch text(d.Attributes, "category") {
	case "gateway":
		return catGateway
	case "lora_radio":
		return catRadio
	case "generator":
		return catGenerator
	case "power_meter":
		return catPower
	case "circuit_meter":
		return catCircuit
	}
	if _, ok := d.Readings["magnet_status"]; ok || strings.EqualFold(text(d.Attributes, "tag_sensor_type"), "door") {
		return catDoor
	}
	return catSensor
}

func doorOpen(r map[string]interface{}) bool {
	switch v := r["magnet_status"].(type) {
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "open" || s == "1" || s == "true" || s == "abierta"
	case float64:
		return v == 1
	case bool:
		return v
	}
	return false
}

// ---------- motor ----------

type emitter struct {
	e   *Engine
	now time.Time
	out []Event
}

func (em *emitter) event(d *discovery.Device, typ string, sev Severity, msg string, value *float64, data map[string]interface{}) Event {
	ev := Event{ID: newID(em.now), Type: typ, Severity: sev, Message: msg, Value: value, OccurredAt: em.now.UTC()}
	if data == nil {
		data = map[string]interface{}{}
	}
	if d != nil {
		ev.ExternalID = d.ExternalID
		data["device"] = d.Name
		if d.Model != "" {
			data["model"] = d.Model
		}
		if a := text(d.Attributes, "area"); a != "" {
			data["area"] = a
		} else if a := text(d.Attributes, "tag_area"); a != "" {
			data["area"] = a
		}
	}
	ev.Data = data
	return ev
}

func (em *emitter) add(ev Event) { em.out = append(em.out, ev) }

// alarm emite raise() al entrar en condicion y clear() al salir; nada mientras se mantiene.
func (em *emitter) alarm(ext, rule string, active bool, raise func() Event, clear func(minutes float64) Event) {
	key := ext + "|" + rule
	since, was := em.e.st.Active[key]
	switch {
	case active && !was:
		em.e.st.Active[key] = em.now
		em.add(raise())
	case !active && was:
		delete(em.e.st.Active, key)
		ev := clear(em.now.Sub(since).Minutes())
		if ev.Data == nil {
			ev.Data = map[string]interface{}{}
		}
		ev.Data["durationMinutes"] = math.Round(em.now.Sub(since).Minutes()*10) / 10
		em.add(ev)
	}
}

func fmtDur(minutes float64) string {
	if minutes < 1 {
		return fmt.Sprintf("%.0f s", minutes*60)
	}
	if minutes < 120 {
		return fmt.Sprintf("%.0f min", minutes)
	}
	return fmt.Sprintf("%.1f h", minutes/60)
}

// Observe evalua las reglas sobre las lecturas nuevas y devuelve los eventos detectados.
func (e *Engine) Observe(devs []discovery.Device, now time.Time) []Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	em := &emitter{e: e, now: now}

	for i := range devs {
		d := devs[i]
		prev, hadPrev := e.prev[d.ExternalID]

		offline := d.State == "offline"
		cat := categoryOf(d)
		// Los gateways los marca offline el propio gatewaysource (sin PUSH/PULL); el resto de
		// LoRaWAN se considera sin comunicacion si deja de mandar uplinks nuevos.
		if d.Protocol == "lorawan" && cat != catGateway {
			e.touchLoRa(d, now)
			if e.loraStale(d.ExternalID, now) {
				offline = true
			}
		}
		e.ruleDiscovery(em, d, cat)
		e.ruleOffline(em, d, offline, now)

		if !offline && d.Readings != nil {
			switch cat {
			case catGateway, catRadio:
				// Sin metricas de negocio: solo descubrimiento, conexion y join requests.
			case catGenerator:
				e.ruleGenerator(em, d)
			case catPower, catCircuit:
				e.ruleElectrical(em, d, prev, hadPrev)
			case catDoor:
				e.ruleDoor(em, d, prev, hadPrev)
				e.ruleBattery(em, d)
			default:
				e.ruleEnvironment(em, d)
				e.ruleWise(em, d)
				e.ruleBattery(em, d)
			}
		}
		e.prev[d.ExternalID] = d
	}
	return em.out
}

// CheckStale se llama antes de cada sync: marca offline (en las copias que se van a enviar) los
// sensores LoRaWAN que dejaron de transmitir y detecta la sede LoRaWAN en silencio.
func (e *Engine) CheckStale(devs map[string]discovery.Device, now time.Time) []Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	em := &emitter{e: e, now: now}

	var newest time.Time
	loraCount := 0
	for ext, d := range devs {
		if d.Protocol != "lorawan" || categoryOf(d) == catGateway {
			continue
		}
		loraCount++
		if t, ok := e.st.LastSeen[ext]; ok && t.After(newest) {
			newest = t
		}
		if e.loraStale(ext, now) {
			d.State = "offline"
			d.Readings = nil // no registrar en el historial lecturas viejas como si fueran nuevas
			devs[ext] = d
			e.ruleOffline(em, d, true, now)
		}
	}

	if loraCount > 0 && !newest.IsZero() {
		silent := now.Sub(newest).Minutes() > e.th.SiteSilentMinutes
		mins := now.Sub(newest).Minutes()
		em.alarm(siteKey, "lorawan_silent", silent,
			func() Event {
				return em.event(nil, "lorawan.site_silent", Critical,
					fmt.Sprintf("Ningún sensor LoRaWAN reporta hace %s: revisar ChirpStack, el gateway o el broker MQTT", fmtDur(mins)),
					ptr(math.Round(mins)), map[string]interface{}{"sensors": loraCount})
			},
			func(float64) Event {
				return em.event(nil, "lorawan.site_restored", Info, "Los sensores LoRaWAN volvieron a reportar", nil, nil)
			})
	}
	return em.out
}

func (e *Engine) touchLoRa(d discovery.Device, now time.Time) {
	fp := text(d.Attributes, "fCnt") + "@" + text(d.Attributes, "lastUplinkAt")
	if fp == "@" {
		fp = fmt.Sprint(d.Readings)
	}
	if e.st.Fingerprint[d.ExternalID] != fp {
		e.st.Fingerprint[d.ExternalID] = fp
		e.st.LastSeen[d.ExternalID] = now
	} else if _, ok := e.st.LastSeen[d.ExternalID]; !ok {
		e.st.LastSeen[d.ExternalID] = now
	}
}

func (e *Engine) loraStale(ext string, now time.Time) bool {
	t, ok := e.st.LastSeen[ext]
	return ok && now.Sub(t).Minutes() > e.th.SensorStaleMinutes
}

// ---------- reglas ----------

// ruleDiscovery registra el autodescubrimiento: la primera vez (en toda la vida del agente, se
// guarda en state.json) que aparece un gateway o un dispositivo por radio, y cada join request.
func (e *Engine) ruleDiscovery(em *emitter, d discovery.Device, cat category) {
	if cat != catGateway && cat != catRadio {
		return
	}
	seenKey := d.ExternalID + "|seen"
	if _, seen := e.st.Counters[seenKey]; !seen {
		e.st.Counters[seenKey] = 1
		if cat == catGateway {
			em.add(em.event(&d, "discovery.gateway", Info,
				fmt.Sprintf("Gateway LoRa %s conectado directo al agente (desde %s)", text(d.Attributes, "gatewayEui"), text(d.Attributes, "ip")), nil, nil))
		} else {
			em.add(em.event(&d, "discovery.radio_device", Info,
				fmt.Sprintf("Nuevo dispositivo escuchado por radio: %s (RSSI %s dBm, gateway %s)", d.Name, text(d.Attributes, "rssi"), text(d.Attributes, "gateway")), nil, nil))
		}
	}
	if joins, ok := num(d.Attributes, "joinRequests"); ok {
		key := d.ExternalID + "|joins"
		if last, seen := e.st.Counters[key]; seen && joins > last {
			em.add(em.event(&d, "lorawan.join_request", Info,
				fmt.Sprintf("%s solicita unirse a la red (DevEUI %s, JoinEUI %s)", d.Name, strings.ToUpper(text(d.Attributes, "devEui")), strings.ToUpper(text(d.Attributes, "joinEui"))),
				ptr(joins), nil))
		} else if !seen && joins > 0 {
			em.add(em.event(&d, "lorawan.join_request", Info,
				fmt.Sprintf("%s solicita unirse a la red (DevEUI %s, JoinEUI %s)", d.Name, strings.ToUpper(text(d.Attributes, "devEui")), strings.ToUpper(text(d.Attributes, "joinEui"))),
				ptr(joins), nil))
		}
		e.st.Counters[key] = joins
	}
}

func (e *Engine) ruleOffline(em *emitter, d discovery.Device, offline bool, now time.Time) {
	sev := Warning
	if c := categoryOf(d); c == catGenerator || c == catPower || c == catGateway {
		sev = Critical
	}
	em.alarm(d.ExternalID, "offline", offline,
		func() Event {
			msg := fmt.Sprintf("%s: sin comunicación", label(d))
			if t, ok := e.st.LastSeen[d.ExternalID]; ok && d.Protocol == "lorawan" {
				msg = fmt.Sprintf("%s: sin uplinks hace %s", label(d), fmtDur(now.Sub(t).Minutes()))
			}
			return em.event(&d, "device.offline", sev, msg, nil, nil)
		},
		func(m float64) Event {
			return em.event(&d, "device.online", Info, fmt.Sprintf("%s: volvió a comunicar (estuvo %s sin datos)", label(d), fmtDur(m)), nil, nil)
		})
}

func (e *Engine) ruleElectrical(em *emitter, d discovery.Device, prev discovery.Device, hadPrev bool) {
	r := d.Readings
	th := e.th

	// --- Vigilante del ATS (S1 comercial / S2 generador) ---
	if s2, ok := num(r, "s2_generator_energy_status"); ok {
		if p2, okp := num(prev.Readings, "s2_generator_energy_status"); hadPrev && okp {
			if p2 == 0 && s2 == 1 {
				em.add(em.event(&d, "energy.source_generator", Critical,
					fmt.Sprintf("%s: el ATS transfirió la carga a GENERADOR", label(d)), ptr(s2), nil))
			} else if p2 == 1 && s2 == 0 {
				em.add(em.event(&d, "energy.source_commercial", Info,
					fmt.Sprintf("%s: regresó a energía COMERCIAL", label(d)), ptr(s2), nil))
			}
		}
	}
	if cnt, ok := num(r, "s2_generator_transition_count"); ok {
		key := d.ExternalID + "|s2count"
		if last, seen := e.st.Counters[key]; seen && cnt > last {
			n := cnt - last
			em.add(em.event(&d, "energy.generator_transfer_counted", Warning,
				fmt.Sprintf("%s: el vigilante registró %.0f transferencia(s) a generador (total %.0f)", label(d), n, cnt),
				ptr(cnt), map[string]interface{}{"increment": n}))
		}
		e.st.Counters[key] = cnt
	}

	// --- Voltaje, fases, frecuencia ---
	phases := []string{"a", "b", "c"}
	switch text(d.Attributes, "phase") {
	case "Monofásica", "Bifásica":
		phases = []string{"a", "b"}
	}
	var volts []float64
	maxV := 0.0
	for _, p := range phases {
		v, _ := num(r, "voltage_"+p+"_n")
		volts = append(volts, v)
		maxV = math.Max(maxV, v)
	}
	if maxV > 0 {
		low := th.NominalVoltage * (1 - th.VoltageTolerancePct/100)
		high := th.NominalVoltage * (1 + th.VoltageTolerancePct/100)
		lost := []string{}
		outOfRange := false
		worst := 0.0
		for i, v := range volts {
			if v < maxV*th.PhaseLossPct/100 {
				lost = append(lost, strings.ToUpper(phases[i]))
				continue
			}
			if v < low || v > high {
				outOfRange = true
				if math.Abs(v-th.NominalVoltage) > math.Abs(worst-th.NominalVoltage) {
					worst = v
				}
			}
		}
		em.alarm(d.ExternalID, "phase_loss", len(lost) > 0,
			func() Event {
				return em.event(&d, "power.phase_loss", Critical,
					fmt.Sprintf("%s: pérdida de fase %s", label(d), strings.Join(lost, ", ")), nil,
					map[string]interface{}{"phases": lost})
			},
			func(m float64) Event {
				return em.event(&d, "power.phase_restored", Info, fmt.Sprintf("%s: fases restablecidas", label(d)), nil, nil)
			})
		em.alarm(d.ExternalID, "voltage", outOfRange,
			func() Event {
				return em.event(&d, "power.voltage_out_of_range", Warning,
					fmt.Sprintf("%s: voltaje fuera de rango (%.1f V; normal %.0f–%.0f V)", label(d), worst, low, high), ptr(worst), nil)
			},
			func(m float64) Event {
				return em.event(&d, "power.voltage_normal", Info, fmt.Sprintf("%s: voltaje normalizado", label(d)), nil, nil)
			})
	}
	if hz, ok := num(r, "frequency"); ok && hz > 0 {
		bad := hz < th.FrequencyMin || hz > th.FrequencyMax
		em.alarm(d.ExternalID, "frequency", bad,
			func() Event {
				return em.event(&d, "power.frequency_out_of_range", Warning,
					fmt.Sprintf("%s: frecuencia fuera de rango (%.2f Hz)", label(d), hz), ptr(hz), nil)
			},
			func(m float64) Event {
				return em.event(&d, "power.frequency_normal", Info, fmt.Sprintf("%s: frecuencia normalizada", label(d)), nil, nil)
			})
	}

	// --- Calidad (solo ION7400) y carga ---
	thd := 0.0
	for _, k := range []string{"thd_voltage_v1_high", "thd_voltage_v2_high", "thd_voltage_v3_high"} {
		if v, ok := num(r, k); ok {
			thd = math.Max(thd, v)
		}
	}
	if thd > 0 {
		em.alarm(d.ExternalID, "thd", thd > th.ThdVoltageMaxPct,
			func() Event {
				return em.event(&d, "power.thd_high", Warning,
					fmt.Sprintf("%s: THD de voltaje alto (%.2f %% > %.0f %%)", label(d), thd, th.ThdVoltageMaxPct), ptr(thd), nil)
			},
			func(m float64) Event {
				return em.event(&d, "power.thd_normal", Info, fmt.Sprintf("%s: THD de voltaje normalizado", label(d)), nil, nil)
			})
	}
	capKva, _ := num(d.Attributes, "capacityKva")
	if kva, ok := num(r, "apparent_power_total"); ok && capKva > 0 {
		load := kva / capKva * 100
		em.alarm(d.ExternalID, "overload", load > th.OverloadPct,
			func() Event {
				return em.event(&d, "power.overload", Warning,
					fmt.Sprintf("%s: carga alta (%.0f %% de %.0f kVA)", label(d), load, capKva), ptr(load), nil)
			},
			func(m float64) Event {
				return em.event(&d, "power.load_normal", Info, fmt.Sprintf("%s: carga normalizada", label(d)), nil, nil)
			})
	}
}

func (e *Engine) ruleGenerator(em *emitter, d discovery.Device) {
	r := d.Readings
	th := e.th
	batt, _ := num(r, "battery_voltage_metering")

	// Un controlador de generador real siempre reporta la bateria de arranque (~12/24 V). Si no,
	// el EBO no esta recibiendo datos del controlador: se avisa una vez y no se evaluan las demas
	// reglas (evita alarmas falsas de "combustible 0 %" con datos vacios).
	valid := batt > 5
	em.alarm(d.ExternalID, "no_data", !valid,
		func() Event {
			return em.event(&d, "generator.no_data", Warning,
				fmt.Sprintf("%s: el servidor Modbus no está publicando datos del controlador del generador", label(d)), ptr(batt), nil)
		},
		func(m float64) Event {
			return em.event(&d, "generator.data_restored", Info, fmt.Sprintf("%s: llegan datos del controlador del generador", label(d)), nil, nil)
		})
	if !valid {
		return
	}

	rpm, _ := num(r, "engine_speed_metering")
	kw, _ := num(r, "gen_kw_total_metering")
	em.alarm(d.ExternalID, "running", rpm > th.GeneratorRunningRPM,
		func() Event {
			return em.event(&d, "generator.started", Warning,
				fmt.Sprintf("%s: generador ARRANCÓ (%.0f RPM)", label(d), rpm), ptr(rpm), nil)
		},
		func(m float64) Event {
			return em.event(&d, "generator.stopped", Info,
				fmt.Sprintf("%s: generador se detuvo tras %s en marcha", label(d), fmtDur(m)), ptr(kw), nil)
		})
	if fuel, ok := num(r, "fuel_level_metering"); ok {
		em.alarm(d.ExternalID, "fuel_low", fuel < th.GeneratorFuelMinPct,
			func() Event {
				return em.event(&d, "generator.fuel_low", Critical,
					fmt.Sprintf("%s: combustible bajo (%.0f %%)", label(d), fuel), ptr(fuel), nil)
			},
			func(m float64) Event {
				return em.event(&d, "generator.fuel_ok", Info, fmt.Sprintf("%s: nivel de combustible normalizado", label(d)), nil, nil)
			})
	}
	em.alarm(d.ExternalID, "battery_low", batt < th.GeneratorBatteryMinV,
		func() Event {
			return em.event(&d, "generator.battery_low", Warning,
				fmt.Sprintf("%s: batería de arranque baja (%.1f V)", label(d), batt), ptr(batt), nil)
		},
		func(m float64) Event {
			return em.event(&d, "generator.battery_ok", Info, fmt.Sprintf("%s: batería de arranque normalizada", label(d)), nil, nil)
		})
	if c, ok := num(r, "coolant_temp_metering"); ok {
		em.alarm(d.ExternalID, "coolant_high", c > th.GeneratorCoolantMaxC,
			func() Event {
				return em.event(&d, "generator.coolant_high", Critical,
					fmt.Sprintf("%s: temperatura de refrigerante alta (%.0f °C)", label(d), c), ptr(c), nil)
			},
			func(m float64) Event {
				return em.event(&d, "generator.coolant_ok", Info, fmt.Sprintf("%s: temperatura de refrigerante normalizada", label(d)), nil, nil)
			})
	}
}

func (e *Engine) ruleDoor(em *emitter, d discovery.Device, prev discovery.Device, hadPrev bool) {
	open := doorOpen(d.Readings)
	_, prevHad := prev.Readings["magnet_status"]
	if hadPrev && prevHad {
		was := doorOpen(prev.Readings)
		if open && !was {
			e.st.OpenSince[d.ExternalID] = em.now
			em.add(em.event(&d, "door.opened", Info, fmt.Sprintf("%s: puerta ABIERTA", label(d)), ptr(1), nil))
		} else if !open && was {
			msg := fmt.Sprintf("%s: puerta cerrada", label(d))
			data := map[string]interface{}{}
			if since, ok := e.st.OpenSince[d.ExternalID]; ok {
				m := em.now.Sub(since).Minutes()
				msg = fmt.Sprintf("%s: puerta cerrada (estuvo abierta %s)", label(d), fmtDur(m))
				data["openMinutes"] = math.Round(m*10) / 10
			}
			em.add(em.event(&d, "door.closed", Info, msg, ptr(0), data))
		}
	}
	if open {
		if _, ok := e.st.OpenSince[d.ExternalID]; !ok {
			e.st.OpenSince[d.ExternalID] = em.now
		}
	} else {
		delete(e.st.OpenSince, d.ExternalID)
	}
	since, isOpen := e.st.OpenSince[d.ExternalID]
	tooLong := isOpen && em.now.Sub(since).Minutes() > e.th.DoorOpenMaxMinutes
	em.alarm(d.ExternalID, "door_open_long", tooLong,
		func() Event {
			return em.event(&d, "door.open_too_long", Warning,
				fmt.Sprintf("%s: puerta abierta más de %.0f min", label(d), e.th.DoorOpenMaxMinutes), nil, nil)
		},
		func(m float64) Event {
			return em.event(&d, "door.open_too_long_cleared", Info, fmt.Sprintf("%s: puerta cerrada tras alarma de apertura prolongada", label(d)), nil, nil)
		})

	tamper := strings.ToLower(text(d.Readings, "tamper_status"))
	tampered := tamper != "" && tamper != "installed" && tamper != "normal" && tamper != "0" && tamper != "false"
	em.alarm(d.ExternalID, "tamper", tampered,
		func() Event {
			return em.event(&d, "door.tamper", Critical, fmt.Sprintf("%s: sensor de puerta removido o manipulado (%s)", label(d), tamper), nil, nil)
		},
		func(m float64) Event {
			return em.event(&d, "door.tamper_cleared", Info, fmt.Sprintf("%s: sensor de puerta reinstalado", label(d)), nil, nil)
		})
}

func (e *Engine) ruleBattery(em *emitter, d discovery.Device) {
	b, ok := num(d.Readings, "battery")
	if !ok {
		return
	}
	em.alarm(d.ExternalID, "battery_low", b < e.th.BatteryMinPct,
		func() Event {
			return em.event(&d, "sensor.battery_low", Warning, fmt.Sprintf("%s: batería baja (%.0f %%)", label(d), b), ptr(b), nil)
		},
		func(m float64) Event {
			return em.event(&d, "sensor.battery_ok", Info, fmt.Sprintf("%s: batería normalizada", label(d)), nil, nil)
		})
}

func (e *Engine) ruleEnvironment(em *emitter, d discovery.Device) {
	r := d.Readings
	// Los tags threshold_min/max de ChirpStack aplican a la magnitud que indica tag_unit: en los
	// LEO-S592 de calidad de aire son CO₂ (unit = ppm, 400-1500), NO temperatura.
	unit := strings.ToLower(text(d.Attributes, "tag_unit"))
	tagLo, _ := num(d.Attributes, "tag_threshold_min")
	tagHi, _ := num(d.Attributes, "tag_threshold_max")
	tagsValid := tagHi > tagLo
	isTempUnit := strings.Contains(unit, "c") && !strings.Contains(unit, "ppm")

	if t, ok := num(r, "temperature"); ok {
		lo, hi := e.th.TemperatureMin, e.th.TemperatureMax
		if tagsValid && isTempUnit {
			lo, hi = tagLo, tagHi
		}
		if hi > lo {
			em.alarm(d.ExternalID, "temp_high", t > hi,
				func() Event {
					return em.event(&d, "env.temperature_high", Warning,
						fmt.Sprintf("%s: temperatura alta (%.1f °C > %.1f °C)", label(d), t, hi), ptr(t), nil)
				},
				func(m float64) Event {
					return em.event(&d, "env.temperature_normal", Info, fmt.Sprintf("%s: temperatura normalizada", label(d)), nil, nil)
				})
			em.alarm(d.ExternalID, "temp_low", t < lo,
				func() Event {
					return em.event(&d, "env.temperature_low", Warning,
						fmt.Sprintf("%s: temperatura baja (%.1f °C < %.1f °C)", label(d), t, lo), ptr(t), nil)
				},
				func(m float64) Event {
					return em.event(&d, "env.temperature_normal", Info, fmt.Sprintf("%s: temperatura normalizada", label(d)), nil, nil)
				})
		}
	}
	if co2, ok := num(r, "co2"); ok {
		co2Max := e.th.Co2MaxPpm
		if tagsValid && unit == "ppm" {
			co2Max = tagHi
		}
		em.alarm(d.ExternalID, "co2_high", co2 > co2Max,
			func() Event {
				return em.event(&d, "air.co2_high", Warning,
					fmt.Sprintf("%s: CO₂ alto (%.0f ppm > %.0f ppm)", label(d), co2, co2Max), ptr(co2), nil)
			},
			func(m float64) Event {
				return em.event(&d, "air.co2_normal", Info, fmt.Sprintf("%s: CO₂ normalizado", label(d)), nil, nil)
			})
	}
}

// ruleWise: entradas analogicas de los WISE. En IGSS son monitores de cadena de frio: cada canal
// configurado en ChirpStack trae su nombre (tag aiN_operative_area), codigo, rango permitido
// (aiN_threshold_min/max, ej. refrigerador 2-6 °C, ultracongelador -40..-30 °C) y una tolerancia
// (aiN_tolerance) que se interpreta como MINUTOS de gracia fuera de rango antes de alarmar
// (una puerta de refrigerador abierta un momento no es una alarma). Solo se evaluan los canales
// configurados con tags; si el sensor no tiene tags por canal, se evaluan todos.
func (e *Engine) ruleWise(em *emitter, d discovery.Device) {
	configured := map[int]bool{}
	for k := 0; k < 8; k++ {
		if text(d.Attributes, fmt.Sprintf("tag_ai%d_type", k)) != "" {
			configured[k] = true
		}
	}
	for k := 0; k < 8; k++ {
		ch := fmt.Sprintf("ai%d", k)
		if _, ok := d.Readings[ch+"_value"]; !ok {
			continue
		}
		if len(configured) > 0 && !configured[k] {
			continue
		}
		if disabled, _ := num(d.Readings, ch+"_ch_disabled"); disabled == 1 {
			continue
		}
		openCircuit, _ := num(d.Readings, ch+"_open_circuit")
		over, _ := num(d.Readings, ch+"_over_range")
		under, _ := num(d.Readings, ch+"_under_range")
		// Una lectura pegada al borde de 4-20 mA (sonda desconectada/dañada) convertida a °C da
		// valores imposibles (4.00 mA -> -100.4 °C): es falla de sensor, no temperatura.
		mA, _ := num(d.Readings, ch+"_value")
		atEdge := mA <= 4.05 || mA >= 19.95
		if atEdge && (over == 1 || under == 1 || openCircuit == 1) {
			atEdge = false // ya lo cubren las banderas del propio WISE
		}
		name := strings.ToUpper(ch)
		if area := text(d.Attributes, "tag_"+ch+"_operative_area"); area != "" {
			name = area
			if code := text(d.Attributes, "tag_"+ch+"_code"); code != "" {
				name = fmt.Sprintf("%s (%s)", area, code)
			}
		}

		sensorFault := openCircuit == 1 || over == 1 || under == 1 || atEdge
		em.alarm(d.ExternalID, ch+"_edge", atEdge,
			func() Event {
				return em.event(&d, "io.sensor_fault", Warning,
					fmt.Sprintf("%s: entrada %s en el límite de la escala (%.2f mA): sonda desconectada o dañada", label(d), name, mA),
					ptr(mA), map[string]interface{}{"channel": strings.ToUpper(ch)})
			},
			func(m float64) Event {
				return em.event(&d, "io.sensor_ok", Info, fmt.Sprintf("%s: entrada %s vuelve a medir", label(d), name), nil, map[string]interface{}{"channel": strings.ToUpper(ch)})
			})

		if t, ok := num(d.Readings, ch+"_temperature"); ok && !sensorFault {
			lo, _ := num(d.Attributes, "tag_"+ch+"_threshold_min")
			hi, _ := num(d.Attributes, "tag_"+ch+"_threshold_max")
			if hi > lo {
				graceMin, _ := num(d.Attributes, "tag_"+ch+"_tolerance")
				key := d.ExternalID + "|" + ch + "_out"
				out := t < lo || t > hi
				if out {
					if _, ok := e.st.OpenSince[key]; !ok {
						e.st.OpenSince[key] = em.now
					}
				} else {
					delete(e.st.OpenSince, key)
				}
				since, isOut := e.st.OpenSince[key]
				active := isOut && em.now.Sub(since).Minutes() >= graceMin
				category := text(d.Attributes, "tag_"+ch+"_category")
				em.alarm(d.ExternalID, ch+"_coldchain", active,
					func() Event {
						return em.event(&d, "coldchain.out_of_range", Critical,
							fmt.Sprintf("%s: %s a %.1f °C, fuera de rango (%.0f a %.0f °C) por más de %.0f min", label(d), name, t, lo, hi, graceMin),
							ptr(t), map[string]interface{}{"channel": strings.ToUpper(ch), "equipment": name, "category": category, "min": lo, "max": hi})
					},
					func(m float64) Event {
						return em.event(&d, "coldchain.normal", Info,
							fmt.Sprintf("%s: %s volvió a rango (%.1f °C)", label(d), name, t),
							ptr(t), map[string]interface{}{"channel": strings.ToUpper(ch), "equipment": name})
					})
			}
		}

		em.alarm(d.ExternalID, ch+"_open", openCircuit == 1,
			func() Event {
				return em.event(&d, "io.open_circuit", Warning, fmt.Sprintf("%s: entrada %s en circuito abierto", label(d), name), nil, map[string]interface{}{"channel": name})
			},
			func(m float64) Event {
				return em.event(&d, "io.open_circuit_cleared", Info, fmt.Sprintf("%s: entrada %s reconectada", label(d), name), nil, map[string]interface{}{"channel": name})
			})
		em.alarm(d.ExternalID, ch+"_range", over == 1 || under == 1,
			func() Event {
				return em.event(&d, "io.out_of_range", Warning, fmt.Sprintf("%s: entrada %s fuera de rango 4–20 mA", label(d), name), nil, map[string]interface{}{"channel": name})
			},
			func(m float64) Event {
				return em.event(&d, "io.in_range", Info, fmt.Sprintf("%s: entrada %s dentro de rango", label(d), name), nil, map[string]interface{}{"channel": name})
			})
	}
}

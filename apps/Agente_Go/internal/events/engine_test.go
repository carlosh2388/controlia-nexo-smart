package events

import (
	"testing"
	"time"

	"agente-go/internal/discovery"
)

func types(evs []Event) []string {
	out := []string{}
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}

func has(evs []Event, typ string) bool {
	for _, e := range evs {
		if e.Type == typ {
			return true
		}
	}
	return false
}

func ion(s1, s2, count float64) discovery.Device {
	return discovery.Device{
		ExternalID: "modbus:ebo:ANALIZADOR-1", Name: "ANALIZADOR-1", Protocol: "modbus", State: "online", Model: "ION7400",
		Attributes: map[string]interface{}{"category": "power_meter", "area": "Cuarto eléctrico", "capacityKva": 300.0},
		Readings: map[string]interface{}{
			"voltage_a_n": 125.0, "voltage_b_n": 126.0, "voltage_c_n": 125.5, "frequency": 59.96,
			"apparent_power_total": 90.0, "thd_voltage_v1_high": 6.2,
			"s1_commercial_energy_status": s1, "s2_generator_energy_status": s2, "s2_generator_transition_count": count,
		},
	}
}

func TestAtsTransferAndCounter(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	now := time.Now()
	if evs := e.Observe([]discovery.Device{ion(1, 0, 28)}, now); len(evs) != 0 {
		t.Fatalf("primera lectura normal no deberia generar eventos: %v", types(evs))
	}
	evs := e.Observe([]discovery.Device{ion(0, 1, 29)}, now.Add(15*time.Second))
	if !has(evs, "energy.source_generator") || !has(evs, "energy.generator_transfer_counted") {
		t.Fatalf("faltan eventos de transferencia: %v", types(evs))
	}
	evs = e.Observe([]discovery.Device{ion(1, 0, 29)}, now.Add(30*time.Second))
	if !has(evs, "energy.source_commercial") || has(evs, "energy.generator_transfer_counted") {
		t.Fatalf("retorno a comercial inesperado: %v", types(evs))
	}
}

func TestPhaseLossRaisesOnceAndClears(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	now := time.Now()
	d := ion(1, 0, 1)
	d.Readings["voltage_c_n"] = 0.0
	evs := e.Observe([]discovery.Device{d}, now)
	if !has(evs, "power.phase_loss") {
		t.Fatalf("se esperaba perdida de fase: %v", types(evs))
	}
	if evs := e.Observe([]discovery.Device{d}, now.Add(time.Minute)); len(evs) != 0 {
		t.Fatalf("una alarma activa no debe repetirse: %v", types(evs))
	}
	d.Readings["voltage_c_n"] = 125.0
	if evs := e.Observe([]discovery.Device{d}, now.Add(2*time.Minute)); !has(evs, "power.phase_restored") {
		t.Fatalf("se esperaba fase restablecida: %v", types(evs))
	}
}

func TestGeneratorWithoutDataDoesNotFakeAlarms(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	g := discovery.Device{
		ExternalID: "modbus:ebo:GEN", Name: "Generador Planta Hospital", Protocol: "modbus", State: "online",
		Attributes: map[string]interface{}{"category": "generator"},
		Readings:   map[string]interface{}{"battery_voltage_metering": 0.27, "fuel_level_metering": 0.0, "engine_speed_metering": 0.0},
	}
	evs := e.Observe([]discovery.Device{g}, time.Now())
	if !has(evs, "generator.no_data") || has(evs, "generator.fuel_low") || has(evs, "generator.battery_low") {
		t.Fatalf("con datos vacios solo debe avisar no_data: %v", types(evs))
	}
	g.Readings = map[string]interface{}{"battery_voltage_metering": 27.4, "fuel_level_metering": 80.0, "engine_speed_metering": 1800.0}
	evs = e.Observe([]discovery.Device{g}, time.Now().Add(time.Minute))
	if !has(evs, "generator.data_restored") || !has(evs, "generator.started") {
		t.Fatalf("esperaba datos restablecidos + arranque: %v", types(evs))
	}
}

func door(open bool, fcnt int) discovery.Device {
	st := "close"
	if open {
		st = "open"
	}
	return discovery.Device{
		ExternalID: "lorawan:24e1", Name: "HES-CLI-1", Protocol: "lorawan", State: "online", Model: "LEO-S595-MSG0",
		Attributes: map[string]interface{}{"tag_area": "Farmacia", "fCnt": fcnt},
		Readings:   map[string]interface{}{"magnet_status": st, "battery": 41.0, "tamper_status": "installed"},
	}
}

func TestDoorOpenCloseWithDuration(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	now := time.Now()
	e.Observe([]discovery.Device{door(false, 1)}, now)
	if evs := e.Observe([]discovery.Device{door(true, 2)}, now.Add(time.Minute)); !has(evs, "door.opened") {
		t.Fatalf("se esperaba door.opened: %v", types(evs))
	}
	evs := e.Observe([]discovery.Device{door(true, 3)}, now.Add(13*time.Minute))
	if !has(evs, "door.open_too_long") {
		t.Fatalf("se esperaba alarma de puerta abierta mucho tiempo: %v", types(evs))
	}
	evs = e.Observe([]discovery.Device{door(false, 4)}, now.Add(14*time.Minute))
	if !has(evs, "door.closed") || !has(evs, "door.open_too_long_cleared") {
		t.Fatalf("se esperaba cierre: %v", types(evs))
	}
}

func TestStaleSensorAndSiteSilent(t *testing.T) {
	e := NewEngine(Thresholds{SensorStaleMinutes: 60, SiteSilentMinutes: 15}, NewState())
	now := time.Now()
	d := door(false, 10)
	e.Observe([]discovery.Device{d}, now)

	snap := map[string]discovery.Device{d.ExternalID: d}
	evs := e.CheckStale(snap, now.Add(20*time.Minute))
	if !has(evs, "lorawan.site_silent") {
		t.Fatalf("se esperaba sede en silencio: %v", types(evs))
	}
	evs = e.CheckStale(snap, now.Add(61*time.Minute))
	if !has(evs, "device.offline") || snap[d.ExternalID].State != "offline" {
		t.Fatalf("se esperaba sensor offline: %v", types(evs))
	}
	// Llega un uplink nuevo (fCnt distinto): vuelve online y la sede deja de estar en silencio.
	evs = e.Observe([]discovery.Device{door(false, 11)}, now.Add(62*time.Minute))
	if !has(evs, "device.online") {
		t.Fatalf("se esperaba device.online: %v", types(evs))
	}
	evs = e.CheckStale(map[string]discovery.Device{d.ExternalID: door(false, 11)}, now.Add(62*time.Minute))
	if !has(evs, "lorawan.site_restored") {
		t.Fatalf("se esperaba lorawan.site_restored: %v", types(evs))
	}
}

func TestRestartDoesNotDuplicateActiveAlarms(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	d := ion(1, 0, 1)
	d.Readings["thd_voltage_v1_high"] = 9.5
	if evs := e.Observe([]discovery.Device{d}, time.Now()); !has(evs, "power.thd_high") {
		t.Fatalf("se esperaba THD alto: %v", types(evs))
	}
	// "Reinicio": motor nuevo con el estado guardado.
	e2 := NewEngine(Thresholds{}, e.Snapshot())
	if evs := e2.Observe([]discovery.Device{d}, time.Now()); has(evs, "power.thd_high") {
		t.Fatalf("tras reiniciar no debe repetirse la alarma: %v", types(evs))
	}
}

func TestStorePersistsAndAcks(t *testing.T) {
	dir := t.TempDir()
	s, _, err := OpenStore(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i := 0; i < 5; i++ {
		s.Add([]Event{{ID: newID(now.Add(time.Duration(i) * time.Millisecond)), Type: "x", Severity: Info, Message: "m", OccurredAt: now}})
	}
	if s.Count() != 3 {
		t.Fatalf("el buffer debe recortar a maxPending, hay %d", s.Count())
	}
	s2, _, _ := OpenStore(dir, 3)
	if s2.Count() != 3 {
		t.Fatalf("los pendientes deben sobrevivir un reinicio, hay %d", s2.Count())
	}
	s2.Ack(s2.Pending(2))
	if s2.Count() != 1 {
		t.Fatalf("Ack debe quitar los confirmados, quedan %d", s2.Count())
	}
}

func TestAirQualityTagsAreCo2NotTemperature(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	d := discovery.Device{
		ExternalID: "lorawan:air", Name: "HES-QUI-AIR-3", Protocol: "lorawan", State: "online", Model: "LEO-S592-AQG0-P",
		Attributes: map[string]interface{}{"fCnt": 1, "tag_unit": "ppm", "tag_threshold_min": "400", "tag_threshold_max": "1500", "tag_sensor_type": "air_quality"},
		Readings:   map[string]interface{}{"temperature": 21.0, "co2": 1100.0},
	}
	evs := e.Observe([]discovery.Device{d}, time.Now())
	if has(evs, "env.temperature_low") || has(evs, "air.co2_high") {
		t.Fatalf("400-1500 ppm son umbrales de CO2: 21 °C y 1100 ppm no son alarma: %v", types(evs))
	}
	d.Readings["co2"] = 1600.0
	d.Attributes["fCnt"] = 2
	if evs := e.Observe([]discovery.Device{d}, time.Now()); !has(evs, "air.co2_high") {
		t.Fatalf("1600 ppm > 1500 deberia alarmar: %v", types(evs))
	}
}

func TestColdChainWithGraceAndUnconfiguredChannels(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	now := time.Now()
	mk := func(temp float64, fcnt int) discovery.Device {
		return discovery.Device{
			ExternalID: "lorawan:wise", Name: "HES-BAN-CF-3", Protocol: "lorawan", State: "online", Model: "WISE-4610-S617",
			Attributes: map[string]interface{}{
				"fCnt": fcnt, "tag_area": "Banco de Sangre",
				"tag_ai0_type": "temperature", "tag_ai0_threshold_min": "2", "tag_ai0_threshold_max": "6", "tag_ai0_tolerance": "20",
				"tag_ai0_operative_area": "Refrigerador Unidades No Liberadas", "tag_ai0_code": "HES008",
			},
			Readings: map[string]interface{}{
				"ai0_value": 15.0, "ai0_temperature": temp, "ai0_open_circuit": 0.0,
				// ai3 sin tags (canal no usado) en circuito abierto: no debe alarmar.
				"ai3_value": 0.0, "ai3_open_circuit": 1.0,
			},
		}
	}
	if evs := e.Observe([]discovery.Device{mk(4.5, 1)}, now); len(evs) != 0 {
		t.Fatalf("refrigerador en rango y canal no configurado: sin eventos, llegaron %v", types(evs))
	}
	if evs := e.Observe([]discovery.Device{mk(8.2, 2)}, now.Add(5*time.Minute)); has(evs, "coldchain.out_of_range") {
		t.Fatalf("dentro de la tolerancia (20 min) no debe alarmar todavia: %v", types(evs))
	}
	if evs := e.Observe([]discovery.Device{mk(8.4, 3)}, now.Add(26*time.Minute)); !has(evs, "coldchain.out_of_range") {
		t.Fatalf("fuera de rango mas de 20 min debe alarmar: %v", types(evs))
	}
	if evs := e.Observe([]discovery.Device{mk(5.0, 4)}, now.Add(30*time.Minute)); !has(evs, "coldchain.normal") {
		t.Fatalf("al volver a rango debe normalizar: %v", types(evs))
	}
}

func TestColdChainProbeAtScaleEdgeIsSensorFault(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	d := discovery.Device{
		ExternalID: "lorawan:wise2", Name: "HES-FAR-CF-2", Protocol: "lorawan", State: "online",
		Attributes: map[string]interface{}{
			"fCnt": 1, "tag_ai0_type": "temperature", "tag_ai0_threshold_min": "0", "tag_ai0_threshold_max": "8", "tag_ai0_tolerance": "0",
			"tag_ai0_operative_area": "Refrigerador 4",
		},
		// 4.00 mA exactos -> -100.4 °C: sonda desconectada, no una temperatura real.
		Readings: map[string]interface{}{"ai0_value": 4.0, "ai0_temperature": -100.4},
	}
	evs := e.Observe([]discovery.Device{d}, time.Now())
	if has(evs, "coldchain.out_of_range") || !has(evs, "io.sensor_fault") {
		t.Fatalf("en el borde de escala debe ser falla de sensor, no alarma de temperatura: %v", types(evs))
	}
}

func TestGatewayAndRadioDiscoveryEvents(t *testing.T) {
	e := NewEngine(Thresholds{}, NewState())
	now := time.Now()
	gw := discovery.Device{ExternalID: "lora-gateway:0016c001f1dde184", Name: "Gateway LoRa 0016c001f1dde184", Protocol: "lorawan", State: "online",
		Attributes: map[string]interface{}{"category": "gateway", "gatewayEui": "0016c001f1dde184", "ip": "192.168.70.50:1700"}, Readings: map[string]interface{}{"frames_received": 1}}
	radio := discovery.Device{ExternalID: "lora-radio:24e124710f139411", Name: "Dispositivo 24E124710F139411 (join, sin llaves)", Protocol: "lorawan", State: "online",
		Attributes: map[string]interface{}{"category": "lora_radio", "devEui": "24e124710f139411", "joinEui": "24e124c0002a0001", "joinRequests": 1, "fCnt": 0, "lastUplinkAt": "t1"},
		Readings:   map[string]interface{}{"rssi": -61.0}}
	evs := e.Observe([]discovery.Device{gw, radio}, now)
	if !has(evs, "discovery.gateway") || !has(evs, "discovery.radio_device") || !has(evs, "lorawan.join_request") {
		t.Fatalf("faltan eventos de descubrimiento: %v", types(evs))
	}
	if evs := e.Observe([]discovery.Device{gw, radio}, now.Add(time.Second)); len(evs) != 0 {
		t.Fatalf("lo ya descubierto no se repite: %v", types(evs))
	}
	radio.Attributes["joinRequests"] = 2
	radio.Attributes["lastUplinkAt"] = "t2"
	if evs := e.Observe([]discovery.Device{radio}, now.Add(2*time.Second)); !has(evs, "lorawan.join_request") {
		t.Fatalf("un nuevo join request debe registrarse: %v", types(evs))
	}
	gw.State = "offline"
	evs = e.Observe([]discovery.Device{gw}, now.Add(3*time.Minute))
	if !has(evs, "device.offline") || evs[0].Severity != Critical {
		t.Fatalf("gateway desconectado debe ser critico: %v", types(evs))
	}
}

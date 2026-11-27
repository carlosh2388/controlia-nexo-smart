package gestion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Igual que POLL_INTERVAL_MS de bacnet.adapter.service.ts.
const intervaloBACnet = 10 * time.Second

// lectorBACnet lee los aires por el puente BACnet (apps/bacnet-bridge), con los mismos puntos y la
// misma traduccion que pollOnce() de la API. Tambien ejecuta las escrituras de las ordenes.
type lectorBACnet struct {
	url, token string
	equipos    []Equipo
	publicar   func(deviceT)
	cliente    *http.Client
	stop       chan struct{}
	ahora      chan struct{}
	wg         sync.WaitGroup
	// Una sola operacion a la vez contra el puente (el gateway real no tolera concurrencia).
	turno sync.Mutex
}

type lecturaBACnet struct {
	Key      string `json:"key"`
	Type     int    `json:"type"`
	Instance int    `json:"instance"`
}

type resultadoBACnet struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
	Ok    bool        `json:"ok"`
	Error string      `json:"error,omitempty"`
}

func nuevoLectorBACnet(url, token string, equipos []Equipo, publicar func(deviceT)) *lectorBACnet {
	l := &lectorBACnet{
		url: strings.TrimRight(url, "/"), token: token, equipos: equipos, publicar: publicar,
		cliente: &http.Client{Timeout: 60 * time.Second},
		stop:    make(chan struct{}),
		ahora:   make(chan struct{}, 1),
	}
	if len(equipos) > 0 {
		if l.url == "" {
			log.Printf("[gestion/bacnet] hay %d aire(s) en el plan pero falta gestion.bacnetBridgeUrl en la config", len(equipos))
		} else {
			l.wg.Add(1)
			go l.bucle()
			log.Printf("[gestion/bacnet] %d aire(s) por el puente %s", len(equipos), l.url)
		}
	}
	return l
}

func (l *lectorBACnet) detener() {
	close(l.stop)
	l.wg.Wait()
}

func (l *lectorBACnet) releer() {
	select {
	case l.ahora <- struct{}{}:
	default:
	}
}

func (l *lectorBACnet) bucle() {
	defer l.wg.Done()
	avisado := map[string]time.Time{}
	for {
		for _, e := range l.equipos {
			select {
			case <-l.stop:
				return
			default:
			}
			if err := l.leer(e); err != nil && time.Since(avisado[e.ID]) > 5*time.Minute {
				log.Printf("[gestion/bacnet] %q: %v", e.Nombre, err)
				avisado[e.ID] = time.Now()
			}
		}
		select {
		case <-l.stop:
			return
		case <-l.ahora:
		case <-time.After(intervaloBACnet):
		}
	}
}

// lecturasDe arma las mismas lecturas que pollOnce() (estado si existe, si no el comando).
func lecturasDe(p map[string]ObjRef) ([]lecturaBACnet, error) {
	punto := func(estado, comando string) (ObjRef, bool) {
		if r, ok := p[estado]; ok && estado != "" {
			return r, true
		}
		r, ok := p[comando]
		return r, ok
	}
	var out []lecturaBACnet
	agregar := func(key, estado, comando string, obligatorio bool) error {
		r, ok := punto(estado, comando)
		if !ok {
			if obligatorio {
				return fmt.Errorf("punto BACnet requerido %q no configurado", key)
			}
			return nil
		}
		out = append(out, lecturaBACnet{Key: key, Type: r.Type, Instance: r.Instance})
		return nil
	}
	for _, x := range []struct {
		key, estado, comando string
		obligatorio          bool
	}{
		{"on", "startStopStatus", "startStopCommand", true},
		{"roomTemp", "", "roomTemp", true},
		{"setRoomTemp", "", "setRoomTemp", true},
		{"mode", "modeStatus", "modeCommand", false},
		{"fanSpeed", "fanStatus", "fanCommand", false},
		{"swing", "swingStatus", "swingCommand", false},
		{"tempRangeLow", "tempRangeLowerStatus", "tempRangeLowerCommand", false},
		{"tempRangeHigh", "tempRangeUpperStatus", "tempRangeUpperCommand", false},
	} {
		if err := agregar(x.key, x.estado, x.comando, x.obligatorio); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// traducir es la parte final de pollOnce(): estado on/off y lecturas con modo/ventilador en texto.
// Si el punto de encendido no respondio, devuelve error: no se inventa un "apagado".
func traducir(e Equipo, res []resultadoBACnet) (deviceT, error) {
	por := map[string]resultadoBACnet{}
	for _, r := range res {
		por[r.Key] = r
	}
	on, ok := por["on"]
	if !ok || !on.Ok || on.Value == nil {
		motivo := on.Error
		if motivo == "" {
			motivo = "sin respuesta"
		}
		return deviceT{}, fmt.Errorf("sin respuesta del equipo BACnet %s (%s)", e.BACnet.Host, motivo)
	}
	valor := func(k string) interface{} {
		if r, ok := por[k]; ok && r.Ok {
			return r.Value
		}
		return nil
	}
	lect := map[string]interface{}{
		"roomTemp":      valor("roomTemp"),
		"setRoomTemp":   valor("setRoomTemp"),
		"mode":          indiceTexto(valor("mode"), e.BACnet.ModeStates),
		"fanSpeed":      indiceTexto(valor("fanSpeed"), e.BACnet.FanStates),
		"tempRangeLow":  valor("tempRangeLow"),
		"tempRangeHigh": valor("tempRangeHigh"),
	}
	if _, ok := por["swing"]; ok {
		lect["swing"] = verdadero(valor("swing"))
	}
	d := dispositivo(e)
	d.State = "off"
	if verdadero(on.Value) {
		d.State = "on"
	}
	d.Readings = lect
	return d, nil
}

func (l *lectorBACnet) leer(e Equipo) error {
	reads, err := lecturasDe(e.BACnet.Points)
	if err != nil {
		return err
	}
	var out struct {
		Values []resultadoBACnet `json:"values"`
	}
	if err := l.post("/read", map[string]interface{}{"host": e.BACnet.Host, "reads": reads}, &out); err != nil {
		return err
	}
	d, err := traducir(e, out.Values)
	if err != nil {
		return err
	}
	l.publicar(d)
	return nil
}

// escribir ejecuta las escrituras de una orden, en orden; la primera que falla detiene el resto.
func (l *lectorBACnet) escribir(host string, ws []EscrituraBACnet) error {
	if l == nil || l.url == "" {
		return fmt.Errorf("el agente no tiene puente BACnet configurado (gestion.bacnetBridgeUrl)")
	}
	for _, w := range ws {
		body := map[string]interface{}{"host": host, "object": w.Object, "valueType": w.ValueType, "value": w.Value}
		if err := l.post("/write", body, nil); err != nil {
			return err
		}
	}
	l.releer()
	return nil
}

func (l *lectorBACnet) post(ruta string, body interface{}, out interface{}) error {
	l.turno.Lock()
	defer l.turno.Unlock()
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, l.url+ruta, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if l.token != "" {
		req.Header.Set("x-bridge-token", l.token)
	}
	resp, err := l.cliente.Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo conectar al puente BACnet: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("puente BACnet respondio %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(respBody, out)
}

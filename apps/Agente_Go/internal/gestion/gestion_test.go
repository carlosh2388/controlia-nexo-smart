package gestion

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func ptr(s string) *string { return &s }

func TestExtraerHTTPComoLaAPI(t *testing.T) {
	ha := `{"entity_id":"switch.sonoff_1","state":"on","attributes":{"brightness":128,"lista":[1,2]}}`
	casos := []struct {
		raw  string
		ruta *string
		want string
	}{
		{ha, ptr("state"), "on"},
		{ha, ptr("attributes.brightness"), "128"},
		{ha, ptr("attributes.lista[1]"), "2"},
		{ha, ptr("no.existe"), ""},
		{"  ON \n", nil, "ON"},
		{"no es json", ptr("state"), "no es json"},
	}
	for _, c := range casos {
		if got := extraerHTTP(c.raw, c.ruta); got != c.want {
			t.Errorf("extraerHTTP(%q, %v) = %q, want %q", c.raw, c.ruta, got, c.want)
		}
	}
}

func TestExtraerMQTTComoLaAPI(t *testing.T) {
	if got := extraerMQTT(`{"state":"ON","brightness":40}`, ptr("state")); got != "ON" {
		t.Fatalf("got %q", got)
	}
	// Sin el campo, la API deja el payload completo.
	raw := `{"brightness":40}`
	if got := extraerMQTT(raw, ptr("state")); got != raw {
		t.Fatalf("got %q", got)
	}
	if got := extraerMQTT("ON", nil); got != "ON" {
		t.Fatalf("got %q", got)
	}
}

func TestEstadoDe(t *testing.T) {
	if estadoDe("on", "on", "off") != "on" || estadoDe("off", "on", "off") != "off" {
		t.Fatal("on/off")
	}
	if estadoDe("ON", "ON", "OFF") != "on" {
		t.Fatal("payload ON")
	}
	if estadoDe("unavailable", "on", "off") != "unavailable" {
		t.Fatal("texto propio de Home Assistant")
	}
	if len(estadoDe(strings.Repeat("x", 90), "on", "off")) != 40 {
		t.Fatal("limite de 40")
	}
}

func equipoHA(id, entidad string, ms int) Equipo {
	return Equipo{
		ID: id, Nombre: id, Protocolo: "http", Tipo: "switch", PayloadOn: "on", PayloadOff: "off",
		HTTP: &PlanHTTP{
			BaseURL:     "http://10.3.0.25:8123",
			Estado:      Plantilla{Method: "GET", Path: "/api/states/" + entidad, Headers: map[string]string{"Authorization": "Bearer x"}},
			JSONPath:    ptr("state"),
			IntervaloMs: ms,
		},
	}
}

func TestAgruparHAUnaConsultaPorHomeAssistant(t *testing.T) {
	otro := equipoHA("c", "switch.c", 5000)
	otro.HTTP.Estado.Path = "/estado/c" // no es Home Assistant: consulta propia
	grupos, sueltos := agruparHA([]Equipo{
		equipoHA("a", "switch.a", 5000),
		equipoHA("b", "switch.b", 3000),
		equipoHA("a2", "switch.a", 5000), // dos equipos sobre la misma entidad
		otro,
	})
	if len(grupos) != 1 || len(sueltos) != 1 {
		t.Fatalf("grupos=%d sueltos=%d", len(grupos), len(sueltos))
	}
	g := grupos[0]
	if g.intervalo != 3*time.Second {
		t.Fatalf("intervalo %v: debe ser el menor del grupo", g.intervalo)
	}
	if len(g.equipos["switch.a"]) != 2 || len(g.equipos["switch.b"]) != 1 {
		t.Fatalf("equipos por entidad: %+v", g.equipos)
	}
}

func TestLectorHTTPLeeTodoConUnaConsulta(t *testing.T) {
	var consultas int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		consultas++
		mu.Unlock()
		if r.URL.Path != "/api/states" || r.Header.Get("Authorization") != "Bearer x" {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(`[{"entity_id":"switch.a","state":"on"},{"entity_id":"switch.b","state":"off"},{"entity_id":"light.x","state":"on"}]`))
	}))
	defer srv.Close()
	a, b := equipoHA("a", "switch.a", 60000), equipoHA("b", "switch.b", 60000)
	a.HTTP.BaseURL, b.HTTP.BaseURL = srv.URL, srv.URL

	got := map[string]string{}
	listo := make(chan struct{}, 4)
	l := nuevoLectorHTTP([]Equipo{a, b}, func(d deviceT) {
		mu.Lock()
		got[d.ExternalID] = d.State
		mu.Unlock()
		listo <- struct{}{}
	})
	defer l.detener()
	for i := 0; i < 2; i++ {
		select {
		case <-listo:
		case <-time.After(3 * time.Second):
			t.Fatal("no llegaron los estados")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if got["nodivo:a"] != "on" || got["nodivo:b"] != "off" {
		t.Fatalf("estados %+v", got)
	}
	if consultas != 1 {
		t.Fatalf("consultas a Home Assistant = %d, want 1", consultas)
	}
}

func aire() Equipo {
	return Equipo{
		ID: "ac1", Nombre: "AC A2", Protocolo: "bacnet", Tipo: "climate",
		BACnet: &PlanBACnet{
			Host: "10.3.0.11",
			Points: map[string]ObjRef{
				"startStopCommand": {Type: 4, Instance: 1}, "startStopStatus": {Type: 3, Instance: 2},
				"roomTemp": {Type: 0, Instance: 3}, "setRoomTemp": {Type: 2, Instance: 4},
				"modeCommand": {Type: 14, Instance: 5}, "modeStatus": {Type: 13, Instance: 6},
				"fanCommand": {Type: 14, Instance: 7},
			},
			ModeStates: []string{"COOL", "DRY", "FAN"},
			FanStates:  []string{"LOW", "MID", "HIGH"},
		},
	}
}

func TestLecturasBACnetComoPollOnce(t *testing.T) {
	reads, err := lecturasDe(aire().BACnet.Points)
	if err != nil {
		t.Fatal(err)
	}
	por := map[string]lecturaBACnet{}
	for _, r := range reads {
		por[r.Key] = r
	}
	if por["on"].Instance != 2 {
		t.Fatal("encendido debe leer el punto de estado, no el de comando")
	}
	if por["mode"].Instance != 6 || por["fanSpeed"].Instance != 7 {
		t.Fatalf("modo/ventilador: %+v", por)
	}
	if _, ok := por["swing"]; ok {
		t.Fatal("swing no esta configurado")
	}
	if _, err := lecturasDe(map[string]ObjRef{"roomTemp": {}}); err == nil {
		t.Fatal("sin punto de encendido debe fallar")
	}
}

func TestTraducirBACnet(t *testing.T) {
	d, err := traducir(aire(), []resultadoBACnet{
		{Key: "on", Value: float64(1), Ok: true},
		{Key: "roomTemp", Value: 23.5, Ok: true},
		{Key: "setRoomTemp", Value: 22.0, Ok: true},
		{Key: "mode", Value: float64(2), Ok: true},
		{Key: "fanSpeed", Value: nil, Ok: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.State != "on" || d.Readings["mode"] != "DRY" || d.Readings["roomTemp"] != 23.5 || d.Readings["fanSpeed"] != nil {
		t.Fatalf("%+v", d)
	}
	// El gateway no respondio: no se inventa "apagado".
	if _, err := traducir(aire(), []resultadoBACnet{{Key: "on", Ok: false, Error: "ERR_TIMEOUT"}}); err == nil {
		t.Fatal("sin respuesta debe ser error")
	}
}

func TestOrdenPermitida(t *testing.T) {
	ha := equipoHA("luz", "switch.a", 5000)
	mq := Equipo{ID: "dim", Nombre: "Dimmer", Protocolo: "mqtt", Tipo: "switch", MQTT: &PlanMQTT{StateTopic: ptr("z/dim"), CommandTopic: ptr("z/dim/set")}}
	plan := &Plan{Equipos: []Equipo{ha, mq, aire()}}
	bien := []OrdenEnviada{
		{DeviceID: "luz", Orden: Orden{Tipo: "http", BaseURL: "http://10.3.0.25:8123/", Method: "POST", Path: "/api/services/switch/turn_on"}},
		{DeviceID: "dim", Orden: Orden{Tipo: "mqtt", Topic: "z/dim/set", Payload: `{"state":"ON"}`}},
		{DeviceID: "ac1", Orden: Orden{Tipo: "bacnet", Host: "10.3.0.11", Escrituras: []EscrituraBACnet{{Object: ObjRef{Type: 4, Instance: 1}, ValueType: "boolean", Value: true}}}},
	}
	for _, o := range bien {
		if err := permitida(plan, nil, o); err != nil {
			t.Errorf("%s deberia pasar: %v", o.Orden.Tipo, err)
		}
	}
	mal := []OrdenEnviada{
		{DeviceID: "otro", Orden: Orden{Tipo: "http", BaseURL: "http://10.3.0.25:8123"}},
		{DeviceID: "luz", Orden: Orden{Tipo: "http", BaseURL: "http://192.168.1.50"}},
		{DeviceID: "dim", Orden: Orden{Tipo: "mqtt", Topic: "z/otro/set"}},
		{DeviceID: "ac1", Orden: Orden{Tipo: "bacnet", Host: "10.3.0.99", Escrituras: []EscrituraBACnet{{Object: ObjRef{Type: 4, Instance: 1}, ValueType: "boolean"}}}},
		{DeviceID: "ac1", Orden: Orden{Tipo: "bacnet", Host: "10.3.0.11", Escrituras: []EscrituraBACnet{{Object: ObjRef{Type: 8, Instance: 9000}, ValueType: "real"}}}},
		{DeviceID: "ac1", Orden: Orden{Tipo: "bacnet", Host: "10.3.0.11"}},
	}
	for i, o := range mal {
		if err := permitida(plan, nil, o); err == nil {
			t.Errorf("orden %d (%s) deberia rechazarse", i, o.Orden.Tipo)
		}
	}
	if err := permitida(plan, []string{"10.3.0.30"}, bien[0]); err == nil {
		t.Error("hostsPermitidos debe restringir")
	}
}

func TestPlanYOrdenesConLaAPI(t *testing.T) {
	var resultados []map[string]interface{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "k" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/agents/tec3/plan":
			_ = json.NewEncoder(w).Encode(Plan{Version: 2})
		case r.URL.Path == "/agents/tec3/ordenes":
			if r.URL.Query().Get("esperar") != "5" {
				w.WriteHeader(400)
				return
			}
			_, _ = w.Write([]byte(`{"ordenes":[{"id":"o1","deviceId":"x","dispositivo":"X","vence":"2099-01-01T00:00:00.000Z","orden":{"tipo":"mqtt","topic":"t","payload":"ON"}}],"versionPlan":3}`))
		case strings.HasSuffix(r.URL.Path, "/resultado"):
			var b map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&b)
			mu.Lock()
			resultados = append(resultados, b)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := newAPIClient(Entorno{APIURL: srv.URL, APIKey: "k", BuildingKey: "tec3"})
	p, err := c.plan()
	if err != nil || p.Version != 2 {
		t.Fatalf("plan: %v %+v", err, p)
	}
	r, err := c.tomarOrdenes(5)
	if err != nil || len(r.Ordenes) != 1 || r.VersionPlan != 3 || r.Ordenes[0].Orden.Topic != "t" || r.Ordenes[0].Vence.Year() != 2099 {
		t.Fatalf("ordenes: %v %+v", err, r)
	}
	if err := c.resultado("o1", false, "fallo"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(resultados) != 1 || resultados[0]["ok"] != false || resultados[0]["error"] != "fallo" {
		t.Fatalf("%+v", resultados)
	}
}

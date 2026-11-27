// Package gestion hace que el agente lea y controle equipos que YA existen en la API central
// (Home Assistant por HTTP, MQTT/Zigbee2MQTT, LoRaWAN de ChirpStack y aires BACnet), en lugar de
// que lo haga la API. La API manda el "plan": que equipos y con que configuracion exacta (la misma
// que usaban sus adaptadores), y las ordenes ya armadas. El agente solo las ejecuta en la red del
// edificio y devuelve el resultado, asi no hay logica de protocolo duplicada.
//
// Cada equipo se reporta con externalId "nodivo:<id del equipo en la API>": la API lo reconoce y
// lo actualiza en el mismo registro (nombre, area, historial y automatizaciones no cambian).
package gestion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// PrefijoID es el prefijo de externalId que la API reconoce como "equipo suyo que maneja el agente".
const PrefijoID = "nodivo:"

type Plan struct {
	Version  int      `json:"version"`
	Respaldo bool     `json:"respaldo"`
	Equipos  []Equipo `json:"equipos"`
}

type Equipo struct {
	ID         string       `json:"id"`
	Nombre     string       `json:"nombre"`
	Protocolo  string       `json:"protocolo"`
	Tipo       string       `json:"tipo"`
	PayloadOn  string       `json:"payloadOn"`
	PayloadOff string       `json:"payloadOff"`
	HTTP       *PlanHTTP    `json:"http,omitempty"`
	MQTT       *PlanMQTT    `json:"mqtt,omitempty"`
	LoRaWAN    *PlanLoRaWAN `json:"lorawan,omitempty"`
	BACnet     *PlanBACnet  `json:"bacnet,omitempty"`
}

// Plantilla es una peticion HTTP tal como la guarda la API (HttpActionTemplateDto).
type Plantilla struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    interface{}       `json:"body,omitempty"`
}

type PlanHTTP struct {
	BaseURL     string    `json:"baseUrl"`
	Estado      Plantilla `json:"estado"`
	JSONPath    *string   `json:"jsonPath"`
	IntervaloMs int       `json:"intervaloMs"`
}

type PlanMQTT struct {
	StateTopic   *string `json:"stateTopic"`
	CommandTopic *string `json:"commandTopic"`
	StatePath    *string `json:"statePath"`
}

type PlanLoRaWAN struct {
	DevEUI string `json:"devEui"`
}

type ObjRef struct {
	Type     int `json:"type"`
	Instance int `json:"instance"`
}

type PlanBACnet struct {
	Host       string            `json:"host"`
	Points     map[string]ObjRef `json:"points"`
	ModeStates []string          `json:"modeStates"`
	FanStates  []string          `json:"fanStates"`
}

// Orden es lo que la API quiere que se haga en un equipo (ver ordenes-agente.service.ts).
type Orden struct {
	Tipo string `json:"tipo"` // "http" | "mqtt" | "bacnet"
	// http
	BaseURL string            `json:"baseUrl,omitempty"`
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    interface{}       `json:"body,omitempty"`
	// mqtt
	Topic   string `json:"topic,omitempty"`
	Payload string `json:"payload,omitempty"`
	// bacnet
	Host       string             `json:"host,omitempty"`
	Escrituras []EscrituraBACnet  `json:"escrituras,omitempty"`
}

type EscrituraBACnet struct {
	Object    ObjRef      `json:"object"`
	ValueType string      `json:"valueType"` // "boolean" | "real" | "enum"
	Value     interface{} `json:"value"`
}

type OrdenEnviada struct {
	ID          string    `json:"id"`
	DeviceID    string    `json:"deviceId"`
	Dispositivo string    `json:"dispositivo"`
	Vence       time.Time `json:"vence"`
	Orden       Orden     `json:"orden"`
}

type respuestaOrdenes struct {
	Ordenes     []OrdenEnviada `json:"ordenes"`
	VersionPlan int            `json:"versionPlan"`
	Respaldo    bool           `json:"respaldo"`
}

// Entorno: como llegar a la API central (los mismos datos del config.yaml del agente).
type Entorno struct {
	APIURL      string
	APIKey      string
	BuildingKey string
}

type apiClient struct {
	env   Entorno
	corto *http.Client
	largo *http.Client // para la consulta larga de ordenes
}

func newAPIClient(env Entorno) *apiClient {
	return &apiClient{
		env:   env,
		corto: &http.Client{Timeout: 15 * time.Second},
		largo: &http.Client{Timeout: 40 * time.Second},
	}
}

func (c *apiClient) ruta(sufijo string) string {
	return strings.TrimRight(c.env.APIURL, "/") + "/agents/" + url.PathEscape(c.env.BuildingKey) + sufijo
}

func (c *apiClient) plan() (*Plan, error) {
	var p Plan
	if err := c.hacer(c.corto, http.MethodGet, c.ruta("/plan"), nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *apiClient) tomarOrdenes(esperarSeg int) (*respuestaOrdenes, error) {
	var r respuestaOrdenes
	if err := c.hacer(c.largo, http.MethodGet, c.ruta(fmt.Sprintf("/ordenes?esperar=%d", esperarSeg)), nil, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (c *apiClient) resultado(id string, ok bool, motivo string) error {
	body := map[string]interface{}{"ok": ok}
	if motivo != "" {
		if len(motivo) > 480 {
			motivo = motivo[:480]
		}
		body["error"] = motivo
	}
	return c.hacer(c.corto, http.MethodPost, c.ruta("/ordenes/"+url.PathEscape(id)+"/resultado"), body, nil)
}

func (c *apiClient) hacer(cl *http.Client, metodo, u string, body interface{}, out interface{}) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequest(metodo, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("x-api-key", c.env.APIKey)
	resp, err := cl.Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo conectar a la API: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("la API respondio %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

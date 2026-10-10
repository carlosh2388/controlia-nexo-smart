// Package mqttsource descubre dispositivos publicados por Zigbee2MQTT (o cualquier puente MQTT
// compatible con el mismo patron de topicos) y los mantiene sincronizados en vivo.
//
// Espejo intencional de apps/api/src/devices/zigbee2mqtt-import.service.ts: mismos nombres de
// campo (friendly_name, ieee_address, definition.exposes[].property), misma regla para decidir
// switch vs sensor. Si esa logica cambia en el backend, hay que replicar el cambio aca.
package mqttsource

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const protocolName = "mqtt"

// z2mExpose refleja la forma de definition.exposes[] que publica Zigbee2MQTT: una lectura/accion
// puede venir directa (property) o anidada dentro de un composite (features[].property).
type z2mExpose struct {
	Property string `json:"property"`
	Features []struct {
		Property string `json:"property"`
	} `json:"features"`
}

type z2mDeviceEntry struct {
	FriendlyName string `json:"friendly_name"`
	IEEEAddress  string `json:"ieee_address"`
	Type         string `json:"type"`
	Definition   *struct {
		Model   string      `json:"model"`
		Exposes []z2mExpose `json:"exposes"`
	} `json:"definition"`
}

var actionableProperties = map[string]bool{"state": true}
var sensorProperties = map[string]bool{
	"temperature": true, "humidity": true, "battery": true, "voltage": true, "linkquality": true,
}

func exposedProperties(e z2mDeviceEntry) map[string]bool {
	props := map[string]bool{}
	if e.Definition == nil {
		return props
	}
	for _, exp := range e.Definition.Exposes {
		if exp.Property != "" {
			props[exp.Property] = true
		}
		for _, f := range exp.Features {
			if f.Property != "" {
				props[f.Property] = true
			}
		}
	}
	return props
}

// inferKind: con "state" expuesto (o accionable de cualquier tipo) es switch; sin accion pero
// con alguna lectura tipo sensor es sensor puro; sin nada reconocible, default switch.
func inferKind(e z2mDeviceEntry) string {
	props := exposedProperties(e)
	hasAction := false
	hasSensorReading := false
	for p := range props {
		if actionableProperties[p] {
			hasAction = true
		}
		if sensorProperties[p] {
			hasSensorReading = true
		}
	}
	if !hasAction && hasSensorReading {
		return "sensor"
	}
	return "switch"
}

// applyTopics completa StateTopic/CommandTopic/MqttJson SOLO para switches: son los que se
// pueden encender/apagar. Mismo esquema exacto que ya usa el import manual "Sin Home Assistant
// (MQTT directo)" (apps/api/src/devices/zigbee2mqtt-import.service.ts) - se replica a proposito
// para que, una vez confirmado, el dispositivo quede tan controlable como uno importado a mano.
func applyTopics(d *discovery.Device, baseTopic, friendlyName string) {
	if d.Kind != "switch" {
		return
	}
	d.StateTopic = baseTopic + "/" + friendlyName
	d.CommandTopic = baseTopic + "/" + friendlyName + "/set"
	d.MqttJson = &discovery.MqttJson{
		StatePath:  "state",
		OnPayload:  map[string]interface{}{"state": "ON"},
		OffPayload: map[string]interface{}{"state": "OFF"},
	}
}

type Source struct {
	cfg config.MQTTConfig

	client mqtt.Client

	mu      sync.Mutex
	devices map[string]discovery.Device // por friendly_name
	kinds   map[string]string           // friendly_name -> "switch"|"sensor", de bridge/devices

	onUpdate func([]discovery.Device)
}

func New(cfg config.MQTTConfig) *Source {
	return &Source{
		cfg:     cfg,
		devices: map[string]discovery.Device{},
		kinds:   map[string]string{},
	}
}

func (s *Source) Name() string { return "mqtt:" + s.cfg.BaseTopic }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	s.onUpdate = onUpdate

	opts := mqtt.NewClientOptions().
		AddBroker(s.cfg.BrokerURL).
		SetClientID(discovery.ClientID("agente-go-" + s.cfg.BaseTopic)).
		SetAutoReconnect(true).
		SetCleanSession(true)
	if s.cfg.Username != "" {
		opts.SetUsername(s.cfg.Username)
	}
	if s.cfg.Password != "" {
		opts.SetPassword(s.cfg.Password)
	}
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		log.Printf("[mqtt] conectado a %s, suscribiendo a %s/bridge/devices y %s/+", s.cfg.BrokerURL, s.cfg.BaseTopic, s.cfg.BaseTopic)
		if token := c.Subscribe(s.cfg.BaseTopic+"/bridge/devices", 0, s.handleBridgeDevices); token.Wait() && token.Error() != nil {
			log.Printf("[mqtt] error suscribiendo a bridge/devices: %v", token.Error())
		}
		if token := c.Subscribe(s.cfg.BaseTopic+"/+", 0, s.handleDeviceState); token.Wait() && token.Error() != nil {
			log.Printf("[mqtt] error suscribiendo a estados: %v", token.Error())
		}
	})
	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		log.Printf("[mqtt] conexion perdida con %s: %v (reintentando)", s.cfg.BrokerURL, err)
	})

	s.client = mqtt.NewClient(opts)
	token := s.client.Connect()
	token.Wait()
	if token.Error() != nil {
		return fmt.Errorf("no se pudo conectar a %s: %w", s.cfg.BrokerURL, token.Error())
	}
	return nil
}

func (s *Source) Stop() {
	if s.client != nil && s.client.IsConnected() {
		s.client.Disconnect(250)
	}
}

// handleBridgeDevices llega con la lista completa retenida por Zigbee2MQTT: actualiza que
// friendly_name es switch/sensor y da de alta cualquier dispositivo que no tuviera estado
// todavia (con kind=switch/sensor pero sin state hasta que llegue su primer mensaje propio).
func (s *Source) handleBridgeDevices(_ mqtt.Client, msg mqtt.Message) {
	var entries []z2mDeviceEntry
	if err := json.Unmarshal(msg.Payload(), &entries); err != nil {
		log.Printf("[mqtt] bridge/devices con payload invalido: %v", err)
		return
	}

	s.mu.Lock()
	for _, e := range entries {
		if e.Type == "Coordinator" || e.FriendlyName == "" {
			continue
		}
		kind := inferKind(e)
		s.kinds[e.FriendlyName] = kind

		externalID := "mqtt:" + e.FriendlyName
		existing, known := s.devices[externalID]
		if !known {
			d := discovery.Device{
				ExternalID: externalID,
				Name:       e.FriendlyName,
				Protocol:   protocolName,
				Kind:       kind,
			}
			applyTopics(&d, s.cfg.BaseTopic, e.FriendlyName)
			s.devices[externalID] = d
		} else {
			existing.Kind = kind
			applyTopics(&existing, s.cfg.BaseTopic, e.FriendlyName)
			s.devices[externalID] = existing
		}
	}
	snapshot := s.snapshotLocked()
	s.mu.Unlock()

	s.onUpdate(snapshot)
}

// handleDeviceState llega por cada topico "<baseTopic>/<friendly_name>" (Zigbee2MQTT publica el
// estado completo del dispositivo como un solo JSON, ej. {"state":"ON","temperature":21.5,...}).
func (s *Source) handleDeviceState(_ mqtt.Client, msg mqtt.Message) {
	topic := msg.Topic()
	friendlyName := strings.TrimPrefix(topic, s.cfg.BaseTopic+"/")
	if friendlyName == "" || friendlyName == "bridge" || strings.HasPrefix(friendlyName, "bridge/") {
		return
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(msg.Payload(), &payload); err != nil {
		// Zigbee2MQTT normalmente publica JSON; un payload plano (ej. availability "online") se ignora.
		return
	}

	state := ""
	if raw, ok := payload["state"]; ok {
		if str, ok := raw.(string); ok {
			state = strings.ToLower(str)
		}
	}
	delete(payload, "state")

	externalID := "mqtt:" + friendlyName

	s.mu.Lock()
	kind := s.kinds[friendlyName]
	if kind == "" {
		kind = "switch"
	}
	device := discovery.Device{
		ExternalID: externalID,
		Name:       friendlyName,
		Protocol:   protocolName,
		Kind:       kind,
	}
	applyTopics(&device, s.cfg.BaseTopic, friendlyName)
	if state != "" {
		device.State = state
	}
	if len(payload) > 0 {
		device.Readings = payload
	}
	s.devices[externalID] = device
	snapshot := s.snapshotLocked()
	s.mu.Unlock()

	s.onUpdate(snapshot)
}

func (s *Source) snapshotLocked() []discovery.Device {
	out := make([]discovery.Device, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, d)
	}
	return out
}

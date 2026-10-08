// Package lorawansource escucha los uplinks de un network server LoRaWAN (ChirpStack) publicados
// por MQTT. Espejo intencional de apps/api/src/adapters/lorawan/lorawan.adapter.service.ts: mismo
// topico fijo, mismo formato de payload, mismos campos. Los sensores LoRaWAN son siempre de solo
// lectura (no hay manera de "comandar" un sensor de temperatura), asi que a diferencia de
// mqttsource este source nunca completa StateTopic/CommandTopic.
package lorawansource

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const protocolName = "lorawan"
const uplinkTopic = "application/+/device/+/event/up"

type chirpstackUplink struct {
	DeviceInfo *struct {
		DevEui     string            `json:"devEui"`
		DeviceName string            `json:"deviceName"`
		Tags       map[string]string `json:"tags"`
	} `json:"deviceInfo"`
	Object map[string]interface{} `json:"object"`
}

type Source struct {
	cfg config.LoRaWANConfig

	client mqtt.Client

	mu      sync.Mutex
	devices map[string]discovery.Device // por devEui

	onUpdate func([]discovery.Device)
}

func New(cfg config.LoRaWANConfig) *Source {
	return &Source{cfg: cfg, devices: map[string]discovery.Device{}}
}

func (s *Source) Name() string { return "lorawan:" + s.cfg.BrokerURL }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	s.onUpdate = onUpdate

	opts := mqtt.NewClientOptions().
		AddBroker(s.cfg.BrokerURL).
		SetClientID("agente-go-lorawan").
		SetAutoReconnect(true).
		SetCleanSession(true)
	if s.cfg.Username != "" {
		opts.SetUsername(s.cfg.Username)
	}
	if s.cfg.Password != "" {
		opts.SetPassword(s.cfg.Password)
	}
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		log.Printf("[lorawan] conectado a %s, suscribiendo a %s", s.cfg.BrokerURL, uplinkTopic)
		if token := c.Subscribe(uplinkTopic, 0, s.handleUplink); token.Wait() && token.Error() != nil {
			log.Printf("[lorawan] error suscribiendo a uplinks: %v", token.Error())
		}
	})
	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		log.Printf("[lorawan] conexion perdida con %s: %v (reintentando)", s.cfg.BrokerURL, err)
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

func (s *Source) handleUplink(_ mqtt.Client, msg mqtt.Message) {
	var uplink chirpstackUplink
	if err := json.Unmarshal(msg.Payload(), &uplink); err != nil {
		return
	}
	if uplink.DeviceInfo == nil || uplink.DeviceInfo.DevEui == "" || uplink.Object == nil {
		return
	}

	devEui := uplink.DeviceInfo.DevEui
	name := uplink.DeviceInfo.DeviceName
	if name == "" {
		name = "LoRaWAN " + devEui
	}

	device := discovery.Device{
		ExternalID: "lorawan:" + devEui,
		Name:       name,
		Protocol:   protocolName,
		Kind:       "sensor",
		State:      "online",
		Readings:   uplink.Object,
	}

	s.mu.Lock()
	s.devices[device.ExternalID] = device
	snapshot := make([]discovery.Device, 0, len(s.devices))
	for _, d := range s.devices {
		snapshot = append(snapshot, d)
	}
	s.mu.Unlock()

	s.onUpdate(snapshot)
}

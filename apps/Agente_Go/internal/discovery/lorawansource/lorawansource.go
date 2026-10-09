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
	"math"
	"strconv"
	"strings"
	"sync"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const protocolName = "lorawan"
const uplinkTopic = "application/+/device/+/event/up"

type chirpstackUplink struct {
	DeviceInfo *struct {
		DevEui            string            `json:"devEui"`
		DeviceName        string            `json:"deviceName"`
		DeviceProfileName string            `json:"deviceProfileName"`
		Tags              map[string]string `json:"tags"`
	} `json:"deviceInfo"`
	Object map[string]interface{} `json:"object"`
	FCnt   *int                   `json:"fCnt"`
	Time   string                 `json:"time"`
	RxInfo []struct {
		Rssi *float64 `json:"rssi"`
		Snr  *float64 `json:"snr"`
	} `json:"rxInfo"`
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

// addScaledChannels convierte las entradas analogicas 4-20 mA de los WISE a su magnitud real usando
// los tags que la sede ya tiene cargados en ChirpStack por canal (tag ai0_multiplier, ai0_offset,
// ai0_type...): valor = mA * multiplier + offset. En IGSS los WISE son monitores de cadena de frio
// (ai0_type = temperature), asi que aparece ai0_temperature en °C junto al ai0_value original.
// Verificado contra lecturas reales: 11.13 mA -> -32.6 °C en un ultracongelador (-40..-30 °C).
func addScaledChannels(readings map[string]interface{}, tags map[string]string) {
	for k := 0; k < 8; k++ {
		ch := fmt.Sprintf("ai%d", k)
		raw, ok := readings[ch+"_value"].(float64)
		if !ok {
			continue
		}
		mult, err1 := strconv.ParseFloat(tags["ai"+strconv.Itoa(k)+"_multiplier"], 64)
		off, err2 := strconv.ParseFloat(tags["ai"+strconv.Itoa(k)+"_offset"], 64)
		if err1 != nil || err2 != nil || mult == 0 {
			continue
		}
		suffix := "_scaled"
		if strings.EqualFold(tags["ai"+strconv.Itoa(k)+"_type"], "temperature") {
			suffix = "_temperature"
		}
		readings[ch+suffix] = math.Round((raw*mult+off)*100) / 100
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

	// Datos del enlace del ultimo uplink (mejor gateway) para el panel "Uplinks MQTT en vivo".
	attrs := map[string]interface{}{"devEui": devEui}
	for k, v := range uplink.DeviceInfo.Tags {
		attrs["tag_"+k] = v
	}
	if uplink.FCnt != nil {
		attrs["fCnt"] = *uplink.FCnt
	}
	if uplink.Time != "" {
		attrs["lastUplinkAt"] = uplink.Time
	}
	for _, rx := range uplink.RxInfo {
		if rx.Rssi == nil {
			continue
		}
		if best, ok := attrs["rssi"].(float64); !ok || *rx.Rssi > best {
			attrs["rssi"] = *rx.Rssi
			if rx.Snr != nil {
				attrs["snr"] = *rx.Snr
			}
		}
	}

	readings := uplink.Object
	addScaledChannels(readings, uplink.DeviceInfo.Tags)

	device := discovery.Device{
		ExternalID: "lorawan:" + devEui,
		Name:       name,
		Protocol:   protocolName,
		Kind:       "sensor",
		State:      "online",
		Readings:   readings,
		Model:      uplink.DeviceInfo.DeviceProfileName,
		Attributes: attrs,
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

package gestion

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

// Topico fijo de ChirpStack para los uplinks (igual que lorawan.adapter.service.ts).
const topicoUplink = "application/+/device/+/event/up"

func conectar(nombre string, b config.GestionBroker, alConectar func(mqtt.Client)) (mqtt.Client, error) {
	opts := mqtt.NewClientOptions().
		AddBroker(b.BrokerURL).
		SetClientID(discovery.ClientID(nombre)).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetCleanSession(true)
	if b.Username != "" {
		opts.SetUsername(b.Username)
	}
	if b.Password != "" {
		opts.SetPassword(b.Password)
	}
	opts.SetOnConnectHandler(alConectar)
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		log.Printf("[gestion/%s] conexion perdida con %s: %v (reintentando)", nombre, b.BrokerURL, err)
	})
	c := mqtt.NewClient(opts)
	t := c.Connect()
	if !t.WaitTimeout(10*time.Second) || t.Error() != nil {
		// Con ConnectRetry sigue intentando solo; se informa y se devuelve el cliente igual.
		if t.Error() != nil {
			return nil, fmt.Errorf("no se pudo conectar a %s: %w", b.BrokerURL, t.Error())
		}
		log.Printf("[gestion/%s] %s todavia no responde; se sigue intentando", nombre, b.BrokerURL)
	}
	return c, nil
}

// ---------------- MQTT (Zigbee2MQTT, home/...) ----------------

type lectorMQTT struct {
	cliente   mqtt.Client
	porTopico map[string][]Equipo
	publicar  func(deviceT)
}

func nuevoLectorMQTT(nombre string, b config.GestionBroker, equipos []Equipo, publicar func(deviceT)) (*lectorMQTT, error) {
	l := &lectorMQTT{porTopico: map[string][]Equipo{}, publicar: publicar}
	for _, e := range equipos {
		if e.MQTT.StateTopic != nil && *e.MQTT.StateTopic != "" {
			l.porTopico[*e.MQTT.StateTopic] = append(l.porTopico[*e.MQTT.StateTopic], e)
		}
	}
	c, err := conectar(nombre, b, func(c mqtt.Client) {
		for topico := range l.porTopico {
			if t := c.Subscribe(topico, 0, l.mensaje); t.Wait() && t.Error() != nil {
				log.Printf("[gestion/mqtt] no se pudo suscribir a %s: %v", topico, t.Error())
			}
		}
		log.Printf("[gestion/mqtt] conectado a %s: %d topico(s) de estado", b.BrokerURL, len(l.porTopico))
	})
	if err != nil {
		return nil, err
	}
	l.cliente = c
	return l, nil
}

func (l *lectorMQTT) detener() {
	if l.cliente != nil {
		l.cliente.Disconnect(250)
	}
}

// mensaje es handleMessage de mqtt.adapter.service.ts.
func (l *lectorMQTT) mensaje(_ mqtt.Client, msg mqtt.Message) {
	raw := strings.TrimSpace(string(msg.Payload()))
	for _, e := range l.porTopico[msg.Topic()] {
		d := dispositivo(e)
		d.State = estadoDe(extraerMQTT(raw, e.MQTT.StatePath), e.PayloadOn, e.PayloadOff)
		if e.Tipo == "sensor" {
			var obj map[string]interface{}
			if json.Unmarshal([]byte(raw), &obj) == nil && obj != nil {
				d.Readings = obj
			}
		}
		l.publicar(d)
	}
}

// publicarOrden manda el payload al topico de comando (QoS 1, como la API).
func (l *lectorMQTT) publicarOrden(topico, payload string) error {
	if l == nil || l.cliente == nil {
		return fmt.Errorf("el agente no tiene conexion MQTT configurada (gestion.mqtt)")
	}
	if !l.cliente.IsConnected() {
		return fmt.Errorf("sin conexion con el broker MQTT")
	}
	t := l.cliente.Publish(topico, 1, false, payload)
	if !t.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("el broker MQTT no confirmo la publicacion en 5 s")
	}
	return t.Error()
}

// ---------------- LoRaWAN (ChirpStack) ----------------

type lectorLoRaWAN struct {
	cliente  mqtt.Client
	porEUI   map[string][]Equipo
	publicar func(deviceT)
}

func nuevoLectorLoRaWAN(b config.GestionBroker, equipos []Equipo, publicar func(deviceT)) (*lectorLoRaWAN, error) {
	l := &lectorLoRaWAN{porEUI: map[string][]Equipo{}, publicar: publicar}
	for _, e := range equipos {
		eui := strings.ToLower(e.LoRaWAN.DevEUI)
		l.porEUI[eui] = append(l.porEUI[eui], e)
	}
	c, err := conectar("agente-go-gestion-lorawan", b, func(c mqtt.Client) {
		if t := c.Subscribe(topicoUplink, 0, l.uplink); t.Wait() && t.Error() != nil {
			log.Printf("[gestion/lorawan] no se pudo suscribir a %s: %v", topicoUplink, t.Error())
			return
		}
		log.Printf("[gestion/lorawan] conectado a %s: %d sensor(es)", b.BrokerURL, len(l.porEUI))
	})
	if err != nil {
		return nil, err
	}
	l.cliente = c
	return l, nil
}

func (l *lectorLoRaWAN) detener() {
	if l.cliente != nil {
		l.cliente.Disconnect(250)
	}
}

// uplink es handleUplink de lorawan.adapter.service.ts: estado "online" y lecturas = object.
func (l *lectorLoRaWAN) uplink(_ mqtt.Client, msg mqtt.Message) {
	var up struct {
		DeviceInfo struct {
			DevEUI string `json:"devEui"`
		} `json:"deviceInfo"`
		Object map[string]interface{} `json:"object"`
	}
	if json.Unmarshal(msg.Payload(), &up) != nil || up.DeviceInfo.DevEUI == "" || up.Object == nil {
		return
	}
	for _, e := range l.porEUI[strings.ToLower(up.DeviceInfo.DevEUI)] {
		d := dispositivo(e)
		d.State = "online"
		d.Readings = up.Object
		l.publicar(d)
	}
}

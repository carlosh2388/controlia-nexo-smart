// Package config carga config.yaml: un archivo por edificio, con las credenciales de la API
// central y que fuentes de protocolo estan habilitadas en esa red.
//
// Las secciones de protocolo (Protocols) tambien pueden venir de la API: se editan en la web
// (Agente Go > Configuracion) y el agente las aplica sin reiniciar. Ver internal/agent/remote.go.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"

	"agente-go/internal/events"
)

type Config struct {
	// Identifica de que edificio/sitio viene cada sync (ver Device.metadata.agent.buildingKey
	// en la API). Debe ser estable: cambiarlo hace que la API trate todos los dispositivos
	// como nuevos otra vez.
	BuildingKey string `yaml:"buildingKey"`

	API APIConfig `yaml:"api"`

	// Default true: los protocolos se toman de la configuracion remota (la API), y las secciones
	// de este archivo solo se usan la primera vez (se suben como version 1) o si la API no responde
	// y no hay copia guardada en dataDir. false = solo este archivo, como antes.
	RemoteConfig *bool `yaml:"remoteConfig"`

	Protocols `yaml:",inline"`

	// Carpeta donde el agente guarda eventos pendientes de enviar y el estado de las alarmas
	// (sobrevive reinicios y caidas de la API). Default "./data".
	DataDir string `yaml:"dataDir"`

	Events EventsConfig `yaml:"events"`

	// Cada cuantos segundos se reenvia el snapshot completo conocido a la API (no es
	// "cada cuanto se detectan cambios": eso es inmediato via MQTT/BACnet; esto es el
	// intervalo del resync completo, que sirve tambien como heartbeat).
	SyncIntervalSeconds int `yaml:"syncIntervalSeconds"`
}

func (c *Config) RemoteEnabled() bool { return c.RemoteConfig == nil || *c.RemoteConfig }

// Protocols son las fuentes que escucha el agente. Cada una es opcional; se arrancan solo las que
// tengan enabled: true.
type Protocols struct {
	MQTT    *MQTTConfig    `yaml:"mqtt,omitempty"`
	LoRaWAN *LoRaWANConfig `yaml:"lorawan,omitempty"`
	BACnet  *BACnetConfig  `yaml:"bacnet,omitempty"`
	// Un solo servidor Modbus: el formato original de config.yaml. Normalize lo mueve a ModbusServers.
	Modbus *ModbusConfig `yaml:"modbus,omitempty"`
	// Uno o mas servidores Modbus TCP (ej. el EBO de la sede y un controlador de generador aparte).
	ModbusServers []ModbusConfig `yaml:"modbusServers,omitempty"`
	// Receptor directo de gateways LoRa (protocolo Semtech UDP, puerto 1700): sin ChirpStack.
	LoRaGateway *LoRaGatewayConfig `yaml:"loraGateway,omitempty"`
	// Rangos de IP donde la web busca equipos (Buscar dispositivos en la red). El agente no lo usa
	// para leer; se guarda aca solo para que viaje junto con el resto de la config.
	Discovery map[string]interface{} `yaml:"discovery,omitempty"`
	// Equipos que ya existen en la API central (Home Assistant, MQTT, LoRaWAN, BACnet) y que este
	// agente lee y controla en lugar de la API. Cuales son lo decide la web (Agente Go > Equipos que
	// maneja); aca solo van los brokers y el puente que el agente usa para llegar a ellos.
	Gestion *GestionConfig `yaml:"gestion,omitempty"`
}

// GestionConfig: conexiones que usa el agente para los equipos que maneja en lugar de la API
// central. El QUE leer (plantillas HTTP, topicos, devEui, puntos BACnet) lo manda la API en el plan.
type GestionConfig struct {
	Enabled bool `yaml:"enabled"`
	// Broker de los equipos MQTT (Zigbee2MQTT, home/...): el mismo MQTT_URL de la API.
	MQTT *GestionBroker `yaml:"mqtt,omitempty"`
	// Broker de ChirpStack para los sensores LoRaWAN: el mismo LORAWAN_MQTT_URL de la API.
	LoRaWAN *GestionBroker `yaml:"lorawan,omitempty"`
	// Puente BACnet (apps/bacnet-bridge) para los aires: el mismo BACNET_BRIDGE_URL de la API.
	BACnetBridgeURL   string `yaml:"bacnetBridgeUrl,omitempty"`
	BACnetBridgeToken string `yaml:"bacnetBridgeToken,omitempty"`
	// Seguridad extra: si tiene valores, el agente SOLO manda ordenes HTTP/BACnet a estos hosts (IP o
	// nombre). Vacio = solo a los hosts de los equipos de su plan.
	HostsPermitidos []string `yaml:"hostsPermitidos,omitempty"`
}

type GestionBroker struct {
	BrokerURL string `yaml:"brokerUrl"`
	Username  string `yaml:"username,omitempty"`
	Password  string `yaml:"password,omitempty"`
}

type APIConfig struct {
	// Ej. "http://192.168.70.4:3010/api/v1" o "https://nodivo.example.com/api/v1".
	BaseURL string `yaml:"baseUrl"`
	// API key con role=agent, creada por un admin en POST /api-keys. Nunca uses una key de rol admin aca.
	APIKey string `yaml:"apiKey"`
}

type MQTTConfig struct {
	Enabled bool `yaml:"enabled"`
	// Ej. "tcp://192.168.70.25:1883".
	BrokerURL string `yaml:"brokerUrl"`
	Username  string `yaml:"username"`
	Password  string `yaml:"password"`
	// Prefijo de topicos de Zigbee2MQTT (o cualquier puente MQTT compatible); default "zigbee2mqtt".
	BaseTopic string `yaml:"baseTopic"`
}

// LoRaWANConfig apunta al broker MQTT de un network server LoRaWAN (ej. ChirpStack) - los
// sensores LoRaWAN "hablan MQTT" en el sentido de que el network server republica sus uplinks
// ahi, con el esquema fijo application/+/device/+/event/up (no configurable, lo define
// ChirpStack). Espejo de apps/api/src/adapters/lorawan/lorawan.adapter.service.ts.
type LoRaWANConfig struct {
	Enabled bool `yaml:"enabled"`
	// Ej. "tcp://192.168.70.6:1883".
	BrokerURL string `yaml:"brokerUrl"`
	Username  string `yaml:"username"`
	Password  string `yaml:"password"`
}

// BACnetConfig apunta a un gateway BACnet/IP (ej. una central VRF de aires acondicionados).
// A diferencia de MQTT, BACnet no es un broker central: cada gateway se escucha por separado,
// por eso es una lista.
//
// El agente NO habla BACnet/IP crudo el mismo: probado en vivo contra el gateway real que una
// libreria Go (alexbeltran/gobacnet) no decodifica bien sus respuestas (WhoIs funciona,
// ReadProperty no). En vez de reimplementar el protocolo desde cero sin poder validarlo contra
// hardware real, este driver es un cliente HTTP de apps/bacnet-bridge (el mismo puente Node ya
// construido y verificado que usa la API central) - BridgeURL apunta a esa instancia, que debe
// correr en la misma maquina/red que puede alcanzar el gateway BACnet.
type BACnetConfig struct {
	Enabled bool `yaml:"enabled"`
	// Ej. "http://localhost:3099". El bridge debe estar corriendo aparte (ver apps/bacnet-bridge).
	BridgeURL string `yaml:"bridgeUrl"`
	// Debe matchear BACNET_BRIDGE_TOKEN del bridge, si tiene uno configurado.
	BridgeToken string `yaml:"bridgeToken"`
	// Cada cuantos segundos se relee el valor actual de cada unidad; default 15.
	PollIntervalSeconds int            `yaml:"pollIntervalSeconds"`
	Devices             []BACnetDevice `yaml:"devices"`
}

type BACnetDevice struct {
	// Nombre libre para identificar este gateway en los logs, ej. "AC Smart 5".
	Name string `yaml:"name"`
	// Ej. "10.3.0.11" - la IP del gateway BACnet real (no la del bridge).
	Host string `yaml:"host"`
}

// LoRaGatewayConfig: el agente escucha directo a los gateways LoRa (en el gateway, "Network
// Server" = IP de esta maquina, puertos 1700). Fase actual: solo recepcion (no transmite por radio);
// descifra los sensores que tengan llaves cargadas en keys.
type LoRaGatewayConfig struct {
	Enabled bool `yaml:"enabled"`
	// Direccion UDP de escucha; default ":1700".
	Listen string `yaml:"listen"`
	// Gateway sin PUSH/PULL por mas de este tiempo = desconectado; default 90.
	GatewayTimeoutSeconds int `yaml:"gatewayTimeoutSeconds"`
	// Limite de dispositivos "escuchados sin llaves" que se reportan (puede haber redes vecinas); default 300.
	MaxRadioDevices int `yaml:"maxRadioDevices"`
	// Llaves de los sensores propios. Sin llaves el agente igual registra la trama (DevAddr, RSSI, FCnt).
	Keys []LoRaDeviceKeys `yaml:"keys"`
}

type LoRaDeviceKeys struct {
	Name   string `yaml:"name"`
	Model  string `yaml:"model"`
	DevEUI string `yaml:"devEui"`
	// Sesion activa (ABP, o una sesion OTAA vigente): con esto se valida el MIC y se descifra.
	DevAddr string `yaml:"devAddr"`
	NwkSKey string `yaml:"nwkSKey"`
	AppSKey string `yaml:"appSKey"`
	// OTAA: con la AppKey se valida el join request (y en la fase activa se aceptara el join).
	AppKey string `yaml:"appKey"`
	// Ultimo contador de subida conocido (de la sesion activa). Necesario si el sensor ya paso de
	// 65535 tramas: por radio solo viajan los 16 bits bajos y sin esto el MIC no valida.
	FCntUp uint32 `yaml:"fCntUp"`
	// Atributos libres que se reenvian a Nodivo (area, codigo...).
	Attributes map[string]interface{} `yaml:"attributes"`
}

// EventsConfig controla la deteccion de eventos en el agente (ver internal/events). Los umbrales
// que se omitan usan los defaults de events.Defaults().
type EventsConfig struct {
	// Default true. false = el agente solo reporta lecturas, sin eventos.
	Enabled *bool `yaml:"enabled"`
	// Maximo de eventos guardados mientras la API no responde; default 20000.
	MaxPending int               `yaml:"maxPending"`
	Thresholds events.Thresholds `yaml:"thresholds"`
}

func (e EventsConfig) IsEnabled() bool { return e.Enabled == nil || *e.Enabled }

// ModbusConfig apunta a un servidor Modbus TCP que concentra varios equipos en bloques de
// registros (ej. el EBO AS-P de una sede IGSS, que expone sus ION7400/PM2130/generadores en una
// sola unidad). Solo lectura: el agente nunca escribe registros.
type ModbusConfig struct {
	Enabled bool `yaml:"enabled"`
	// Nombre libre para logs y para el atributo "source" de cada equipo, ej. "EBO-ASP-ESCUINTLA".
	Name string `yaml:"name"`
	Host string `yaml:"host"`
	// Default 502.
	Port int `yaml:"port"`
	// Unit ID / slave ID; default 1.
	UnitID int `yaml:"unitId"`
	// Default 15.
	PollIntervalSeconds int `yaml:"pollIntervalSeconds"`
	// Default 8000.
	TimeoutMs int `yaml:"timeoutMs"`
	// Pausa entre lecturas para no saturar el servidor; default 50.
	ReadDelayMs int            `yaml:"readDelayMs"`
	Devices     []ModbusDevice `yaml:"devices"`
}

// ModbusDevice es un equipo dentro del servidor Modbus: un perfil (que sabe el orden y tipo de
// cada registro) aplicado a partir de un registro inicial.
type ModbusDevice struct {
	// Nombre estable, ej. "ANALIZADOR-1". Es parte del externalId: no lo cambies despues.
	Name string `yaml:"name"`
	// Via AS-P: "ion7400" | "ion7400-b" | "pm2130" | "generator" (modbussource/profiles.go).
	// Directo al medidor: "ion7400-directo" | "pm2130-directo" (modbussource/direct.go); "start" no se usa.
	Profile string `yaml:"profile"`
	// Registro inicial en numeracion del EBO (1-based: el registro 101 es la direccion Modbus 100).
	Start int `yaml:"start"`
	// Registros iniciales alternativos a probar si Start no trae datos validos (como hacia
	// api-SIASA con PM2130-7). Opcional.
	StartCandidates []int `yaml:"startCandidates"`
	// Registros sueltos de 16 bits fuera del bloque (ej. estado S1/S2 del ATS que vigila un ION7400).
	Extra []ModbusExtraRegister `yaml:"extra"`
	// Datos descriptivos que se reenvian tal cual como attributes (area, code, phase, capacityKva, feeds...).
	Attributes map[string]interface{} `yaml:"attributes"`
}

type ModbusExtraRegister struct {
	Key      string `yaml:"key"`
	Register int    `yaml:"register"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no se pudo leer %q: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("config invalida en %q: %w", path, err)
	}

	if cfg.BuildingKey == "" {
		return nil, fmt.Errorf("buildingKey es obligatorio")
	}
	if cfg.API.BaseURL == "" {
		return nil, fmt.Errorf("api.baseUrl es obligatorio")
	}
	if cfg.API.APIKey == "" {
		return nil, fmt.Errorf("api.apiKey es obligatorio")
	}
	if cfg.SyncIntervalSeconds <= 0 {
		cfg.SyncIntervalSeconds = 30
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}
	if cfg.Events.MaxPending <= 0 {
		cfg.Events.MaxPending = 20000
	}
	if err := cfg.Protocols.Normalize(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Normalize completa defaults y valida. Se usa igual para config.yaml y para la config remota.
func (p *Protocols) Normalize() error {
	if p.Modbus != nil {
		p.ModbusServers = append([]ModbusConfig{*p.Modbus}, p.ModbusServers...)
		p.Modbus = nil
	}
	if p.MQTT != nil {
		if p.MQTT.BaseTopic == "" {
			p.MQTT.BaseTopic = "zigbee2mqtt"
		}
		if p.MQTT.Enabled && p.MQTT.BrokerURL == "" {
			return fmt.Errorf("mqtt.brokerUrl es obligatorio")
		}
	}
	if g := p.Gestion; g != nil && g.Enabled {
		if g.MQTT != nil && g.MQTT.BrokerURL == "" {
			return fmt.Errorf("gestion.mqtt.brokerUrl es obligatorio")
		}
		if g.LoRaWAN != nil && g.LoRaWAN.BrokerURL == "" {
			return fmt.Errorf("gestion.lorawan.brokerUrl es obligatorio")
		}
	}
	if p.LoRaWAN != nil && p.LoRaWAN.Enabled && p.LoRaWAN.BrokerURL == "" {
		return fmt.Errorf("lorawan.brokerUrl es obligatorio")
	}
	if b := p.BACnet; b != nil {
		if b.PollIntervalSeconds <= 0 {
			b.PollIntervalSeconds = 15
		}
		if b.Enabled && b.BridgeURL == "" {
			return fmt.Errorf("bacnet.bridgeUrl es obligatorio")
		}
	}
	if g := p.LoRaGateway; g != nil {
		if g.Listen == "" {
			g.Listen = ":1700"
		}
		if g.GatewayTimeoutSeconds <= 0 {
			g.GatewayTimeoutSeconds = 90
		}
		if g.MaxRadioDevices <= 0 {
			g.MaxRadioDevices = 300
		}
	}
	for i := range p.ModbusServers {
		m := &p.ModbusServers[i]
		if m.Port <= 0 {
			m.Port = 502
		}
		if m.UnitID <= 0 {
			m.UnitID = 1
		}
		if m.PollIntervalSeconds <= 0 {
			m.PollIntervalSeconds = 15
		}
		if m.TimeoutMs <= 0 {
			m.TimeoutMs = 8000
		}
		if m.ReadDelayMs < 0 {
			m.ReadDelayMs = 0
		} else if m.ReadDelayMs == 0 {
			m.ReadDelayMs = 50
		}
		if m.Name == "" {
			m.Name = m.Host
		}
		if m.Enabled && m.Host == "" {
			return fmt.Errorf("modbusServers[%d].host es obligatorio", i)
		}
	}
	return nil
}

// ProtocolsFromJSON lee la config remota (JSON con las mismas claves que config.yaml). Pasa por
// YAML a proposito: asi los nombres de campo son exactamente los tags yaml de este archivo, sin
// mantener un segundo juego de tags json.
func ProtocolsFromJSON(data []byte) (Protocols, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Protocols{}, fmt.Errorf("config remota invalida: %w", err)
	}
	y, err := yaml.Marshal(raw)
	if err != nil {
		return Protocols{}, err
	}
	var p Protocols
	dec := yaml.NewDecoder(strings.NewReader(string(y)))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		return Protocols{}, fmt.Errorf("config remota invalida: %w", err)
	}
	if err := p.Normalize(); err != nil {
		return Protocols{}, err
	}
	return p, nil
}

// ToJSON es la inversa de ProtocolsFromJSON (para subir config.yaml como version 1).
func (p Protocols) ToJSON() ([]byte, error) {
	y, err := yaml.Marshal(p)
	if err != nil {
		return nil, err
	}
	var raw map[string]interface{}
	if err := yaml.Unmarshal(y, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		raw = map[string]interface{}{}
	}
	return json.Marshal(raw)
}

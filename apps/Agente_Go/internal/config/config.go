// Package config carga config.yaml: un archivo por edificio, con las credenciales de la API
// central y que fuentes de protocolo estan habilitadas en esa red.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"agente-go/internal/events"
)

type Config struct {
	// Identifica de que edificio/sitio viene cada sync (ver Device.metadata.agent.buildingKey
	// en la API). Debe ser estable: cambiarlo hace que la API trate todos los dispositivos
	// como nuevos otra vez.
	BuildingKey string `yaml:"buildingKey"`

	API APIConfig `yaml:"api"`

	// Cada driver de protocolo es opcional; el agente arranca solo los que tengan enabled: true.
	MQTT    *MQTTConfig    `yaml:"mqtt"`
	LoRaWAN *LoRaWANConfig `yaml:"lorawan"`
	BACnet  *BACnetConfig  `yaml:"bacnet"`
	Modbus  *ModbusConfig  `yaml:"modbus"`
	// Receptor directo de gateways LoRa (protocolo Semtech UDP, puerto 1700): sin ChirpStack.
	LoRaGateway *LoRaGatewayConfig `yaml:"loraGateway"`

	// Carpeta donde el agente guarda eventos pendientes de enviar y el estado de las alarmas
	// (sobrevive reinicios y caidas de la API). Default "./data".
	DataDir string `yaml:"dataDir"`

	Events EventsConfig `yaml:"events"`

	// Cada cuantos segundos se reenvia el snapshot completo conocido a la API (no es
	// "cada cuanto se detectan cambios": eso es inmediato via MQTT/BACnet; esto es el
	// intervalo del resync completo, que sirve tambien como heartbeat).
	SyncIntervalSeconds int `yaml:"syncIntervalSeconds"`
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
	// "ion7400" | "ion7400-b" | "pm2130" | "generator" (ver modbussource/profiles.go).
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
	if cfg.MQTT != nil && cfg.MQTT.BaseTopic == "" {
		cfg.MQTT.BaseTopic = "zigbee2mqtt"
	}
	if cfg.BACnet != nil && cfg.BACnet.PollIntervalSeconds <= 0 {
		cfg.BACnet.PollIntervalSeconds = 15
	}
	if g := cfg.LoRaGateway; g != nil {
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
	if m := cfg.Modbus; m != nil {
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
			return nil, fmt.Errorf("modbus.host es obligatorio")
		}
	}

	return &cfg, nil
}

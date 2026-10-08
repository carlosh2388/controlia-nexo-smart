// Package config carga config.yaml: un archivo por edificio, con las credenciales de la API
// central y que fuentes de protocolo estan habilitadas en esa red.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
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
	if cfg.MQTT != nil && cfg.MQTT.BaseTopic == "" {
		cfg.MQTT.BaseTopic = "zigbee2mqtt"
	}
	if cfg.BACnet != nil && cfg.BACnet.PollIntervalSeconds <= 0 {
		cfg.BACnet.PollIntervalSeconds = 15
	}

	return &cfg, nil
}

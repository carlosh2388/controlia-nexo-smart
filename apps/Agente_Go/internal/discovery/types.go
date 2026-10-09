// Package discovery define el contrato comun que cualquier protocolo (mqtt, bacnet, ...)
// tiene que cumplir para que el agente lo pueda sincronizar contra la API central.
package discovery

// MqttJson replica apps/api/src/devices/dto/mqtt-json-config.dto.ts: como extraer el estado de un
// payload JSON y que mandar al topic de comando para encender/apagar.
type MqttJson struct {
	StatePath  string                 `json:"statePath,omitempty"`
	OnPayload  map[string]interface{} `json:"onPayload,omitempty"`
	OffPayload map[string]interface{} `json:"offPayload,omitempty"`
}

// Device es un dispositivo tal como lo va a recibir POST /devices/agent-sync en la API
// (ver apps/api/src/devices/dto/agent-sync.dto.ts) - los tags json coinciden a proposito
// con los nombres de esos campos.
//
// StateTopic/CommandTopic/MqttJson son OPCIONALES y solo tienen sentido para protocol="mqtt":
// si un source los completa (ver mqttsource), el dispositivo queda realmente controlable desde
// el panel apenas se confirma (la API lo registra en su propio adaptador MQTT en proceso, el mismo
// que ya usa "Sin Home Assistant (MQTT directo)") en vez de quedar en "solo lectura" para siempre.
// Esto solo funciona si la API central y este agente apuntan al MISMO broker - ver docs/agente-go.md.
type Device struct {
	ExternalID  string                 `json:"externalId"`
	Name        string                 `json:"name"`
	Protocol    string                 `json:"protocol"` // "mqtt" | "http" | "bacnet" | "lorawan" | "ewelink"
	Kind        string                 `json:"kind"`     // "switch" | "sensor" | "climate"
	State       string                 `json:"state,omitempty"`
	Readings    map[string]interface{} `json:"readings,omitempty"`
	StateTopic  string                 `json:"stateTopic,omitempty"`
	CommandTopic string                `json:"commandTopic,omitempty"`
	MqttJson    *MqttJson              `json:"mqttJson,omitempty"`
	// Model es el perfil/modelo del equipo ("ION7400", "PM2130", "generator", o el
	// deviceProfileName de ChirpStack). La pestaña Sedes elige la tarjeta con esto.
	Model string `json:"model,omitempty"`
	// Attributes son datos descriptivos fijos (area, codigo, fase, capacidad, RSSI/SNR...).
	Attributes map[string]interface{} `json:"attributes,omitempty"`
}

// Source es lo que implementa cada driver de protocolo (mqttsource, bacnetsource, ...).
// onUpdate se llama cada vez que ese source tiene un snapshot nuevo de SUS dispositivos
// (no hace falta que sea incremental: el agente combina snapshots de todas las fuentes
// por ExternalID, asi que mandar la lista completa conocida en cada llamada es valido
// y mas simple de implementar que trackear diffs).
type Source interface {
	Name() string
	Start(onUpdate func([]Device)) error
	Stop()
}

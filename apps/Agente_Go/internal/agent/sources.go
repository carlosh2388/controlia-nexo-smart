package agent

import (
	"encoding/json"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
	"agente-go/internal/discovery/bacnetsource"
	"agente-go/internal/discovery/gatewaysource"
	"agente-go/internal/discovery/lorawansource"
	"agente-go/internal/discovery/modbussource"
	"agente-go/internal/discovery/mqttsource"
	"agente-go/internal/gestion"
)

// Secciones de la config que se arrancan y reinician por separado: si en la web solo cambia el
// puerto Modbus, el receptor LoRa y los brokers MQTT siguen corriendo sin cortes.
var sectionNames = []string{"mqtt", "lorawan", "bacnet", "modbus", "loraGateway", "gestion"}

// sectionKey es lo que se compara para saber si una seccion cambio entre dos versiones de config.
func sectionKey(p config.Protocols, name string) string {
	var v interface{}
	switch name {
	case "mqtt":
		v = p.MQTT
	case "lorawan":
		v = p.LoRaWAN
	case "bacnet":
		v = p.BACnet
	case "modbus":
		v = p.ModbusServers
	case "loraGateway":
		v = p.LoRaGateway
	case "gestion":
		v = p.Gestion
	}
	data, _ := json.Marshal(v)
	return string(data)
}

// buildSection crea (sin arrancar) las fuentes habilitadas de una seccion.
// Fase 4 (adaptadores HTTP por fabricante): se agrega aca del mismo modo, como su propio
// discovery.Source - ver docs/agente-go.md "Como agregar un protocolo nuevo".
func buildSection(p config.Protocols, name string, env gestion.Entorno) ([]discovery.Source, error) {
	var out []discovery.Source
	switch name {
	case "gestion":
		if p.Gestion != nil && p.Gestion.Enabled {
			out = append(out, gestion.New(*p.Gestion, env))
		}
	case "mqtt":
		if p.MQTT != nil && p.MQTT.Enabled {
			out = append(out, mqttsource.New(*p.MQTT))
		}
	case "lorawan":
		if p.LoRaWAN != nil && p.LoRaWAN.Enabled {
			out = append(out, lorawansource.New(*p.LoRaWAN))
		}
	case "bacnet":
		if p.BACnet != nil && p.BACnet.Enabled {
			for _, dev := range p.BACnet.Devices {
				out = append(out, bacnetsource.New(*p.BACnet, dev))
			}
		}
	case "modbus":
		for _, m := range p.ModbusServers {
			if m.Enabled {
				out = append(out, modbussource.New(m))
			}
		}
	case "loraGateway":
		if p.LoRaGateway != nil && p.LoRaGateway.Enabled {
			gw, err := gatewaysource.New(*p.LoRaGateway)
			if err != nil {
				return nil, err
			}
			out = append(out, gw)
		}
	}
	return out, nil
}

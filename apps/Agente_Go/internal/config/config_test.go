package config

import (
	"testing"
)

// La config remota viaja como JSON con las mismas claves que config.yaml; ida y vuelta no debe
// perder nada (puertos, unit IDs, perfiles Modbus, atributos).
func TestProtocolsJSONRoundTrip(t *testing.T) {
	in := Protocols{
		Modbus: &ModbusConfig{
			Enabled: true, Name: "EBO", Host: "10.0.6.26", Port: 502, UnitID: 1,
			Devices: []ModbusDevice{{Name: "ANALIZADOR-1", Profile: "ion7400", Start: 101, StartCandidates: []int{201},
				Attributes: map[string]interface{}{"area": "Tablero principal"}}},
		},
		BACnet:      &BACnetConfig{Enabled: true, BridgeURL: "http://localhost:3099", Devices: []BACnetDevice{{Name: "AC", Host: "10.3.0.11"}}},
		LoRaGateway: &LoRaGatewayConfig{Enabled: true, Listen: ":1701"},
		Discovery:   map[string]interface{}{"modbus": map[string]interface{}{"targets": []interface{}{"10.0.6.0/24"}}},
	}
	if err := in.Normalize(); err != nil {
		t.Fatal(err)
	}
	data, err := in.ToJSON()
	if err != nil {
		t.Fatal(err)
	}
	out, err := ProtocolsFromJSON(data)
	if err != nil {
		t.Fatalf("%v\n%s", err, data)
	}

	if out.Modbus != nil || len(out.ModbusServers) != 1 {
		t.Fatalf("modbus: se esperaba 1 servidor en modbusServers, got %+v", out.ModbusServers)
	}
	m := out.ModbusServers[0]
	if m.Host != "10.0.6.26" || m.Port != 502 || m.UnitID != 1 || m.PollIntervalSeconds != 15 {
		t.Errorf("servidor modbus: %+v", m)
	}
	if len(m.Devices) != 1 || m.Devices[0].Start != 101 || m.Devices[0].StartCandidates[0] != 201 ||
		m.Devices[0].Attributes["area"] != "Tablero principal" {
		t.Errorf("equipos modbus: %+v", m.Devices)
	}
	if out.BACnet == nil || out.BACnet.Devices[0].Host != "10.3.0.11" {
		t.Errorf("bacnet: %+v", out.BACnet)
	}
	if out.LoRaGateway == nil || out.LoRaGateway.Listen != ":1701" {
		t.Errorf("loraGateway: %+v", out.LoRaGateway)
	}
	if out.Discovery["modbus"] == nil {
		t.Errorf("discovery se perdio: %+v", out.Discovery)
	}
}

func TestProtocolsFromJSONRejectsInvalid(t *testing.T) {
	for _, bad := range []string{
		`{"modbusServers":[{"enabled":true,"port":502}]}`,           // sin host
		`{"mqtt":{"enabled":true}}`,                                // sin broker
		`{"modbusServers":[{"enabled":true,"host":"x","prot":502}]}`, // campo mal escrito
	} {
		if _, err := ProtocolsFromJSON([]byte(bad)); err == nil {
			t.Errorf("%s deberia ser invalido", bad)
		}
	}
}

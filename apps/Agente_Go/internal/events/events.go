// Package events detecta eventos en el borde (en el propio Agente_Go), comparando cada lectura nueva
// con la anterior del mismo equipo: transferencias del ATS, arranque/paro de generador, alarmas por
// umbral (con su "normalizado"), puertas, sensores sin comunicacion, sede LoRaWAN en silencio.
//
// Por que en el agente y no en la API: el agente ve TODAS las lecturas en tiempo real (Modbus cada
// 15 s, cada uplink LoRaWAN), mientras que a la API solo le llega un snapshot por sync y el
// historial se guarda como mucho una vez por minuto - una puerta que se abre y se cierra en 20 s, o
// una transferencia corta del ATS, solo se ve aca.
//
// Las alarmas tienen estado (activa / normalizada): se emite un evento al entrar en condicion y
// otro al salir, nunca uno por lectura. Ese estado y los eventos pendientes de enviar se guardan
// en disco (ver store.go), asi que reiniciar el agente no duplica alarmas ni pierde eventos.
package events

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

type Severity string

const (
	Info     Severity = "info"
	Warning  Severity = "warning"
	Critical Severity = "critical"
)

// Event replica apps/api/src/site-events/dto/site-event.dto.ts (AgentEventDto).
type Event struct {
	ID         string                 `json:"id"`
	ExternalID string                 `json:"externalId,omitempty"`
	Type       string                 `json:"type"`
	Severity   Severity               `json:"severity"`
	Message    string                 `json:"message"`
	Value      *float64               `json:"value,omitempty"`
	Data       map[string]interface{} `json:"data,omitempty"`
	OccurredAt time.Time              `json:"occurredAt"`
}

func newID(now time.Time) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%d-%s", now.UnixMilli(), hex.EncodeToString(b))
}

func ptr(v float64) *float64 { return &v }

// Thresholds son los umbrales de las alarmas. Todos tienen default (ver Defaults) y se pueden
// cambiar por sede en config.yaml, seccion events.
type Thresholds struct {
	NominalVoltage       float64 `yaml:"nominalVoltage"`
	VoltageTolerancePct  float64 `yaml:"voltageTolerancePct"`
	FrequencyMin         float64 `yaml:"frequencyMin"`
	FrequencyMax         float64 `yaml:"frequencyMax"`
	ThdVoltageMaxPct     float64 `yaml:"thdVoltageMaxPct"`
	OverloadPct          float64 `yaml:"overloadPct"`
	PhaseLossPct         float64 `yaml:"phaseLossPct"`
	GeneratorRunningRPM  float64 `yaml:"generatorRunningRpm"`
	GeneratorFuelMinPct  float64 `yaml:"generatorFuelMinPct"`
	GeneratorBatteryMinV float64 `yaml:"generatorBatteryMinV"`
	GeneratorCoolantMaxC float64 `yaml:"generatorCoolantMaxC"`
	Co2MaxPpm            float64 `yaml:"co2MaxPpm"`
	BatteryMinPct        float64 `yaml:"batteryMinPct"`
	DoorOpenMaxMinutes   float64 `yaml:"doorOpenMaxMinutes"`
	SensorStaleMinutes   float64 `yaml:"sensorStaleMinutes"`
	SiteSilentMinutes    float64 `yaml:"siteSilentMinutes"`
	// Umbrales de temperatura por defecto para sensores sin tag_threshold_min/max en ChirpStack.
	// 0/0 = no alarmar por temperatura salvo que el sensor traiga sus propios umbrales (hay
	// sensores de cadena de frio a 2-8 °C y salas a 18-26 °C en la misma sede).
	TemperatureMin float64 `yaml:"temperatureMin"`
	TemperatureMax float64 `yaml:"temperatureMax"`
}

func Defaults() Thresholds {
	return Thresholds{
		NominalVoltage:       120,
		VoltageTolerancePct:  10,
		FrequencyMin:         59.5,
		FrequencyMax:         60.5,
		ThdVoltageMaxPct:     8, // IEEE 519, sistemas < 1 kV
		OverloadPct:          80,
		PhaseLossPct:         50,
		GeneratorRunningRPM:  100,
		GeneratorFuelMinPct:  25,
		GeneratorBatteryMinV: 24,
		GeneratorCoolantMaxC: 95,
		Co2MaxPpm:            1000,
		BatteryMinPct:        20,
		DoorOpenMaxMinutes:   10,
		SensorStaleMinutes:   60,
		SiteSilentMinutes:    15,
	}
}

// Merge completa con defaults los campos que vengan en 0 desde config.yaml.
func (t Thresholds) Merge() Thresholds {
	d := Defaults()
	pick := func(v, def float64) float64 {
		if v == 0 {
			return def
		}
		return v
	}
	return Thresholds{
		NominalVoltage:       pick(t.NominalVoltage, d.NominalVoltage),
		VoltageTolerancePct:  pick(t.VoltageTolerancePct, d.VoltageTolerancePct),
		FrequencyMin:         pick(t.FrequencyMin, d.FrequencyMin),
		FrequencyMax:         pick(t.FrequencyMax, d.FrequencyMax),
		ThdVoltageMaxPct:     pick(t.ThdVoltageMaxPct, d.ThdVoltageMaxPct),
		OverloadPct:          pick(t.OverloadPct, d.OverloadPct),
		PhaseLossPct:         pick(t.PhaseLossPct, d.PhaseLossPct),
		GeneratorRunningRPM:  pick(t.GeneratorRunningRPM, d.GeneratorRunningRPM),
		GeneratorFuelMinPct:  pick(t.GeneratorFuelMinPct, d.GeneratorFuelMinPct),
		GeneratorBatteryMinV: pick(t.GeneratorBatteryMinV, d.GeneratorBatteryMinV),
		GeneratorCoolantMaxC: pick(t.GeneratorCoolantMaxC, d.GeneratorCoolantMaxC),
		Co2MaxPpm:            pick(t.Co2MaxPpm, d.Co2MaxPpm),
		BatteryMinPct:        pick(t.BatteryMinPct, d.BatteryMinPct),
		DoorOpenMaxMinutes:   pick(t.DoorOpenMaxMinutes, d.DoorOpenMaxMinutes),
		SensorStaleMinutes:   pick(t.SensorStaleMinutes, d.SensorStaleMinutes),
		SiteSilentMinutes:    pick(t.SiteSilentMinutes, d.SiteSilentMinutes),
		TemperatureMin:       t.TemperatureMin,
		TemperatureMax:       t.TemperatureMax,
	}
}

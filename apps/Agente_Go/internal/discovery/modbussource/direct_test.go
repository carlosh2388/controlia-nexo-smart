package modbussource

import (
	"math"
	"testing"
)

// Valores reales leidos el 09/11/2026 de ANALIZADOR-1 (10.0.6.9, ID 21) y PM2130-1 (10.0.6.18, ID 2).
func putF32(regs map[int]uint16, register int, v float32) {
	hi, lo := f32Regs(v, false)
	regs[register-1], regs[register] = hi, lo
}

func TestDecodeDirectIon7400(t *testing.T) {
	regs := map[int]uint16{}
	putF32(regs, 3000, 400.235)              // A
	putF32(regs, 3028, 125.156)              // V
	putF32(regs, 3060, 145147.0)             // W -> kW
	putF32(regs, 3110, 59.959)               // Hz
	putF32(regs, 3150, -0.977)               // FP
	putF32(regs, 21300, 0.055)               // fraccion -> %
	putF32(regs, 30112, 212395.6)            // VA -> kVA
	putF32(regs, 30464, float32(math.NaN())) // no aplica: se omite
	regs[413-1] = 4798                       // contador S1 (16 bit)
	got := decodeDirect(directProfiles["ion7400-directo"], regs)
	want := map[string]float64{
		"current_a": 400.235, "voltage_a_n": 125.156, "active_power_total": 145.147, "frequency": 59.959,
		"power_factor_total": -0.977, "thd_current_a_high": 5.5, "apparent_power_total_peak_demand": 212.396,
		"s1_commercial_transition_count": 4798,
	}
	for k, w := range want {
		if math.Abs(got[k]-w) > 0.002 {
			t.Errorf("%s = %v, se esperaba %v", k, got[k], w)
		}
	}
	if _, ok := got["apparent_power_del_b_peak_demand"]; ok {
		t.Errorf("un NaN no debe reportarse")
	}
	if _, ok := got["current_b"]; ok {
		t.Errorf("un registro no leido no debe reportarse")
	}
	if !directProfiles["ion7400-directo"].Validate(got) {
		t.Errorf("deberia validar")
	}
}

func TestDecodeDirectPm2130EnergyAndMissingPhase(t *testing.T) {
	regs := map[int]uint16{}
	putF32(regs, 3028, 122.081)
	putF32(regs, 3032, float32(math.NaN())) // fase C inexistente
	putF32(regs, 3020, 215.922)
	putF32(regs, 3110, 59.981)
	putF32(regs, 3060, 3.953) // ya en kW
	// 17435894 Wh = 0x00000000_010A0CF6 en int64 ABCD
	regs[3203], regs[3204], regs[3205], regs[3206] = 0, 0, 0x010A, 0x0CF6
	got := decodeDirect(directProfiles["pm2130-directo"], regs)
	if math.Abs(got["energy_active_kwh"]-17435.894) > 0.001 {
		t.Errorf("energia = %v, se esperaba 17435.894 kWh", got["energy_active_kwh"])
	}
	if math.Abs(got["active_power_total"]-3.953) > 0.001 {
		t.Errorf("potencia = %v", got["active_power_total"])
	}
	if _, ok := got["voltage_c_n"]; ok {
		t.Errorf("la fase C en NaN no debe reportarse como 0")
	}
	if !directProfiles["pm2130-directo"].Validate(got) {
		t.Errorf("deberia validar")
	}
}

// Bloque real del generador de planta (10.0.6.9, ID 2, direccion 4769, 38 registros) del
// 10/11/2026, motor en espera.
func TestDecodeDirectGenerator(t *testing.T) {
	raw := []uint16{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16256, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 106, 0, 0, 0, 274, 0, 0, 0}
	regs := map[int]uint16{}
	for i, v := range raw {
		regs[4769+i] = v
	}
	p := directProfiles["generador-directo"]
	got := decodeDirect(p, regs)
	want := map[string]float64{"coolant_temp_metering": 10.6, "battery_voltage_metering": 27.4, "power_factor_metering": 1, "engine_speed_metering": 0, "fuel_level_metering": 0}
	for k, w := range want {
		if math.Abs(got[k]-w) > 1e-9 {
			t.Errorf("%s = %v, se esperaba %v", k, got[k], w)
		}
	}
	if len(got) != 19 {
		t.Errorf("se esperaban 19 puntos, llegaron %d", len(got))
	}
	if !p.Validate(got) {
		t.Error("el bloque real no pasa la validacion del generador")
	}
}
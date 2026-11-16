package lorawansource

import "testing"

func TestAddScaledChannelsColdChain(t *testing.T) {
	r := map[string]interface{}{"ai0_value": 11.1273, "ai1_value": 15.1164, "ai2_value": 10.0}
	tags := map[string]string{
		"ai0_type": "temperature", "ai0_multiplier": "9.5147", "ai0_offset": "-138.45",
		"ai1_type": "temperature", "ai1_multiplier": "9.5147", "ai1_offset": "-138.45",
		// ai2 sin tags: no se convierte.
	}
	addScaledChannels(r, tags)
	if v := r["ai0_temperature"].(float64); v < -32.7 || v > -32.5 {
		t.Errorf("ai0_temperature = %v, se esperaba ~-32.58 (ultracongelador)", v)
	}
	if v := r["ai1_temperature"].(float64); v < 5.3 || v > 5.5 {
		t.Errorf("ai1_temperature = %v, se esperaba ~5.38 (refrigerador)", v)
	}
	if _, ok := r["ai2_temperature"]; ok {
		t.Errorf("un canal sin tags no debe convertirse")
	}
}

// Formulas reales de Escuintla (docs/formulas-4-20ma.md): bombeo 9.375(X) - 37.5 PSI y calentador
// 12.893(X) - 48.111 °C. Como su tipo no es "temperature" van a aiN_scaled, no a cadena de frio.
func TestAddScaledChannelsPressureAndHeater(t *testing.T) {
	r := map[string]interface{}{"ai0_value": 5.8284}
	addScaledChannels(r, map[string]string{"ai0_type": "water_pressure", "ai0_multiplier": "9.375", "ai0_offset": "-37.5"})
	if v := r["ai0_scaled"].(float64); v != 17.14 {
		t.Errorf("bombeo ai0_scaled = %v, se esperaba 17.14 PSI", v)
	}
	h := map[string]interface{}{"ai0_value": 8.0}
	addScaledChannels(h, map[string]string{"ai0_type": "water_heater_temperature", "ai0_multiplier": "12.893", "ai0_offset": "-48.111"})
	if v := h["ai0_scaled"].(float64); v != 55.03 {
		t.Errorf("calentador ai0_scaled = %v, se esperaba 55.03 °C", v)
	}
	if _, ok := h["ai0_temperature"]; ok {
		t.Errorf("un calentador no debe quedar como temperatura de cadena de frio")
	}
}

// Trama de solo entrada digital del WISE (total_length=145) despues de una con analogicas: deben
// conservarse los valores analogicos anteriores.
func TestMergeReadingsKeepsAnalogFromPreviousFrame(t *testing.T) {
	prev := map[string]interface{}{"ai0_value": 5.8, "ai0_scaled": 17.14, "di0_mode": 2.0}
	next := map[string]interface{}{"di0_mode": 0.0, "total_length": 145.0}
	got := mergeReadings(prev, next)
	if got["ai0_scaled"] != 17.14 || got["di0_mode"] != 0.0 || got["total_length"] != 145.0 {
		t.Errorf("merge incorrecto: %v", got)
	}
}

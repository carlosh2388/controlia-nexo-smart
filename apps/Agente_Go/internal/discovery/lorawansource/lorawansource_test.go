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

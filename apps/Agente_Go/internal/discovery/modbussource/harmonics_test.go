package modbussource

import (
	"math"
	"testing"

	"agente-go/internal/config"
)

// Valores reales de ANALIZADOR-1 (13/11/2026): voltaje A-N y corriente A, H1-H5.
func TestReadHarmonicsIon7400(t *testing.T) {
	regs := map[int]uint16{}
	h := ionHarmonics
	for _, ch := range h.Channels {
		for a := ch.Start - 1; a < ch.Start-1+h.Orders*h.Stride; a++ {
			regs[a] = 0
		}
	}
	put := func(start, order int, v float32) { putFloat(regs, start-1+(order-1)*h.Stride, v) }
	put(22878, 1, 123.647)
	put(22878, 3, 6.370)
	put(22878, 5, 3.138)
	put(22878, 63, 0.008)
	put(24430, 1, 381.960)
	put(24430, 5, 21.407)
	putFloat(regs, 22878-1+2, -9.153) // angulo del H1: no se debe tomar como otro armonico
	nanHi, nanLo := f32Regs(float32(math.NaN()), false)
	regs[23266-1], regs[23266] = nanHi, nanLo // canal B-N: H1 NaN = no aplica

	host, port := simulador(t, regs, 125)
	s := New(config.ModbusConfig{Host: host, Port: port, UnitID: 21, TimeoutMs: 2000})
	defer s.client.close()
	got, err := s.readHarmonics(h, map[string]int{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{
		"harm_v_a_01": 123.647, "harm_v_a_03": 6.37, "harm_v_a_05": 3.138, "harm_v_a_63": 0.008, "harm_v_a_02": 0,
		"harm_i_a_01": 381.96, "harm_i_a_05": 21.407,
	}
	for k, v := range want {
		if math.Abs(got[k]-v) > 1e-3 {
			t.Errorf("%s = %v, se esperaba %v", k, got[k], v)
		}
	}
	if _, ok := got["harm_v_b_01"]; ok {
		t.Errorf("harm_v_b_01 es NaN y no se debe reportar")
	}
	if n := len(got); n != 6*63-1 {
		t.Errorf("se esperaban %d valores, llegaron %d", 6*63-1, n)
	}
}

// Como ANALIZADOR-5: armonicos solo hasta el 31; desde el 32 el medidor responde excepcion 2.
func TestReadHarmonicsHasta31(t *testing.T) {
	regs := map[int]uint16{}
	h := ionHarmonics
	for _, ch := range h.Channels {
		for a := ch.Start - 1; a < ch.Start-1+30*h.Stride+2; a++ { // H1..H31 (H31 = 2 registros)
			regs[a] = 0
		}
		putFloat(regs, ch.Start-1, 120)
		putFloat(regs, ch.Start-1+30*h.Stride, 0.25) // H31
	}
	host, port := simulador(t, regs, 125)
	s := New(config.ModbusConfig{Host: host, Port: port, UnitID: 255, TimeoutMs: 2000})
	defer s.client.close()
	limits := map[string]int{}
	got, err := s.readHarmonics(h, limits)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(got); n != 6*31 {
		t.Errorf("se esperaban %d valores (6 canales x 31), llegaron %d", 6*31, n)
	}
	if got["harm_i_c_31"] != 0.25 {
		t.Errorf("harm_i_c_31 = %v", got["harm_i_c_31"])
	}
	for _, ch := range h.Channels {
		if limits[ch.Key] != 31 {
			t.Errorf("limite de %s = %d, se esperaba 31", ch.Key, limits[ch.Key])
		}
	}
	// Segunda lectura: ya no pregunta por H32+ (mismos datos, sin errores).
	again, err := s.readHarmonics(h, limits)
	if err != nil || len(again) != 6*31 {
		t.Errorf("segunda lectura: %d valores, error %v", len(again), err)
	}
}

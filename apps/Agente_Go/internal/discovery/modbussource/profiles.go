package modbussource

import (
	"math"
)

// Perfiles por modelo de equipo. Cada perfil dice, a partir del registro inicial de un bloque,
// que metrica hay en cada offset y como decodificarla. Todo se tomo del lector que ya funciona en
// produccion para las sedes IGSS (api-SIASA/modbus_cliente/lectura_Ebo_v2.js), no de un manual:
//   - registro N del EBO = direccion Modbus N-1;
//   - ION7400 y PM2130: float32, orden ABCD con respaldo CDAB si el valor sale 0/invalido;
//   - THD y flicker del ION7400: el EBO los entrega con escala variable, se elige la escala que
//     cae en un rango razonable (pickIon7400ByUnit en el original);
//   - generador: int32/uint32 en orden CDAB (respaldo ABCD) y uint16, con escala 0.01.
// Las claves de las metricas son las mismas que usa api-SIASA, para no romper nada que ya las lea.

type fieldType int

const (
	typeFloat32 fieldType = iota
	typeInt32
	typeUint32
	typeUint16
	// typeRaw16: registro de estado/contador, se reporta el valor crudo del primer registro.
	typeRaw16
)

type scaleHeuristic int

const (
	heuristicNone scaleHeuristic = iota
	heuristicPercent
	heuristicPst
)

type field struct {
	Key       string
	Unit      string
	Type      fieldType
	Scale     float64
	Offset    int
	Heuristic scaleHeuristic
}

type profile struct {
	Name     string
	Model    string
	Category string
	// Cantidad de registros a leer desde el inicio del bloque.
	Length   int
	Fields   []field
	Validate func(values map[string]float64) bool
}

func f32(key, unit string, index int) field {
	return field{Key: key, Unit: unit, Type: typeFloat32, Scale: 1, Offset: index * 2}
}

func f32Scaled(key, unit string, index int, h scaleHeuristic) field {
	f := f32(key, unit, index)
	f.Heuristic = h
	return f
}

// Indices 0-19, comunes a los dos layouts de ION7400 del EBO.
var ionBaseFields = []field{
	f32("active_power_a", "kW", 0),
	f32("active_power_b", "kW", 1),
	f32("active_power_c", "kW", 2),
	f32("active_power_total", "kW", 3),
	f32("apparent_power_a", "kVA", 4),
	f32("apparent_power_b", "kVA", 5),
	f32("apparent_power_c", "kVA", 6),
	f32("apparent_power_del_a_peak_demand", "kVA", 7),
	f32("apparent_power_del_b_peak_demand", "kVA", 8),
	f32("apparent_power_del_c_peak_demand", "kVA", 9),
	f32("apparent_power_total", "kVA", 10),
	f32("apparent_power_total_peak_demand", "kVA", 11),
	f32("current_a", "A", 12),
	f32("current_b", "A", 13),
	f32("current_c", "A", 14),
	f32("power_factor_total", "pf", 15),
	f32("frequency", "Hz", 16),
	f32("power_factor_a", "pf", 17),
	f32("power_factor_b", "pf", 18),
	f32("power_factor_c", "pf", 19),
}

// Calidad de energia + voltajes, en el orden en que el EBO los publica.
func ionQualityFields(firstIndex int) []field {
	i := firstIndex
	return []field{
		f32Scaled("short_term_flicker_pst_a_n", "Pst", i+0, heuristicPst),
		f32Scaled("short_term_flicker_pst_b_n", "Pst", i+1, heuristicPst),
		f32Scaled("short_term_flicker_pst_c_n", "Pst", i+2, heuristicPst),
		f32Scaled("thd_current_a_high", "%", i+3, heuristicPercent),
		f32Scaled("thd_current_b_high", "%", i+4, heuristicPercent),
		f32Scaled("thd_current_c_high", "%", i+5, heuristicPercent),
		f32Scaled("thd_voltage_v1_high", "%", i+6, heuristicPercent),
		f32Scaled("thd_voltage_v2_high", "%", i+7, heuristicPercent),
		f32Scaled("thd_voltage_v3_high", "%", i+8, heuristicPercent),
		f32("voltage_a_b", "V", i+9),
		f32("voltage_a_n", "V", i+10),
		f32("voltage_b_c", "V", i+11),
		f32("voltage_b_n", "V", i+12),
		f32("voltage_c_a", "V", i+13),
		f32("voltage_c_n", "V", i+14),
	}
}

func concat(parts ...[]field) []field {
	out := []field{}
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func validIon(v map[string]float64) bool {
	if hz := v["frequency"]; hz >= 40 && hz <= 80 {
		return true
	}
	for _, k := range []string{"active_power_total", "current_a", "voltage_a_n", "voltage_a_b"} {
		if v[k] != 0 {
			return true
		}
	}
	return false
}

// validPm2130 replica isLikelyPm2130Metrics de api-SIASA.
func validPm2130(v map[string]float64) bool {
	phase := false
	for _, k := range []string{"voltage_a_n", "voltage_b_n", "voltage_c_n"} {
		if x := v[k]; x >= 50 && x <= 300 {
			phase = true
		}
	}
	line := false
	for _, k := range []string{"voltage_a_b", "voltage_b_c", "voltage_c_a"} {
		if x := v[k]; x >= 80 && x <= 500 {
			line = true
		}
	}
	hz := v["frequency"]
	return (phase || line) && hz >= 40 && hz <= 80
}

func validGenerator(v map[string]float64) bool {
	// En espera el motor reporta 0 en casi todo, pero la bateria del arranque siempre tiene voltaje.
	if b := v["battery_voltage_metering"]; b > 5 && b < 60 {
		return true
	}
	for _, x := range v {
		if x != 0 {
			return true
		}
	}
	return false
}

func genField(key, unit string, t fieldType, scale float64, index int) field {
	return field{Key: key, Unit: unit, Type: t, Scale: scale, Offset: index * 2}
}

var profiles = map[string]profile{
	// ANALIZADOR-1 de Escuintla: 35 campos seguidos.
	"ion7400": {
		Name: "ion7400", Model: "ION7400", Category: "power_meter",
		Length:   70,
		Fields:   concat(ionBaseFields, ionQualityFields(20)),
		Validate: validIon,
	},
	// ANALIZADOR-2..6: indices 20-21 reservados (en ANALIZADOR-5 son el estado S1/S2, que se
	// configura como "extra") y la calidad de energia empieza en el indice 22.
	"ion7400-b": {
		Name: "ion7400-b", Model: "ION7400", Category: "power_meter",
		Length:   74,
		Fields:   concat(ionBaseFields, ionQualityFields(22)),
		Validate: validIon,
	},
	"pm2130": {
		Name: "pm2130", Model: "PM2130", Category: "circuit_meter",
		Length: 22,
		Fields: []field{
			f32("voltage_a_n", "V", 0),
			f32("voltage_b_n", "V", 1),
			f32("voltage_c_n", "V", 2),
			f32("voltage_a_b", "V", 3),
			f32("voltage_b_c", "V", 4),
			f32("voltage_c_a", "V", 5),
			f32("current_a", "A", 6),
			f32("current_b", "A", 7),
			f32("current_c", "A", 8),
			f32("frequency", "Hz", 9),
			f32("demand_total", "kW", 10),
		},
		Validate: validPm2130,
	},
	"generator": {
		Name: "generator", Model: "generator", Category: "generator",
		Length: 38,
		Fields: []field{
			genField("gen_kva_a_metering", "kVA", typeInt32, 0.01, 0),
			genField("gen_kva_b_metering", "kVA", typeInt32, 0.01, 1),
			genField("gen_kva_c_metering", "kVA", typeInt32, 0.01, 2),
			genField("gen_kva_total_metering", "kVA", typeInt32, 0.01, 3),
			genField("gen_kw_a_metering", "kW", typeInt32, 0.01, 4),
			genField("gen_kw_b_metering", "kW", typeInt32, 0.01, 5),
			genField("gen_kw_c_metering", "kW", typeInt32, 0.01, 6),
			genField("gen_kw_total_metering", "kW", typeInt32, 0.01, 7),
			genField("power_factor_metering", "pf", typeUint16, 0.01, 8),
			genField("gen_pf_lagging", "state", typeInt32, 1, 9),
			genField("gen_frequency_metering", "Hz", typeUint16, 0.01, 10),
			genField("bus_frequency_metering", "Hz", typeUint16, 0.01, 11),
			genField("active_speed_source", "state", typeUint32, 1, 12),
			genField("engine_speed_metering", "RPM", typeUint32, 1, 13),
			genField("engine_load_metering", "%", typeInt32, 0.01, 14),
			genField("coolant_temp_metering", "°C", typeInt32, 0.01, 15),
			genField("oil_pressure_metering", "psi", typeInt32, 0.01, 16),
			genField("battery_voltage_metering", "V", typeInt32, 0.01, 17),
			genField("fuel_level_metering", "%", typeInt32, 0.01, 18),
		},
		Validate: validGenerator,
	},
}

// ---------- decodificacion ----------

func decodeFloat32(hi, lo uint16, swapped bool) float64 {
	if swapped {
		hi, lo = lo, hi
	}
	return float64(math.Float32frombits(uint32(hi)<<16 | uint32(lo)))
}

func decodeUint32(hi, lo uint16, swapped bool) float64 {
	if swapped {
		hi, lo = lo, hi
	}
	return float64(uint32(hi)<<16 | uint32(lo))
}

func decodeInt32(hi, lo uint16, swapped bool) float64 {
	if swapped {
		hi, lo = lo, hi
	}
	return float64(int32(uint32(hi)<<16 | uint32(lo)))
}

func usable(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) < 1e9
}

// pickByUnit replica pickIon7400ByUnit: prueba escalas 10^n y se queda con la mas cercana a un
// valor tipico dentro de un rango valido.
func pickByUnit(candidates []float64, h scaleHeuristic) float64 {
	minV, maxV, target := 0.0, 200.0, 5.0
	if h == heuristicPst {
		minV, maxV, target = 0, 10, 1
	}
	factors := []float64{1, 0.1, 0.01, 0.001, 0.0001, 0.00001, 0.000001, 0.0000001, 0.00000001, 0.000000001, 10, 100}
	best, bestDist, found := 0.0, math.Inf(1), false
	for _, v := range candidates {
		for _, f := range factors {
			c := v * f
			if !usable(c) || c < minV || c > maxV {
				continue
			}
			if d := math.Abs(c - target); d < bestDist {
				best, bestDist, found = c, d, true
			}
		}
	}
	if found {
		return best
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return 0
}

// plausibleRange replica getGeneratorPlausibleRange.
func plausibleRange(unit string) (float64, float64) {
	switch unit {
	case "%":
		return -1, 100
	case "Hz":
		return 0, 100
	case "V":
		return 0, 1000
	case "°C":
		return -50, 250
	case "psi":
		return 0, 1000
	case "pf":
		return -100, 100
	case "RPM":
		return 0, 10000
	default:
		return -100000, 100000
	}
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

// decode aplica el perfil sobre los registros leidos (regs[0] = registro inicial del bloque).
func decode(p profile, regs []uint16) map[string]float64 {
	out := make(map[string]float64, len(p.Fields))
	at := func(i int) (uint16, bool) {
		if i < 0 || i >= len(regs) {
			return 0, false
		}
		return regs[i], true
	}

	for _, f := range p.Fields {
		hi, ok1 := at(f.Offset)
		if !ok1 {
			continue
		}
		if f.Type == typeRaw16 {
			out[f.Key] = float64(hi)
			continue
		}
		if f.Type == typeUint16 {
			out[f.Key] = round2(float64(hi) * f.Scale)
			continue
		}
		lo, ok2 := at(f.Offset + 1)
		if !ok2 {
			continue
		}

		switch f.Type {
		case typeFloat32:
			primary := decodeFloat32(hi, lo, false)
			alternate := decodeFloat32(hi, lo, true)
			if f.Heuristic != heuristicNone {
				cands := []float64{}
				for _, c := range []float64{primary, alternate} {
					if usable(c) {
						cands = append(cands, c)
					}
				}
				out[f.Key] = round2(pickByUnit(cands, f.Heuristic))
				continue
			}
			v := 0.0
			if usable(primary) && primary != 0 {
				v = primary
			} else if usable(alternate) {
				v = alternate
			}
			out[f.Key] = round2(v)
		case typeInt32, typeUint32:
			dec := decodeInt32
			if f.Type == typeUint32 {
				dec = decodeUint32
			}
			// El generador usa CDAB por defecto (MODBUS_GENERATOR_WORD_ORDER en api-SIASA).
			cands := []float64{dec(hi, lo, true) * f.Scale, dec(hi, lo, false) * f.Scale}
			minV, maxV := plausibleRange(f.Unit)
			v := cands[0]
			for _, c := range cands {
				if usable(c) && c >= minV && c <= maxV {
					v = c
					break
				}
			}
			out[f.Key] = round2(v)
		}
	}
	return out
}

func allZero(regs []uint16) bool {
	for _, r := range regs {
		if r != 0 {
			return false
		}
	}
	return true
}

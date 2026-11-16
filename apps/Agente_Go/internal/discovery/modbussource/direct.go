package modbussource

import (
	"errors"
	"fmt"
	"math"
)

// Perfiles de LECTURA DIRECTA (piloto Gravix, Fase B): el agente lee cada medidor por su propia IP
// en vez de los bloques que republica el AS-P. Los registros son los mismos que el AS-P lee de
// cada equipo (exportacion de sus puntos Modbus en EcoStruxure, 09/11/2026) y se verificaron con una
// lectura de solo lectura contra ANALIZADOR-1 (10.0.6.9, ID 21) y PM2130-1 (10.0.6.18, ID 2),
// comparando contra el AS-P en el mismo instante:
//   - direccion Modbus = registro - 1 (igual que el AS-P);
//   - float32 en orden ABCD (lo que EcoStruxure llama "32 bit real swapped");
//   - energias del PM2130: int64 ABCD en Wh/VARh/VAh;
//   - ION7400: potencias en W/VA (se pasan a kW/kVA) y THD como fraccion (se pasa a %);
//   - PM2130: potencias ya en kW y THD ya en %;
//   - un valor NaN es "no aplica" (ej. fase C de un circuito bifasico): se omite, no se reporta 0.
// Las claves son las mismas del perfil AS-P del mismo modelo, para poder comparar metrica por metrica.

type directField struct {
	Key      string
	Unit     string
	Register int
	Type     fieldType
	Scale    float64
	// Swapped: palabras en orden CDAB (la baja primero), como el controlador del generador.
	Swapped bool
}

type directProfile struct {
	Name     string
	Model    string
	Category string
	// Bloques {registro inicial, cantidad} que se leen de una vez. nil = se lee valor por valor: el
	// PM2130 rechaza (excepcion 3) cualquier consulta que no empiece justo en un valor o que incluya
	// registros sin definir.
	Blocks   [][2]int
	Fields   []directField
	Validate func(values map[string]float64) bool
	// Espectro de armonicos: se lee aparte, cada harmonicsEvery (ver harmonics.go).
	Harmonics *harmonicSpec
}

const typeInt64 fieldType = 100

func df(key, unit string, register int, scale float64) directField {
	return directField{Key: key, Unit: unit, Register: register, Type: typeFloat32, Scale: scale}
}

func (f directField) count() int {
	switch f.Type {
	case typeInt64:
		return 4
	case typeRaw16:
		return 1
	default:
		return 2
	}
}

var directProfiles = map[string]directProfile{
	"ion7400-directo": {
		Name: "ion7400-directo", Model: "ION7400", Category: "power_meter",
		Blocks: [][2]int{{3000, 78}, {3110, 42}, {21300, 36}, {34649, 6}, {30112, 2}, {30450, 30}, {411, 4}},
		Fields: []directField{
			df("current_a", "A", 3000, 1), df("current_b", "A", 3002, 1), df("current_c", "A", 3004, 1),
			df("voltage_a_b", "V", 3020, 1), df("voltage_b_c", "V", 3022, 1), df("voltage_c_a", "V", 3024, 1),
			df("voltage_a_n", "V", 3028, 1), df("voltage_b_n", "V", 3030, 1), df("voltage_c_n", "V", 3032, 1),
			df("active_power_a", "kW", 3054, 0.001), df("active_power_b", "kW", 3056, 0.001),
			df("active_power_c", "kW", 3058, 0.001), df("active_power_total", "kW", 3060, 0.001),
			df("apparent_power_a", "kVA", 3070, 0.001), df("apparent_power_b", "kVA", 3072, 0.001),
			df("apparent_power_c", "kVA", 3074, 0.001), df("apparent_power_total", "kVA", 3076, 0.001),
			df("frequency", "Hz", 3110, 1),
			df("power_factor_a", "pf", 3144, 1), df("power_factor_b", "pf", 3146, 1),
			df("power_factor_c", "pf", 3148, 1), df("power_factor_total", "pf", 3150, 1),
			df("thd_current_a_high", "%", 21300, 100), df("thd_current_b_high", "%", 21302, 100), df("thd_current_c_high", "%", 21304, 100),
			df("thd_voltage_v1_high", "%", 21330, 100), df("thd_voltage_v2_high", "%", 21332, 100), df("thd_voltage_v3_high", "%", 21334, 100),
			df("short_term_flicker_pst_a_n", "Pst", 34649, 1), df("short_term_flicker_pst_b_n", "Pst", 34651, 1), df("short_term_flicker_pst_c_n", "Pst", 34653, 1),
			df("apparent_power_total_peak_demand", "kVA", 30112, 0.001),
			df("apparent_power_del_a_peak_demand", "kVA", 30450, 0.001),
			df("apparent_power_del_b_peak_demand", "kVA", 30464, 0.001),
			df("apparent_power_del_c_peak_demand", "kVA", 30478, 0.001),
			{Key: "s1_commercial_energy_status", Unit: "state", Register: 411, Type: typeRaw16, Scale: 1},
			{Key: "s2_generator_energy_status", Unit: "state", Register: 412, Type: typeRaw16, Scale: 1},
			{Key: "s1_commercial_transition_count", Unit: "count", Register: 413, Type: typeRaw16, Scale: 1},
			{Key: "s2_generator_transition_count", Unit: "count", Register: 414, Type: typeRaw16, Scale: 1},
		},
		Validate:  validIon,
		Harmonics: ionHarmonics,
	},
	"pm2130-directo": {
		Name: "pm2130-directo", Model: "PM2130", Category: "circuit_meter",
		Fields: []directField{
			df("current_a", "A", 3000, 1), df("current_b", "A", 3002, 1), df("current_c", "A", 3004, 1), df("current_avg", "A", 3010, 1),
			df("voltage_a_b", "V", 3020, 1), df("voltage_b_c", "V", 3022, 1), df("voltage_c_a", "V", 3024, 1), df("voltage_ll_avg", "V", 3026, 1),
			df("voltage_a_n", "V", 3028, 1), df("voltage_b_n", "V", 3030, 1), df("voltage_c_n", "V", 3032, 1), df("voltage_ln_avg", "V", 3036, 1),
			df("active_power_a", "kW", 3054, 1), df("active_power_b", "kW", 3056, 1), df("active_power_c", "kW", 3058, 1), df("active_power_total", "kW", 3060, 1),
			// Verificado: total = A + B (0.751 + 0.284 = 1.035 kVAr; 2.915 + 1.172 = 4.087 kVA).
			df("reactive_power_a", "kVAr", 3062, 1), df("reactive_power_b", "kVAr", 3064, 1), df("reactive_power_total", "kVAr", 3068, 1),
			df("apparent_power_a", "kVA", 3070, 1), df("apparent_power_b", "kVA", 3072, 1), df("apparent_power_total", "kVA", 3076, 1),
			df("power_factor_a", "pf", 3078, 1), df("power_factor_b", "pf", 3080, 1), df("power_factor_total", "pf", 3084, 1),
			df("frequency", "Hz", 3110, 1),
			df("demand_total", "kW", 3764, 1),
			df("thd_current_a_high", "%", 21300, 1), df("thd_current_b_high", "%", 21302, 1),
			df("thd_voltage_v1_high", "%", 21330, 1), df("thd_voltage_v2_high", "%", 21332, 1),
			// Nombres pendientes de confirmar con la exportacion completa del AS-P (columna NAME cortada).
			df("thd_voltage_r21322", "%", 21322, 1), df("thd_voltage_r21328", "%", 21328, 1), df("thd_voltage_r21338", "%", 21338, 1),
			{Key: "energy_active_kwh", Unit: "kWh", Register: 3204, Type: typeInt64, Scale: 0.001},
			{Key: "energy_active_r3208_kwh", Unit: "kWh", Register: 3208, Type: typeInt64, Scale: 0.001},
			{Key: "energy_reactive_kvarh", Unit: "kVArh", Register: 3220, Type: typeInt64, Scale: 0.001},
			{Key: "energy_reactive_r3224_kvarh", Unit: "kVArh", Register: 3224, Type: typeInt64, Scale: 0.001},
			{Key: "energy_apparent_kvah", Unit: "kVAh", Register: 3236, Type: typeInt64, Scale: 0.001},
			{Key: "energy_apparent_r3240_kvah", Unit: "kVAh", Register: 3240, Type: typeInt64, Scale: 0.001},
		},
		Validate: validPm2130,
	},
	// Controlador del generador de planta, leido por el cable RS-485 a traves del ANALIZADOR-2
	// (10.0.6.9, ID 2). Son los mismos 19 puntos (registros 4770-4806, uno cada 2 registros) que el
	// AS-P lee y republica en 5705-5742. Verificado el 10/11/2026 con el generador en espera:
	//   - int32 en orden CDAB (palabra baja primero);
	//   - temperatura del refrigerante y bateria en decimas: crudo 106 -> 10.6 °C, 274 -> 27.4 V
	//     (el AS-P republica 11 y 27, redondeados);
	//   - factor de potencia: float32 CDAB (crudo 0x3F80 0000 -> 1.0). El EBO lo lee como entero
	//     x0.001 y por eso muestra 16.26.
	// Con el motor apagado los demas puntos valen 0: su escala se confirma en la proxima prueba del
	// generador comparando contra el AS-P (pestaña "Directo vs AS-P").
	"generador-directo": {
		Name: "generador-directo", Model: "generator", Category: "generator",
		Blocks: [][2]int{{4770, 38}},
		Fields: []directField{
			gd("gen_kva_a_metering", "kVA", 0, 1), gd("gen_kva_b_metering", "kVA", 1, 1),
			gd("gen_kva_c_metering", "kVA", 2, 1), gd("gen_kva_total_metering", "kVA", 3, 1),
			gd("gen_kw_a_metering", "kW", 4, 1), gd("gen_kw_b_metering", "kW", 5, 1),
			gd("gen_kw_c_metering", "kW", 6, 1), gd("gen_kw_total_metering", "kW", 7, 1),
			{Key: "power_factor_metering", Unit: "pf", Register: 4786, Type: typeFloat32, Scale: 1, Swapped: true},
			gd("gen_pf_lagging", "state", 9, 1),
			gd("gen_frequency_metering", "Hz", 10, 1), gd("bus_frequency_metering", "Hz", 11, 1),
			gd("active_speed_source", "state", 12, 1), gd("engine_speed_metering", "RPM", 13, 1),
			gd("engine_load_metering", "%", 14, 1),
			gd("coolant_temp_metering", "°C", 15, 0.1),
			gd("oil_pressure_metering", "psi", 16, 1),
			gd("battery_voltage_metering", "V", 17, 0.1),
			gd("fuel_level_metering", "%", 18, 1),
		},
		Validate: validGenerator,
	},
}

// gd: punto i del controlador del generador (registro 4770 + 2*i), int32 CDAB.
func gd(key, unit string, i int, scale float64) directField {
	return directField{Key: key, Unit: unit, Register: 4770 + 2*i, Type: typeInt32, Scale: scale, Swapped: true}
}

func isKnownProfile(name string) bool {
	if _, ok := profiles[name]; ok {
		return true
	}
	_, ok := directProfiles[name]
	return ok
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// decodeDirect convierte los registros leidos (direccion Modbus -> valor) segun el perfil directo.
func decodeDirect(p directProfile, regs map[int]uint16) map[string]float64 {
	out := make(map[string]float64, len(p.Fields))
	for _, f := range p.Fields {
		addr := f.Register - 1
		words := make([]uint16, f.count())
		ok := true
		for i := range words {
			w, has := regs[addr+i]
			if !has {
				ok = false
				break
			}
			words[i] = w
		}
		if !ok {
			continue
		}
		var v float64
		switch f.Type {
		case typeRaw16:
			v = float64(int16(words[0]))
		case typeInt64:
			var u uint64
			for _, w := range words {
				u = u<<16 | uint64(w)
			}
			v = float64(int64(u))
		case typeInt32:
			v = decodeInt32(words[0], words[1], f.Swapped)
		default:
			v = decodeFloat32(words[0], words[1], f.Swapped)
		}
		if !usable(v) {
			continue // NaN = no aplica en este equipo
		}
		out[f.Key] = round3(v * f.Scale)
	}
	return out
}

// readDirect lee el equipo por bloques o valor por valor. Error solo si no respondio nada.
func (s *Source) readDirect(p directProfile) (map[string]float64, error) {
	regs := map[int]uint16{}
	var lastErr error
	// Devuelve false si hay que abandonar el ciclo: un error de red (no una excepcion Modbus) con
	// el medidor caido haria esperar el timeout en cada uno de los valores.
	read := func(register, count int) bool {
		vals, err := s.client.readRegisters(fnReadHolding, uint16(register-1), uint16(count))
		s.pause()
		if err != nil {
			lastErr = err
			var exc *ExceptionError
			return errors.As(err, &exc)
		}
		for i, v := range vals {
			regs[register-1+i] = v
		}
		return true
	}
	if p.Blocks != nil {
		for _, b := range p.Blocks {
			if !read(b[0], b[1]) {
				break
			}
		}
	} else {
		for _, f := range p.Fields {
			if !read(f.Register, f.count()) {
				break
			}
		}
	}
	if len(regs) == 0 {
		if lastErr == nil {
			lastErr = fmt.Errorf("sin datos")
		}
		return nil, lastErr
	}
	values := decodeDirect(p, regs)
	if !p.Validate(values) {
		return nil, fmt.Errorf("los valores leidos no pasan la validacion del perfil %s", p.Name)
	}
	return values, nil
}

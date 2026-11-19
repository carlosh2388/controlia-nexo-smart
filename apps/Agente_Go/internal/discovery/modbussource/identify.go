package modbussource

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

// Identity es lo que el escaneo deduce de un equipo Modbus: que modelo es, con que perfil se lee y
// por que lo cree (la "huella"). Todo con lecturas de solo lectura (funcion 03) y pausas entre
// consultas, igual que el ciclo normal.
//
// Huellas verificadas en IGSS Escuintla (09-10/11/2026):
//   - ION7400: acepta bloques grandes (3000+78 registros), frecuencia float32 ABCD en el 3110 y su
//     nombre en texto en los registros 30-49;
//   - PM2130: frecuencia en el 3110 pero rechaza (excepcion 3) cualquier bloque que incluya
//     registros sin definir, por eso se lee valor por valor; fase C NaN = circuito monofasico;
//   - controlador del generador: bloque 4770-4806 en int32 CDAB, bateria (punto 17) en decimas
//     entre 18 y 32 V aunque el motor este apagado.
type Identity struct {
	UnitID     int    `json:"unitId"`
	Model      string `json:"model"`             // "ION7400" | "PM2130" | "generator" | ""
	Profile    string `json:"profile,omitempty"` // perfil directo con el que se leeria
	Confidence int    `json:"confidence"`        // 0-100
	Name       string `json:"name,omitempty"`    // nombre que el equipo reporta, si tiene
	Evidence   string `json:"evidence"`
}

// Identify reconoce el equipo que responde en host:port con ese unit ID.
func Identify(host string, port, unit int, timeout time.Duration) Identity {
	c := newTCPClient(host, port, unit, timeout)
	defer c.close()
	read := func(addr, count int) ([]uint16, error) {
		v, err := c.readRegisters(fnReadHolding, uint16(addr), uint16(count))
		time.Sleep(80 * time.Millisecond)
		return v, err
	}
	id := Identity{UnitID: unit}

	freq, ferr := read(3109, 2)
	hz := math.NaN()
	if ferr == nil && len(freq) == 2 {
		hz = decodeFloat32(freq[0], freq[1], false)
	}
	if hz >= 45 && hz <= 65 {
		// Lo primero: el modelo que el propio equipo reporta (registros 50-69 del mapa comun de los
		// medidores Schneider). Si no lo entrega, se usa la huella de abajo.
		modelo := ""
		if m, err := read(49, 20); err == nil {
			modelo = registersText(m)
		}
		// ION7400 lee el bloque completo; el PM2130 lo rechaza con excepcion 3.
		_, berr := read(2999, 78)
		var exc *ExceptionError
		if berr == nil {
			nombre := ""
			if name, err := read(29, 20); err == nil {
				nombre = registersText(name)
			}
			id.Name = nombre
			switch {
			case reION7400.MatchString(modelo):
				id.Model, id.Profile, id.Confidence = "ION7400", "ion7400-directo", 99
				id.Evidence = fmt.Sprintf("Modelo \"%s\" leido del equipo (registros 50-69) · %.2f Hz en el 3110", modelo, hz)
			case rePM2130.MatchString(modelo):
				id.Model, id.Profile, id.Confidence = "PM2130", "pm2130-directo", 99
				id.Evidence = fmt.Sprintf("Modelo \"%s\" leido del equipo (registros 50-69) · %.2f Hz en el 3110", modelo, hz)
			case modelo != "" && reModeloMedidor.MatchString(modelo):
				// Otro medidor (PM5xxx, PM8xxx...): Nodivo todavia no tiene perfil para leerlo.
				id.Evidence = fmt.Sprintf("Modelo \"%s\" leido del equipo: todavia no hay perfil de lectura para el (por confirmar)", modelo)
			case reNombrePM.MatchString(nombre):
				// "Power Meter" es el nombre de fabrica de la serie PM: aceptar el bloque grande no basta
				// para decir que es un ION7400.
				id.Evidence = fmt.Sprintf("Se nombra \"%s\" y acepta bloques grandes, pero no entrega su modelo: confirmarlo en la placa (por confirmar)", nombre)
			default:
				id.Model, id.Profile, id.Confidence = "ION7400", "ion7400-directo", 90
				id.Evidence = fmt.Sprintf("Lee el bloque 3000-3077 y da %.2f Hz en el 3110 (float32 ABCD)", hz)
				if nombre != "" {
					id.Confidence = 98
					id.Evidence = fmt.Sprintf("Nombre \"%s\" en los registros 30-49 · %.2f Hz en el 3110", nombre, hz)
				}
			}
			return id
		}
		if errors.As(berr, &exc) {
			id.Model, id.Profile, id.Confidence = "PM2130", "pm2130-directo", 88
			id.Evidence = fmt.Sprintf("Rechaza el bloque con registros vacios y da %.2f Hz en el 3110: se lee valor por valor", hz)
			if rePM2130.MatchString(modelo) {
				id.Confidence = 99
				id.Evidence = fmt.Sprintf("Modelo \"%s\" leido del equipo (registros 50-69) · rechaza bloques con registros vacios: se lee valor por valor", modelo)
			}
			if v, err := read(3027, 2); err == nil && len(v) == 2 {
				volt := decodeFloat32(v[0], v[1], false)
				if volt > 50 && volt < 700 {
					id.Confidence = 96
					id.Evidence += fmt.Sprintf(" · %.1f V en el 3028", volt)
				}
			}
			if v, err := read(3031, 2); err == nil && len(v) == 2 && math.IsNaN(decodeFloat32(v[0], v[1], false)) {
				id.Evidence += " · fase C sin dato (monofasico)"
			}
			return id
		}
	}

	// Generador: bloque 4770-4806 (direccion 4769, 38 registros), int32 CDAB.
	if g, err := read(4769, 38); err == nil && len(g) == 38 {
		bat := decodeInt32(g[34], g[35], true) * 0.1
		if bat >= 18 && bat <= 32 {
			id.Model, id.Profile, id.Confidence = "generator", "generador-directo", 93
			id.Evidence = fmt.Sprintf("Bloque 4770-4806 (int32 CDAB) con bateria de %.1f V", bat)
			return id
		}
	}

	id.Evidence = "Responde Modbus pero no coincide con ION7400, PM2130 ni generador: revisar a mano"
	if !math.IsNaN(hz) && hz != 0 {
		id.Evidence += fmt.Sprintf(" (registro 3110 = %.2f)", hz)
	}
	return id
}

var (
	reION7400       = regexp.MustCompile(`(?i)ION\s*-?\s*7400|^7400$`)
	rePM2130        = regexp.MustCompile(`(?i)PM\s*-?\s*21[23]\d|^2130$`)
	reModeloMedidor = regexp.MustCompile(`(?i)\b(PM|ION|iEM|EM)\s*-?\s*\d{3,4}`)
	reNombrePM      = regexp.MustCompile(`(?i)power\s*meter`)
)

// registersText convierte registros a texto (2 caracteres por registro) y deja solo lo imprimible.
func registersText(regs []uint16) string {
	var b strings.Builder
	for _, r := range regs {
		for _, ch := range []byte{byte(r >> 8), byte(r)} {
			if ch >= 32 && ch < 127 {
				b.WriteByte(ch)
			}
		}
	}
	s := strings.TrimSpace(b.String())
	if len(s) < 3 {
		return ""
	}
	return s
}

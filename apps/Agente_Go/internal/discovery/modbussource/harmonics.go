package modbussource

import (
	"errors"
	"fmt"
	"log"
	"time"
)

// Espectro de armonicos del ION7400 (lectura directa). Registros tomados de la exportacion de puntos
// del AS-P de Escuintla (13/11/2026) y verificados ese dia con una lectura de solo lectura (funcion 03)
// contra ANALIZADOR-1 (10.0.6.9, ID 21): el THD calculado con H2-H20 dio 5.76 %, igual al THD del
// medidor (registros 21300/21330), en voltaje A-N y en corriente A.
//   - armonico n del canal = registro inicial + 6*(n-1); 63 armonicos por canal;
//   - float32 ABCD ("32 bit real swapped"), magnitud en V o A; H1 es la fundamental;
//   - el registro +2 de cada armonico trae su angulo (corriente H1: -9.15°); todavia no se usa.
// Claves: harm_<v|i>_<a|b|c>_<NN> en V o A. La web calcula el % contra H1 (como la pagina del ION).

type harmonicChannel struct {
	Key   string
	Start int
}

type harmonicSpec struct {
	Channels []harmonicChannel
	Orders   int
	Stride   int
}

var ionHarmonics = &harmonicSpec{
	Channels: []harmonicChannel{
		{"v_a", 22878}, {"v_b", 23266}, {"v_c", 23654},
		{"i_a", 24430}, {"i_b", 24818}, {"i_c", 25206},
	},
	Orders: 63,
	Stride: 6,
}

const (
	// Cada cuanto se lee el espectro: el intervalo de 10 min de la IEC 61000-4-30. Son 24 lecturas
	// de bloque por medidor; la API guarda una fila por armonico por cada espectro nuevo.
	harmonicsEvery = 10 * time.Minute
	// Si falla, se reintenta despues de esto (no en cada ciclo).
	harmonicsRetry = time.Minute
	// Un espectro mas viejo que esto ya no se reporta.
	harmonicsMaxAge = 3 * harmonicsEvery
	// Armonicos por consulta: 20 * 6 = 120 registros (el maximo de Modbus es 125).
	harmonicsPerRead = 20
)

type harmonicCache struct {
	values  map[string]float64
	readAt  time.Time
	lastTry time.Time
	// Ultimo armonico que existe en cada canal, si el medidor no llega al 63.
	limits map[string]int
}

func harmonicKey(ch string, order int) string { return fmt.Sprintf("harm_%s_%02d", ch, order) }

// decodeHarmonics convierte los registros de un canal (empezando en el armonico "first") en valores.
func decodeHarmonics(ch string, first, n, stride int, regs []uint16, out map[string]float64) {
	for k := 0; k < n; k++ {
		i := k * stride
		if i+1 >= len(regs) {
			return
		}
		v := decodeFloat32(regs[i], regs[i+1], false)
		if usable(v) {
			out[harmonicKey(ch, first+k)] = round3(v)
		}
	}
}

// readHarmonics lee los armonicos de cada canal. Error si no respondio ningun canal o si hubo un
// error de red (con el medidor caido no tiene sentido seguir).
//
// No todos los ION7400 miden hasta el 63: ANALIZADOR-5 esta configurado hasta el 31 y desde el 32
// responde excepcion 2 (direccion ilegal), lo que hace fallar todo el bloque que lo incluya. Si un
// bloque falla, ese tramo se lee armonico por armonico hasta el primero que no existe, y ese limite
// se recuerda en limits (por canal) para no volver a preguntar.
func (s *Source) readHarmonics(h *harmonicSpec, limits map[string]int) (map[string]float64, error) {
	out := map[string]float64{}
	var lastErr error
	isExc := func(err error) bool {
		var exc *ExceptionError
		return errors.As(err, &exc)
	}
	for _, ch := range h.Channels {
		max := h.Orders
		if l, ok := limits[ch.Key]; ok {
			max = l
		}
	chunks:
		for first := 1; first <= max; first += harmonicsPerRead {
			n := harmonicsPerRead
			if first+n-1 > max {
				n = max - first + 1
			}
			start := ch.Start + (first-1)*h.Stride
			regs, err := s.client.readRegisters(fnReadHolding, uint16(start-1), uint16((n-1)*h.Stride+2))
			s.pause()
			if err == nil {
				decodeHarmonics(ch.Key, first, n, h.Stride, regs, out)
				continue
			}
			lastErr = err
			if !isExc(err) {
				return nil, err
			}
			for k := 0; k < n; k++ {
				one, err := s.client.readRegisters(fnReadHolding, uint16(start-1+k*h.Stride), 2)
				s.pause()
				if err != nil {
					if !isExc(err) {
						return nil, err
					}
					limits[ch.Key] = first + k - 1
					log.Printf("[modbus] %s: el medidor da armonicos de %s hasta el %d", s.cfg.Name, ch.Key, first+k-1)
					break chunks
				}
				decodeHarmonics(ch.Key, first+k, 1, h.Stride, one, out)
			}
		}
	}
	if len(out) == 0 {
		if lastErr == nil {
			lastErr = fmt.Errorf("sin datos")
		}
		return nil, lastErr
	}
	return out, nil
}

// withHarmonics agrega a readings el ultimo espectro del equipo (leyendolo si ya toca) y su hora de
// lectura en harm_read_at (segundos Unix). La API guarda el espectro con esa hora, una sola vez.
func (s *Source) withHarmonics(externalID, name string, h *harmonicSpec, readings map[string]float64) {
	c := s.harm[externalID]
	if c == nil {
		c = &harmonicCache{limits: map[string]int{}}
		s.harm[externalID] = c
	}
	now := time.Now()
	if now.Sub(c.readAt) >= harmonicsEvery && now.Sub(c.lastTry) >= harmonicsRetry {
		c.lastTry = now
		vals, err := s.readHarmonics(h, c.limits)
		if err != nil {
			log.Printf("[modbus] %s: no se pudo leer el espectro de armonicos: %v", name, err)
		} else {
			c.values, c.readAt = vals, now.UTC()
		}
	}
	if c.values == nil || now.Sub(c.readAt) > harmonicsMaxAge {
		return
	}
	for k, v := range c.values {
		readings[k] = v
	}
	readings["harm_read_at"] = float64(c.readAt.Unix())
}

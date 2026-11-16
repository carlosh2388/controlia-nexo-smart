package modbussource

import (
	"errors"
	"time"
)

// Excepciones de gateway Modbus: el gateway respondio pero no hay ningun equipo detras de ese
// unit ID. Cualquier otra excepcion (ej. 2 = direccion ilegal) si prueba que el equipo existe.
const (
	excGatewayPathUnavailable = 0x0A
	excGatewayTargetFailed    = 0x0B
)

// ProbeUnits pregunta a host:port que unit IDs responden, con una sola lectura de 1 registro
// (funcion 03, direccion 0) por unit. Solo lectura, como todo el agente. Lo usa el descubrimiento
// de la web (internal/scan); no forma parte del ciclo de lectura normal.
func ProbeUnits(host string, port int, unitIDs []int, timeout time.Duration) []int {
	c := newTCPClient(host, port, 1, timeout)
	defer c.close()

	var found []int
	for _, unit := range unitIDs {
		c.unitID = byte(unit)
		_, err := c.readRegisters(fnReadHolding, 0, 1)
		var exc *ExceptionError
		switch {
		case err == nil:
			found = append(found, unit)
		case errors.As(err, &exc):
			if exc.Code != excGatewayPathUnavailable && exc.Code != excGatewayTargetFailed {
				found = append(found, unit)
			}
		}
		// Misma pausa que el ciclo normal: no saturar el servidor de la sede.
		time.Sleep(50 * time.Millisecond)
	}
	return found
}

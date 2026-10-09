package modbussource

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// Cliente Modbus TCP minimo, solo lectura (funciones 03 y 04). Se implementa a mano en vez de
// traer una libreria porque es todo lo que el agente necesita: ~100 lineas, sin dependencias
// nuevas en go.mod, y el agente nunca debe poder escribir registros (no hay funcion para eso).

const (
	fnReadHolding = 0x03
	fnReadInput   = 0x04
	// Limite del protocolo para una lectura de registros.
	maxRegistersPerRead = 125
)

// ExceptionError es una respuesta de excepcion Modbus (ej. 2 = direccion ilegal).
type ExceptionError struct {
	Function byte
	Code     byte
}

func (e *ExceptionError) Error() string {
	return fmt.Sprintf("excepcion Modbus %d en funcion 0x%02x", e.Code, e.Function)
}

type tcpClient struct {
	addr    string
	unitID  byte
	timeout time.Duration

	conn net.Conn
	txID uint16
}

func newTCPClient(host string, port, unitID int, timeout time.Duration) *tcpClient {
	return &tcpClient{
		addr:    net.JoinHostPort(host, fmt.Sprint(port)),
		unitID:  byte(unitID),
		timeout: timeout,
	}
}

func (c *tcpClient) connect() error {
	if c.conn != nil {
		return nil
	}
	conn, err := net.DialTimeout("tcp", c.addr, c.timeout)
	if err != nil {
		return err
	}
	c.conn = conn
	return nil
}

func (c *tcpClient) close() {
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
}

// readRegisters lee qty registros a partir de address (direccion Modbus 0-based) con la
// funcion indicada. Ante un error de red cierra la conexion para que la proxima llamada reconecte.
func (c *tcpClient) readRegisters(function byte, address, qty uint16) ([]uint16, error) {
	if qty == 0 || qty > maxRegistersPerRead {
		return nil, fmt.Errorf("cantidad de registros invalida: %d", qty)
	}
	if err := c.connect(); err != nil {
		return nil, err
	}

	c.txID++
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:], c.txID)
	binary.BigEndian.PutUint16(req[2:], 0) // protocolo Modbus
	binary.BigEndian.PutUint16(req[4:], 6) // bytes que siguen: unit + PDU de 5
	req[6] = c.unitID
	req[7] = function
	binary.BigEndian.PutUint16(req[8:], address)
	binary.BigEndian.PutUint16(req[10:], qty)

	_ = c.conn.SetDeadline(time.Now().Add(c.timeout))
	if _, err := c.conn.Write(req); err != nil {
		c.close()
		return nil, err
	}

	header := make([]byte, 7)
	if _, err := io.ReadFull(c.conn, header); err != nil {
		c.close()
		return nil, err
	}
	length := binary.BigEndian.Uint16(header[4:])
	if length < 2 || length > 260 {
		c.close()
		return nil, fmt.Errorf("longitud de respuesta invalida: %d", length)
	}
	pdu := make([]byte, length-1)
	if _, err := io.ReadFull(c.conn, pdu); err != nil {
		c.close()
		return nil, err
	}
	if binary.BigEndian.Uint16(header[0:]) != c.txID {
		// Respuesta desfasada (ej. de una peticion anterior que expiro): resincronizar reconectando.
		c.close()
		return nil, errors.New("transaction id no coincide")
	}

	if pdu[0] == function|0x80 {
		code := byte(0)
		if len(pdu) > 1 {
			code = pdu[1]
		}
		return nil, &ExceptionError{Function: function, Code: code}
	}
	if pdu[0] != function || len(pdu) < 2 {
		c.close()
		return nil, fmt.Errorf("respuesta inesperada (funcion 0x%02x)", pdu[0])
	}
	byteCount := int(pdu[1])
	if byteCount != int(qty)*2 || len(pdu) < 2+byteCount {
		c.close()
		return nil, fmt.Errorf("se esperaban %d bytes, llegaron %d", int(qty)*2, byteCount)
	}

	values := make([]uint16, qty)
	for i := range values {
		values[i] = binary.BigEndian.Uint16(pdu[2+i*2:])
	}
	return values, nil
}

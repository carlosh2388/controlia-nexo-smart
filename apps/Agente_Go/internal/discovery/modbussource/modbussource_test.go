package modbussource

import (
	"encoding/binary"
	"io"
	"math"
	"net"
	"testing"
	"time"

	"agente-go/internal/config"
)

func f32Regs(v float32, swapped bool) (uint16, uint16) {
	bits := math.Float32bits(v)
	hi, lo := uint16(bits>>16), uint16(bits)
	if swapped {
		return lo, hi
	}
	return hi, lo
}

func i32Regs(v int32, swapped bool) (uint16, uint16) {
	u := uint32(v)
	hi, lo := uint16(u>>16), uint16(u)
	if swapped {
		return lo, hi
	}
	return hi, lo
}

func TestDecodePm2130ABCDAndFallbackCDAB(t *testing.T) {
	p := profiles["pm2130"]
	regs := make([]uint16, p.Length)
	values := []float32{121.96, 122.45, 32.52, 213.16, 107.07, 116.36, 14.92, 14.59, 0, 59.97, 3.82}
	for i, v := range values {
		// La mitad en ABCD y la otra mitad en CDAB: el decoder debe recuperar ambas.
		regs[i*2], regs[i*2+1] = f32Regs(v, i%2 == 1)
	}
	got := decode(p, regs)
	want := map[string]float64{"voltage_a_n": 121.96, "voltage_b_n": 122.45, "frequency": 59.97, "demand_total": 3.82, "current_c": 0}
	for k, w := range want {
		if math.Abs(got[k]-w) > 0.005 {
			t.Errorf("%s = %v, se esperaba %v", k, got[k], w)
		}
	}
	if !p.Validate(got) {
		t.Errorf("un PM2130 con datos reales deberia validar")
	}
	if p.Validate(decode(p, make([]uint16, p.Length))) {
		t.Errorf("un bloque en ceros no deberia validar")
	}
}

func TestDecodeGeneratorInt32CDABScaled(t *testing.T) {
	p := profiles["generator"]
	regs := make([]uint16, p.Length)
	set32 := func(index int, v int32) { regs[index*2], regs[index*2+1] = i32Regs(v, true) }
	set32(17, 2720)  // battery_voltage_metering = 27.20 V
	set32(18, 8600)  // fuel_level_metering = 86.00 %
	set32(15, -150)  // coolant_temp_metering = -1.5 °C (int32 negativo)
	regs[10*2] = 6000 // gen_frequency_metering uint16 = 60.00 Hz
	got := decode(p, regs)
	for k, w := range map[string]float64{"battery_voltage_metering": 27.2, "fuel_level_metering": 86, "coolant_temp_metering": -1.5, "gen_frequency_metering": 60} {
		if math.Abs(got[k]-w) > 0.005 {
			t.Errorf("%s = %v, se esperaba %v", k, got[k], w)
		}
	}
	if !p.Validate(got) {
		t.Errorf("un generador en espera con bateria deberia validar")
	}
}

func TestDecodeIonThdScaleHeuristic(t *testing.T) {
	p := profiles["ion7400"]
	regs := make([]uint16, p.Length)
	regs[16*2], regs[16*2+1] = f32Regs(59.95, false) // frequency
	regs[26*2], regs[26*2+1] = f32Regs(586, false)   // THD V1 entregado x100 por el EBO
	got := decode(p, regs)
	if math.Abs(got["thd_voltage_v1_high"]-5.86) > 0.005 {
		t.Errorf("thd_voltage_v1_high = %v, se esperaba 5.86", got["thd_voltage_v1_high"])
	}
	if !p.Validate(got) {
		t.Errorf("un ION7400 con frecuencia valida deberia validar")
	}
}

// Servidor Modbus TCP falso: responde funcion 03 con registros = direccion, y excepcion 2 a la 04.
func fakeServer(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			req := make([]byte, 12)
			if _, err := io.ReadFull(conn, req); err != nil {
				return
			}
			fn := req[7]
			addr := binary.BigEndian.Uint16(req[8:])
			qty := binary.BigEndian.Uint16(req[10:])
			var pdu []byte
			if fn == fnReadHolding {
				pdu = []byte{fn, byte(qty * 2)}
				for i := uint16(0); i < qty; i++ {
					pdu = binary.BigEndian.AppendUint16(pdu, addr+i)
				}
			} else {
				pdu = []byte{fn | 0x80, 2}
			}
			resp := make([]byte, 7)
			copy(resp, req[:4])
			binary.BigEndian.PutUint16(resp[4:], uint16(len(pdu)+1))
			resp[6] = req[6]
			conn.Write(append(resp, pdu...))
		}
	}()
	return ln.Addr().String()
}

func TestClientReadsAndReportsExceptions(t *testing.T) {
	host, portStr, _ := net.SplitHostPort(fakeServer(t))
	var port int
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}
	c := newTCPClient(host, port, 1, 2*time.Second)
	defer c.close()

	regs, err := c.readRegisters(fnReadHolding, 100, 4)
	if err != nil {
		t.Fatal(err)
	}
	if regs[0] != 100 || regs[3] != 103 {
		t.Errorf("registros inesperados: %v", regs)
	}
	if _, err := c.readRegisters(fnReadInput, 100, 2); err == nil {
		t.Errorf("se esperaba excepcion Modbus en la funcion 04")
	}
	// La conexion debe seguir usable despues de una excepcion (no es error de red).
	if _, err := c.readRegisters(fnReadHolding, 5704, 38); err != nil {
		t.Errorf("lectura despues de excepcion: %v", err)
	}

	// Source completo: el bloque del servidor falso no es un PM2130 valido -> no se reporta.
	s := New(config.ModbusConfig{Host: host, Port: port, UnitID: 1, TimeoutMs: 2000, Name: "fake",
		Devices: []config.ModbusDevice{{Name: "PM2130-1", Profile: "pm2130", Start: 101}}})
	if got := s.pollOnce(); len(got) != 0 {
		t.Errorf("un bloque invalido no deberia reportarse, llegaron %d", len(got))
	}
}

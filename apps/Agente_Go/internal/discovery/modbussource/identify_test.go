package modbussource

import (
	"encoding/binary"
	"math"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

// servidor Modbus TCP minimo: responde funcion 03 con el mapa dado. maxBlock > 0 imita al PM2130:
// rechaza (excepcion 3) las consultas mas largas que eso.
func simulador(t *testing.T, regs map[int]uint16, maxBlock int) (string, int) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					req := make([]byte, 12)
					if _, err := c.Read(req); err != nil {
						return
					}
					addr, count := int(binary.BigEndian.Uint16(req[8:])), int(binary.BigEndian.Uint16(req[10:]))
					exc := func(code byte) {
						resp := []byte{req[0], req[1], 0, 0, 0, 3, req[6], 0x83, code}
						_, _ = c.Write(resp)
					}
					if maxBlock > 0 && count > maxBlock {
						exc(3)
						continue
					}
					data := make([]byte, 0, count*2)
					ok := true
					for i := 0; i < count; i++ {
						v, has := regs[addr+i]
						if !has {
							ok = false
							break
						}
						data = binary.BigEndian.AppendUint16(data, v)
					}
					if !ok {
						exc(2)
						continue
					}
					resp := []byte{req[0], req[1], 0, 0, 0, byte(3 + len(data)), req[6], 3, byte(len(data))}
					_, _ = c.Write(append(resp, data...))
				}
			}(conn)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port
}

func putFloat(regs map[int]uint16, addr int, v float32) {
	hi, lo := f32Regs(v, false)
	regs[addr], regs[addr+1] = hi, lo
}

func TestIdentifyION7400(t *testing.T) {
	regs := map[int]uint16{}
	for a := 2999; a < 2999+78; a++ {
		regs[a] = 0
	}
	putFloat(regs, 3109, 60.01)
	name := "ION7400-ANALIZADOR-2"
	for i := 0; i < 20; i++ {
		var hi, lo byte
		if 2*i < len(name) {
			hi = name[2*i]
		}
		if 2*i+1 < len(name) {
			lo = name[2*i+1]
		}
		regs[29+i] = uint16(hi)<<8 | uint16(lo)
	}
	host, port := simulador(t, regs, 0)
	id := Identify(host, port, 255, 2*time.Second)
	if id.Model != "ION7400" || id.Profile != "ion7400-directo" || id.Confidence < 95 || id.Name != name {
		t.Fatalf("identidad inesperada: %+v", id)
	}
}

func TestIdentifyPM2130(t *testing.T) {
	regs := map[int]uint16{}
	putFloat(regs, 3109, 59.98)
	putFloat(regs, 3027, 121.7)
	hi, lo := f32Regs(float32(math.NaN()), false)
	regs[3031], regs[3032] = hi, lo
	host, port := simulador(t, regs, 4)
	id := Identify(host, port, 2, 2*time.Second)
	if id.Model != "PM2130" || id.Profile != "pm2130-directo" || id.Confidence < 95 || !strings.Contains(id.Evidence, "monofasico") {
		t.Fatalf("identidad inesperada: %+v", id)
	}
}

func TestIdentifyGenerador(t *testing.T) {
	// Bloque real del generador de planta (10.0.6.9 ID 2) del 10/11/2026.
	raw := []uint16{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16256, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 106, 0, 0, 0, 274, 0, 0, 0}
	regs := map[int]uint16{}
	for i, v := range raw {
		regs[4769+i] = v
	}
	host, port := simulador(t, regs, 0)
	id := Identify(host, port, 2, 2*time.Second)
	if id.Model != "generator" || !strings.Contains(id.Evidence, "27.4") {
		t.Fatalf("identidad inesperada: %+v", id)
	}
}

func TestIdentifyDesconocido(t *testing.T) {
	host, port := simulador(t, map[int]uint16{0: 1}, 0)
	id := Identify(host, port, 1, 2*time.Second)
	if id.Model != "" || id.Confidence != 0 {
		t.Fatalf("no deberia reconocerlo: %+v", id)
	}
	_ = strconv.Itoa(port)
}

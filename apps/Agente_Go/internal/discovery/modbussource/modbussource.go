// Package modbussource lee equipos electricos (ION7400, PM2130, generadores) concentrados en un
// servidor Modbus TCP - en las sedes IGSS, el EBO AS-P de cada sede - y los reporta como sensores
// de solo lectura. Nunca escribe registros.
//
// "Autodescubrimiento" aca significa: el agente prueba cada bloque configurado en cada ciclo y
// solo reporta los equipos cuyo bloque trae datos validos para su perfil (ver profiles.go). Un
// bloque vacio (equipo no conectado, direccion equivocada) simplemente no aparece en Nodivo; si
// un equipo ya visto deja de responder, se reporta como "offline". Modbus no tiene un mecanismo
// para preguntar "que equipos hay" - ver docs/agente-go.md.
package modbussource

import (
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const protocolName = "modbus"

type Source struct {
	cfg    config.ModbusConfig
	client *tcpClient

	stop chan struct{}
	wg   sync.WaitGroup

	// Equipos que ya trajeron datos validos al menos una vez (por ExternalID).
	seen map[string]discovery.Device
}

func New(cfg config.ModbusConfig) *Source {
	return &Source{
		cfg:    cfg,
		client: newTCPClient(cfg.Host, cfg.Port, cfg.UnitID, time.Duration(cfg.TimeoutMs)*time.Millisecond),
		stop:   make(chan struct{}),
		seen:   map[string]discovery.Device{},
	}
}

func (s *Source) Name() string { return fmt.Sprintf("modbus:%s:%d", s.cfg.Host, s.cfg.Port) }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	for _, dev := range s.cfg.Devices {
		if _, ok := profiles[dev.Profile]; !ok {
			return fmt.Errorf("modbus: perfil desconocido %q en %q", dev.Profile, dev.Name)
		}
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(time.Duration(s.cfg.PollIntervalSeconds) * time.Second)
		defer ticker.Stop()
		for {
			if snapshot := s.pollOnce(); len(snapshot) > 0 {
				onUpdate(snapshot)
			}
			select {
			case <-s.stop:
				return
			case <-ticker.C:
			}
		}
	}()
	log.Printf("[modbus] leyendo %d equipo(s) de %s (%s:%d unit %d) cada %ds",
		len(s.cfg.Devices), s.cfg.Name, s.cfg.Host, s.cfg.Port, s.cfg.UnitID, s.cfg.PollIntervalSeconds)
	return nil
}

func (s *Source) Stop() {
	close(s.stop)
	s.wg.Wait()
	s.client.close()
}

func (s *Source) pause() {
	if s.cfg.ReadDelayMs > 0 {
		time.Sleep(time.Duration(s.cfg.ReadDelayMs) * time.Millisecond)
	}
}

// readBlock lee count registros desde el registro EBO "start" (1-based). Prueba holding (03) y,
// si da excepcion o vuelve todo en cero, input registers (04): api-SIASA necesitaba input para
// parte de ANALIZADOR-2.
func (s *Source) readBlock(start, count int) ([]uint16, error) {
	address := uint16(start - 1)
	regs, err := s.client.readRegisters(fnReadHolding, address, uint16(count))
	s.pause()
	if err == nil && !allZero(regs) {
		return regs, nil
	}
	var exc *ExceptionError
	if err != nil && !errors.As(err, &exc) {
		return nil, err // error de red: no tiene sentido probar la otra funcion
	}
	alt, altErr := s.client.readRegisters(fnReadInput, address, uint16(count))
	s.pause()
	if altErr == nil && !allZero(alt) {
		return alt, nil
	}
	if err == nil {
		return regs, nil // todo en cero, pero la lectura fue valida
	}
	return nil, err
}

func (s *Source) pollOnce() []discovery.Device {
	valid := 0
	for _, dev := range s.cfg.Devices {
		p := profiles[dev.Profile]
		externalID := fmt.Sprintf("modbus:%s:%s", s.cfg.Host, dev.Name)

		readings, start, err := s.readDevice(dev, p)
		if err != nil || readings == nil {
			if prev, ok := s.seen[externalID]; ok {
				prev.State = "offline"
				prev.Readings = nil
				s.seen[externalID] = prev
			}
			if err != nil {
				log.Printf("[modbus] %s: %v", dev.Name, err)
			}
			continue
		}

		for _, extra := range dev.Extra {
			regs, err := s.client.readRegisters(fnReadHolding, uint16(extra.Register-1), 1)
			s.pause()
			if err == nil {
				readings[extra.Key] = float64(regs[0])
			}
		}

		attrs := map[string]interface{}{
			"category": p.Category,
			"profile":  p.Name,
			"source":   s.cfg.Name,
			"host":     s.cfg.Host,
			"unitId":   s.cfg.UnitID,
			"registers": fmt.Sprintf("%d-%d", start, start+p.Length-1),
		}
		for k, v := range dev.Attributes {
			attrs[k] = v
		}

		s.seen[externalID] = discovery.Device{
			ExternalID: externalID,
			Name:       dev.Name,
			Protocol:   protocolName,
			Kind:       "sensor",
			State:      "online",
			Readings:   toInterfaceMap(readings),
			Model:      p.Model,
			Attributes: attrs,
		}
		valid++
	}

	if valid == 0 {
		// Probablemente la conexion esta caida: forzar reconexion en el proximo ciclo.
		s.client.close()
	}
	log.Printf("[modbus] %s: %d/%d equipo(s) con datos validos", s.cfg.Name, valid, len(s.cfg.Devices))

	out := make([]discovery.Device, 0, len(s.seen))
	for _, d := range s.seen {
		out = append(out, d)
	}
	return out
}

// readDevice lee y decodifica el bloque del equipo; si no pasa la validacion del perfil prueba
// los registros iniciales alternativos. Devuelve readings=nil si ninguno trae datos validos.
func (s *Source) readDevice(dev config.ModbusDevice, p profile) (map[string]float64, int, error) {
	starts := append([]int{dev.Start}, dev.StartCandidates...)
	var lastErr error
	for _, start := range starts {
		if start <= 0 {
			continue
		}
		regs, err := s.readBlock(start, p.Length)
		if err != nil {
			lastErr = err
			continue
		}
		values := decode(p, regs)
		if p.Validate(values) {
			return values, start, nil
		}
	}
	return nil, dev.Start, lastErr
}

func toInterfaceMap(m map[string]float64) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

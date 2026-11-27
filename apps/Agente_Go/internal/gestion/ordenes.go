package gestion

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Segundos que la API retiene la consulta de ordenes si no hay ninguna (consulta larga).
const esperaOrdenes = 25

// bucleOrdenes toma las ordenes de la API apenas se crean y devuelve el resultado de cada una.
func (s *Source) bucleOrdenes() {
	cliente := &http.Client{Timeout: 10 * time.Second}
	avisado := time.Time{}
	for {
		select {
		case <-s.stop:
			return
		default:
		}
		r, err := s.api.tomarOrdenes(esperaOrdenes)
		if err != nil {
			if time.Since(avisado) > time.Minute {
				log.Printf("[gestion/ordenes] no se pudo consultar ordenes: %v", err)
				avisado = time.Now()
			}
			select {
			case <-s.stop:
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}
		s.mu.Lock()
		cambioPlan := s.plan != nil && r.VersionPlan != s.plan.Version
		s.mu.Unlock()
		if cambioPlan {
			select {
			case s.cambio <- struct{}{}:
			default:
			}
		}
		// En orden de llegada: dos clics seguidos se aplican en el mismo orden.
		for _, o := range r.Ordenes {
			motivo := s.ejecutar(cliente, o)
			if motivo == "" {
				log.Printf("[gestion/ordenes] %q: %s OK", o.Dispositivo, describir(o.Orden))
			} else {
				log.Printf("[gestion/ordenes] %q: %s FALLO: %s", o.Dispositivo, describir(o.Orden), motivo)
			}
			if err := s.api.resultado(o.ID, motivo == "", motivo); err != nil {
				log.Printf("[gestion/ordenes] no se pudo informar el resultado de %s: %v", o.ID, err)
			}
		}
	}
}

func describir(o Orden) string {
	switch o.Tipo {
	case "http":
		return o.Method + " " + o.Path
	case "mqtt":
		return "MQTT " + o.Topic
	case "bacnet":
		return fmt.Sprintf("BACnet %s (%d escritura(s))", o.Host, len(o.Escrituras))
	}
	return o.Tipo
}

// ejecutar valida y ejecuta una orden. Devuelve "" si salio bien o el motivo del fallo.
func (s *Source) ejecutar(cliente *http.Client, o OrdenEnviada) string {
	if !o.Vence.IsZero() && time.Now().After(o.Vence) {
		return "orden vencida: llego tarde al agente y no se ejecuto"
	}
	s.mu.Lock()
	plan, lh, lm, lb := s.plan, s.http, s.mqtt, s.bacnet
	s.mu.Unlock()
	if plan == nil {
		return "el agente todavia no tiene plan de equipos"
	}
	if err := permitida(plan, s.cfg.HostsPermitidos, o); err != nil {
		return err.Error()
	}
	switch o.Orden.Tipo {
	case "http":
		_, err := pedir(cliente, o.Orden.BaseURL, Plantilla{Method: o.Orden.Method, Path: o.Orden.Path, Headers: o.Orden.Headers, Body: o.Orden.Body})
		if err != nil {
			return err.Error()
		}
		if lh != nil {
			lh.releer()
		}
	case "mqtt":
		if err := lm.publicarOrden(o.Orden.Topic, o.Orden.Payload); err != nil {
			return err.Error()
		}
	case "bacnet":
		if err := lb.escribir(o.Orden.Host, o.Orden.Escrituras); err != nil {
			return err.Error()
		}
	default:
		return "tipo de orden desconocido: " + o.Orden.Tipo
	}
	return ""
}

// permitida: el agente solo actua sobre equipos de SU plan, aunque la orden venga de la API.
//   - HTTP: el host de la orden tiene que ser el de un equipo HTTP del plan.
//   - MQTT: el topico tiene que ser el topico de comando de un equipo del plan.
//   - BACnet: el host y el objeto tienen que ser puntos de un aire del plan.
//
// Si hostsPermitidos tiene valores, ademas el host tiene que estar en esa lista.
func permitida(plan *Plan, hostsPermitidos []string, o OrdenEnviada) error {
	var equipo *Equipo
	for i := range plan.Equipos {
		if plan.Equipos[i].ID == o.DeviceID {
			equipo = &plan.Equipos[i]
			break
		}
	}
	if equipo == nil {
		return fmt.Errorf("el equipo %q no esta en el plan de este agente", o.Dispositivo)
	}
	enLista := func(host string) bool {
		if len(hostsPermitidos) == 0 {
			return true
		}
		for _, h := range hostsPermitidos {
			if strings.EqualFold(strings.TrimSpace(h), host) {
				return true
			}
		}
		return false
	}
	switch o.Orden.Tipo {
	case "http":
		if equipo.HTTP == nil {
			return fmt.Errorf("%q no es un equipo HTTP en el plan", o.Dispositivo)
		}
		h, hp := hostDe(o.Orden.BaseURL), hostDe(equipo.HTTP.BaseURL)
		if h == "" || h != hp {
			return fmt.Errorf("host %q no corresponde al equipo %q", h, o.Dispositivo)
		}
		if !enLista(h) {
			return fmt.Errorf("host %q fuera de gestion.hostsPermitidos", h)
		}
	case "mqtt":
		if equipo.MQTT == nil || equipo.MQTT.CommandTopic == nil || *equipo.MQTT.CommandTopic != o.Orden.Topic {
			return fmt.Errorf("el topico %q no es el de comando de %q", o.Orden.Topic, o.Dispositivo)
		}
	case "bacnet":
		if equipo.BACnet == nil || equipo.BACnet.Host != o.Orden.Host {
			return fmt.Errorf("host BACnet %q no corresponde al aire %q", o.Orden.Host, o.Dispositivo)
		}
		if !enLista(o.Orden.Host) {
			return fmt.Errorf("host %q fuera de gestion.hostsPermitidos", o.Orden.Host)
		}
		if len(o.Orden.Escrituras) == 0 {
			return fmt.Errorf("orden BACnet sin escrituras")
		}
		for _, w := range o.Orden.Escrituras {
			if !puntoDelAire(equipo.BACnet.Points, w.Object) {
				return fmt.Errorf("el objeto BACnet %d:%d no pertenece al aire %q", w.Object.Type, w.Object.Instance, o.Dispositivo)
			}
			switch w.ValueType {
			case "boolean", "real", "enum":
			default:
				return fmt.Errorf("tipo de valor BACnet no permitido: %q", w.ValueType)
			}
		}
	}
	return nil
}

func puntoDelAire(points map[string]ObjRef, obj ObjRef) bool {
	for _, p := range points {
		if p == obj {
			return true
		}
	}
	return false
}

func hostDe(base string) string {
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	h := u.Hostname()
	if ip := net.ParseIP(h); ip != nil {
		return ip.String()
	}
	return strings.ToLower(h)
}

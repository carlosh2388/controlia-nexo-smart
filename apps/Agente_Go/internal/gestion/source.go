package gestion

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

type deviceT = discovery.Device

// Cada cuanto se vuelve a pedir el plan aunque la API no avise cambios.
const refrescoPlan = 5 * time.Minute

// lector es un protocolo (HTTP, MQTT, LoRaWAN, BACnet) leyendo los equipos del plan.
type lector interface {
	detener()
}

type Source struct {
	cfg config.GestionConfig
	api *apiClient

	mu       sync.Mutex
	plan     *Plan
	estado   map[string]discovery.Device // por ExternalID
	lectores []lector
	http     *lectorHTTP
	mqtt     *lectorMQTT
	bacnet   *lectorBACnet

	onUpdate func([]discovery.Device)
	stop     chan struct{}
	cambio   chan struct{} // la API aviso una version nueva del plan
	once     sync.Once
}

func New(cfg config.GestionConfig, env Entorno) *Source {
	return &Source{
		cfg:    cfg,
		api:    newAPIClient(env),
		estado: map[string]discovery.Device{},
		stop:   make(chan struct{}),
		cambio: make(chan struct{}, 1),
	}
}

func (s *Source) Name() string { return "gestion:" + s.api.env.BuildingKey }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	s.onUpdate = onUpdate
	plan, err := s.api.plan()
	if err != nil {
		return fmt.Errorf("no se pudo pedir el plan de equipos a la API: %w", err)
	}
	s.aplicar(plan)
	go s.bucleOrdenes()
	go s.buclePlan()
	return nil
}

func (s *Source) Stop() {
	s.once.Do(func() {
		close(s.stop)
		s.mu.Lock()
		lectores := s.lectores
		s.lectores = nil
		s.mu.Unlock()
		for _, l := range lectores {
			l.detener()
		}
	})
}

func (s *Source) buclePlan() {
	t := time.NewTicker(refrescoPlan)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		case <-s.cambio:
		}
		plan, err := s.api.plan()
		if err != nil {
			log.Printf("[gestion] no se pudo refrescar el plan: %v", err)
			continue
		}
		s.mu.Lock()
		igual := s.plan != nil && mismoPlan(s.plan, plan)
		s.mu.Unlock()
		if !igual {
			s.aplicar(plan)
		}
	}
}

// aplicar arranca los lectores del plan nuevo (y detiene los del anterior).
func (s *Source) aplicar(plan *Plan) {
	s.mu.Lock()
	viejos := s.lectores
	s.lectores = nil
	s.plan = plan
	vigentes := map[string]bool{}
	for _, e := range plan.Equipos {
		vigentes[PrefijoID+e.ID] = true
	}
	for id := range s.estado {
		if !vigentes[id] {
			delete(s.estado, id)
		}
	}
	s.mu.Unlock()
	for _, l := range viejos {
		l.detener()
	}

	var http, bac, mq, lora []Equipo
	for _, e := range plan.Equipos {
		switch {
		case e.HTTP != nil:
			http = append(http, e)
		case e.BACnet != nil:
			bac = append(bac, e)
		case e.MQTT != nil:
			mq = append(mq, e)
		case e.LoRaWAN != nil:
			lora = append(lora, e)
		}
	}

	var (
		nuevos []lector
		lh     *lectorHTTP
		lb     *lectorBACnet
		lm     *lectorMQTT
	)
	if len(http) > 0 {
		lh = nuevoLectorHTTP(http, s.publicar)
		nuevos = append(nuevos, lh)
	}
	if len(bac) > 0 || s.cfg.BACnetBridgeURL != "" {
		lb = nuevoLectorBACnet(s.cfg.BACnetBridgeURL, s.cfg.BACnetBridgeToken, bac, s.publicar)
		nuevos = append(nuevos, lb)
	}
	// MQTT queda conectado aunque no haya equipos: lo usan las ordenes.
	if s.cfg.MQTT != nil {
		m, err := nuevoLectorMQTT("agente-go-gestion-mqtt", *s.cfg.MQTT, mq, s.publicar)
		if err != nil {
			log.Printf("[gestion] MQTT: %v (se reintenta al refrescar el plan)", err)
		} else {
			lm = m
			nuevos = append(nuevos, m)
		}
	} else if len(mq) > 0 {
		log.Printf("[gestion] hay %d equipo(s) MQTT en el plan pero falta gestion.mqtt en la config", len(mq))
	}
	if len(lora) > 0 {
		if s.cfg.LoRaWAN == nil {
			log.Printf("[gestion] hay %d sensor(es) LoRaWAN en el plan pero falta gestion.lorawan en la config", len(lora))
		} else if l, err := nuevoLectorLoRaWAN(*s.cfg.LoRaWAN, lora, s.publicar); err != nil {
			log.Printf("[gestion] LoRaWAN: %v (se reintenta al refrescar el plan)", err)
		} else {
			nuevos = append(nuevos, l)
		}
	}

	s.mu.Lock()
	s.lectores = nuevos
	s.http, s.bacnet, s.mqtt = lh, lb, lm
	s.mu.Unlock()
	log.Printf("[gestion] plan v%d: %d equipo(s) (HTTP %d, MQTT %d, LoRaWAN %d, BACnet %d)%s",
		plan.Version, len(plan.Equipos), len(http), len(mq), len(lora), len(bac), map[bool]string{true: " - la API los tiene en respaldo hasta el proximo sync", false: ""}[plan.Respaldo])
}

// publicar recibe la lectura nueva de un equipo y reenvia el snapshot completo al agente.
func (s *Source) publicar(d discovery.Device) {
	s.mu.Lock()
	if s.plan == nil {
		s.mu.Unlock()
		return
	}
	s.estado[d.ExternalID] = d
	out := make([]discovery.Device, 0, len(s.estado))
	for _, x := range s.estado {
		out = append(out, x)
	}
	s.mu.Unlock()
	s.onUpdate(out)
}

func dispositivo(e Equipo) discovery.Device {
	return discovery.Device{ExternalID: PrefijoID + e.ID, Name: e.Nombre, Protocol: e.Protocolo, Kind: e.Tipo}
}

func mismoPlan(a, b *Plan) bool {
	if len(a.Equipos) != len(b.Equipos) {
		return false
	}
	ja, _ := json.Marshal(a.Equipos)
	jb, _ := json.Marshal(b.Equipos)
	return string(ja) == string(jb)
}

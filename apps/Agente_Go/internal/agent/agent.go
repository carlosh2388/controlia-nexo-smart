// Package agent es el recolector: combina todas las fuentes de protocolo habilitadas en un solo
// snapshot, detecta eventos sobre cada lectura nueva (internal/events) y reenvia snapshot + eventos
// a la API central cada ciclo. No decide nada de negocio (no arma nombres bonitos, no asigna areas)
// - eso es a proposito trabajo de la API + un humano, no del agente.
package agent

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
	"agente-go/internal/events"
	"agente-go/internal/reporter"
)

// Maximo de eventos por sync; si hay mas pendientes (ej. tras una caida larga de la API) se
// envian en los ciclos siguientes, los mas antiguos primero.
const maxEventsPerSync = 500

type Agent struct {
	cfg      *config.Config
	sources  []discovery.Source
	reporter *reporter.Client
	version  string

	// nil si events.enabled: false en la config.
	engine *events.Engine
	store  *events.Store

	// Un evento critico dispara un sync inmediato en vez de esperar el proximo tick.
	kick chan struct{}

	mu       sync.Mutex
	snapshot map[string]discovery.Device // combinado de todas las fuentes, por ExternalID
}

func New(cfg *config.Config, sources []discovery.Source, rep *reporter.Client, version string) (*Agent, error) {
	a := &Agent{
		cfg:      cfg,
		sources:  sources,
		reporter: rep,
		version:  version,
		kick:     make(chan struct{}, 1),
		snapshot: map[string]discovery.Device{},
	}
	if cfg.Events.IsEnabled() {
		store, state, err := events.OpenStore(cfg.DataDir, cfg.Events.MaxPending)
		if err != nil {
			return nil, err
		}
		a.store = store
		a.engine = events.NewEngine(cfg.Events.Thresholds, state)
	}
	return a, nil
}

func (a *Agent) Run(ctx context.Context) error {
	for _, src := range a.sources {
		if err := src.Start(a.mergeUpdate); err != nil {
			return fmt.Errorf("no se pudo iniciar la fuente %q: %w", src.Name(), err)
		}
	}
	defer func() {
		for _, src := range a.sources {
			src.Stop()
		}
		if a.engine != nil {
			a.store.SaveState(a.engine.Snapshot())
		}
	}()

	log.Printf(
		"agente %s iniciado: edificio=%q intervalo=%ds fuentes=%d eventos=%v datos=%s",
		a.version, a.cfg.BuildingKey, a.cfg.SyncIntervalSeconds, len(a.sources), a.engine != nil, a.cfg.DataDir,
	)

	ticker := time.NewTicker(time.Duration(a.cfg.SyncIntervalSeconds) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("agente deteniendose...")
			return nil
		case <-ticker.C:
			a.syncNow()
		case <-a.kick:
			a.syncNow()
		}
	}
}

// mergeUpdate lo llama cualquier Source con SU snapshot completo; se mezcla por ExternalID en el
// snapshot combinado que se manda en el proximo tick. Los eventos se detectan aca mismo, sobre
// cada lectura nueva (tiempo real); el envio a la API va en el proximo sync, salvo que haya un
// evento critico, que adelanta el sync.
func (a *Agent) mergeUpdate(devices []discovery.Device) {
	a.mu.Lock()
	for _, d := range devices {
		a.snapshot[d.ExternalID] = d
	}
	a.mu.Unlock()

	if a.engine == nil {
		return
	}
	evs := a.engine.Observe(devices, time.Now())
	a.recordEvents(evs)
}

func (a *Agent) recordEvents(evs []events.Event) {
	if len(evs) == 0 {
		return
	}
	a.store.Add(evs)
	critical := false
	for _, e := range evs {
		log.Printf("[evento] %-8s %-34s %s", e.Severity, e.Type, e.Message)
		if e.Severity == events.Critical {
			critical = true
		}
	}
	if critical {
		select {
		case a.kick <- struct{}{}:
		default:
		}
	}
}

func (a *Agent) syncNow() {
	a.mu.Lock()
	byID := make(map[string]discovery.Device, len(a.snapshot))
	for k, d := range a.snapshot {
		byID[k] = d
	}
	a.mu.Unlock()

	var pending []events.Event
	if a.engine != nil {
		// Marca offline (solo en esta copia) los sensores LoRaWAN que dejaron de transmitir.
		a.recordEvents(a.engine.CheckStale(byID, time.Now()))
		pending = a.store.Pending(maxEventsPerSync)
		defer a.store.SaveState(a.engine.Snapshot())
	}

	devices := make([]discovery.Device, 0, len(byID))
	for _, d := range byID {
		devices = append(devices, d)
	}
	if len(devices) == 0 && len(pending) == 0 {
		log.Println("sync omitido: todavia no se descubrio ningun dispositivo")
		return
	}

	result, err := a.reporter.Sync(a.cfg.BuildingKey, a.version, devices, pending)
	if err != nil {
		left := 0
		if a.store != nil {
			left = a.store.Count()
		}
		log.Printf("error sincronizando con la API (eventos en espera: %d): %v", left, err)
		return
	}
	if a.store != nil {
		a.store.Ack(pending)
	}
	log.Printf(
		"sync OK: total=%d nuevos=%d actualizados=%d ya-existian=%d eventos=%d/%d",
		result.Total, result.Created, result.Updated, result.SkippedExisting, result.EventsRecorded, len(pending),
	)
}

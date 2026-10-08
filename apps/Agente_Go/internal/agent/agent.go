// Package agent combina todas las fuentes de protocolo habilitadas en un solo snapshot y lo
// reenvia a la API central cada ciclo. No decide nada de negocio (no arma nombres bonitos, no
// asigna areas) - eso es a proposito trabajo de la API + un humano, no del agente.
package agent

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
	"agente-go/internal/reporter"
)

type Agent struct {
	cfg      *config.Config
	sources  []discovery.Source
	reporter *reporter.Client
	version  string

	mu       sync.Mutex
	snapshot map[string]discovery.Device // combinado de todas las fuentes, por ExternalID
}

func New(cfg *config.Config, sources []discovery.Source, rep *reporter.Client, version string) *Agent {
	return &Agent{
		cfg:      cfg,
		sources:  sources,
		reporter: rep,
		version:  version,
		snapshot: map[string]discovery.Device{},
	}
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
	}()

	log.Printf(
		"agente %s iniciado: edificio=%q intervalo=%ds fuentes=%d",
		a.version, a.cfg.BuildingKey, a.cfg.SyncIntervalSeconds, len(a.sources),
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
		}
	}
}

// mergeUpdate lo llama cualquier Source con SU snapshot completo; se mezcla por ExternalID en el
// snapshot combinado que se manda en el proximo tick. No dispara un sync inmediato a proposito:
// evita golpear la API en cada mensaje MQTT individual cuando hay muchos dispositivos ruidosos.
func (a *Agent) mergeUpdate(devices []discovery.Device) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, d := range devices {
		a.snapshot[d.ExternalID] = d
	}
}

func (a *Agent) syncNow() {
	a.mu.Lock()
	devices := make([]discovery.Device, 0, len(a.snapshot))
	for _, d := range a.snapshot {
		devices = append(devices, d)
	}
	a.mu.Unlock()

	if len(devices) == 0 {
		log.Println("sync omitido: todavia no se descubrio ningun dispositivo")
		return
	}

	result, err := a.reporter.Sync(a.cfg.BuildingKey, a.version, devices)
	if err != nil {
		log.Printf("error sincronizando con la API: %v", err)
		return
	}
	log.Printf(
		"sync OK: total=%d nuevos=%d actualizados=%d ya-existian=%d",
		result.Total, result.Created, result.Updated, result.SkippedExisting,
	)
}

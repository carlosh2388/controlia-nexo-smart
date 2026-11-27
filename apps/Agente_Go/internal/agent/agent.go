// Package agent es el recolector: combina todas las fuentes de protocolo habilitadas en un solo
// snapshot, detecta eventos sobre cada lectura nueva (internal/events) y reenvia snapshot + eventos
// a la API central cada ciclo. No decide nada de negocio (no arma nombres bonitos, no asigna areas)
// - eso es a proposito trabajo de la API + un humano, no del agente.
//
// Las fuentes se arrancan por seccion de config (mqtt, lorawan, bacnet, modbus, loraGateway). Si
// la config remota cambia (ver remote.go), solo se reinician las secciones que cambiaron.
package agent

import (
	"context"
	"log"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"agente-go/internal/backlog"
	"agente-go/internal/config"
	"agente-go/internal/discovery"
	"agente-go/internal/events"
	"agente-go/internal/gestion"
	"agente-go/internal/reporter"
)

// Maximo de eventos por sync; si hay mas pendientes (ej. tras una caida larga de la API) se
// envian en los ciclos siguientes, los mas antiguos primero.
const maxEventsPerSync = 500

// Cada cuanto se reintenta arrancar una fuente que fallo (broker caido, bridge apagado, puerto ocupado).
const retryFailedInterval = time.Minute

type Agent struct {
	cfg      *config.Config
	reporter *reporter.Client
	version  string

	// nil si events.enabled: false en la config.
	engine *events.Engine
	store  *events.Store

	// Lecturas Modbus que no se pudieron entregar, en disco (dataDir/backlog). Solo las toca syncNow.
	backlog    *backlog.Store
	lastQueued map[string]time.Time

	// Un evento critico o una config nueva disparan un sync inmediato en vez de esperar el proximo tick.
	kick chan struct{}

	mu       sync.Mutex
	snapshot map[string]discovery.Device // combinado de todas las fuentes, por ExternalID
	owner    map[string]string           // ExternalID -> seccion que lo reporto
	gen      map[string]int              // sube al reiniciar una seccion: descarta updates de fuentes viejas

	// Solo los toca la goroutine de Run.
	protocols config.Protocols
	started   bool
	sections  map[string]*section
	remote    remoteState

	scanning atomic.Bool
}

type section struct {
	updater func([]discovery.Device)
	running []discovery.Source
	failed  []discovery.Source
	errs    map[string]string // por src.Name()
	// La seccion ni siquiera se pudo armar (ej. llaves LoRa invalidas).
	buildErr string
}

func New(cfg *config.Config, rep *reporter.Client, version string) (*Agent, error) {
	a := &Agent{
		cfg:        cfg,
		reporter:   rep,
		version:    version,
		kick:       make(chan struct{}, 1),
		snapshot:   map[string]discovery.Device{},
		owner:      map[string]string{},
		gen:        map[string]int{},
		sections:   map[string]*section{},
		lastQueued: map[string]time.Time{},
	}
	bl, err := backlog.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	a.backlog = bl
	if n := bl.Count(); n > 0 {
		log.Printf("[backlog] %d bloque(s) de 5 min pendientes de reenviar desde el disco", n)
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
	protocols, version := a.initialConfig()
	problems := a.applyProtocols(protocols)
	if version > 0 {
		a.remote.version = version
		a.reportApplied(version, problems, false)
	}
	defer func() {
		for _, s := range a.sections {
			for _, src := range s.running {
				src.Stop()
			}
		}
		if a.engine != nil {
			a.store.SaveState(a.engine.Snapshot())
		}
	}()

	running := 0
	for _, s := range a.sections {
		running += len(s.running)
	}
	log.Printf(
		"agente %s iniciado: edificio=%q intervalo=%ds fuentes=%d config=%s eventos=%v datos=%s",
		a.version, a.cfg.BuildingKey, a.cfg.SyncIntervalSeconds, running, a.configLabel(), a.engine != nil, a.cfg.DataDir,
	)
	if running == 0 && problems == "" {
		log.Println("ninguna fuente habilitada: el agente queda esperando que se configure desde la web (Agente Go > Configuracion)")
	}

	ticker := time.NewTicker(time.Duration(a.cfg.SyncIntervalSeconds) * time.Second)
	defer ticker.Stop()
	retry := time.NewTicker(retryFailedInterval)
	defer retry.Stop()
	// Sin config remota el canal queda en nil y ese case nunca se dispara.
	var control <-chan time.Time
	if a.cfg.RemoteEnabled() {
		t := time.NewTicker(controlInterval)
		defer t.Stop()
		control = t.C
	}

	for {
		select {
		case <-ctx.Done():
			log.Println("agente deteniendose...")
			return nil
		case <-ticker.C:
			a.syncNow()
		case <-a.kick:
			a.syncNow()
		case <-control:
			a.controlTick()
		case <-retry.C:
			a.retryFailed()
		}
	}
}

func (a *Agent) configLabel() string {
	if !a.cfg.RemoteEnabled() {
		return "local (remoteConfig: false)"
	}
	if a.remote.version > 0 {
		return "remota v" + itoa(a.remote.version)
	}
	return "local (sin version remota todavia)"
}

// applyProtocols arranca la config nueva reiniciando solo las secciones que cambiaron. Devuelve
// los problemas de arranque (texto vacio si todo arranco).
func (a *Agent) applyProtocols(next config.Protocols) string {
	for _, name := range sectionNames {
		if !a.started || sectionKey(a.protocols, name) != sectionKey(next, name) {
			a.restartSection(next, name)
		}
	}
	a.protocols = next
	a.started = true
	return a.problems()
}

func (a *Agent) restartSection(p config.Protocols, name string) {
	if old := a.sections[name]; old != nil {
		for _, src := range old.running {
			log.Printf("[config] deteniendo %s", src.Name())
			src.Stop()
		}
	}

	a.mu.Lock()
	a.gen[name]++
	gen := a.gen[name]
	// Lo que reportaba la seccion vieja deja de reenviarse; lo nuevo llega con el primer update.
	for id, owner := range a.owner {
		if owner == name {
			delete(a.snapshot, id)
			delete(a.owner, id)
		}
	}
	a.mu.Unlock()

	s := &section{errs: map[string]string{}}
	a.sections[name] = s
	srcs, err := buildSection(p, name, gestion.Entorno{APIURL: a.cfg.API.BaseURL, APIKey: a.cfg.API.APIKey, BuildingKey: a.cfg.BuildingKey})
	if err != nil {
		s.buildErr = err.Error()
		log.Printf("[config] %s: %v", name, err)
		return
	}
	s.updater = a.updaterFor(name, gen)
	for _, src := range srcs {
		a.startSource(s, src)
	}
}

func (a *Agent) startSource(s *section, src discovery.Source) {
	if err := src.Start(s.updater); err != nil {
		log.Printf("no se pudo iniciar la fuente %q (se reintenta cada %s): %v", src.Name(), retryFailedInterval, err)
		s.failed = append(s.failed, src)
		s.errs[src.Name()] = err.Error()
		return
	}
	delete(s.errs, src.Name())
	s.running = append(s.running, src)
}

func (a *Agent) retryFailed() {
	retried := false
	for _, s := range a.sections {
		failed := s.failed
		s.failed = nil
		for _, src := range failed {
			retried = true
			a.startSource(s, src)
		}
	}
	if retried && a.remote.version > 0 {
		if problems := a.problems(); problems != a.remote.lastProblems {
			a.reportApplied(a.remote.version, problems, false)
		}
	}
}

func (a *Agent) problems() string {
	var out []string
	for _, name := range sectionNames {
		s := a.sections[name]
		if s == nil {
			continue
		}
		if s.buildErr != "" {
			out = append(out, name+": "+s.buildErr)
		}
		for src, msg := range s.errs {
			out = append(out, src+": "+msg)
		}
	}
	sort.Strings(out)
	return strings.Join(out, "; ")
}

// updaterFor es el onUpdate de las fuentes de una seccion: mezcla SU snapshot completo por
// ExternalID en el snapshot combinado que se manda en el proximo tick. Los eventos se detectan aca
// mismo, sobre cada lectura nueva (tiempo real); el envio a la API va en el proximo sync, salvo
// que haya un evento critico, que adelanta el sync.
func (a *Agent) updaterFor(name string, gen int) func([]discovery.Device) {
	return func(devices []discovery.Device) {
		a.mu.Lock()
		if a.gen[name] != gen {
			// Fuente de una config anterior que todavia no termino de detenerse.
			a.mu.Unlock()
			return
		}
		cambio := false
		for _, d := range devices {
			// Equipos que el agente maneja en lugar de la API (luces, interruptores, aires): un
			// cambio de encendido/apagado se manda enseguida, sin esperar el proximo sync.
			if name == "gestion" && d.State != "" {
				if prev, ok := a.snapshot[d.ExternalID]; !ok || prev.State != d.State {
					cambio = true
				}
			}
			a.snapshot[d.ExternalID] = d
			a.owner[d.ExternalID] = name
		}
		a.mu.Unlock()
		if cambio {
			a.kickSync()
		}

		if a.engine == nil {
			return
		}
		evs := a.engine.Observe(devices, time.Now())
		a.recordEvents(evs)
	}
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
		a.kickSync()
	}
}

func (a *Agent) kickSync() {
	select {
	case a.kick <- struct{}{}:
	default:
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
		saved := a.saveBacklog(devices)
		log.Printf("error sincronizando con la API (eventos en espera: %d, lecturas guardadas en disco: %d): %v", left, saved, err)
		return
	}
	if a.store != nil {
		a.store.Ack(pending)
	}
	log.Printf(
		"sync OK: total=%d nuevos=%d actualizados=%d ya-existian=%d eventos=%d/%d",
		result.Total, result.Created, result.Updated, result.SkippedExisting, result.EventsRecorded, len(pending),
	)
	a.flushBacklog()
}

// Bloques de 5 minutos que se reenvian por cada sync correcto: 4 = 20 min de datos cada 15-30 s,
// asi un corte de un dia se pone al dia en menos de una hora sin saturar a la API.
const backlogFilesPerSync = 4

// saveBacklog guarda en disco las lecturas Modbus que no se pudieron entregar (una sola vez cada
// lectura: el sync siguiente puede volver a fallar con el mismo snapshot).
func (a *Agent) saveBacklog(devices []discovery.Device) int {
	if a.backlog == nil {
		return 0
	}
	var entries []backlog.Entry
	for _, d := range devices {
		if d.Protocol != "modbus" || d.ReadAt == nil || d.State == "offline" || len(d.Readings) == 0 {
			continue
		}
		if last, ok := a.lastQueued[d.ExternalID]; ok && !d.ReadAt.After(last) {
			continue
		}
		entries = append(entries, backlog.Entry{ExternalID: d.ExternalID, ReadAt: *d.ReadAt, Readings: d.Readings})
		a.lastQueued[d.ExternalID] = *d.ReadAt
	}
	if err := a.backlog.Append(entries); err != nil {
		log.Printf("[backlog] no se pudieron guardar %d lecturas: %v", len(entries), err)
		return 0
	}
	return len(entries)
}

// flushBacklog reenvia los bloques pendientes mas viejos. Si la API rechaza un bloque por su
// contenido (4xx) se descarta para no quedar trabado; si vuelve a fallar la conexion, se reintenta.
func (a *Agent) flushBacklog() {
	if a.backlog == nil {
		return
	}
	for i := 0; i < backlogFilesPerSync; i++ {
		name, entries, ok, err := a.backlog.Oldest()
		if !ok {
			return
		}
		if err != nil || len(entries) == 0 {
			log.Printf("[backlog] bloque %s ilegible o vacio, se descarta: %v", name, err)
			a.backlog.Remove(name)
			continue
		}
		res, err := a.reporter.SendBacklog(a.cfg.BuildingKey, a.version, entries)
		if err != nil {
			if reporter.Rejected(err) {
				log.Printf("[backlog] la API rechazo el bloque %s (%d lecturas), se descarta: %v", name, len(entries), err)
				a.backlog.Remove(name)
				continue
			}
			log.Printf("[backlog] no se pudo reenviar %s, se reintenta en el proximo sync: %v", name, err)
			return
		}
		a.backlog.Remove(name)
		log.Printf("[backlog] reenviado %s: %d lecturas atrasadas, %d valores guardados (quedan %d bloques)", name, len(entries), res.BacklogRecorded, a.backlog.Count())
	}
}

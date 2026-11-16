package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/reporter"
	"agente-go/internal/scan"
)

// Configuracion remota: la web guarda la config en la API (Agente Go > Configuracion) y el agente
// la consulta cada controlInterval. El agente no abre puertos para esto; todo lo inicia el.

const (
	controlInterval = 5 * time.Second
	cacheFile       = "remote-config.json"
	scanMaxDuration = 10 * time.Minute
	scanUploadEvery = 2 * time.Second
)

type remoteState struct {
	// Version de config remota que esta corriendo (0 = la de config.yaml, sin version remota).
	version int
	// Version que el agente rechazo por invalida: no se vuelve a descargar hasta que haya otra.
	rejected     int
	lastProblems string
	apiOK        bool
	lastScanID   string
	lastSeedTry  time.Time
}

type cachedConfig struct {
	Version int             `json:"version"`
	Config  json.RawMessage `json:"config"`
}

// initialConfig decide con que protocolos arrancar:
//  1. la config remota, si la API responde;
//  2. si la API no tiene config para este buildingKey, la de config.yaml, que se sube como v1;
//  3. si la API no responde, la ultima config remota guardada en dataDir;
//  4. si no hay copia, la de config.yaml.
func (a *Agent) initialConfig() (config.Protocols, int) {
	local := a.cfg.Protocols
	if !a.cfg.RemoteEnabled() {
		return local, 0
	}

	rc, err := a.reporter.GetConfig(a.cfg.BuildingKey)
	switch {
	case err == nil:
		a.remote.apiOK = true
		p, perr := config.ProtocolsFromJSON(rc.Config)
		if perr == nil {
			a.saveCache(rc)
			return p, rc.Version
		}
		log.Printf("[config] la config remota v%d no es valida, se ignora: %v", rc.Version, perr)
		a.remote.rejected = rc.Version
		a.reportApplied(rc.Version, perr.Error(), true)
	case errors.Is(err, reporter.ErrNotFound):
		a.remote.apiOK = true
		if p, v, ok := a.seed(local); ok {
			return p, v
		}
		return local, 0
	default:
		log.Printf("[config] la API no responde (%v); se usa la ultima config guardada", err)
	}

	if cached, err := a.loadCache(); err == nil {
		if p, perr := config.ProtocolsFromJSON(cached.Config); perr == nil {
			log.Printf("[config] usando la copia local de la config remota v%d", cached.Version)
			return p, cached.Version
		}
	}
	return local, 0
}

// seed sube los protocolos de config.yaml como version 1 de la config remota. Si la API ya tenia
// una (otro proceso la creo en el medio), devuelve esa.
func (a *Agent) seed(local config.Protocols) (config.Protocols, int, bool) {
	data, err := local.ToJSON()
	if err != nil {
		log.Printf("[config] no se pudo preparar config.yaml para subirla: %v", err)
		return local, 0, false
	}
	rc, err := a.reporter.SeedConfig(a.cfg.BuildingKey, data)
	if err != nil {
		log.Printf("[config] no se pudo subir config.yaml como config remota: %v", err)
		return local, 0, false
	}
	p, perr := config.ProtocolsFromJSON(rc.Config)
	if perr != nil {
		log.Printf("[config] la config remota v%d no es valida: %v", rc.Version, perr)
		return local, 0, false
	}
	a.saveCache(rc)
	log.Printf("[config] config.yaml subida a la API como config remota v%d: desde ahora se edita en la web", rc.Version)
	return p, rc.Version, true
}

// controlTick pregunta a la API si hay una version nueva de config o un escaneo pendiente.
func (a *Agent) controlTick() {
	ctl, err := a.reporter.Control(a.cfg.BuildingKey)
	if err != nil {
		if a.remote.apiOK {
			log.Printf("[config] sin conexion con la API para la config remota: %v", err)
		}
		a.remote.apiOK = false
		return
	}
	if !a.remote.apiOK {
		log.Println("[config] conexion con la API restablecida")
	}
	a.remote.apiOK = true

	switch {
	case ctl.ConfigVersion == 0:
		// La API no tiene config para este agente (ej. arranco sin API): subir la que esta corriendo.
		if time.Since(a.remote.lastSeedTry) < time.Minute {
			break
		}
		a.remote.lastSeedTry = time.Now()
		if p, v, ok := a.seed(a.protocols); ok {
			a.applyRemote(p, v)
		}
	case ctl.ConfigVersion != a.remote.version && ctl.ConfigVersion != a.remote.rejected:
		a.fetchAndApply()
	}

	if len(ctl.Scan) > 0 && string(ctl.Scan) != "null" && !a.scanning.Load() {
		var req scan.Request
		if err := json.Unmarshal(ctl.Scan, &req); err != nil {
			log.Printf("[scan] pedido invalido: %v", err)
			return
		}
		if req.ID != "" && req.ID != a.remote.lastScanID {
			a.remote.lastScanID = req.ID
			a.scanning.Store(true)
			opts := scan.Options{}
			if b := a.protocols.BACnet; b != nil {
				opts.BACnetBridgeURL, opts.BACnetBridgeToken = b.BridgeURL, b.BridgeToken
			}
			go a.runScan(req, opts)
		}
	}
}

func (a *Agent) fetchAndApply() {
	rc, err := a.reporter.GetConfig(a.cfg.BuildingKey)
	if err != nil {
		log.Printf("[config] no se pudo descargar la config remota: %v", err)
		return
	}
	p, perr := config.ProtocolsFromJSON(rc.Config)
	if perr != nil {
		log.Printf("[config] v%d rechazada, se sigue con la v%d: %v", rc.Version, a.remote.version, perr)
		a.remote.rejected = rc.Version
		a.reportApplied(rc.Version, perr.Error(), true)
		return
	}
	a.saveCache(rc)
	a.applyRemote(p, rc.Version)
}

func (a *Agent) applyRemote(p config.Protocols, version int) {
	log.Printf("[config] aplicando config remota v%d (antes v%d)", version, a.remote.version)
	problems := a.applyProtocols(p)
	a.remote.version = version
	a.reportApplied(version, problems, false)
	a.kickSync()
}

func (a *Agent) reportApplied(version int, problems string, rejected bool) {
	if !rejected {
		a.remote.lastProblems = problems
	}
	if err := a.reporter.ConfigApplied(a.cfg.BuildingKey, version, problems, rejected); err != nil {
		log.Printf("[config] no se pudo avisar a la API que se aplico la v%d: %v", version, err)
	}
}

func (a *Agent) cachePath() string { return filepath.Join(a.cfg.DataDir, cacheFile) }

func (a *Agent) saveCache(rc *reporter.RemoteConfig) {
	data, err := json.Marshal(cachedConfig{Version: rc.Version, Config: rc.Config})
	if err == nil {
		_ = os.MkdirAll(a.cfg.DataDir, 0o755)
		// Tiene contraseñas y llaves LoRa, igual que config.yaml: solo lectura para el usuario del agente.
		err = os.WriteFile(a.cachePath(), data, 0o600)
	}
	if err != nil {
		log.Printf("[config] no se pudo guardar la copia local de la config: %v", err)
	}
}

func (a *Agent) loadCache() (*cachedConfig, error) {
	data, err := os.ReadFile(a.cachePath())
	if err != nil {
		return nil, err
	}
	var c cachedConfig
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// runScan ejecuta un escaneo pedido desde la web y sube el avance cada scanUploadEvery.
func (a *Agent) runScan(req scan.Request, opts scan.Options) {
	defer a.scanning.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), scanMaxDuration)
	defer cancel()

	startedAt := time.Now().UTC().Format(time.RFC3339)
	log.Printf("[scan] %s: %d item(s)", req.ID, len(req.Items))
	upload := func(status string, progress map[string]scan.Progress, results []scan.Result, problem string) {
		if results == nil {
			results = []scan.Result{}
		}
		body := map[string]interface{}{"status": status, "results": results, "progress": progress, "startedAt": startedAt}
		if problem != "" {
			body["error"] = problem
		}
		if status != "running" {
			body["finishedAt"] = time.Now().UTC().Format(time.RFC3339)
		}
		if err := a.reporter.ScanResult(a.cfg.BuildingKey, req.ID, body); err != nil {
			log.Printf("[scan] no se pudo subir el avance: %v", err)
		}
	}

	var mu sync.Mutex
	var last time.Time
	var lastProgress map[string]scan.Progress
	onProgress := func(p map[string]scan.Progress, results []scan.Result) {
		mu.Lock()
		lastProgress = p
		due := time.Since(last) >= scanUploadEvery
		if due {
			last = time.Now()
		}
		mu.Unlock()
		if due {
			upload("running", p, results, "")
		}
	}

	results, err := scan.Run(ctx, req, opts, onProgress)
	mu.Lock()
	progress := lastProgress
	mu.Unlock()
	status, problem := "done", ""
	if err != nil {
		problem = err.Error()
		if len(results) == 0 {
			status = "error"
		}
	}
	log.Printf("[scan] %s terminado: %d respuesta(s) %s", req.ID, len(results), problem)
	upload(status, progress, results, problem)
}

func itoa(n int) string { return strconv.Itoa(n) }

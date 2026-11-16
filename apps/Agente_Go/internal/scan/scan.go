// Package scan es el descubrimiento de equipos que pide la web (Agente Go > Configuracion >
// Buscar dispositivos en la red). Recorre solo las IP que escribio el operador y solo hace
// lecturas: conexion TCP al puerto, una lectura Modbus 03 de un registro por unit ID, y Who-Is
// BACnet a traves de apps/bacnet-bridge. No escribe registros ni envia comandos.
package scan

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"agente-go/internal/discovery/modbussource"
)

// Limites para no cargar la red de una sede en produccion.
const (
	maxHostsPerItem   = 1024
	maxBrokersPerItem = 16
	workers           = 32
	dialTimeout       = 700 * time.Millisecond
	probeTimeout      = 1500 * time.Millisecond
)

type Item struct {
	Protocol string   `json:"protocol"` // "modbus" | "bacnet" | "mqtt" | "lorawan"
	Targets  []string `json:"targets"`
	Port     int      `json:"port,omitempty"`
	UnitIDs  string   `json:"unitIds,omitempty"`
}

type Request struct {
	ID    string `json:"id"`
	Items []Item `json:"items"`
}

type Result struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	// "ok" = respondio; "unreachable" = sin respuesta (solo se informa para brokers, que el operador
	// escribio uno por uno y necesita saber si fallan).
	Status   string `json:"status"`
	Detail   string `json:"detail"`
	UnitIDs  []int  `json:"unitIds,omitempty"`
	DeviceID *int   `json:"deviceId,omitempty"`
	VendorID *int   `json:"vendorId,omitempty"`
	// Modbus: que equipo es cada unit ID que respondio (ION7400 / PM2130 / generador) y por que.
	Devices []modbussource.Identity `json:"devices,omitempty"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// Options trae lo que el escaneo necesita de la config vigente del agente.
type Options struct {
	BACnetBridgeURL   string
	BACnetBridgeToken string
}

// Run ejecuta todos los items en orden. onProgress se llama seguido (el que llama decide cada
// cuanto lo sube a la API); recibe el avance por protocolo y una copia de los resultados.
func Run(ctx context.Context, req Request, opts Options, onProgress func(map[string]Progress, []Result)) ([]Result, error) {
	s := &state{progress: map[string]Progress{}, onProgress: onProgress}
	var problems []string
	for _, item := range req.Items {
		if ctx.Err() != nil {
			break
		}
		var err error
		switch item.Protocol {
		case "modbus":
			err = s.scanModbus(ctx, item)
		case "bacnet":
			err = s.scanBACnet(ctx, item, opts)
		case "mqtt", "lorawan":
			err = s.scanBrokers(ctx, item)
		default:
			err = fmt.Errorf("protocolo %q no se puede escanear", item.Protocol)
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", item.Protocol, err))
		}
	}
	results := s.snapshot()
	if len(problems) > 0 {
		return results, fmt.Errorf("%s", strings.Join(problems, "; "))
	}
	return results, nil
}

type state struct {
	mu         sync.Mutex
	results    []Result
	progress   map[string]Progress
	onProgress func(map[string]Progress, []Result)
}

func (s *state) add(r Result) {
	s.mu.Lock()
	s.results = append(s.results, r)
	s.mu.Unlock()
}

func (s *state) setProgress(protocol string, done, total int) {
	s.mu.Lock()
	s.progress[protocol] = Progress{Done: done, Total: total}
	prog := make(map[string]Progress, len(s.progress))
	for k, v := range s.progress {
		prog[k] = v
	}
	results := append([]Result(nil), s.results...)
	s.mu.Unlock()
	if s.onProgress != nil {
		s.onProgress(prog, results)
	}
}

func (s *state) snapshot() []Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Result(nil), s.results...)
}

// forEachHost reparte los hosts entre workers y reporta el avance a medida que terminan.
func (s *state) forEachHost(ctx context.Context, protocol string, hosts []string, fn func(host string)) {
	total := len(hosts)
	s.setProgress(protocol, 0, total)
	jobs := make(chan string)
	var done int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < workers && i < total; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for h := range jobs {
				fn(h)
				mu.Lock()
				done++
				d := done
				mu.Unlock()
				s.setProgress(protocol, d, total)
			}
		}()
	}
	for _, h := range hosts {
		if ctx.Err() != nil {
			break
		}
		jobs <- h
	}
	close(jobs)
	wg.Wait()
}

func tcpOpen(host string, port int, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (s *state) scanModbus(ctx context.Context, item Item) error {
	port := item.Port
	if port == 0 {
		port = 502
	}
	hosts, err := ExpandTargets(item.Targets, maxHostsPerItem)
	if err != nil {
		return err
	}
	units, err := ParseUnitIDs(item.UnitIDs)
	if err != nil {
		return err
	}
	s.forEachHost(ctx, "modbus", hosts, func(host string) {
		if !tcpOpen(host, port, dialTimeout) {
			return
		}
		found := modbussource.ProbeUnits(host, port, units, probeTimeout)
		detail := fmt.Sprintf("Puerto %d abierto, ningun unit ID respondio (probados: %s)", port, describeUnits(units))
		var devices []modbussource.Identity
		if len(found) > 0 {
			detail = fmt.Sprintf("Responde Modbus TCP · unit ID %s", describeUnits(found))
			// Reconoce cada equipo (solo lecturas 03, una consulta a la vez con pausas).
			for _, u := range found {
				if ctx.Err() != nil {
					break
				}
				devices = append(devices, modbussource.Identify(host, port, u, probeTimeout))
			}
		}
		s.add(Result{Protocol: "modbus", Host: host, Port: port, Status: "ok", Detail: detail, UnitIDs: found, Devices: devices})
	})
	return nil
}

func (s *state) scanBrokers(ctx context.Context, item Item) error {
	port := item.Port
	if port == 0 {
		port = 1883
	}
	hosts, err := ExpandTargets(item.Targets, maxBrokersPerItem)
	if err != nil {
		return err
	}
	s.forEachHost(ctx, item.Protocol, hosts, func(host string) {
		r := Result{Protocol: item.Protocol, Host: host, Port: port, Status: "unreachable", Detail: fmt.Sprintf("Sin respuesta en el puerto %d", port)}
		if tcpOpen(host, port, 2*time.Second) {
			r.Status = "ok"
			r.Detail = fmt.Sprintf("Broker MQTT alcanzable en el puerto %d", port)
		}
		s.add(r)
	})
	return nil
}

type whoIsResponse struct {
	Devices []struct {
		Address  string `json:"address"`
		DeviceID int    `json:"deviceId"`
		VendorID *int   `json:"vendorId"`
	} `json:"devices"`
}

func (s *state) scanBACnet(ctx context.Context, item Item, opts Options) error {
	if opts.BACnetBridgeURL == "" {
		return fmt.Errorf("falta la URL del bridge BACnet (seccion BACnet de la configuracion)")
	}
	hosts, err := ExpandTargets(item.Targets, maxHostsPerItem)
	if err != nil {
		return err
	}
	s.setProgress("bacnet", 0, len(hosts))

	body, _ := json.Marshal(map[string]interface{}{"hosts": hosts, "timeoutMs": 5000})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(opts.BACnetBridgeURL, "/")+"/who-is", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if opts.BACnetBridgeToken != "" {
		req.Header.Set("x-bridge-token", opts.BACnetBridgeToken)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo contactar al bridge BACnet: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("el bridge BACnet no tiene /who-is: actualizalo (apps/bacnet-bridge)")
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("el bridge BACnet respondio %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var out whoIsResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return fmt.Errorf("respuesta invalida del bridge BACnet: %w", err)
	}
	for _, d := range out.Devices {
		id := d.DeviceID
		detail := fmt.Sprintf("Dispositivo BACnet · instancia %d", id)
		if d.VendorID != nil {
			detail += fmt.Sprintf(" · fabricante %d", *d.VendorID)
		}
		s.add(Result{Protocol: "bacnet", Host: d.Address, Port: 47808, Status: "ok", Detail: detail, DeviceID: &id, VendorID: d.VendorID})
	}
	s.setProgress("bacnet", len(hosts), len(hosts))
	return nil
}

func describeUnits(units []int) string {
	parts := make([]string, len(units))
	for i, u := range units {
		parts[i] = fmt.Sprint(u)
	}
	return strings.Join(parts, ", ")
}

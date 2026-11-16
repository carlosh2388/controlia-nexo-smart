// Package backlog guarda en disco las lecturas Modbus que el agente no pudo entregar a la API (API,
// base de datos o red caidas) y las reenvia cuando la API vuelve, con su hora real de lectura.
//
// Formato: <dataDir>/backlog/<AAAAMMDDhhmm>.jsonl, un archivo por bloque de 5 minutos, una lectura
// por linea. Nada se guarda en memoria: cada lectura se escribe al final de su archivo y se olvida.
// Al reenviar se toma el archivo mas viejo (unos cientos de KB como maximo), y se borra cuando la API
// confirma. Tope: maxFiles archivos (3 dias); si se pasa, se descartan los mas viejos y queda en el log.
package backlog

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	segment  = 5 * time.Minute
	maxFiles = 3 * 24 * 12 // 3 dias de bloques de 5 minutos
)

// Entry replica AgentBacklogItemDto de la API (apps/api/src/devices/dto/agent-sync.dto.ts).
type Entry struct {
	ExternalID string                 `json:"externalId"`
	ReadAt     time.Time              `json:"readAt"`
	Readings   map[string]interface{} `json:"readings"`
}

type Store struct {
	dir string
	mu  sync.Mutex
}

func Open(dataDir string) (*Store, error) {
	dir := filepath.Join(dataDir, "backlog")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("no se pudo crear %s: %w", dir, err)
	}
	return &Store{dir: dir}, nil
}

func fileFor(t time.Time) string {
	return t.UTC().Truncate(segment).Format("200601021504") + ".jsonl"
}

// Append escribe las lecturas al final del archivo de su bloque de 5 minutos.
func (s *Store) Append(entries []Entry) error {
	if len(entries) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	byFile := map[string][]Entry{}
	for _, e := range entries {
		byFile[fileFor(e.ReadAt)] = append(byFile[fileFor(e.ReadAt)], e)
	}
	for name, list := range byFile {
		f, err := os.OpenFile(filepath.Join(s.dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		w := bufio.NewWriter(f)
		enc := json.NewEncoder(w)
		for _, e := range list {
			if err := enc.Encode(e); err != nil {
				f.Close()
				return err
			}
		}
		if err := w.Flush(); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	s.trim()
	return nil
}

func (s *Store) files() []string {
	list, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, f := range list {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".jsonl") {
			out = append(out, f.Name())
		}
	}
	sort.Strings(out) // AAAAMMDDhhmm: orden alfabetico = orden cronologico
	return out
}

// trim respeta el tope de 3 dias descartando los bloques mas viejos.
func (s *Store) trim() {
	files := s.files()
	for len(files) > maxFiles {
		if err := os.Remove(filepath.Join(s.dir, files[0])); err == nil {
			log.Printf("[backlog] tope de %d bloques: se descarta el mas viejo (%s)", maxFiles, files[0])
		}
		files = files[1:]
	}
}

// Count devuelve cuantos bloques de 5 minutos hay pendientes.
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.files())
}

// Oldest devuelve las lecturas del bloque mas viejo, sin borrarlo. ok=false si no hay pendientes.
// El agente escribe (sync fallido) y reenvia (sync correcto) desde la misma goroutine, asi que un
// bloque nunca recibe lecturas nuevas entre que se lee y se borra.
func (s *Store) Oldest() (name string, entries []Entry, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files := s.files()
	if len(files) == 0 {
		return "", nil, false, nil
	}
	name = files[0]
	f, err := os.Open(filepath.Join(s.dir, name))
	if err != nil {
		return name, nil, false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.ExternalID != "" {
			entries = append(entries, e)
		}
	}
	return name, entries, true, sc.Err()
}

// Remove borra un bloque ya entregado (o descartado).
func (s *Store) Remove(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.Remove(filepath.Join(s.dir, name))
}

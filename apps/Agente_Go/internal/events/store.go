package events

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// Store guarda en disco (dataDir) los eventos que todavia no confirmo la API y el estado del motor.
// Si la API o la red se caen, el agente sigue detectando eventos y los envia cuando vuelve: es lo
// que lo hace un recolector y no solo un reenviador.
//
//	<dataDir>/pending-events.json  eventos detectados y aun no confirmados por la API
//	<dataDir>/state.json           alarmas activas, contadores, ultima vez visto cada sensor
type Store struct {
	dir        string
	maxPending int

	mu      sync.Mutex
	pending []Event
}

func OpenStore(dir string, maxPending int) (*Store, State, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, State{}, fmt.Errorf("no se pudo crear %q: %w", dir, err)
	}
	s := &Store{dir: dir, maxPending: maxPending}

	if data, err := os.ReadFile(s.path("pending-events.json")); err == nil {
		if err := json.Unmarshal(data, &s.pending); err != nil {
			log.Printf("[eventos] pending-events.json invalido, se descarta: %v", err)
			s.pending = nil
		}
	}
	st := NewState()
	if data, err := os.ReadFile(s.path("state.json")); err == nil {
		if err := json.Unmarshal(data, &st); err != nil {
			log.Printf("[eventos] state.json invalido, se empieza de cero: %v", err)
			st = NewState()
		}
	}
	st.ensure()
	if len(s.pending) > 0 {
		log.Printf("[eventos] %d evento(s) pendiente(s) de enviar recuperados del disco", len(s.pending))
	}
	return s, st, nil
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

// writeAtomic escribe a un temporal y renombra, para no dejar un JSON a medias si se corta la luz.
func (s *Store) writeAtomic(name string, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[eventos] no se pudo serializar %s: %v", name, err)
		return
	}
	tmp := s.path(name + ".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("[eventos] no se pudo escribir %s: %v", name, err)
		return
	}
	if err := os.Rename(tmp, s.path(name)); err != nil {
		log.Printf("[eventos] no se pudo reemplazar %s: %v", name, err)
	}
}

func (s *Store) Add(evs []Event) {
	if len(evs) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = append(s.pending, evs...)
	if over := len(s.pending) - s.maxPending; over > 0 {
		log.Printf("[eventos] buffer lleno: se descartan los %d evento(s) mas antiguos", over)
		s.pending = s.pending[over:]
	}
	s.writeAtomic("pending-events.json", s.pending)
}

// Pending devuelve hasta max eventos, los mas antiguos primero.
func (s *Store) Pending(max int) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) < max {
		max = len(s.pending)
	}
	out := make([]Event, max)
	copy(out, s.pending[:max])
	return out
}

func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// Ack quita de la cola los eventos que la API ya guardo.
func (s *Store) Ack(sent []Event) {
	if len(sent) == 0 {
		return
	}
	done := make(map[string]bool, len(sent))
	for _, e := range sent {
		done[e.ID] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.pending[:0]
	for _, e := range s.pending {
		if !done[e.ID] {
			keep = append(keep, e)
		}
	}
	s.pending = keep
	s.writeAtomic("pending-events.json", s.pending)
}

func (s *Store) SaveState(st State) {
	s.writeAtomic("state.json", st)
}

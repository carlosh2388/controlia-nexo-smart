package backlog

import (
	"testing"
	"time"
)

func TestAppendOldestRemoveInOrder(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 11, 9, 22, 0, 10, 0, time.UTC)
	// Dos bloques de 5 minutos, escritos en desorden.
	if err := s.Append([]Entry{{ExternalID: "b", ReadAt: t0.Add(6 * time.Minute), Readings: map[string]interface{}{"x": 2.0}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append([]Entry{
		{ExternalID: "a", ReadAt: t0, Readings: map[string]interface{}{"x": 1.0}},
		{ExternalID: "a", ReadAt: t0.Add(30 * time.Second), Readings: map[string]interface{}{"x": 1.5}},
	}); err != nil {
		t.Fatal(err)
	}
	if s.Count() != 2 {
		t.Fatalf("se esperaban 2 bloques, hay %d", s.Count())
	}
	name, entries, ok, err := s.Oldest()
	if err != nil || !ok || len(entries) != 2 || entries[0].ExternalID != "a" || !entries[0].ReadAt.Equal(t0) {
		t.Fatalf("el bloque mas viejo deberia ser el de 'a' con 2 lecturas: %v %v %v", entries, ok, err)
	}
	s.Remove(name)
	_, entries, ok, _ = s.Oldest()
	if !ok || len(entries) != 1 || entries[0].ExternalID != "b" {
		t.Fatalf("despues de borrar, deberia quedar el bloque de 'b': %v", entries)
	}
}

func TestTrimKeepsMostRecent(t *testing.T) {
	s, _ := Open(t.TempDir())
	t0 := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < maxFiles+3; i++ {
		_ = s.Append([]Entry{{ExternalID: "a", ReadAt: t0.Add(time.Duration(i) * segment), Readings: map[string]interface{}{"x": float64(i)}}})
	}
	if s.Count() != maxFiles {
		t.Fatalf("tope: se esperaban %d bloques, hay %d", maxFiles, s.Count())
	}
	_, entries, _, _ := s.Oldest()
	if entries[0].Readings["x"].(float64) != 3 {
		t.Fatalf("deberian haberse descartado los 3 bloques mas viejos, el primero es %v", entries[0].Readings["x"])
	}
}

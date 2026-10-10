package gatewaysource

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"
)

// Compara el decodificador contra pares reales (bytes descifrados, objeto decodificado por
// ChirpStack) capturados en la sede Escuintla (testdata/chirpstack-pairs.json).
func TestDecodeMilesightMatchesChirpStack(t *testing.T) {
	raw, err := os.ReadFile("testdata/chirpstack-pairs.json")
	if err != nil {
		t.Fatal(err)
	}
	var pairs map[string][]struct {
		Hex    string                 `json:"hex"`
		Object map[string]interface{} `json:"object"`
	}
	if err := json.Unmarshal(raw, &pairs); err != nil {
		t.Fatal(err)
	}
	n := 0
	for model, list := range pairs {
		for _, p := range list {
			b, _ := hex.DecodeString(p.Hex)
			got, ok := DecodeMilesight(model, b)
			if !ok {
				t.Errorf("%s %s: canal desconocido", model, p.Hex)
				continue
			}
			for k, want := range p.Object {
				g, present := got[k]
				if !present {
					t.Errorf("%s %s: falta %q", model, p.Hex, k)
					continue
				}
				if wf, isNum := want.(float64); isNum {
					if math.Abs(g.(float64)-wf) > 0.001 {
						t.Errorf("%s %s: %s = %v, ChirpStack %v", model, p.Hex, k, g, wf)
					}
				} else if g != want {
					t.Errorf("%s %s: %s = %v, ChirpStack %v", model, p.Hex, k, g, want)
				}
			}
			n++
		}
	}
	if n < 10 {
		t.Fatalf("muy pocos pares verificados: %d", n)
	}
}

func TestDecodeMilesightEM300AndEM500(t *testing.T) {
	// Bytes armados segun el decodificador oficial de Milesight (em300-th: 03/67 int16 /10, 04/68 uint8 /2; em500-lgt: 03/94 uint32).
	b, _ := hex.DecodeString("0175640367100104686d")
	got, ok := DecodeMilesight("EM300-TH", b)
	if !ok || got["battery"] != 100.0 || got["temperature"] != 27.2 || got["humidity"] != 54.5 {
		t.Fatalf("EM300-TH: %v", got)
	}
	b, _ = hex.DecodeString("017564039410270000")
	got, ok = DecodeMilesight("EM500-LGT", b)
	if !ok || got["illumination"] != 10000.0 {
		t.Fatalf("EM500-LGT: %v", got)
	}
}

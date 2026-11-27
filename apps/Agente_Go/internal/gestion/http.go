package gestion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Home Assistant: GET /api/states/<entidad> devuelve el mismo objeto que trae, para esa entidad, la
// lista completa GET /api/states. Por eso los equipos del mismo Home Assistant se leen con UNA sola
// peticion por ciclo (118 Sonoff = 1 consulta cada 5 s, en vez de 118).
var rutaEstadoHA = regexp.MustCompile(`^/api/states/([^/?#]+)$`)

const intervaloHTTPDefault = 5 * time.Second

type lectorHTTP struct {
	publicar func(d deviceT)
	cliente  *http.Client
	stop     chan struct{}
	ahora    chan struct{}
	wg       sync.WaitGroup
}

// grupoHA: equipos del mismo Home Assistant (misma URL base y mismos encabezados).
type grupoHA struct {
	baseURL   string
	headers   map[string]string
	intervalo time.Duration
	equipos   map[string][]Equipo // entidad -> equipos (puede haber dos equipos sobre la misma entidad)
}

func nuevoLectorHTTP(equipos []Equipo, publicar func(d deviceT)) *lectorHTTP {
	l := &lectorHTTP{
		publicar: publicar,
		cliente:  &http.Client{Timeout: 10 * time.Second},
		stop:     make(chan struct{}),
		ahora:    make(chan struct{}, 1),
	}
	grupos, sueltos := agruparHA(equipos)
	for _, g := range grupos {
		l.wg.Add(1)
		go l.bucleGrupo(g)
	}
	for _, e := range sueltos {
		l.wg.Add(1)
		go l.bucleSuelto(e)
	}
	log.Printf("[gestion/http] %d equipo(s): %d Home Assistant en %d consulta(s) por ciclo, %d con consulta propia",
		len(equipos), len(equipos)-len(sueltos), len(grupos), len(sueltos))
	return l
}

func (l *lectorHTTP) detener() {
	close(l.stop)
	l.wg.Wait()
}

// releer adelanta la proxima lectura (despues de una orden).
func (l *lectorHTTP) releer() {
	select {
	case l.ahora <- struct{}{}:
	default:
	}
}

func agruparHA(equipos []Equipo) ([]*grupoHA, []Equipo) {
	grupos := map[string]*grupoHA{}
	var sueltos []Equipo
	for _, e := range equipos {
		est := e.HTTP.Estado
		m := rutaEstadoHA.FindStringSubmatch(est.Path)
		if m == nil || (est.Method != "" && !strings.EqualFold(est.Method, http.MethodGet)) || est.Body != nil {
			sueltos = append(sueltos, e)
			continue
		}
		hk, _ := json.Marshal(est.Headers)
		clave := e.HTTP.BaseURL + "|" + string(hk)
		g := grupos[clave]
		if g == nil {
			g = &grupoHA{baseURL: e.HTTP.BaseURL, headers: est.Headers, intervalo: time.Hour, equipos: map[string][]Equipo{}}
			grupos[clave] = g
		}
		entidad, _ := url.PathUnescape(m[1])
		g.equipos[entidad] = append(g.equipos[entidad], e)
		if iv := intervaloDe(e); iv < g.intervalo {
			g.intervalo = iv
		}
	}
	out := make([]*grupoHA, 0, len(grupos))
	for _, g := range grupos {
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].baseURL < out[j].baseURL })
	return out, sueltos
}

func intervaloDe(e Equipo) time.Duration {
	if e.HTTP.IntervaloMs >= 1000 {
		return time.Duration(e.HTTP.IntervaloMs) * time.Millisecond
	}
	return intervaloHTTPDefault
}

func (l *lectorHTTP) bucleGrupo(g *grupoHA) {
	defer l.wg.Done()
	avisado := time.Time{}
	for {
		if err := l.leerGrupo(g); err != nil && time.Since(avisado) > time.Minute {
			log.Printf("[gestion/http] %s: %v", g.baseURL, err)
			avisado = time.Now()
		}
		select {
		case <-l.stop:
			return
		case <-l.ahora:
		case <-time.After(g.intervalo):
		}
	}
}

func (l *lectorHTTP) leerGrupo(g *grupoHA) error {
	raw, err := pedir(l.cliente, g.baseURL, Plantilla{Method: http.MethodGet, Path: "/api/states", Headers: g.headers})
	if err != nil {
		return err
	}
	var lista []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &lista); err != nil {
		return fmt.Errorf("respuesta de /api/states no es una lista: %w", err)
	}
	for _, obj := range lista {
		var cab struct {
			EntityID string `json:"entity_id"`
		}
		if json.Unmarshal(obj, &cab) != nil {
			continue
		}
		for _, e := range g.equipos[cab.EntityID] {
			l.publicarEstado(e, string(obj))
		}
	}
	return nil
}

func (l *lectorHTTP) bucleSuelto(e Equipo) {
	defer l.wg.Done()
	avisado := time.Time{}
	for {
		raw, err := pedir(l.cliente, e.HTTP.BaseURL, e.HTTP.Estado)
		if err != nil {
			if time.Since(avisado) > time.Minute {
				log.Printf("[gestion/http] %q: %v", e.Nombre, err)
				avisado = time.Now()
			}
		} else {
			l.publicarEstado(e, raw)
		}
		select {
		case <-l.stop:
			return
		case <-l.ahora:
		case <-time.After(intervaloDe(e)):
		}
	}
}

func (l *lectorHTTP) publicarEstado(e Equipo, raw string) {
	d := dispositivo(e)
	d.State = estadoDe(extraerHTTP(raw, e.HTTP.JSONPath), e.PayloadOn, e.PayloadOff)
	l.publicar(d)
}

// pedir es request() de http.adapter.service.ts: la ruta se resuelve contra la URL base y una
// respuesta que no sea 2xx es un error.
func pedir(c *http.Client, baseURL string, t Plantilla) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("URL base invalida %q: %w", baseURL, err)
	}
	ref, err := url.Parse(t.Path)
	if err != nil {
		return "", fmt.Errorf("ruta invalida %q: %w", t.Path, err)
	}
	u := base.ResolveReference(ref).String()
	metodo := t.Method
	if metodo == "" {
		metodo = http.MethodGet
	}
	var body io.Reader
	conBody := t.Body != nil && !strings.EqualFold(metodo, http.MethodGet)
	if conBody {
		data, err := json.Marshal(t.Body)
		if err != nil {
			return "", err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequest(strings.ToUpper(metodo), u, body)
	if err != nil {
		return "", err
	}
	if conBody {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range t.Headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		txt := string(data)
		if len(txt) > 200 {
			txt = txt[:200]
		}
		return "", fmt.Errorf("HTTP %d en %s: %s", resp.StatusCode, u, txt)
	}
	return string(data), nil
}

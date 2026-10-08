// Package bacnetsource descubre y lee unidades de un gateway BACnet/IP (ej. una central VRF de
// aires acondicionados) a traves de apps/bacnet-bridge, NO hablando BACnet/IP directamente.
//
// Por que: se probo en vivo la libreria Go alexbeltran/gobacnet contra el gateway real de este
// proyecto (AC Smart 5, 10.3.0.11) - WhoIs funciona (encuentra el dispositivo correctamente) pero
// ReadProperty no devuelve datos utilizables para NINGUNA propiedad, ni siquiera un PresentValue
// simple. En vez de reimplementar el protocolo BACnet/IP desde cero sin poder validarlo, este
// driver reutiliza bacnet-bridge, que ya esta construido y verificado contra este mismo gateway
// (usa bacstack, la misma libreria que ya prueba la API central). El bridge debe correr aparte,
// en una maquina/red que alcance el gateway BACnet por UDP.
package bacnetsource

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const protocolName = "bacnet"

type bridgeObjectRef struct {
	Type     int `json:"type"`
	Instance int `json:"instance"`
}

type bridgeUnit struct {
	UnitKey string                     `json:"unitKey"`
	Points  map[string]bridgeObjectRef `json:"points"`
	Sample  struct {
		On          *bool    `json:"on"`
		RoomTemp    *float64 `json:"roomTemp"`
		SetRoomTemp *float64 `json:"setRoomTemp"`
	} `json:"sample"`
}

type discoverResponse struct {
	DeviceID     int          `json:"deviceId"`
	VendorID     int          `json:"vendorId"`
	TotalObjects int          `json:"totalObjects"`
	Units        []bridgeUnit `json:"units"`
}

type readRequestItem struct {
	Key      string `json:"key"`
	Type     int    `json:"type"`
	Instance int    `json:"instance"`
}

type readResultItem struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
	Ok    bool        `json:"ok"`
}

type readResponse struct {
	Values []readResultItem `json:"values"`
}

type Source struct {
	cfg    config.BACnetConfig
	device config.BACnetDevice
	http   *http.Client

	units []bridgeUnit // fijo tras el discover inicial: los puntos de cada unidad no cambian

	stop     chan struct{}
	onUpdate func([]discovery.Device)
}

func New(cfg config.BACnetConfig, device config.BACnetDevice) *Source {
	return &Source{
		cfg:    cfg,
		device: device,
		http:   &http.Client{Timeout: 180 * time.Second}, // discover puede tardar con miles de objetos
		stop:   make(chan struct{}),
	}
}

func (s *Source) Name() string { return "bacnet:" + s.device.Host }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	s.onUpdate = onUpdate

	resp, err := s.discover()
	if err != nil {
		return fmt.Errorf("discover en %s (%s) fallo: %w", s.device.Name, s.device.Host, err)
	}
	s.units = resp.Units
	log.Printf(
		"[bacnet] %s (%s): deviceId=%d vendorId=%d totalObjects=%d unidades=%d",
		s.device.Name, s.device.Host, resp.DeviceID, resp.VendorID, resp.TotalObjects, len(s.units),
	)

	s.onUpdate(s.toDevices(resp.Units))

	go s.pollLoop()
	return nil
}

func (s *Source) Stop() {
	close(s.stop)
}

func (s *Source) pollLoop() {
	interval := time.Duration(s.cfg.PollIntervalSeconds) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			units, err := s.readAll()
			if err != nil {
				log.Printf("[bacnet] %s: error releyendo valores: %v", s.device.Name, err)
				continue
			}
			s.onUpdate(s.toDevices(units))
		}
	}
}

func (s *Source) toDevices(units []bridgeUnit) []discovery.Device {
	out := make([]discovery.Device, 0, len(units))
	for _, u := range units {
		state := ""
		if u.Sample.On != nil {
			if *u.Sample.On {
				state = "on"
			} else {
				state = "off"
			}
		}
		readings := map[string]interface{}{}
		if u.Sample.RoomTemp != nil {
			readings["roomTemp"] = *u.Sample.RoomTemp
		}
		if u.Sample.SetRoomTemp != nil {
			readings["setRoomTemp"] = *u.Sample.SetRoomTemp
		}
		out = append(out, discovery.Device{
			ExternalID: fmt.Sprintf("bacnet:%s:%s", s.device.Host, u.UnitKey),
			Name:       fmt.Sprintf("AC %s", strings.ToUpper(u.UnitKey)),
			Protocol:   protocolName,
			Kind:       "climate",
			State:      state,
			Readings:   readings,
		})
	}
	return out
}

func (s *Source) discover() (*discoverResponse, error) {
	var result discoverResponse
	if err := s.post("/discover", map[string]string{"host": s.device.Host}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// readAll relee startStopStatus/roomTemp/setRoomTemp de cada unidad ya conocida (los puntos no
// cambian entre discovers, asi que no hace falta volver a descubrir, solo releer present values).
func (s *Source) readAll() ([]bridgeUnit, error) {
	var reads []readRequestItem
	for _, u := range s.units {
		statusPoint, hasStatus := u.Points["startStopStatus"]
		if !hasStatus {
			statusPoint, hasStatus = u.Points["startStopCommand"]
		}
		if hasStatus {
			reads = append(reads, readRequestItem{Key: u.UnitKey + ":on", Type: statusPoint.Type, Instance: statusPoint.Instance})
		}
		if p, ok := u.Points["roomTemp"]; ok {
			reads = append(reads, readRequestItem{Key: u.UnitKey + ":roomTemp", Type: p.Type, Instance: p.Instance})
		}
		if p, ok := u.Points["setRoomTemp"]; ok {
			reads = append(reads, readRequestItem{Key: u.UnitKey + ":setRoomTemp", Type: p.Type, Instance: p.Instance})
		}
	}

	var result readResponse
	body := map[string]interface{}{"host": s.device.Host, "reads": reads}
	if err := s.post("/read", body, &result); err != nil {
		return nil, err
	}

	byKey := map[string]interface{}{}
	for _, r := range result.Values {
		if r.Ok {
			byKey[r.Key] = r.Value
		}
	}

	updated := make([]bridgeUnit, len(s.units))
	for i, u := range s.units {
		nu := u
		if v, ok := byKey[u.UnitKey+":on"].(bool); ok {
			b := v
			nu.Sample.On = &b
		}
		if v, ok := byKey[u.UnitKey+":roomTemp"].(float64); ok {
			f := v
			nu.Sample.RoomTemp = &f
		}
		if v, ok := byKey[u.UnitKey+":setRoomTemp"].(float64); ok {
			f := v
			nu.Sample.SetRoomTemp = &f
		}
		updated[i] = nu
	}
	return updated, nil
}

func (s *Source) post(path string, body interface{}, out interface{}) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(s.cfg.BridgeURL, "/")+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.BridgeToken != "" {
		req.Header.Set("x-bridge-token", s.cfg.BridgeToken)
	}

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo conectar al bacnet-bridge en %s: %w", s.cfg.BridgeURL, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("bacnet-bridge respondio %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return json.Unmarshal(respBody, out)
}

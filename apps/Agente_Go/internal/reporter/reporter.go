// Package reporter envia lotes de dispositivos descubiertos a POST /devices/agent-sync en la
// API central (ver apps/api/src/devices/agent-sync.service.ts), autenticado con una API key de
// role=agent via el header x-api-key (mismo mecanismo que ya usa el "Gateway externo" del API).
package reporter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"agente-go/internal/discovery"
	"agente-go/internal/events"
)

type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

type SyncResult struct {
	Total   int `json:"total"`
	Created int `json:"created"`
	Updated int `json:"updated"`
	// Ya existia un dispositivo con esta misma identidad fisica creado por otra via (import
	// manual, adaptador en proceso) - la API no lo toco para no duplicarlo ni pelearle el estado.
	SkippedExisting int `json:"skippedExisting"`
	EventsReceived  int `json:"eventsReceived"`
	// Nuevos guardados; los reenviados que la API ya tenia no cuentan (idempotente por id).
	EventsRecorded int `json:"eventsRecorded"`
}

type syncRequest struct {
	BuildingKey  string             `json:"buildingKey"`
	AgentVersion string             `json:"agentVersion,omitempty"`
	Devices      []discovery.Device `json:"devices"`
	Events       []events.Event     `json:"events,omitempty"`
}

func New(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) Sync(buildingKey, agentVersion string, devices []discovery.Device, evs []events.Event) (*SyncResult, error) {
	body, err := json.Marshal(syncRequest{BuildingKey: buildingKey, AgentVersion: agentVersion, Devices: devices, Events: evs})
	if err != nil {
		return nil, fmt.Errorf("no se pudo serializar el lote: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/devices/agent-sync", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("no se pudo conectar a %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("la API respondio %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var result SyncResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("respuesta invalida de la API: %w", err)
	}
	return &result, nil
}

package reporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Endpoints de configuracion remota y descubrimiento (apps/api/src/agents/agents.controller.ts).

// ErrNotFound: la API respondio 404 (ej. el agente todavia no tiene configuracion remota).
var ErrNotFound = errors.New("no encontrado")

type RemoteConfig struct {
	Version int             `json:"version"`
	Config  json.RawMessage `json:"config"`
}

type Control struct {
	ConfigVersion int             `json:"configVersion"`
	Scan          json.RawMessage `json:"scan"`
}

func (c *Client) GetConfig(buildingKey string) (*RemoteConfig, error) {
	var out RemoteConfig
	if err := c.do(http.MethodGet, agentPath(buildingKey, "config"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SeedConfig sube la config de config.yaml como version 1. Si la API ya tenia una, devuelve esa.
func (c *Client) SeedConfig(buildingKey string, config json.RawMessage) (*RemoteConfig, error) {
	var out RemoteConfig
	body := map[string]json.RawMessage{"config": config}
	if err := c.do(http.MethodPost, agentPath(buildingKey, "config/seed"), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Control(buildingKey string) (*Control, error) {
	var out Control
	if err := c.do(http.MethodGet, agentPath(buildingKey, "control"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConfigApplied avisa que version quedo corriendo. rejected = la config no era valida y el agente
// sigue con la anterior; si no, problem lista las fuentes que no pudieron arrancar (puede ser vacio).
func (c *Client) ConfigApplied(buildingKey string, version int, problem string, rejected bool) error {
	body := map[string]interface{}{"version": version, "rejected": rejected}
	if problem != "" {
		body["error"] = truncate(problem, 2000)
	}
	return c.do(http.MethodPost, agentPath(buildingKey, "config/applied"), body, nil)
}

// ScanResult sube el avance o el resultado final de un escaneo.
func (c *Client) ScanResult(buildingKey, scanID string, result interface{}) error {
	return c.do(http.MethodPost, agentPath(buildingKey, "scan/"+url.PathEscape(scanID)+"/result"), result, nil)
}

func agentPath(buildingKey, rest string) string {
	return "/agents/" + url.PathEscape(buildingKey) + "/" + rest
}

func (c *Client) do(method, path string, body, out interface{}) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("x-api-key", c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("no se pudo conectar a %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("la API respondio %d en %s: %s", resp.StatusCode, path, truncate(strings.TrimSpace(string(respBody)), 300))
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("respuesta invalida de la API en %s: %w", path, err)
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

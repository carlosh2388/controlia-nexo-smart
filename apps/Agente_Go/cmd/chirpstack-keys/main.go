// chirpstack-keys: exportacion UNICA y de SOLO LECTURA de las llaves de los sensores de un
// ChirpStack v4 (API REST), para cargarlas en el receptor directo del Agente Go
// (config loraGateway.keys) y poder dejar de depender de ChirpStack.
//
// Usa solo GET: /api/tenants, /api/applications, /api/devices, /api/devices/{devEui}/activation y
// /api/devices/{devEui}/keys (rutas verificadas contra api/proto/api/device.proto de ChirpStack).
//
// Uso:
//
//	chirpstack-keys -api http://192.168.70.6:8090 -token <API key de ChirpStack> > llaves.yaml
//
// La salida es el bloque YAML "keys:" listo para pegar bajo loraGateway. Contiene llaves
// secretas: guardarlo con permisos restringidos y nunca subirlo a git.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

var (
	apiBase string
	token   string
	client  = &http.Client{Timeout: 20 * time.Second}
)

func get(path string, q url.Values, out interface{}) error {
	u := strings.TrimRight(apiBase, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Grpc-Metadata-Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s -> %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, out)
}

var errNotFound = fmt.Errorf("no encontrado")

type listResp struct {
	TotalCount int `json:"totalCount"`
	Result     []struct {
		ID                string            `json:"id"`
		Name              string            `json:"name"`
		DevEui            string            `json:"devEui"`
		DeviceProfileName string            `json:"deviceProfileName"`
		Tags              map[string]string `json:"tags"`
	} `json:"result"`
}

func main() {
	flag.StringVar(&apiBase, "api", "http://192.168.70.6:8090", "URL de la API REST de ChirpStack v4")
	flag.StringVar(&token, "token", os.Getenv("CHIRPSTACK_TOKEN"), "API key de ChirpStack (o variable CHIRPSTACK_TOKEN)")
	flag.Parse()
	if token == "" {
		log.Fatal("falta -token (API key de ChirpStack con permiso de lectura)")
	}

	limit := url.Values{"limit": {"1000"}}
	var tenants listResp
	if err := get("/api/tenants", limit, &tenants); err != nil {
		log.Fatalf("no se pudieron listar los tenants: %v", err)
	}

	type row struct {
		name, model, devEui, devAddr, nwk, app, appKey, area string
		fcnt                                               uint32
		active                                             bool
	}
	var rows []row
	for _, t := range tenants.Result {
		var apps listResp
		if err := get("/api/applications", url.Values{"limit": {"1000"}, "tenantId": {t.ID}}, &apps); err != nil {
			log.Fatalf("aplicaciones del tenant %q: %v", t.Name, err)
		}
		for _, a := range apps.Result {
			var devs listResp
			if err := get("/api/devices", url.Values{"limit": {"1000"}, "applicationId": {a.ID}}, &devs); err != nil {
				log.Fatalf("dispositivos de %q: %v", a.Name, err)
			}
			for _, d := range devs.Result {
				r := row{name: d.Name, model: d.DeviceProfileName, devEui: strings.ToLower(d.DevEui), area: d.Tags["area"]}
				var act struct {
					DeviceActivation struct {
						DevAddr     string `json:"devAddr"`
						AppSKey     string `json:"appSKey"`
						NwkSEncKey  string `json:"nwkSEncKey"`
						FNwkSIntKey string `json:"fNwkSIntKey"`
						FCntUp      uint32 `json:"fCntUp"`
					} `json:"deviceActivation"`
				}
				if err := get("/api/devices/"+d.DevEui+"/activation", nil, &act); err == nil && act.DeviceActivation.DevAddr != "" {
					a := act.DeviceActivation
					r.devAddr, r.app, r.fcnt, r.active = strings.ToLower(a.DevAddr), a.AppSKey, a.FCntUp, true
					// LoRaWAN 1.0.x: la unica llave de red es la misma en los tres campos de 1.1.
					r.nwk = a.FNwkSIntKey
					if r.nwk == "" {
						r.nwk = a.NwkSEncKey
					}
				} else if err != nil && err != errNotFound {
					log.Printf("aviso: activacion de %s (%s): %v", d.Name, d.DevEui, err)
				}
				var keys struct {
					DeviceKeys struct {
						NwkKey string `json:"nwkKey"`
						AppKey string `json:"appKey"`
					} `json:"deviceKeys"`
				}
				if err := get("/api/devices/"+d.DevEui+"/keys", nil, &keys); err == nil {
					// En LoRaWAN 1.0.x ChirpStack guarda la AppKey en nwkKey.
					r.appKey = keys.DeviceKeys.NwkKey
					if r.appKey == "" {
						r.appKey = keys.DeviceKeys.AppKey
					}
				}
				rows = append(rows, r)
			}
		}
	}

	sort.Slice(rows, func(i, j int) bool { return rows[i].name < rows[j].name })
	active := 0
	fmt.Printf("# Exportado de %s el %s - %d dispositivo(s). CONTIENE LLAVES SECRETAS.\n", apiBase, time.Now().Format(time.RFC3339), len(rows))
	fmt.Println("keys:")
	for _, r := range rows {
		fmt.Printf("  - name: %q\n    model: %q\n    devEui: %q\n", r.name, r.model, r.devEui)
		if r.active {
			active++
			fmt.Printf("    devAddr: %q\n    nwkSKey: %q\n    appSKey: %q\n    fCntUp: %d\n", r.devAddr, r.nwk, r.app, r.fcnt)
		} else {
			fmt.Println("    # sin sesion activa en ChirpStack (no se ha unido a la red)")
		}
		if r.appKey != "" {
			fmt.Printf("    appKey: %q\n", r.appKey)
		}
		if r.area != "" {
			fmt.Printf("    attributes: { area: %q }\n", r.area)
		}
	}
	log.Printf("%d dispositivo(s) exportados, %d con sesion activa", len(rows), active)
}

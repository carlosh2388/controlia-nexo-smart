package gestion

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Estas funciones copian a proposito el comportamiento de los adaptadores de la API (getByPath y
// String() de JavaScript), para que el estado que reporta el agente sea identico al que guardaba la API.

var separadores = regexp.MustCompile(`[.\[\]]+`)

// porRuta es getByPath de http.adapter.service.ts / mqtt.adapter.service.ts ("a.b[0].c").
func porRuta(v interface{}, ruta string) interface{} {
	for _, k := range separadores.Split(ruta, -1) {
		if k == "" {
			continue
		}
		switch t := v.(type) {
		case map[string]interface{}:
			v = t[k]
		case []interface{}:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(t) {
				return nil
			}
			v = t[i]
		default:
			return nil
		}
	}
	return v
}

// textoJS es String(value) de JavaScript para valores salidos de JSON.parse.
func textoJS(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case []interface{}:
		partes := make([]string, len(t))
		for i, x := range t {
			if x != nil {
				partes[i] = textoJS(x)
			}
		}
		return strings.Join(partes, ",")
	default:
		return "[object Object]"
	}
}

// extraerHTTP es la extraccion de estado del adaptador HTTP de la API.
func extraerHTTP(raw string, jsonPath *string) string {
	if jsonPath == nil || *jsonPath == "" {
		return strings.TrimSpace(raw)
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return strings.TrimSpace(raw)
	}
	v := porRuta(parsed, *jsonPath)
	if v == nil {
		return ""
	}
	return textoJS(v)
}

// extraerMQTT es la extraccion de estado del adaptador MQTT de la API (raw ya sin espacios).
func extraerMQTT(raw string, statePath *string) string {
	if statePath == nil || *statePath == "" {
		return raw
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return raw
	}
	v := porRuta(parsed, *statePath)
	if v == nil {
		return raw
	}
	return textoJS(v)
}

// estadoDe traduce el valor extraido a on/off con los payloads del equipo (igual que la API).
func estadoDe(extraido, payloadOn, payloadOff string) string {
	switch extraido {
	case payloadOn:
		return "on"
	case payloadOff:
		return "off"
	}
	// La API acepta hasta 40 caracteres en el sync.
	if len(extraido) > 40 {
		return extraido[:40]
	}
	return extraido
}

// verdadero es !!value de JavaScript.
func verdadero(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	default:
		return true
	}
}

// indiceTexto es config.modeStates?.[index - 1] de la API.
func indiceTexto(v interface{}, textos []string) interface{} {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	i := int(f) - 1
	if float64(int(f)) != f || i < 0 || i >= len(textos) {
		return nil
	}
	return textos[i]
}

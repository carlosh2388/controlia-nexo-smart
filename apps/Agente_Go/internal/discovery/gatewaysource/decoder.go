package gatewaysource

import (
	"encoding/binary"
	"fmt"
	"strings"
)

// Decodificador de payloads Milesight (formato canal + tipo + valor, little endian). Verificado
// contra los decodificadores oficiales (github.com/Milesight-IoT/SensorDecoders: am308, em300-th,
// em500-lgt, ws301) y contra pares reales bytes/objeto de ChirpStack (LEO-S592-AQG0-P, LEO-S595-MSG0).
// Los nombres de las metricas son los mismos que entrega el decodificador de ChirpStack de cada
// perfil, para que Nodivo muestre igual un sensor llegue por ChirpStack o directo.

// lightLevels: etiquetas que entrega el perfil LEO-S592 para el canal 06/cb. Niveles 0-2 verificados con
// pares reales bytes/objeto; 3 visto en lecturas reales del mismo perfil; 4 y 5 vienen de la escala de 6 niveles del AM308 y se marcan "nivel N" si no hay etiqueta.
var lightLevels = map[int]string{0: "0-5 lux", 1: "6-50 lux", 2: "51-100 lux", 3: "101-500 lux"}

// DecodeMilesight convierte el payload descifrado en metricas. model es el deviceProfile/modelo
// (decide el nombre de los canales digitales: pir, puerta, sabotaje). Devuelve ok=false si
// encuentra un tipo de canal desconocido (no se puede saber su largo); lo ya decodificado se conserva.
func DecodeMilesight(model string, b []byte) (map[string]interface{}, bool) {
	out := map[string]interface{}{}
	m := strings.ToLower(model)
	i := 0
	for i+2 <= len(b) {
		ch, typ := b[i], b[i+1]
		i += 2
		need := func(n int) bool { return i+n <= len(b) }
		switch {
		case ch == 0xff: // informacion del dispositivo (version, SN, clase...): se salta por largo conocido
			l := map[byte]int{0x01: 1, 0x09: 2, 0x0a: 2, 0x0b: 1, 0x0f: 1, 0x16: 8, 0xff: 2, 0xfe: 1, 0x08: 6}[typ]
			if l == 0 || !need(l) {
				return out, false
			}
			i += l
		case typ == 0x75 && need(1): // bateria %
			out["battery"] = float64(b[i])
			i++
		case typ == 0x67 && need(2): // temperatura int16 /10
			out["temperature"] = round(float64(int16(binary.LittleEndian.Uint16(b[i:])))/10, 1)
			i += 2
		case typ == 0x68 && need(1): // humedad uint8 /2
			out["humidity"] = round(float64(b[i])/2, 1)
			i++
		case typ == 0x73 && need(2): // presion barometrica uint16 /10 hPa
			out["barometricPressure"] = round(float64(binary.LittleEndian.Uint16(b[i:]))/10, 1)
			i += 2
		case typ == 0x94 && need(4): // iluminancia uint32 lux
			out["illumination"] = float64(binary.LittleEndian.Uint32(b[i:]))
			i += 4
		case typ == 0xcb && need(1): // nivel de luz
			lvl := int(b[i])
			if s, ok := lightLevels[lvl]; ok {
				out["lightLevel"] = s
			} else {
				out["lightLevel"] = fmt.Sprintf("nivel %d", lvl)
			}
			out["light_level"] = float64(lvl)
			i++
		case typ == 0x7d && need(2): // concentraciones uint16 (escala segun canal)
			v := float64(binary.LittleEndian.Uint16(b[i:]))
			switch ch {
			case 0x07:
				out["co2"] = v
			case 0x08:
				out["tvoc"] = round(v/100, 2)
			case 0x0a:
				out["hcho"] = round(v/100, 2)
			case 0x0b:
				out["pm2_5"] = v
			case 0x0c:
				out["pm10"] = v
			default:
				out[fmt.Sprintf("ch%02x_7d", ch)] = v
			}
			i += 2
		case typ == 0x00 && need(1): // entrada digital
			v := b[i]
			i++
			switch {
			case ch == 0x05 && (strings.Contains(m, "s592") || strings.Contains(m, "am3")):
				out["pirStatus"] = map[byte]string{0: "Vacant", 1: "Occupied"}[v]
			case ch == 0x03 && (strings.Contains(m, "s595") || strings.Contains(m, "ws301")):
				out["magnet_status"] = map[byte]string{0: "close", 1: "open"}[v]
			case ch == 0x04 && (strings.Contains(m, "s595") || strings.Contains(m, "ws301")):
				out["tamper_status"] = map[byte]string{0: "installed", 1: "uninstalled"}[v]
			default:
				out[fmt.Sprintf("digital_ch%d", ch)] = float64(v)
			}
		default:
			return out, false
		}
	}
	return out, true
}

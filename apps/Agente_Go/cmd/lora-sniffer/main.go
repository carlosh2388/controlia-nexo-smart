// lora-sniffer: herramienta de diagnostico SOLO LECTURA para la migracion a LoRaWAN directo.
//
// Se suscribe a un broker donde los gateways publican sus tramas crudas (formato del "MQTT
// forwarder"/"gateway bridge" de ChirpStack: topic <region>/gateway/<eui>/event/up, protobuf) y a
// los uplinks ya procesados (application/+/device/+/event/up, JSON). Decodifica cada trama cruda con
// el MISMO decodificador del receptor directo del agente (gatewaysource.DecodeFrame) y lo compara
// con lo que reporto el servidor de red: si DevAddr y FCnt coinciden, el agente lee las tramas de
// radio igual que el servidor de red.
//
// Uso: lora-sniffer -broker tcp://192.168.70.6:1883 -seconds 60
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"gopkg.in/yaml.v3"

	"agente-go/internal/config"
	"agente-go/internal/discovery/gatewaysource"
)

// phyPayloadFromUplinkFrame extrae el campo 1 (bytes phy_payload) del protobuf gw.UplinkFrame sin
// depender del paquete generado de ChirpStack: recorre los campos y salta los demas.
func phyPayloadFromUplinkFrame(b []byte) []byte {
	i := 0
	varint := func() (uint64, bool) {
		var v uint64
		for shift := uint(0); i < len(b) && shift < 64; shift += 7 {
			c := b[i]
			i++
			v |= uint64(c&0x7f) << shift
			if c < 0x80 {
				return v, true
			}
		}
		return 0, false
	}
	for i < len(b) {
		key, ok := varint()
		if !ok {
			return nil
		}
		field, wire := key>>3, key&7
		switch wire {
		case 0:
			if _, ok := varint(); !ok {
				return nil
			}
		case 1:
			i += 8
		case 5:
			i += 4
		case 2:
			n, ok := varint()
			if !ok || i+int(n) > len(b) {
				return nil
			}
			if field == 1 {
				return b[i : i+int(n)]
			}
			i += int(n)
		default:
			return nil
		}
	}
	return nil
}

type appUp struct {
	DevAddr    string `json:"devAddr"`
	FCnt       uint32 `json:"fCnt"`
	Object     map[string]interface{} `json:"object"`
	DeviceInfo struct {
		DevEui     string `json:"devEui"`
		DeviceName string `json:"deviceName"`
	} `json:"deviceInfo"`
}

func main() {
	broker := flag.String("broker", "tcp://192.168.70.6:1883", "broker MQTT donde publican los gateways")
	seconds := flag.Int("seconds", 60, "segundos de captura")
	replayTo := flag.String("replay-to", "", "opcional: reenviar cada trama cruda como PUSH_DATA (Semtech UDP) a esta direccion, ej. 127.0.0.1:17000, para probar el receptor directo del agente de punta a punta")
	keysFile := flag.String("keys", "", "opcional: YAML con el bloque keys (salida de chirpstack-keys) para descifrar las tramas crudas y comparar las metricas contra las del servidor de red")
	flag.Parse()

	sess := map[string]*gatewaysource.SessionKeys{}
	models := map[string]string{}
	fcnts := map[string]uint32{}
	if *keysFile != "" {
		data, err := os.ReadFile(*keysFile)
		if err != nil {
			log.Fatalf("keys: %v", err)
		}
		var kf struct {
			Keys []config.LoRaDeviceKeys `yaml:"keys"`
		}
		if err := yaml.Unmarshal(data, &kf); err != nil {
			log.Fatalf("keys: %v", err)
		}
		for _, k := range kf.Keys {
			if k.DevAddr == "" {
				continue
			}
			sk, err := gatewaysource.NewSessionKeys(k.DevAddr, k.NwkSKey, k.AppSKey)
			if err != nil {
				continue
			}
			a := strings.ToLower(k.DevAddr)
			sess[a], models[a], fcnts[a] = sk, k.Model, k.FCntUp
		}
		log.Printf("%d sesion(es) cargadas para descifrar", len(sess))
	}
	decoded := map[string]map[string]interface{}{}
	micOK, micBad := 0, 0

	var replay *net.UDPConn
	if *replayTo != "" {
		addr, err := net.ResolveUDPAddr("udp", *replayTo)
		if err != nil {
			log.Fatalf("replay-to invalido: %v", err)
		}
		if replay, err = net.DialUDP("udp", nil, addr); err != nil {
			log.Fatalf("replay-to: %v", err)
		}
		defer replay.Close()
		log.Printf("reenviando tramas crudas a %s como un gateway (Semtech UDP)", *replayTo)
	}
	sendReplay := func(gatewayEUI string, phy []byte) {
		if replay == nil {
			return
		}
		eui, err := hex.DecodeString(gatewayEUI)
		if err != nil || len(eui) != 8 {
			return
		}
		// rssi/snr no se extraen del protobuf del gateway: se marcan como 0 (solo es una prueba de la cadena).
		body, _ := json.Marshal(map[string]interface{}{"rxpk": []map[string]interface{}{{
			"tmst": uint32(time.Now().UnixMicro()), "freq": 902.3, "stat": 1, "modu": "LORA", "datr": "SF7BW125",
			"codr": "4/5", "rssi": 0, "lsnr": 0, "size": len(phy), "data": base64.StdEncoding.EncodeToString(phy),
		}}})
		pkt := append([]byte{2, byte(time.Now().UnixNano()), byte(time.Now().UnixNano() >> 8), 0x00}, eui...)
		_, _ = replay.Write(append(pkt, body...))
	}

	var mu sync.Mutex
	raw := map[string]uint32{} // "devAddr|fCnt16" -> veces vista cruda
	rawJoins := 0
	rawErrors := 0
	app := map[string]appUp{} // "devAddr|fCnt" -> uplink del servidor de red
	gateways := map[string]bool{}

	opts := mqtt.NewClientOptions().AddBroker(*broker).SetClientID(fmt.Sprintf("nodivo-lora-sniffer-%d", time.Now().UnixNano())).SetCleanSession(true)
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		c.Subscribe("+/gateway/+/event/up", 0, func(_ mqtt.Client, m mqtt.Message) {
			parts := strings.Split(m.Topic(), "/")
			phy := phyPayloadFromUplinkFrame(m.Payload())
			mu.Lock()
			defer mu.Unlock()
			if len(parts) > 2 {
				gateways[parts[2]] = true
			}
			if phy == nil {
				rawErrors++
				return
			}
			if len(parts) > 2 {
				sendReplay(parts[2], phy)
			}
			f, err := gatewaysource.DecodeFrame(phy, func(a string) *gatewaysource.SessionKeys { return sess[a] },
				func(a string, c uint32) uint32 { return gatewaysource.FullFCnt(fcnts[a], c) })
			if err != nil {
				rawErrors++
				return
			}
			if f.Join {
				rawJoins++
				fmt.Printf("  join request  DevEUI %s\n", f.DevEUI)
				return
			}
			key := fmt.Sprintf("%s|%d", f.DevAddr, f.FCnt16)
			raw[key]++
			if f.MICValid != nil {
				if *f.MICValid {
					micOK++
					if f.Payload != nil {
						if m, _ := gatewaysource.DecodeMilesight(models[f.DevAddr], f.Payload); len(m) > 0 {
							decoded[key] = m
						}
					}
				} else {
					micBad++
				}
			}
		})
		c.Subscribe("application/+/device/+/event/up", 0, func(_ mqtt.Client, m mqtt.Message) {
			var u appUp
			if json.Unmarshal(m.Payload(), &u) != nil {
				return
			}
			mu.Lock()
			app[fmt.Sprintf("%s|%d", strings.ToLower(u.DevAddr), u.FCnt&0xFFFF)] = u
			mu.Unlock()
		})
	})
	c := mqtt.NewClient(opts)
	if t := c.Connect(); t.Wait() && t.Error() != nil {
		log.Fatalf("no se pudo conectar a %s: %v", *broker, t.Error())
	}
	log.Printf("escuchando %s durante %ds (solo lectura)...", *broker, *seconds)
	time.Sleep(time.Duration(*seconds) * time.Second)
	c.Disconnect(250)

	mu.Lock()
	defer mu.Unlock()
	matched := 0
	keys := make([]string, 0, len(app))
	for k := range app {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Printf("\nGateways vistos: %d\n", len(gateways))
	fmt.Printf("Tramas crudas decodificadas: %d (joins %d, no decodificables %d)\n", len(raw), rawJoins, rawErrors)
	fmt.Println("\nComparacion contra el servidor de red (DevAddr + FCnt):")
	for _, k := range keys {
		u := app[k]
		ok := raw[k] > 0
		if ok {
			matched++
		}
		mark := "NO"
		if ok {
			mark = "SI"
		}
		fmt.Printf("  [%s] %-40s DevAddr %s FCnt %d\n", mark, u.DeviceInfo.DeviceName, u.DevAddr, u.FCnt)
		if d, ok := decoded[k]; ok {
			same, diff := 0, []string{}
			for name, want := range u.Object {
				if fmt.Sprint(d[name]) == fmt.Sprint(want) {
					same++
				} else {
					diff = append(diff, fmt.Sprintf("%s agente=%v servidor=%v", name, d[name], want))
				}
			}
			fmt.Printf("        descifrado por el agente: %d/%d metricas iguales %v\n", same, len(u.Object), diff)
		}
	}
	fmt.Printf("\nCoinciden %d de %d uplinks del servidor de red.\n", matched, len(app))
	if len(sess) > 0 {
		fmt.Printf("Descifrado con llaves: MIC valido %d, MIC invalido %d, con metricas %d\n", micOK, micBad, len(decoded))
	}
	if len(app) > 0 && matched < len(app) {
		os.Exit(2)
	}
}

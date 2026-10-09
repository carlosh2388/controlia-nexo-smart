// Package gatewaysource es el receptor directo de gateways LoRa: el gateway apunta su "Network
// Server" a la IP del agente (puerto UDP 1700) y el agente recibe las tramas de radio sin pasar por
// ChirpStack ni por ningun broker.
//
// Fase actual (receptor): responde el protocolo del gateway (PUSH_ACK / PULL_ACK), decodifica cada
// trama, lleva el estado de cada gateway y de cada dispositivo escuchado, y descifra los sensores
// cuyas llaves esten en la config. NO transmite por radio todavia (no acepta joins ni envia ACKs a
// los sensores): eso es la fase "servidor de red activo". Ver docs/lorawan-directo.md.
package gatewaysource

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"net"
	"strings"
	"sync"
	"time"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

type gatewayState struct {
	EUI        string
	Addr       string
	FirstSeen  time.Time
	LastSeen   time.Time
	LastPull   time.Time
	Stat       *gwStat
	Frames     int
	CRCErrors  int
	DevicesSet map[string]bool
}

type radioDevice struct {
	Key          string // "eui:<devEui>" (llaves/join) o "addr:<devAddr>"
	DevEUI       string
	DevAddr      string
	JoinEUI      string
	Name         string
	Model        string
	Attrs        map[string]interface{}
	FCnt16       uint32
	FCnt32       uint32
	FPort        *uint8
	Confirmed    bool
	RSSI, SNR    float64
	FreqMHz      float64
	DataRate     string
	Size         int
	Gateways     map[string]bool
	LastGateway  string
	LastSeen     time.Time
	Uplinks      int
	JoinRequests int
	DevNonce     uint16
	Payload      []byte
	MICValid     *bool
	Encrypted    bool
	HasKeys      bool
}

type keyEntry struct {
	cfg  config.LoRaDeviceKeys
	sess *SessionKeys
}

type Source struct {
	cfg config.LoRaGatewayConfig

	conn *net.UDPConn
	stop chan struct{}
	wg   sync.WaitGroup

	mu        sync.Mutex
	gateways  map[string]*gatewayState
	devices   map[string]*radioDevice
	keysByAdr map[string]*keyEntry // devAddr -> llaves de sesion
	keysByEUI map[string]*keyEntry
	// Deduplicacion: la misma trama llega por varios gateways.
	recent map[string]time.Time

	onUpdate func([]discovery.Device)
}

func New(cfg config.LoRaGatewayConfig) (*Source, error) {
	s := &Source{
		cfg:       cfg,
		stop:      make(chan struct{}),
		gateways:  map[string]*gatewayState{},
		devices:   map[string]*radioDevice{},
		keysByAdr: map[string]*keyEntry{},
		keysByEUI: map[string]*keyEntry{},
		recent:    map[string]time.Time{},
	}
	for _, k := range cfg.Keys {
		k := k
		e := &keyEntry{cfg: k}
		if k.DevAddr != "" {
			addr, err := parseDevAddr(k.DevAddr)
			if err != nil {
				return nil, fmt.Errorf("loraGateway.keys %q: devAddr invalido: %w", k.Name, err)
			}
			nwk, err1 := parseKey(k.NwkSKey)
			app, err2 := parseKey(k.AppSKey)
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("loraGateway.keys %q: nwkSKey/appSKey deben ser 32 caracteres hex", k.Name)
			}
			e.sess = &SessionKeys{DevAddr: addr, NwkSKey: nwk, AppSKey: app}
			s.keysByAdr[addr.String()] = e
		}
		if k.DevEUI != "" {
			s.keysByEUI[strings.ToLower(strings.TrimSpace(k.DevEUI))] = e
		}
	}
	return s, nil
}

func (s *Source) Name() string { return "lora-gateway:" + s.cfg.Listen }

func (s *Source) Start(onUpdate func([]discovery.Device)) error {
	s.onUpdate = onUpdate
	addr, err := net.ResolveUDPAddr("udp", s.cfg.Listen)
	if err != nil {
		return fmt.Errorf("loraGateway.listen invalido: %w", err)
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return fmt.Errorf("no se pudo escuchar UDP %s (¿otro proceso usa el puerto o falta permiso del firewall?): %w", s.cfg.Listen, err)
	}
	s.conn = conn
	log.Printf("[lora-gw] escuchando gateways LoRa (Semtech UDP) en %s - %d sensor(es) con llaves", s.cfg.Listen, len(s.cfg.Keys))

	s.wg.Add(2)
	go s.readLoop()
	go s.tickLoop()
	return nil
}

func (s *Source) Stop() {
	close(s.stop)
	if s.conn != nil {
		_ = s.conn.Close()
	}
	s.wg.Wait()
}

func (s *Source) readLoop() {
	defer s.wg.Done()
	buf := make([]byte, 65535)
	for {
		n, from, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-s.stop:
				return
			default:
				log.Printf("[lora-gw] error leyendo UDP: %v", err)
				continue
			}
		}
		data := make([]byte, n)
		copy(data, buf[:n])
		s.handle(data, from, time.Now())
	}
}

// tickLoop reenvia el snapshot periodicamente para que un gateway que se calla pase a offline.
func (s *Source) tickLoop() {
	defer s.wg.Done()
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.publish(time.Now())
		}
	}
}

func (s *Source) handle(data []byte, from *net.UDPAddr, now time.Time) {
	p, err := parsePacket(data)
	if err != nil {
		return
	}
	if ack := ackFor(p); ack != nil && s.conn != nil {
		_, _ = s.conn.WriteToUDP(ack, from)
	}

	switch p.Identifier {
	case pullData:
		s.mu.Lock()
		gw := s.gateway(p.GatewayEUI, from, now)
		gw.LastPull = now
		s.mu.Unlock()
	case pushData:
		push, err := parsePush(p.Payload)
		if err != nil {
			log.Printf("[lora-gw] JSON invalido del gateway %s: %v", p.GatewayEUI, err)
			return
		}
		s.mu.Lock()
		gw := s.gateway(p.GatewayEUI, from, now)
		if push.Stat != nil {
			gw.Stat = push.Stat
		}
		for _, rx := range push.RXPK {
			s.handleRX(gw, rx, now)
		}
		s.mu.Unlock()
		if len(push.RXPK) > 0 || push.Stat != nil {
			s.publish(now)
		}
	}
}

func (s *Source) gateway(eui string, from *net.UDPAddr, now time.Time) *gatewayState {
	gw, ok := s.gateways[eui]
	if !ok {
		gw = &gatewayState{EUI: eui, FirstSeen: now, DevicesSet: map[string]bool{}}
		s.gateways[eui] = gw
		log.Printf("[lora-gw] gateway nuevo conectado: %s desde %s", eui, from.String())
	}
	gw.LastSeen = now
	if from != nil {
		gw.Addr = from.String()
	}
	return gw
}

func (s *Source) handleRX(gw *gatewayState, rx rxpk, now time.Time) {
	if rx.Stat == -1 {
		gw.CRCErrors++
		return
	}
	phy, err := base64.StdEncoding.DecodeString(rx.Data)
	if err != nil || len(phy) == 0 {
		return
	}
	gw.Frames++

	frame, err := DecodeFrame(phy,
		func(devAddr string) *SessionKeys {
			if e := s.keysByAdr[devAddr]; e != nil {
				return e.sess
			}
			return nil
		},
		func(devAddr string, fcnt16 uint32) uint32 {
			if d := s.devices["addr:"+devAddr]; d != nil {
				return FullFCnt(d.FCnt32, fcnt16)
			}
			if e := s.keysByAdr[devAddr]; e != nil && e.cfg.DevEUI != "" {
				if d := s.devices["eui:"+strings.ToLower(e.cfg.DevEUI)]; d != nil {
					return FullFCnt(d.FCnt32, fcnt16)
				}
			}
			return fcnt16
		})
	if err != nil || !frame.Uplink {
		return
	}

	// La misma trama la pueden reportar varios gateways: se cuenta una vez, se guarda el mejor RSSI.
	dedupKey := frame.MIC + "|" + frame.DevAddr + frame.DevEUI
	duplicate := false
	if t, ok := s.recent[dedupKey]; ok && now.Sub(t) < 3*time.Second {
		duplicate = true
	}
	s.recent[dedupKey] = now
	if len(s.recent) > 2000 {
		for k, t := range s.recent {
			if now.Sub(t) > time.Minute {
				delete(s.recent, k)
			}
		}
	}

	key, ke := s.identity(frame)
	d, exists := s.devices[key]
	if !exists {
		radioOnly := ke == nil
		if radioOnly && s.countRadioOnly() >= s.cfg.MaxRadioDevices {
			return
		}
		d = &radioDevice{Key: key, Gateways: map[string]bool{}, Attrs: map[string]interface{}{}}
		if ke != nil {
			d.Name, d.Model, d.HasKeys = ke.cfg.Name, ke.cfg.Model, true
			for k, v := range ke.cfg.Attributes {
				d.Attrs[k] = v
			}
		}
		s.devices[key] = d
	}
	d.Gateways[gw.EUI] = true
	gw.DevicesSet[key] = true

	if duplicate {
		if rx.RSSI > d.RSSI {
			d.RSSI, d.SNR, d.LastGateway = rx.RSSI, rx.LSNR, gw.EUI
		}
		return
	}

	d.LastSeen = now
	d.RSSI, d.SNR, d.LastGateway = rx.RSSI, rx.LSNR, gw.EUI
	d.FreqMHz = rx.Freq
	d.DataRate = fmt.Sprint(rx.DatR)
	d.Size = rx.Size
	if frame.Join {
		d.JoinRequests++
		d.DevEUI, d.JoinEUI, d.DevNonce = frame.DevEUI, frame.JoinEUI, frame.DevNonce
		return
	}
	d.Uplinks++
	d.DevAddr = frame.DevAddr
	d.FCnt16 = frame.FCnt16
	if d.FCnt32 == 0 || frame.MICValid != nil {
		d.FCnt32 = FullFCnt(d.FCnt32, frame.FCnt16)
	}
	d.FPort = frame.FPort
	d.Confirmed = frame.Confirmed
	d.MICValid = frame.MICValid
	d.Encrypted = frame.Encrypted
	if frame.Payload != nil {
		d.Payload = frame.Payload
	}
}

// identity: un sensor con llaves se identifica por su DevEUI (estable); uno sin llaves por su
// DevAddr (cambia si vuelve a unirse a la red) o por el DevEUI de su join request.
func (s *Source) identity(f Frame) (string, *keyEntry) {
	if f.Join {
		eui := strings.ToLower(f.DevEUI)
		return "eui:" + eui, s.keysByEUI[eui]
	}
	if e := s.keysByAdr[f.DevAddr]; e != nil && e.cfg.DevEUI != "" {
		return "eui:" + strings.ToLower(e.cfg.DevEUI), e
	}
	return "addr:" + f.DevAddr, s.keysByAdr[f.DevAddr]
}

func (s *Source) countRadioOnly() int {
	n := 0
	for _, d := range s.devices {
		if !d.HasKeys {
			n++
		}
	}
	return n
}

func round(v float64, dec int) float64 {
	p := math.Pow(10, float64(dec))
	return math.Round(v*p) / p
}

func (s *Source) publish(now time.Time) {
	if s.onUpdate == nil {
		return
	}
	s.mu.Lock()
	out := make([]discovery.Device, 0, len(s.gateways)+len(s.devices))
	timeout := time.Duration(s.cfg.GatewayTimeoutSeconds) * time.Second

	for _, gw := range s.gateways {
		last := gw.LastSeen
		if gw.LastPull.After(last) {
			last = gw.LastPull
		}
		state := "online"
		if now.Sub(last) > timeout {
			state = "offline"
		}
		readings := map[string]interface{}{
			"frames_received": gw.Frames, "crc_errors": gw.CRCErrors, "devices_heard": len(gw.DevicesSet),
		}
		if st := gw.Stat; st != nil {
			readings["rxnb"], readings["rxok"], readings["rxfw"] = st.RXNb, st.RXOK, st.RXFW
			readings["ackr"], readings["dwnb"], readings["txnb"] = st.ACKR, st.DWNb, st.TXNb
		}
		out = append(out, discovery.Device{
			ExternalID: "lora-gateway:" + gw.EUI,
			Name:       "Gateway LoRa " + gw.EUI,
			Protocol:   "lorawan",
			Kind:       "sensor",
			State:      state,
			Readings:   readings,
			Model:      "lorawan-gateway",
			Attributes: map[string]interface{}{
				"category": "gateway", "gatewayEui": gw.EUI, "ip": gw.Addr,
				"lastSeenAt": last.UTC().Format(time.RFC3339), "firstSeenAt": gw.FirstSeen.UTC().Format(time.RFC3339),
				"transport": "semtech-udp", "listen": s.cfg.Listen,
			},
		})
	}

	for _, d := range s.devices {
		attrs := map[string]interface{}{
			"category": "lora_radio", "devAddr": d.DevAddr, "devEui": d.DevEUI, "joinEui": d.JoinEUI,
			"fCnt": d.FCnt32, "rssi": d.RSSI, "snr": d.SNR, "gateway": d.LastGateway, "gateways": len(d.Gateways),
			"lastUplinkAt": d.LastSeen.UTC().Format(time.RFC3339Nano), "uplinks": d.Uplinks,
			"joinRequests": d.JoinRequests, "encrypted": d.Encrypted, "hasKeys": d.HasKeys, "transport": "gateway-directo",
		}
		if d.MICValid != nil {
			attrs["micValid"] = *d.MICValid
		}
		for k, v := range d.Attrs {
			attrs[k] = v
		}
		readings := map[string]interface{}{
			"rssi": d.RSSI, "snr": d.SNR, "frequency_mhz": round(d.FreqMHz, 3), "size_bytes": d.Size,
			"fcnt": d.FCnt32, "uplinks": d.Uplinks, "join_requests": d.JoinRequests, "confirmed": d.Confirmed,
		}
		if d.FPort != nil {
			readings["fport"] = int(*d.FPort)
		}
		if d.DataRate != "" {
			readings["data_rate"] = d.DataRate
		}
		if len(d.Payload) > 0 {
			readings["payload_hex"] = hex.EncodeToString(d.Payload)
		}

		name := d.Name
		externalID := "lora-radio:" + strings.TrimPrefix(strings.TrimPrefix(d.Key, "eui:"), "addr:")
		model := d.Model
		if d.HasKeys {
			// Mismo externalId que usa lorawansource ("lorawan:<devEui>"): si el sensor tambien
			// existe por otra via, la API no lo duplica.
			if strings.HasPrefix(d.Key, "eui:") {
				externalID = "lorawan:" + strings.TrimPrefix(d.Key, "eui:")
			} else {
				externalID = "lorawan-addr:" + strings.ToLower(d.DevAddr)
			}
			attrs["category"] = "lora_sensor"
		} else {
			if model == "" {
				model = "lorawan-radio"
			}
			if name == "" {
				if d.DevEUI != "" {
					name = "Dispositivo " + strings.ToUpper(d.DevEUI) + " (join, sin llaves)"
				} else {
					name = "DevAddr " + strings.ToUpper(d.DevAddr) + " (sin llaves)"
				}
			}
		}
		if name == "" {
			name = "LoRaWAN " + d.Key
		}
		out = append(out, discovery.Device{
			ExternalID: externalID, Name: name, Protocol: "lorawan", Kind: "sensor", State: "online",
			Readings: readings, Model: model, Attributes: attrs,
		})
	}
	s.mu.Unlock()
	s.onUpdate(out)
}

package gatewaysource

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/brocaar/lorawan"

	"agente-go/internal/config"
	"agente-go/internal/discovery"
)

const (
	testDevAddr = "26011bda"
	testNwkSKey = "2b7e151628aed2a6abf7158809cf4f3c"
	testAppSKey = "3c4fcf098815f7aba6d2ae2816157e2b"
	testDevEUI  = "24e124710f139411"
	testAppKey  = "000102030405060708090a0b0c0d0e0f"
)

// buildUplink arma una trama de datos real (cifrada y con MIC) como la mandaria un sensor.
func buildUplink(t *testing.T, fcnt uint32, payload []byte) []byte {
	t.Helper()
	addr, _ := parseDevAddr(testDevAddr)
	nwk, _ := parseKey(testNwkSKey)
	app, _ := parseKey(testAppSKey)
	fport := uint8(85)
	p := lorawan.PHYPayload{
		MHDR: lorawan.MHDR{MType: lorawan.UnconfirmedDataUp, Major: lorawan.LoRaWANR1},
		MACPayload: &lorawan.MACPayload{
			FHDR:       lorawan.FHDR{DevAddr: addr, FCtrl: lorawan.FCtrl{ADR: true}, FCnt: fcnt},
			FPort:      &fport,
			FRMPayload: []lorawan.Payload{&lorawan.DataPayload{Bytes: append([]byte{}, payload...)}},
		},
	}
	if err := p.EncryptFRMPayload(app); err != nil {
		t.Fatal(err)
	}
	if err := p.SetUplinkDataMIC(lorawan.LoRaWAN1_0, 0, 0, 0, nwk, nwk); err != nil {
		t.Fatal(err)
	}
	b, err := p.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func buildJoinRequest(t *testing.T) []byte {
	t.Helper()
	var dev, join lorawan.EUI64
	_ = dev.UnmarshalText([]byte(testDevEUI))
	_ = join.UnmarshalText([]byte("24e124c0002a0001"))
	key, _ := parseKey(testAppKey)
	p := lorawan.PHYPayload{
		MHDR:       lorawan.MHDR{MType: lorawan.JoinRequest, Major: lorawan.LoRaWANR1},
		MACPayload: &lorawan.JoinRequestPayload{JoinEUI: join, DevEUI: dev, DevNonce: 1234},
	}
	if err := p.SetUplinkJoinMIC(key); err != nil {
		t.Fatal(err)
	}
	b, _ := p.MarshalBinary()
	return b
}

func TestDecodeWithKeysValidatesMICAndDecrypts(t *testing.T) {
	addr, _ := parseDevAddr(testDevAddr)
	nwk, _ := parseKey(testNwkSKey)
	app, _ := parseKey(testAppSKey)
	keys := &SessionKeys{DevAddr: addr, NwkSKey: nwk, AppSKey: app}
	plain := []byte{0x01, 0x75, 0x5c, 0x03, 0x67, 0x10, 0x01}

	phy := buildUplink(t, 70001, plain) // > 65535: prueba la reconstruccion del contador de 32 bits
	f, err := DecodeFrame(phy,
		func(string) *SessionKeys { return keys },
		func(_ string, fc16 uint32) uint32 { return FullFCnt(70000, fc16) })
	if err != nil {
		t.Fatal(err)
	}
	if f.DevAddr != testDevAddr || f.MICValid == nil || !*f.MICValid {
		t.Fatalf("MIC deberia ser valido: %+v", f)
	}
	if hex.EncodeToString(f.Payload) != hex.EncodeToString(plain) || f.Encrypted {
		t.Fatalf("payload descifrado incorrecto: %x", f.Payload)
	}

	// Con una llave equivocada el MIC no valida y no se entrega payload.
	bad, _ := parseKey("00000000000000000000000000000000")
	f2, _ := DecodeFrame(phy, func(string) *SessionKeys { return &SessionKeys{NwkSKey: bad, AppSKey: bad} },
		func(_ string, fc16 uint32) uint32 { return FullFCnt(70000, fc16) })
	if f2.MICValid == nil || *f2.MICValid || f2.Payload != nil {
		t.Fatalf("con llave equivocada no debe validar ni descifrar: %+v", f2)
	}
}

func TestDecodeWithoutKeysKeepsMetadata(t *testing.T) {
	f, err := DecodeFrame(buildUplink(t, 12, []byte{1, 2, 3}), func(string) *SessionKeys { return nil },
		func(_ string, fc16 uint32) uint32 { return fc16 })
	if err != nil {
		t.Fatal(err)
	}
	if f.DevAddr != testDevAddr || f.FCnt16 != 12 || !f.Encrypted || f.Payload != nil || f.FPort == nil || *f.FPort != 85 {
		t.Fatalf("sin llaves debe identificar la trama sin descifrar: %+v", f)
	}
}

func TestDecodeJoinRequest(t *testing.T) {
	f, err := DecodeFrame(buildJoinRequest(t), func(string) *SessionKeys { return nil }, func(_ string, c uint32) uint32 { return c })
	if err != nil {
		t.Fatal(err)
	}
	if !f.Join || f.DevEUI != testDevEUI || f.DevNonce != 1234 {
		t.Fatalf("join request mal decodificado: %+v", f)
	}
}

func TestFullFCnt(t *testing.T) {
	cases := []struct{ last, fc16, want uint32 }{
		{0, 5, 5},
		{65530, 3, 65539},    // vuelta del contador de 16 bits
		{70000, 4465, 70001}, // 70001 & 0xFFFF = 4465
		{100, 99, 99},        // retransmision cercana: no salta de vuelta
	}
	for _, c := range cases {
		if got := FullFCnt(c.last, c.fc16); got != c.want {
			t.Errorf("FullFCnt(%d,%d) = %d, se esperaba %d", c.last, c.fc16, got, c.want)
		}
	}
}

// Gateway simulado: PULL_DATA + PUSH_DATA por UDP real, igual que un packet forwarder.
func TestUDPReceiverEndToEnd(t *testing.T) {
	src, err := New(config.LoRaGatewayConfig{
		Listen: "127.0.0.1:0", GatewayTimeoutSeconds: 90, MaxRadioDevices: 10,
		Keys: []config.LoRaDeviceKeys{{Name: "Sensor piloto", Model: "LEO-S592", DevEUI: testDevEUI, DevAddr: testDevAddr, NwkSKey: testNwkSKey, AppSKey: testAppSKey}},
	})
	if err != nil {
		t.Fatal(err)
	}
	updates := make(chan []discovery.Device, 10)
	if err := src.Start(func(d []discovery.Device) { updates <- d }); err != nil {
		t.Fatal(err)
	}
	defer src.Stop()

	gw, err := net.DialUDP("udp", nil, src.conn.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer gw.Close()
	eui, _ := hex.DecodeString("0016c001f1dde184")
	readAck := func(want byte) {
		t.Helper()
		_ = gw.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 16)
		n, err := gw.Read(buf)
		if err != nil || n < 4 || buf[3] != want {
			t.Fatalf("se esperaba ACK 0x%02x, llego %x (err %v)", want, buf[:n], err)
		}
	}

	_, _ = gw.Write(append([]byte{2, 0xAA, 0xBB, pullData}, eui...))
	readAck(pullAck)

	plain := []byte{0x03, 0x67, 0xEA, 0x00}
	body, _ := json.Marshal(map[string]interface{}{
		"rxpk": []map[string]interface{}{{
			"tmst": 1, "chan": 2, "rfch": 0, "freq": 902.7, "stat": 1, "modu": "LORA", "datr": "SF10BW125",
			"codr": "4/5", "rssi": -61, "lsnr": 9.5, "size": 20,
			"data": base64.StdEncoding.EncodeToString(buildUplink(t, 1, plain)),
		}},
		"stat": map[string]interface{}{"rxnb": 3, "rxok": 3, "rxfw": 3, "ackr": 100, "dwnb": 0, "txnb": 0},
	})
	_, _ = gw.Write(append(append([]byte{2, 0x01, 0x02, pushData}, eui...), body...))
	readAck(pushAck)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case devs := <-updates:
			var gwOK, sensorOK bool
			for _, d := range devs {
				if d.ExternalID == "lora-gateway:0016c001f1dde184" && d.State == "online" {
					gwOK = true
				}
				if d.ExternalID == "lorawan:"+testDevEUI && d.Readings["payload_hex"] == hex.EncodeToString(plain) && d.Attributes["micValid"] == true {
					sensorOK = true
				}
			}
			if gwOK && sensorOK {
				return
			}
		case <-deadline:
			t.Fatal("no llego el snapshot con el gateway y el sensor descifrado")
		}
	}
}

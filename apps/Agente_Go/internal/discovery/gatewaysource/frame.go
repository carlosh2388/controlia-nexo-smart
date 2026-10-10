package gatewaysource

import (
	"encoding/hex"
	"errors"
	"strings"

	"github.com/brocaar/lorawan"
)

// Frame es una trama LoRaWAN decodificada a partir del PHYPayload que manda el gateway. El parseo
// y la criptografia (MIC, descifrado) los hace la libreria github.com/brocaar/lorawan (MIT, la misma
// base que usa ChirpStack) - no se reimplementan a mano.
type Frame struct {
	MType     string // "JoinRequest", "UnconfirmedDataUp", "ConfirmedDataUp", ...
	Uplink    bool
	Join      bool
	DevAddr   string // datos: direccion de red asignada al sensor (hex)
	DevEUI    string // join request: identificador unico de fabrica del sensor
	JoinEUI   string
	DevNonce  uint16
	FCnt16    uint32 // contador de trama tal como viaja (16 bits menos significativos)
	FPort     *uint8
	Confirmed bool
	ADR       bool
	// Solo si habia llaves de sesion para este DevAddr:
	MICValid  *bool
	Payload   []byte // FRMPayload descifrado (FPort > 0)
	Encrypted bool   // true si no se pudo descifrar (sin llaves)
	MIC       string
}

// SessionKeys son las llaves de sesion de un sensor (ABP, o las de una sesion OTAA ya activa).
type SessionKeys struct {
	DevAddr lorawan.DevAddr
	NwkSKey lorawan.AES128Key
	AppSKey lorawan.AES128Key
}

func parseKey(s string) (lorawan.AES128Key, error) {
	var k lorawan.AES128Key
	err := k.UnmarshalText([]byte(strings.TrimSpace(s)))
	return k, err
}

func parseDevAddr(s string) (lorawan.DevAddr, error) {
	var a lorawan.DevAddr
	err := a.UnmarshalText([]byte(strings.TrimSpace(s)))
	return a, err
}

// DecodeFrame decodifica un PHYPayload. keysFor devuelve las llaves de un DevAddr (o nil) y
// fullFCnt reconstruye el contador de 32 bits a partir de los 16 bits que viajan por radio.
func DecodeFrame(phy []byte, keysFor func(devAddr string) *SessionKeys, fullFCnt func(devAddr string, fcnt16 uint32) uint32) (Frame, error) {
	var p lorawan.PHYPayload
	if err := p.UnmarshalBinary(phy); err != nil {
		return Frame{}, err
	}
	f := Frame{MType: p.MHDR.MType.String(), MIC: hex.EncodeToString(p.MIC[:])}

	switch p.MHDR.MType {
	case lorawan.JoinRequest:
		jr, ok := p.MACPayload.(*lorawan.JoinRequestPayload)
		if !ok {
			return f, errors.New("join request sin payload")
		}
		f.Uplink, f.Join = true, true
		f.DevEUI = jr.DevEUI.String()
		f.JoinEUI = jr.JoinEUI.String()
		f.DevNonce = uint16(jr.DevNonce)
		return f, nil

	case lorawan.UnconfirmedDataUp, lorawan.ConfirmedDataUp:
		mac, ok := p.MACPayload.(*lorawan.MACPayload)
		if !ok {
			return f, errors.New("trama de datos sin MACPayload")
		}
		f.Uplink = true
		f.Confirmed = p.MHDR.MType == lorawan.ConfirmedDataUp
		f.DevAddr = mac.FHDR.DevAddr.String()
		f.FCnt16 = mac.FHDR.FCnt
		f.ADR = mac.FHDR.FCtrl.ADR
		f.FPort = mac.FPort
		f.Encrypted = true

		keys := keysFor(f.DevAddr)
		if keys == nil {
			return f, nil
		}
		// El MIC se calcula con el contador completo de 32 bits.
		mac.FHDR.FCnt = fullFCnt(f.DevAddr, f.FCnt16)
		valid, err := p.ValidateUplinkDataMIC(lorawan.LoRaWAN1_0, 0, 0, 0, keys.NwkSKey, keys.NwkSKey)
		if err != nil {
			return f, err
		}
		f.MICValid = &valid
		if !valid {
			return f, nil
		}
		if f.FPort != nil && *f.FPort > 0 {
			if err := p.DecryptFRMPayload(keys.AppSKey); err != nil {
				return f, err
			}
			for _, pl := range mac.FRMPayload {
				if dp, ok := pl.(*lorawan.DataPayload); ok {
					f.Payload = append(f.Payload, dp.Bytes...)
				}
			}
			f.Encrypted = false
		}
		return f, nil
	}

	// Bajadas que algun gateway reporte, RejoinRequest, propietarias: solo se identifica el tipo.
	return f, nil
}

// FullFCnt reconstruye el contador de 32 bits: elige el valor mas cercano por encima del ultimo
// contador conocido cuyos 16 bits bajos coinciden (estandar LoRaWAN 1.0).
func FullFCnt(last uint32, fcnt16 uint32) uint32 {
	candidate := (last & 0xFFFF0000) | (fcnt16 & 0xFFFF)
	if candidate < last && last-candidate > 0x8000 {
		candidate += 0x10000
	}
	return candidate
}

// NewSessionKeys arma las llaves de sesion a partir de los textos hex de la config.
func NewSessionKeys(devAddr, nwkSKey, appSKey string) (*SessionKeys, error) {
	addr, err := parseDevAddr(devAddr)
	if err != nil {
		return nil, err
	}
	nwk, err := parseKey(nwkSKey)
	if err != nil {
		return nil, err
	}
	app, err := parseKey(appSKey)
	if err != nil {
		return nil, err
	}
	return &SessionKeys{DevAddr: addr, NwkSKey: nwk, AppSKey: app}, nil
}

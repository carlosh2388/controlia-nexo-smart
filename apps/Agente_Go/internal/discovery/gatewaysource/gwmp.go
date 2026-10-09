package gatewaysource

import (
	"encoding/hex"
	"encoding/json"
	"errors"
)

// Protocolo de los gateways LoRa "Semtech UDP packet forwarder" (GWMP, versiones 1 y 2). Es el que
// usan por defecto casi todos los gateways (Advantech, Milesight, RAK, Kerlink...): el gateway envia
// lo que recibe por radio en PUSH_DATA y mantiene abierto el canal de bajada con PULL_DATA; el
// servidor responde PUSH_ACK / PULL_ACK. Referencia: PROTOCOL.TXT del packet_forwarder de Semtech.
//
//	byte 0     version (1 o 2)
//	byte 1-2   token aleatorio (se devuelve en el ACK)
//	byte 3     identificador
//	byte 4-11  EUI del gateway (PUSH_DATA, PULL_DATA, TX_ACK)
//	byte 12-   JSON (PUSH_DATA, TX_ACK)
const (
	pushData = 0x00
	pushAck  = 0x01
	pullData = 0x02
	pullResp = 0x03
	pullAck  = 0x04
	txAck    = 0x05
)

type packet struct {
	Version    byte
	Token      [2]byte
	Identifier byte
	GatewayEUI string // hex en minusculas
	Payload    []byte // JSON (puede venir vacio)
}

var errShort = errors.New("paquete GWMP demasiado corto")

func parsePacket(b []byte) (packet, error) {
	if len(b) < 4 {
		return packet{}, errShort
	}
	p := packet{Version: b[0], Token: [2]byte{b[1], b[2]}, Identifier: b[3]}
	if p.Version != 1 && p.Version != 2 {
		return packet{}, errors.New("version GWMP no soportada")
	}
	switch p.Identifier {
	case pushData, pullData, txAck:
		if len(b) < 12 {
			return packet{}, errShort
		}
		p.GatewayEUI = hex.EncodeToString(b[4:12])
		p.Payload = b[12:]
	}
	return p, nil
}

func ackFor(p packet) []byte {
	switch p.Identifier {
	case pushData:
		return []byte{p.Version, p.Token[0], p.Token[1], pushAck}
	case pullData:
		return []byte{p.Version, p.Token[0], p.Token[1], pullAck}
	}
	return nil
}

// rxpk es una trama recibida por radio (campos del packet forwarder).
type rxpk struct {
	Time string  `json:"time"`
	Tmst uint32  `json:"tmst"`
	Chan int     `json:"chan"`
	RFCh int     `json:"rfch"`
	Freq float64 `json:"freq"`
	Stat int     `json:"stat"` // 1 = CRC OK, -1 = CRC malo, 0 = sin CRC
	Modu string  `json:"modu"`
	DatR any     `json:"datr"` // "SF7BW125" en LoRa, numero en FSK
	CodR string  `json:"codr"`
	RSSI float64 `json:"rssi"`
	LSNR float64 `json:"lsnr"`
	Size int     `json:"size"`
	Data string  `json:"data"` // PHYPayload en base64
}

// gwStat son las estadisticas que el gateway envia cada ~30 s.
type gwStat struct {
	Time string  `json:"time"`
	Lati float64 `json:"lati"`
	Long float64 `json:"long"`
	Alti float64 `json:"alti"`
	RXNb int     `json:"rxnb"` // tramas recibidas
	RXOK int     `json:"rxok"` // con CRC correcto
	RXFW int     `json:"rxfw"` // reenviadas
	ACKR float64 `json:"ackr"` // % de PUSH_DATA confirmados
	DWNb int     `json:"dwnb"` // bajadas recibidas
	TXNb int     `json:"txnb"` // tramas transmitidas
}

type pushPayload struct {
	RXPK []rxpk  `json:"rxpk"`
	Stat *gwStat `json:"stat"`
}

func parsePush(b []byte) (pushPayload, error) {
	var p pushPayload
	if len(b) == 0 {
		return p, nil
	}
	err := json.Unmarshal(b, &p)
	return p, err
}

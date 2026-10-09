# LoRaWAN directo: gateway → Agente Go (sin ChirpStack)

Objetivo: que Nodivo reciba los sensores LoRaWAN **directo de los gateways**, sin ChirpStack ni
ningun broker intermedio, y que el Agente Go sea quien recolecta, descifra y genera los eventos.

```
Sensores ── radio ──▶ Gateway LoRa ── Semtech UDP :1700 ──▶ Agente Go ──▶ API Nodivo ──▶ Sedes
                       (Network Server = IP del agente)      (gatewaysource)
```

## Que hay construido (fase "receptor", 2026-10-09)

`apps/Agente_Go/internal/discovery/gatewaysource/`:

| Archivo | Que hace |
|---|---|
| `gwmp.go` | Protocolo de los gateways (Semtech UDP / GWMP v1-v2): PUSH_DATA → PUSH_ACK, PULL_DATA → PULL_ACK, tramas `rxpk` y estadisticas `stat`. |
| `frame.go` | Decodifica cada trama LoRaWAN (join request, datos confirmados/no confirmados) con `github.com/brocaar/lorawan` (MIT, la base de ChirpStack): DevAddr, DevEUI, FCnt (reconstruye 32 bits), FPort, MIC y descifrado del payload si hay llaves. |
| `source.go` | Servidor UDP; estado de cada gateway (conectado/desconectado, IP, tramas, errores CRC) y de cada dispositivo escuchado (RSSI, SNR, frecuencia, data rate, contador, join requests); deduplica la misma trama recibida por varios gateways. |

Lo que reporta a la API (`agent-sync`), con `buildingKey` de la sede:

- **Gateway**: `lora-gateway:<eui>`, modelo `lorawan-gateway`, online/offline (sin paquetes por > 90 s).
- **Dispositivo sin llaves**: `lora-radio:<devAddr|devEui>`, modelo `lorawan-radio`: se sabe que existe,
  su señal y su contador, no el contenido (esta cifrado).
- **Sensor con llaves** (config `loraGateway.keys`): `lorawan:<devEui>`, MIC validado y `payload_hex` descifrado.

Eventos nuevos (motor del agente): `discovery.gateway`, `discovery.radio_device` (autodescubrimiento,
una sola vez en la vida del agente), `lorawan.join_request`, y `device.offline` critico si un gateway se desconecta.

En la web: **Sedes → TEC 3 · Oficina (pruebas)** → pestaña *Sensores LoRaWAN · directo*: tarjeta por
gateway, tabla "Escuchados por radio · sin llaves", tramas en vivo y eventos.

## Verificacion hecha

- Tests (`go test ./...`): protocolo UDP con un gateway simulado de punta a punta (PULL/PUSH + ACK),
  descifrado y MIC con llaves correctas/incorrectas, join request, reconstruccion de FCnt > 65535,
  eventos de descubrimiento y gateway desconectado.
- **Tramas reales de TEC 3**: `cmd/lora-sniffer` escucha (solo lectura) las tramas crudas de los
  gateways en 192.168.70.6 y las decodifica con el mismo `DecodeFrame`: **20 de 20** coinciden en
  DevAddr y FCnt con lo que reporto ChirpStack (incluido FCnt 70937).
- Cadena completa con tramas reales reenviadas al agente por UDP (`lora-sniffer -replay-to`):
  gateway conectado, 13 dispositivos descubiertos, eventos en la API y en la pestaña Sedes. Los datos
  de esa prueba se borraron despues.

## Lo que todavia NO hace (fase "servidor de red activo")

El receptor **no transmite por radio**. Un servidor de red LoRaWAN completo ademas:
1. acepta los join requests (JoinAccept por radio, en la ventana de 5 s);
2. confirma los uplinks confirmados y envia comandos MAC (ADR, link check);
3. administra llaves de sesion y contadores de bajada.

Mientras eso no exista, un sensor que se mueva a un gateway apuntado al agente:
- **sigue transmitiendo** con su sesion actual (el agente lo ve como "escuchado por radio");
- si usa uplinks confirmados o link check, al no recibir respuesta **puede intentar unirse de nuevo**
  (join requests repetidos, visibles como eventos) y dejar de enviar datos.

Por eso la prueba se hace con un **gateway de pruebas** que no sea el unico que escucha a los sensores
de produccion.

## Como hacer la prueba con el gateway de pruebas

1. Correr el agente con `config.tec3-oficina.example.yaml` (copiado a `config.yaml`, con su API key)
   en una maquina **alcanzable desde el gateway por UDP 1700**:
   - mismo segmento que los gateways (ej. el servidor 192.168.70.4), o
   - otra maquina con ruta a esa red, abriendo el firewall: entrada UDP 1700.
2. En el gateway (Advantech: *LoRaWAN RF → Radio Setting*): **Network Server** = IP de esa maquina,
   **Upstream/Downstream Port** = 1700. Submit.
3. En el log del agente debe aparecer `[lora-gw] gateway nuevo conectado: <eui>` y en Sedes → TEC 3 · Oficina el gateway "Conectado directo al agente".
4. Volver atras = poner de nuevo `10.0.6.35` / `192.168.70.6` en Network Server.

**No usar** el gateway `0016c001f1de39f9` de TEC 3 para la prueba: es por donde entran todos los
sensores de TEC 3 (verificado 2026-10-09). Los gateways `0016c001f1dde184` y `0016c001f1de3fd3` no llevaban sensores.

## Siguientes pasos

1. Llaves de 1-2 sensores piloto (generadas por Nodivo y cargadas en el sensor con la app del fabricante).
2. Decodificadores por modelo en Go (Milesight LEO-S592/EM300/EM500, Advantech WISE-4610) desde la
   documentacion del fabricante, para pasar de `payload_hex` a metricas.
3. Fase activa: JoinAccept + respuestas por radio (con `brocaar/lorawan` y el plan US902-0 del gateway).
4. Registro de llaves en Nodivo (alta de sensores, importacion CSV) para todas las sedes.

# Agente_Go

Agente en Go que corre en el servidor local de **un** edificio, escucha los protocolos IoT
habilitados en su red (MQTT/Zigbee2MQTT, LoRaWAN, BACnet/IP), y reporta lo que descubre a la API
central de Nodivo. Es la pieza de "instalar uno por edificio" del plan de automatización — ver
[`docs/agente-go.md`](../../docs/agente-go.md) para la arquitectura completa, el roadmap de fases
y los diagramas.

No reemplaza nada de lo que ya corre dentro de `apps/api` (los adaptadores MQTT/HTTP/eWeLink/LoRaWAN/
BACnet siguen ahi para TEC 3) y **no duplica lo que ya gestionan esos adaptadores**: antes de crear
un dispositivo, `agent-sync` verifica si ya existe uno fisicamente igual (mismo `stateTopic`,
`devEui`, o `host`+`unitKey` BACnet) creado por cualquier otra via, y si lo encuentra no lo toca -
ver "Como se evitan los duplicados" en `docs/agente-go.md`. Verificado en vivo contra los 13 AC y
19 sensores reales de TEC 3: 0 duplicados.

## Que hace y que no hace

- ✅ **MQTT/Zigbee2MQTT**: descubre dispositivos (topico `bridge/devices`) y sus estados en vivo.
  Reporta tambien el `commandTopic`/`stateTopic` reales, asi que un switch queda **controlable de
  verdad** (no solo lectura) apenas se confirma - siempre que la API central y el agente apunten al
  mismo broker.
- ✅ **LoRaWAN** (ChirpStack via MQTT): descubre sensores por sus uplinks, siempre de solo lectura
  (son sensores, no hay nada que "encender").
- ✅ **BACnet/IP** (gateways como una central VRF de aires acondicionados): via `apps/bacnet-bridge`
  corriendo aparte - ver "Por que BACnet no habla el protocolo directo" en `docs/agente-go.md`. Solo
  lectura por ahora (el control de clima es multi-punto, no un simple on/off).
- ✅ Todo se reporta a `POST /devices/agent-sync` cada `syncIntervalSeconds`. Un dispositivo nuevo
  llega con `areaId: null` y `metadata.agent.pendingReview: true` - alguien tiene que asignarlo a
  un area/sala desde el frontend (pestaña "Agente Go"), como con cualquier import manual.
- ❌ **BACnet/LoRaWAN todavia no reciben comandos de vuelta** (Fase 3: falta un canal agente<-API
  para protocolos que no son MQTT).
- ❌ **No deduplica contra dispositivos ya importados por los flujos manuales existentes** - ver la
  advertencia en `docs/agente-go.md` antes de correrlo contra un edificio que ya tiene datos.
- ❌ No hace HTTP (Shelly/Tasmota/Home Assistant) todavia (Fase 4).

## Requisitos

- Go 1.24+ para compilar (no hace falta en el servidor destino: se distribuye como binario).
- Una API key de Nodivo con `role: agent` (la crea un admin, ver mas abajo).
- Acceso de red desde el servidor del edificio hacia: (a) el broker MQTT de ese edificio, (b) la
  API central de Nodivo por HTTPS/HTTP saliente.

## Compilar

```bash
# Build para la misma maquina donde estas parado
go build -o bin/agente-go ./cmd/agent

# Cross-compile para el servidor Linux del edificio (esto es lo que se usa en produccion)
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/agente-go-linux-amd64 ./cmd/agent

# Sin Go instalado localmente, con Docker:
docker run --rm -v "$(pwd)":/app -w /app -e GOOS=linux -e GOARCH=amd64 -e CGO_ENABLED=0 \
  golang:1.24 go build -o bin/agente-go-linux-amd64 ./cmd/agent
```

Da como resultado un binario estatico sin dependencias (~10MB) - se copia solo, no necesita
`node_modules` ni runtime instalado en el servidor destino.

## Configurar

1. Copia `config.example.yaml` a `config.yaml` y completa los valores del edificio real.
2. Crea la API key del agente (una vez, como admin, contra la API central):

   ```bash
   curl -X POST http://TU_API/api/v1/api-keys \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{"name":"Agente <nombre del edificio>","role":"agent"}'
   ```

   La respuesta trae `key` **una sola vez** - copiala a `config.yaml` en ese momento, no se puede
   volver a ver despues (mismo comportamiento que cualquier otra API key de Nodivo).

3. `config.yaml` nunca se commitea (esta en `.gitignore`): vive solo en el servidor del edificio.

## Correr

```bash
./bin/agente-go-linux-amd64 -config /etc/agente-go/config.yaml
```

### Como servicio systemd (Linux)

```ini
# /etc/systemd/system/agente-go.service
[Unit]
Description=Agente_Go - Nodivo building agent
After=network-online.target

[Service]
ExecStart=/opt/agente-go/agente-go-linux-amd64 -config /etc/agente-go/config.yaml
Restart=on-failure
RestartSec=5
User=agente-go

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agente-go
sudo journalctl -u agente-go -f   # logs en vivo
```

## Estructura del proyecto

```
apps/Agente_Go/
  cmd/agent/main.go          - entrypoint: arma las fuentes habilitadas y arranca el agente
  internal/config/           - carga y valida config.yaml
  internal/discovery/        - contrato Source/Device comun a cualquier protocolo
  internal/discovery/mqttsource/ - driver MQTT/Zigbee2MQTT (Fase 1)
  internal/reporter/         - cliente HTTP hacia POST /devices/agent-sync
  internal/agent/            - junta snapshots de todas las fuentes y sincroniza cada tick
  config.example.yaml        - plantilla de configuracion (copiar a config.yaml)
```

## Como agregar un protocolo nuevo (Fase 2+)

1. Crear `internal/discovery/<protocolo>source/` implementando la interfaz `discovery.Source`
   (`Name()`, `Start(onUpdate func([]discovery.Device)) error`, `Stop()`) - `mqttsource` es la
   referencia a copiar.
2. Agregar su seccion de config en `internal/config/config.go` (mismo patron que `MQTTConfig`).
3. Registrarlo en `cmd/agent/main.go` junto al de MQTT.

El resto (reporter, agent, el endpoint `agent-sync` en la API) no cambia: estan escritos para
cualquier cantidad de fuentes, no solo MQTT.

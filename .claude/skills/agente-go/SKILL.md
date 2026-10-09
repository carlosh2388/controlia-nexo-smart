---
name: agente-go
description: Compilar, probar, configurar, ejecutar y desplegar el Agente_Go (recolector de una sede/edificio que lee Modbus TCP, LoRaWAN por MQTT, Zigbee2MQTT y BACnet, detecta eventos y los reporta a la API de Nodivo). Usar cuando se pida correr el agente, cambiar su config, revisar sus logs, agregar una fuente de protocolo, o instalarlo en un servidor.
---

# Agente_Go: el recolector de cada sede

Codigo: `apps/Agente_Go/`. Documentacion completa: `docs/agente-go.md` (arquitectura) y
`docs/sedes-igss.md` (sedes IGSS, Modbus, LoRaWAN, eventos).

## Que hace (en una frase por paso)

1. **Descubre y lee** cada fuente habilitada en `config.yaml`:
   `modbussource` (EBO AS-P por Modbus TCP, solo lectura), `lorawansource` (uplinks de ChirpStack
   por MQTT), `gatewaysource` (**LoRaWAN directo**: los gateways mandan sus tramas al agente por
   Semtech UDP 1700, sin ChirpStack - ver `docs/lorawan-directo.md`), `mqttsource` (Zigbee2MQTT),
   `bacnetsource` (via `apps/bacnet-bridge`).
   Herramienta de diagnostico: `cmd/lora-sniffer` (solo lectura) compara las tramas crudas de los
   gateways contra lo que reporta un servidor de red, y con `-replay-to` las reenvia al agente.
2. **Normaliza** (perfiles por modelo, conversion 4-20 mA -> °C de los WISE con los tags de ChirpStack).
3. **Detecta eventos** sobre cada lectura nueva (`internal/events`): transferencias del ATS,
   generador, alarmas por umbral, puertas, cadena de frio, sensores sin comunicacion, ChirpStack caido.
4. **Guarda en disco** lo que no pudo enviar (`dataDir/pending-events.json`, `state.json`).
5. **Reporta** cada `syncIntervalSeconds` (o de inmediato si hay un evento critico) a
   `POST /api/v1/devices/agent-sync` con una API key de rol `agent`.

## Compilar y probar (Windows, sin instalar Go en el sistema)

Go 1.24.13 portable (verificar SHA256 contra https://go.dev/dl/?mode=json&include=all):

```powershell
$go = "<carpeta>\go\bin\go.exe"; $env:GOROOT = "<carpeta>\go"; $env:GOTOOLCHAIN = "local"
cd apps/Agente_Go
& $go vet ./...
& $go test ./...                 # modbussource, events, lorawansource tienen tests
& $go build -o bin/agente-go.exe ./cmd/agent
$env:GOOS="linux"; $env:GOARCH="amd64"; & $go build -o bin/agente-go-linux-amd64 ./cmd/agent   # servidor Linux
```

PowerShell 5.1: al generar un config.yaml desde el ejemplo, leer/escribir con
`[IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)` - `Get-Content` lo lee como ANSI y rompe las
tildes ("MÃ³dulos"), lo que cambia los externalId de los equipos.

## Configurar una sede

1. Partir de `config.igss-escuintla.example.yaml` (o `config.example.yaml` para TEC 3).
2. `buildingKey` estable (`igss-<sede>`): **no cambiarlo despues** (es parte de la identidad de cada equipo).
3. API key de rol agent (como admin):
   `POST /api/v1/api-keys {"name":"Agente IGSS <Sede>","role":"agent"}` -> el valor sale una sola vez.
4. Agregar la sede en `apps/web/src/config/sites.ts` con el mismo `buildingKey`.
5. Para mapear los bloques Modbus de una sede nueva usar el skill `sede-igss`.

## Ejecutar y verificar

```powershell
bin/agente-go.exe -config config.yaml
```

Lineas que deben aparecer en el log:
- `[modbus] EBO-...: N/M equipo(s) con datos validos` cada 15 s.
- `[lorawan] conectado a tcp://...:1883, suscribiendo a application/+/device/+/event/up`.
- `[evento] <severidad> <tipo> <mensaje>` por cada evento detectado.
- `sync OK: total=.. nuevos=.. actualizados=.. eventos=X/Y`.

Luego en la web: pestaña **Sedes** -> la sede -> Energia / Sensores LoRaWAN / Eventos.

## Desplegar en un servidor Linux (ej. 192.168.70.4)

Copiar `bin/agente-go-linux-amd64` + `config.yaml` a `~/agente-go/`, crear `data/`, y dejarlo como
servicio (systemd, ver `apps/Agente_Go/README.md`) o `@reboot` en crontab. El servidor debe poder
alcanzar el EBO (TCP 502) y el broker de ChirpStack (TCP 1883) de la sede.
**Gotcha conocido**: por SSH no usar `pkill -f`/`pgrep -f` con el nombre del script (se mata la
propia sesion); usar PIDs o `pgrep -x`.

## Reglas que no se rompen

- El agente **nunca escribe** registros Modbus (el cliente solo implementa funciones 03/04).
- No mandar comandos a equipos reales sin confirmacion explicita del usuario por equipo.
- Cambiar umbrales de eventos en `config.yaml` (`events.thresholds`), no en el codigo.

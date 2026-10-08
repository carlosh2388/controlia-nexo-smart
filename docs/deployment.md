# Despliegue

## Docker Compose

El stack completo se levanta con:

```bash
docker-compose up -d --build
```

Servicios publicados por defecto:

| Servicio | Puerto host | Puerto contenedor |
| --- | ---: | ---: |
| web | 5173 | 80 |
| api | 3010 | 3000 |
| postgres | 5432 | 5432 |
| redis | 6379 | 6379 |
| mosquitto | 1883 | 1883 |

En el servidor `192.168.70.4`, el puerto `5432` ya estaba ocupado por otro contenedor, por lo que Postgres del proyecto se deja interno en Docker y la API accede por hostname `postgres`.

## Variables

API:

```env
DATABASE_URL=postgresql://siasa:siasa@postgres:5432/siasa_iot?schema=public
REDIS_URL=redis://redis:6379
MQTT_URL=mqtt://mosquitto:1883
JWT_ACCESS_SECRET=change-me-access
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=change-me-refresh
JWT_REFRESH_EXPIRES_IN=7d
API_PORT=3000
CORS_ORIGIN=http://192.168.70.4:5173
```

Web build args:

```env
VITE_API_URL=http://192.168.70.4:3010/api/v1
VITE_WS_URL=ws://192.168.70.4:3010/ws
```

## Puente BACnet (aires acondicionados)

`apps/bacnet-bridge` corre nativo en el servidor (fuera de Docker, usuario `api`), lo arranca
`~/siasa-iot-platform/start-bacnet-bridge.sh` desde el crontab (`@reboot`) y escribe en
`logs/bacnet-bridge.log`. El API en Docker le habla directo por
`BACNET_BRIDGE_URL=http://host.docker.internal:3099` (`extra_hosts` en `docker-compose.yml`).
El token debe ser el mismo en `.env` y en `start-bacnet-bridge.sh`.

Solo un puente debe consultar el gateway (`10.3.0.11`) a la vez: no dejar corriendo otro en un
PC de desarrollo contra el mismo gateway.

```bash
# reiniciar el puente
pkill -f "apps/bacnet-bridge/server.js"; setsid nohup sh ./start-bacnet-bridge.sh >/dev/null 2>&1 &
tail -f logs/bacnet-bridge.log
```

En este servidor el Who-Is no recibe respuesta del gateway (el I-Am sale por broadcast en la red
10.3.0.x y no llega), pero las lecturas y escrituras unicast si funcionan. Por eso
`start-bacnet-bridge.sh` pasa `BACNET_KNOWN_DEVICES=10.3.0.11=9000`: con el deviceId conocido,
`POST /discover` se salta el Who-Is.

Ojo al reiniciar por SSH: `pkill -f`/`pgrep -f` con el nombre del script tambien matchea la propia
linea de comando de la sesion SSH y la mata. Usar el PID (`ss -lntp | grep 3099`).

## Agente_Go (servidor)

Instalado en `~/agente-go/` (binario `agente-go` linux/amd64, `config.yaml` con permisos 600 y la
API key `role=agent` "Agente TEC3 (servidor)"). Lo arranca `~/agente-go/start-agente-go.sh` desde
el crontab (`@reboot`), que lo reinicia si se cae; log en `~/agente-go/agente-go.log`.
`buildingKey: tec3-nivel10`, fuentes LoRaWAN (`192.168.70.6`) y BACnet (via el puente local).
El estado del ultimo sync se ve en la pestaña "Agente Go" (`GET /devices/agent-status`).

```bash
tail -f ~/agente-go/agente-go.log
kill $(pgrep -x agente-go)   # el script lo vuelve a levantar en 5s
```

## Pipeline del Contenedor API

```mermaid
flowchart LR
  S[Source] --> N[npm ci]
  N --> P[prisma generate]
  P --> B[nest build]
  B --> R[container start]
  R --> M[prisma migrate deploy]
  M --> Seed[prisma seed]
  Seed --> API[node apps/api/dist/src/main.js]
```

## Comandos Operativos

```bash
cd ~/siasa-iot-platform
docker-compose ps
docker-compose logs --tail=100 api
docker stats --no-stream
docker-compose restart api
docker-compose up -d --build
```


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


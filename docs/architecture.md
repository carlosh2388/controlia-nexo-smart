# Arquitectura

## Vista General

```mermaid
flowchart LR
  U[Usuario / Navegador] --> W[Web React + Vite + Nginx]
  W -->|REST JSON| A[NestJS API]
  W -->|WebSocket /ws| RT[Realtime Gateway]
  A --> P[(PostgreSQL)]
  A --> R[(Redis)]
  A --> M[Broker MQTT Mosquitto]
  A --> HA[Home Assistant API]
  A --> EW[eWeLink HTTP API]
  A --> EXT[Gateway externo x-api-key]
  M --> Z2M[Zigbee2MQTT / Dispositivos MQTT]
  RT --> W
```

## Componentes

### Web

Ubicacion: `apps/web`

Responsabilidades:

- Login y persistencia de sesion con Zustand.
- Panel clasico de dispositivos.
- Vista de edificio con imagenes, areas y poligonos.
- Gestion inteligente de automatizaciones.
- Importacion desde Home Assistant y MQTT/Zigbee2MQTT.
- Consumo REST via Axios y sincronizacion con React Query.
- Actualizacion en tiempo real via WebSocket.

### API

Ubicacion: `apps/api`

Responsabilidades:

- Autenticacion JWT y refresh tokens.
- Gestion de usuarios y API keys.
- CRUD de dispositivos.
- Despacho de comandos por MQTT, HTTP/Home Assistant y eWeLink.
- Lectura de estados y publicacion al bus interno.
- Areas/tenants para la vista de edificio.
- Reglas de automatizacion por estado y horario.
- Gateway externo opcional para integraciones con `x-api-key`.

### Infraestructura

Servicios de `docker-compose.yml`:

- `postgres`: base de datos.
- `redis`: cola BullMQ.
- `mosquitto`: broker MQTT.
- `api`: backend NestJS.
- `web`: frontend estatico servido con Nginx.

## Comunicacion Principal

```mermaid
sequenceDiagram
  participant Browser as Navegador
  participant Web as Web React
  participant API as NestJS API
  participant DB as PostgreSQL
  participant Queue as Redis/BullMQ
  participant MQTT as Mosquitto
  participant Device as Dispositivo

  Browser->>Web: Abre /devices
  Web->>API: POST /auth/login
  API->>DB: valida usuario
  API-->>Web: accessToken + refreshToken
  Web->>API: GET /devices
  API->>DB: dispositivos + estados
  API-->>Web: lista de dispositivos
  Web->>API: POST /devices/:id/command
  API->>DB: crea command pending
  API->>Queue: encola comando
  Queue->>API: procesa command
  API->>MQTT: publish payload
  MQTT->>Device: comando
  Device->>MQTT: estado
  MQTT->>API: mensaje estado
  API->>DB: upsert DeviceState
  API-->>Web: evento WebSocket
  Web->>API: refetch cache
```

## Cola de Comandos (Redis)

Redis no guarda datos de negocio (eso es Postgres): es el backend de BullMQ, la
cola de trabajos para comandos hacia dispositivos. La API responde al usuario
de inmediato sin esperar al dispositivo; el envio real ocurre en paralelo via
un worker que consume la cola.

```mermaid
flowchart LR
  U[Usuario] -->|"1. POST comando"| API[API NestJS]
  API -.->|"2. 200 OK inmediato"| U
  API -->|"3. commandsQueue.add()"| R[("Redis: cola")]
  R -->|"4. worker toma el job"| W["Worker: commands.processor.ts"]
  W -->|"5. publica"| M[Broker MQTT]
  M -->|"6. ejecuta comando"| D[Dispositivo]
```

Si la API se reinicia entre el paso 3 y el 4, el job sigue en Redis y el
worker lo retoma apenas vuelve a levantar. Sin Redis, ese job viviria solo en
la memoria del proceso y se perderia.

## Modulos Backend

```mermaid
flowchart TB
  AppModule --> AuthModule
  AppModule --> UsersModule
  AppModule --> DevicesModule
  AppModule --> AreasModule
  AppModule --> AutomationsModule
  AppModule --> ApiKeysModule
  AppModule --> RealtimeModule
  AppModule --> AdaptersModule
  AppModule --> PrismaModule
  AppModule --> StateBusModule
  AppModule --> EventsModule

  DevicesModule --> BullMQ
  DevicesModule --> AdapterRegistry
  AdapterRegistry --> MqttAdapter
  AdapterRegistry --> HttpAdapter
  AdapterRegistry --> EwelinkAdapter
  MqttAdapter --> StateBusModule
  StateBusModule --> RealtimeModule
  StateBusModule --> AutomationsModule
```


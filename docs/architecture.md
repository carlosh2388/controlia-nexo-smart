# Arquitectura

> Este documento cubre TEC 3 (adaptadores en proceso dentro de `apps/api`). Para edificios nuevos,
> gestionados por un agente local en vez de adaptadores en proceso, ver
> [`agente-go.md`](./agente-go.md).

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
  A --> LW[Broker MQTT LoRaWAN / ChirpStack]
  A -->|HTTP| BB["bacnet-bridge (Node, host, no Docker)"]
  BB -->|UDP/47808 BACnet/IP| BAC["Gateway BACnet/IP AV/climatizacion\n(ej. VRF aires)"]
  A --> EXT[Gateway externo x-api-key]
  M --> Z2M[Zigbee2MQTT / Dispositivos MQTT]
  RT --> W

  AG["Agente_Go (edificios nuevos)"] -->|"POST /devices/agent-sync\nx-api-key role=agent"| A
  AG -.->|"ver agente-go.md"| BB
```

## Componentes

### Web

Ubicacion: `apps/web`

Responsabilidades:

- Login y persistencia de sesion con Zustand.
- Panel clasico de dispositivos.
- Vista de edificio con imagenes, areas y poligonos.
- Gestion inteligente de automatizaciones.
- Importacion desde Home Assistant, MQTT/Zigbee2MQTT y BACnet/IP para dispositivos AV/climatizacion.
- Consumo REST via Axios y sincronizacion con React Query.
- Actualizacion en tiempo real via WebSocket.

### API

Ubicacion: `apps/api`

Responsabilidades:

- Autenticacion JWT y refresh tokens.
- Gestion de usuarios y API keys.
- CRUD de dispositivos.
- Despacho de comandos por MQTT, HTTP/Home Assistant, eWeLink y BACnet/IP para AV/climatizacion.
- Lectura de estados y publicacion al bus interno.
- Areas/tenants para la vista de edificio.
- Reglas de automatizacion por estado y horario.
- Gateway externo opcional para integraciones con `x-api-key`.

## Protocolos de Dispositivos

La plataforma modela el protocolo en `Device.protocol` y selecciona el adaptador
correspondiente desde `AdapterRegistry`.

| Protocolo | Uso principal | Canal |
| --- | --- | --- |
| `mqtt` | Zigbee2MQTT y dispositivos MQTT locales | Broker Mosquitto |
| `http` | Dispositivos importados desde Home Assistant | API REST de Home Assistant |
| `ewelink` | Sonoff/eWeLink LAN | HTTP local |
| `lorawan` | Sensores LoRaWAN via ChirpStack | MQTT ChirpStack |
| `bacnet` | Dispositivos AV/climatizacion, como VRF/aires | API -> `bacnet-bridge` -> BACnet/IP UDP 47808 |

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
  DevicesModule --> AgentSyncService
  AdapterRegistry --> MqttAdapter
  AdapterRegistry --> HttpAdapter
  AdapterRegistry --> EwelinkAdapter
  AdapterRegistry --> LorawanAdapter
  AdapterRegistry --> BacnetAdapter
  BacnetAdapter -->|HTTP| BacnetBridge["bacnet-bridge (fuera de Docker)"]
  BacnetBridge -->|UDP/47808 BACnet/IP| BacnetGateway["Gateway BACnet AV/climatizacion"]
  MqttAdapter --> StateBusModule
  LorawanAdapter --> StateBusModule
  BacnetAdapter --> StateBusModule
  StateBusModule --> RealtimeModule
  StateBusModule --> AutomationsModule

  AgentSyncService -.->|"dispositivos de Agente_Go\n(edificios nuevos, ver agente-go.md)"| PrismaModule
```


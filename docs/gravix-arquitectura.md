# Gravix: arquitectura de la solución implementada

Estado al **23/11/2026**. Sede piloto: **IGSS Escuintla**, que desde el 20/11 funciona en su **Gravix de sede**.
Servidor: **192.168.70.4 (pruebas)**.

> En producción cada sede tiene **su propio Gravix local** (VM Linux con Docker), igual que hoy cada
> sede de Telemetría 1 tiene su AS-P. La arquitectura actual está en la **[sección 0](#0-arquitectura-en-producción-actualizado-al-2311)**.
> La instalación y operación por sede, en [gravix-sede.md](./gravix-sede.md). La lista completa de
> endpoints, en [api-referencia.md](./api-referencia.md).

Gravix es la solución de SIASA para que las sedes **no dependan del EBO AS-P ni de sus licencias**
para tener sus datos de energía. El software lee los medidores, guarda todo el historial con su hora,
detecta los datos que faltan y, en la fase final, los recupera. Este documento describe **lo que ya
está construido y funcionando**. La bitácora del despliegue, el mapa de registros y el detalle del
comparativo están en [piloto-gravix.md](./piloto-gravix.md).

---

## 0. Arquitectura en producción (actualizado al 23/11)

![Gravix de sede y Centro de mando en producción](./diagramas/gravix-produccion.svg)

Archivos: [SVG](./diagramas/gravix-produccion.svg) · [PNG en alta resolución](./diagramas/gravix-produccion.png).
El diagrama del piloto en un solo servidor (estado del 18/11) sigue en las secciones 2 a 8:
[gravix-arquitectura.svg](./diagramas/gravix-arquitectura.svg).

### 0.1 Vista general

```mermaid
flowchart LR
  subgraph RED["Red de la sede"]
    MED["Medidores ION7400 / PM2130 / generador"]
    ASP["AS-P EBO (transición)"]
    CS["ChirpStack (LoRaWAN)"]
  end
  subgraph VM["VM de la sede · Gravix de sede (docker compose)"]
    AG["Agentes Go<br/>directo + general"]
    API["BACKEND<br/>Gravix API NestJS<br/>GRAVIX_MODO=sede"]
    WEB["FRONTEND<br/>web local React + nginx"]
    TS[("TimescaleDB<br/>base principal")]
    IX[("InfluxDB de la sede<br/>telemetry · monitoreo")]
    TG["Telegraf"]
  end
  subgraph CEN["Servidor central"]
    WC["FRONTEND<br/>Centro de mando"]
    AC["BACKEND<br/>API central NestJS<br/>GRAVIX_MODO=central"]
    PC[("PostgreSQL + TimescaleDB<br/>del central")]
    IC[("InfluxDB CENTRAL<br/>un bucket por sede + resumen")]
    MC["Monitoreo central 10.30.10.27<br/>(Telemetría 1, solo lectura)"]
  end
  MED -->|"Modbus TCP directo"| AG
  ASP -->|"Modbus"| AG
  CS -->|"MQTT"| AG
  AG -->|"POST /devices/agent-sync"| API
  WEB -->|"/api/v1 + /ws (nginx)"| API
  API --> TS
  API -->|"lectura · alarma · correo"| IX
  TG --> IX
  IX ==>|"réplica nativa, cola en disco 5 GB"| IC
  AC -->|"GET /sede/* cada 15 s<br/>x-api-key (viewer)"| API
  WC -->|"/api/v1 + JWT · /ws"| AC
  AC --> PC
  AC -->|"GET /api/vista"| MC
  TS -.->|"respaldo nocturno (pendiente)"| CEN
```

### 0.2 Bases de datos

| Base | Dónde | Motor | Qué guarda | Retención |
| --- | --- | --- | --- | --- |
| **TimescaleDB de la sede** (servicio `db`) | VM de la sede | PostgreSQL 16 + TimescaleDB 2.31 | **Todo**: `readings` (energía, bloques de 1 día, comprime a 7 días), `device_readings` (historial de sensores y medidores), `devices` y `agent_configs` (equipos, fichas, configuración de agentes), `alarma_eventos`, `alarma_correos`, `alarma_config`, `reading_gaps`, `site_events`, `users`, `role_permissions`, `api_keys`, `device_states` | Detalle **60 días** (`SEDE_RETENCION_DIAS`). Alarmas 12 meses. Configuración sin límite |
| **InfluxDB de la sede** (servicio `influxdb`) | VM de la sede | InfluxDB 2.8 | Bucket `telemetry`: measurements **`lectura`** (energía), **`alarma`** (apertura y cierre) y **`correo`** (preparado o enviado) | **60 días** |
| | | | Bucket `monitoreo`: consumo de contenedores y tamaño de las bases (Telegraf, cada 10 s) | 30 días |
| | | | Bucket `monitoreo_horas`: resumen por hora (tarea "Resumen de consumo por hora") | 1 año |
| **InfluxDB central** (`deploy/central-influx`) | Servidor central | InfluxDB 2.8 | **Un bucket por sede** (código de la sede): réplica de `lectura`, `alarma` y `correo` | **1 año** |
| | | | Bucket `resumen`: promedio, mínimo y máximo de 15 min de todas las sedes (`lectura_15m_prom/_min/_max`) | **5 años** |
| **PostgreSQL + TimescaleDB del central** | Servidor central | PostgreSQL 16 + TimescaleDB | `red_grupos` y `red_sedes` (URL y clave cifrada de cada sede, fuente de alarmas), `centro_lecturas` (foto por minuto de cada sede), usuarios y permisos, TEC 3, historial de Escuintla anterior al 20/11 | Sin política |
| Comparativo (opcional, desde el 20/11) | VM de la sede | `db-comparativo` (TimescaleDB) + `influxdb-comparativo` | Las mismas lecturas de energía en dos bases vacías, para medir el consumo de cada una | Hasta que termine la prueba |
| Redis (servicio `redis`) | Sede y central | Redis 7 | Cola de comandos (BullMQ) | En memoria |

**Por qué dos motores:**
- **TimescaleDB es la base principal de Gravix.** Además de las lecturas guarda lo que no es serie de
  tiempo (fichas, configuración, usuarios, alarmas, huecos), con ediciones, relaciones y transacciones.
- **InfluxDB guarda solo series de tiempo.** Viaja al central por la réplica y alimenta los tableros.
- **La configuración no va a InfluxDB.** Su respaldo es el **respaldo nocturno de TimescaleDB**
  (pendiente) al central.

**Si se cae el enlace con el central,** la sede sigue completa: lee, guarda, detecta huecos y genera
alarmas. Al volver:
- la réplica envía en orden todo lo pendiente (prueba del 23/11: 6 793 lecturas de un corte de 3 min, iguales en los dos lados);
- el Centro de mando vuelve a consultar la sede.

### 0.3 Backend, frontend y cómo se comunican

| Pieza | Tecnología | Dónde corre | Qué hace |
| --- | --- | --- | --- |
| **Backend de sede** (Gravix API) | NestJS 10 + Fastify, Prisma, Node 20 | Contenedor `gravix` (:3010) | Recibe a los agentes, guarda en TimescaleDB e InfluxDB, detecta huecos, normas, motor de alarmas, API `/sede` para el central |
| **Frontend de sede** (web local) | React 18 + Vite + TypeScript, React Query, Tailwind; nginx | Contenedor `web` (:5173) | Equipos (buscar y agregar, ficha), Piloto Gravix, Usuarios. Compilado con `VITE_GRAVIX_MODO=sede` |
| **Backend central** (API central) | El mismo código, `GRAVIX_MODO=central` | Contenedor `api` (:3010) | Centro de mando, red y sedes Gravix (colector, paso de consultas), módulo de alarmas, asistente, TEC 3 |
| **Frontend central** (Centro de mando) | La misma web, modo central | Contenedor `web` (:5173) | Mapa, Telemetría 1/2/3, alertas, Piloto, Equipos, Alarmas y correos, Usuarios |

**Cómo se comunican:**
1. **Frontend → backend (REST):**
   - El navegador llama a `/api/v1/...` con `axios` (`apps/web/src/api/client.ts`). Envía `Authorization: Bearer <JWT>`.
   - El JWT dura 15 min. Ante un 401, el cliente lo renueva solo con `POST /auth/refresh`.
   - **React Query** guarda en caché y refresca cada pantalla, normalmente cada 15–60 s.
   - En la sede, la web usa rutas **relativas** (`/api/v1`) y **nginx** las pasa a la API. Así la misma imagen sirve para cualquier IP.
2. **Backend → frontend (tiempo real):** WebSocket **`/ws?token=<JWT>`**. La API envía
   `{type: "device.state", deviceId, state}` cuando cambia un equipo, y la web refresca sus datos (`useDeviceSocket.ts`).
3. **Agente → backend de sede:**
   - Cada 15–30 s, `POST /devices/agent-sync` con `x-api-key` de rol `agent`: estado, lecturas, eventos y respaldo en disco.
   - Cada 5 s, `GET /agents/:key/control`, para saber si hay configuración nueva o una búsqueda pedida.
4. **Backend central → backend de sede:**
   - Cada 15 s, `GET /sede/vista`, `/devices`, `/devices/agent-status` y `/agents`, más `/sede/salud` cada minuto, con la **clave de consulta** (rol `viewer`, cifrada en el central).
   - Las pantallas del central piden el detalle de un equipo de la sede **a través del central** (paso de consultas, solo GET).
   - El módulo de alarmas escribe en `PUT /sede/alarmas/config`, la única escritura que la sede acepta del central.
5. **Backend → bases:** Prisma (SQL) a TimescaleDB; *line protocol* por HTTP a InfluxDB.
6. **InfluxDB de la sede → InfluxDB central:** réplica nativa de InfluxDB, con cola en disco. **No pasa por la API.**

```mermaid
sequenceDiagram
  autonumber
  participant N as Navegador (Centro de mando)
  participant AC as API central
  participant AS as Gravix API (sede)
  participant TS as TimescaleDB (sede)
  participant AG as Agente Go
  AG->>AS: POST /devices/agent-sync (x-api-key agent)
  AS->>TS: lecturas, estado, huecos
  N->>AC: GET /api/v1/pilot/devices/ID/series (Bearer JWT)
  AC->>AS: misma ruta con x-api-key de consulta (paso de consultas)
  AS->>TS: SELECT time_bucket(...)
  AS-->>AC: serie
  AC-->>N: serie (la pantalla no sabe que vino de la sede)
  AS-->>N: (WebSocket /ws en la web local: device.state)
```

La lista completa de los 97 endpoints, con permisos y en qué servidor existe cada uno, está en
**[api-referencia.md](./api-referencia.md)**.

---

![Arquitectura de Gravix (piloto, 18/11)](./diagramas/gravix-arquitectura.svg)

Archivos del diagrama del piloto: [SVG](./diagramas/gravix-arquitectura.svg) ·
[PNG en alta resolución](./diagramas/gravix-arquitectura.png).

---

## 1. Alcance y fases

| Fase | Qué resuelve | Estado |
| --- | --- | --- |
| **A. Historial** | Cada lectura se guarda con su hora en PostgreSQL + TimescaleDB y cada hueco queda registrado con su causa | **En producción** desde el 03/11/2026 |
| **B. Lectura directa** | El agente lee cada medidor por su propia IP, sin pasar por el AS-P, y se compara contra el AS-P | **En prueba** desde el 09/11/2026 con los 14 equipos. Comparativo cerrado el 12/11: **viable** |
| **C. Recuperación** | Rellenar los huecos desde la memoria del ION7400 (dato "recuperado") o por diferencia de contador (dato "estimado") | **Pendiente**. Primero hay que verificar en el equipo cómo se lee su memoria |

El piloto se limita a Escuintla hasta que esté validado por completo. Las sedes de Telemetría 2 y 3
todavía no existen.

Principios que no cambian:

- **Solo lectura.** El agente usa solo las funciones Modbus 03 y 04. No existe código para escribir en
  un medidor.
- **En paralelo, sin tocar producción.** El camino del AS-P sigue funcionando igual mientras se
  prueba la lectura directa.
- **Nada se pierde.** Si la API o la red se caen, el agente guarda lo leído en disco y lo reenvía con
  su hora real.

## 2. Vista por capas

```mermaid
flowchart LR
  classDef campo fill:#ffffff,stroke:#94a3b8,color:#0f172a
  classDef asp fill:#eff6ff,stroke:#2563eb,color:#0f172a
  classDef agente fill:#f0fdfa,stroke:#0d9488,color:#0f172a
  classDef svc fill:#ecfeff,stroke:#0891b2,color:#0f172a
  classDef bd fill:#eef2ff,stroke:#6366f1,color:#0f172a
  classDef web fill:#f0f9ff,stroke:#0284c7,color:#0f172a

  subgraph SEDE["1 · Sede IGSS Escuintla"]
    MED["6 ION7400 · 7 PM2130<br/>2 generadores"]:::campo
    ASP["EBO AS-P<br/>10.0.6.26:502"]:::asp
    A2["ANALIZADOR-2<br/>10.0.6.9 · ID 255"]:::campo
    A1["ANALIZADOR-1 · ID 21"]:::campo
    GEN["Generador · ID 2"]:::campo
    A36["ANALIZADOR-3 a 6<br/>10.0.6.10–.13 · ID 255"]:::campo
    PM["PM2130-1 a 7<br/>10.0.6.18–.24 · ID 2"]:::campo
    MED --> ASP
    A2 -- "RS-485" --- A1 -- "RS-485" --- GEN
  end

  subgraph REC["2 · Agentes Go (servidor, nativos)"]
    AG4["agente-go-escuintla v0.4<br/>igss-escuintla · 15 s"]:::agente
    AG5["agente-go-escuintla-directo v0.5.5<br/>igss-escuintla-directo · 30 s<br/>readAt · backlog · armónicos"]:::agente
  end

  subgraph API["3 · API NestJS"]
    SYNC["AgentSyncService"]:::svc
    TS["TimeseriesService"]:::svc
    GAP["GapDetectorService"]:::svc
    PIL["PilotService"]:::svc
    QUA["QualityService"]:::svc
    AGS["AgentsService"]:::svc
    DB[("PostgreSQL 16<br/>+ TimescaleDB")]:::bd
    SYNC --> TS --> GAP
    TS --> DB
    GAP --> DB
    PIL --> DB
    QUA --> DB
    AGS --> DB
  end

  subgraph WEB["4 · Web Nodivo"]
    PG["Piloto Gravix"]:::web
    CM["Centro de mando<br/>normas · predicción"]:::web
    EQ["Equipos<br/>descubrir · configurar"]:::web
  end

  ASP -- "Modbus 03/04" --> AG4
  A2 -. "Modbus directo" .-> AG5
  A36 -. "Modbus directo" .-> AG5
  PM -. "Modbus directo" .-> AG5
  AG4 == "POST /devices/agent-sync" ==> SYNC
  AG5 == "POST /devices/agent-sync" ==> SYNC
  AGS -. "config remota y búsquedas" .-> AG5
  PIL --> PG
  QUA --> CM
  AGS --> EQ
```

## 3. Capa 1: la sede y sus dos caminos

### Camino EBO (el que existía)

Los 6 ION7400, los 7 PM2130 y los 2 generadores llegan al **EBO AS-P** (10.0.6.26:502, unit 1). El AS-P
republica un subconjunto de sus valores en los registros 101–5787. Es el camino que usa el monitoreo
de siempre, y Gravix lo sigue leyendo sin cambios.

Problemas medidos en el comparativo: llega **hasta 1 minuto atrasado**, repite valores (hasta 2 minutos
sin cambiar) y entrega mal algunos datos: THD de corriente fase A en 0, corriente A del ANALIZADOR-2
en 0, flicker con escala variable y factor de potencia del generador en 16.

### Camino directo (Gravix)

| Equipo | IP | ID Modbus | Cómo se llega |
| --- | --- | --- | --- |
| ANALIZADOR-2 | 10.0.6.9 | 255 | Es el único con IP propia en ese tablero y hace de puerta hacia el RS-485 |
| ANALIZADOR-1 | 10.0.6.9 | 21 | Por RS-485, detrás del ANALIZADOR-2 |
| Generador Planta Hospital | 10.0.6.9 | 2 | Controlador en el mismo cable RS-485 |
| ANALIZADOR-3 a 6 | 10.0.6.10 – .13 | 255 | Directo (255 = "este mismo equipo"; con otros IDs reenvían al puerto serie) |
| PM2130-1 a 7 | 10.0.6.18 – .24 | 2 | Directo. La placa dice EM6400NG+: modelo por confirmar |

El ID de la consulta decide quién contesta detrás de una misma IP. El "Generador Módulos" (bloque 5743
del AS-P) todavía no se lee directo.

Reglas del mapa de registros, verificadas contra el equipo:

- Dirección Modbus = registro − 1, float32 en orden ABCD.
- **ION7400:** potencias en W y VA (se pasan a kW y kVA), THD como fracción (se pasa a %). Acepta lecturas en bloque.
- **PM2130:** potencias ya en kW, THD ya en %, energías int64 en Wh. **Rechaza cualquier bloque** que no
  empiece justo en un valor (excepción 3), así que se lee valor por valor.
- **Generador:** registros 4770–4806 del controlador, int32 CDAB (los mismos que lee el AS-P).
- **NaN = no aplica** (por ejemplo, la fase C de un PM2130 monofásico). Se omite; el AS-P lo convierte en 0.

## 4. Capa 2: recolección (Agentes Go)

Dos agentes corren **en paralelo** en el servidor, como procesos nativos fuera de Docker. Cada uno tiene
su propio `buildingKey`, así que sus datos nunca se mezclan. La API los empareja **por nombre del
equipo** para compararlos.

| | `agente-go-escuintla` | `agente-go-escuintla-directo` |
| --- | --- | --- |
| Carpeta | `~/agente-go-escuintla/` | `~/agente-go-escuintla-directo/` |
| Versión | 0.4 | 0.5.5 |
| `buildingKey` | `igss-escuintla` | `igss-escuintla-directo` |
| Lee | El AS-P (más los sensores LoRaWAN de la sede) | Cada medidor por su IP (14 equipos) |
| Intervalo | 15 s | 30 s, `readDelayMs` 100, una conexión fija por medidor |
| Perfiles | `ion7400`, `pm2130`, `generator` | `ion7400-directo`, `pm2130-directo`, `generador-directo` |
| Hora de la lectura | Hora de llegada a la API | `readAt`: hora real en que se leyó |
| Respaldo en disco | No | Sí: `data/backlog/*.jsonl`, bloques de 5 min, hasta 3 días |
| Armónicos | No | Espectro H1–H63 del ION7400 cada 10 min |
| Configuración | `config.yaml` local | Remota (`remoteConfig: true`), editable desde la web |
| Eventos | Activos (producción) | Apagados (prueba) |
| Arranque automático | crontab `@reboot` | **No está en el crontab** |

### Piezas del agente que usa Gravix

| Código | Qué hace |
| --- | --- |
| [modbussource/client.go](../apps/Agente_Go/internal/discovery/modbussource/client.go) | Cliente Modbus TCP propio, solo funciones 03 y 04 |
| [modbussource/profiles.go](../apps/Agente_Go/internal/discovery/modbussource/profiles.go) | Perfiles del camino AS-P |
| [modbussource/direct.go](../apps/Agente_Go/internal/discovery/modbussource/direct.go) | Perfiles directos por medidor, con conversión de unidades |
| [modbussource/harmonics.go](../apps/Agente_Go/internal/discovery/modbussource/harmonics.go) | Espectro de armónicos del ION7400. Detecta solo el orden máximo (63, o 31 en ANALIZADOR-5 y 6) |
| [modbussource/identify.go](../apps/Agente_Go/internal/discovery/modbussource/identify.go) | Reconoce en una búsqueda si un ID es ION7400, PM2130 o generador, y lee el modelo (registros 50-69) |
| [internal/backlog](../apps/Agente_Go/internal/backlog/backlog.go) | Respaldo en disco: escribe lo que no se pudo enviar y lo reenvía, 4 bloques por ciclo, el más viejo primero |
| [internal/reporter](../apps/Agente_Go/internal/reporter/) | Envío a la API y consulta de la configuración remota |

Cada medidor directo es un servidor Modbus propio en la configuración (`modbusServers`), con su host,
su `unitId` y un solo equipo con su perfil. Por eso cada medidor tiene su propia conexión fija.

```yaml
# Fragmento ilustrativo (la configuración real vive en la API, versión vigente en la web → Equipos)
buildingKey: igss-escuintla-directo
remoteConfig: true
modbusServers:
  - name: ANALIZADOR-1
    enabled: true
    host: 10.0.6.9
    port: 502
    unitId: 21
    pollIntervalSeconds: 30
    readDelayMs: 100
    devices:
      - name: ANALIZADOR-1
        profile: ion7400-directo
```

## 5. Capa 3: API (NestJS, módulos `timeseries` y `agents`)

| Servicio | Archivo | Responsabilidad |
| --- | --- | --- |
| `AgentSyncService` | `apps/api/src/devices/` | Recibe el snapshot del agente, actualiza el estado en vivo y pasa los equipos Modbus al historial |
| `TimeseriesService` | [timeseries.service.ts](../apps/api/src/timeseries/timeseries.service.ts) | `recordSnapshot`, `recordBacklog`, `recordHarmonics`. Usa `readAt` si viene. No guarda la misma lectura repetida en menos de 20 s |
| `GapDetectorService` | [gap-detector.service.ts](../apps/api/src/timeseries/gap-detector.service.ts) | Cada 15 s: un equipo con más de 45 s sin dato abre un hueco con su causa. `reconcile` lo marca como recuperado o parcial cuando llega el respaldo |
| `PilotService` | [pilot.service.ts](../apps/api/src/timeseries/pilot.service.ts) | Equipos de la sede, series con `time_bucket`, huecos, comparación directo vs AS-P, espectro, Excel |
| `QualityService` | [quality.service.ts](../apps/api/src/timeseries/quality.service.ts) | Normas (NTSD, IEEE 519, EN 50160) y cumplimiento, pronóstico, umbrales por equipo, "Probar lectura" |
| `AgentsService` | [agents.service.ts](../apps/api/src/agents/agents.service.ts) | Configuración remota versionada, control y búsquedas de equipos |

### Endpoints

Endpoints de Gravix para historial y agentes. La lista completa de los 97 endpoints, incluida la API
`/sede` que consulta el Centro de mando y el módulo de alarmas, está en [api-referencia.md](./api-referencia.md).

| Método | Ruta | Uso |
| --- | --- | --- |
| POST | `/devices/agent-sync` | El agente envía snapshot, eventos y respaldo (API key de rol `agent`) |
| GET | `/pilot/:buildingKey/devices` | Equipos de energía: estado, huecos de 7 días, % de datos completos, conexión directa |
| GET | `/pilot/devices/:id/series?metric=&minutes=` | Serie agrupada (unos 240 puntos) con sus huecos |
| GET | `/pilot/devices/:id/gaps?days=` | Huecos del equipo |
| GET | `/pilot/devices/:id/compare?minutes=` | Directo vs AS-P, por métrica y con tolerancia |
| GET | `/pilot/devices/:id/espectro?at=` | Último espectro de armónicos hasta esa hora |
| GET | `/pilot/devices/:id/excel?metrics=&minutes=&step=` | Historial en Excel, con la columna del EBO si el equipo tiene pareja |
| PUT | `/pilot/devices/:id/connection` | IP, puerto, ID, puente RS-485 (`metadata.directConnection`); solo administrador |
| GET | `/pilot/normas` · `/pilot/:buildingKey/cumplimiento` | Normas y % de cumplimiento |
| GET | `/pilot/devices/:id/pronostico` | Historia horaria y pronóstico con rango |
| GET / PUT | `/pilot/devices/:id/umbrales` | Umbrales propios del equipo |
| POST | `/pilot/devices/:id/probar` | Una lectura función 03 al equipo |
| GET / PUT | `/agents/:buildingKey/config` | Configuración remota (el PUT exige `baseVersion`) |
| GET | `/agents/:buildingKey/control` | Lo consulta el agente cada 5 s: versión vigente y búsqueda pendiente |
| POST | `/agents/:buildingKey/config/applied` | El agente informa si aplicó o rechazó una versión |
| POST / GET | `/agents/:buildingKey/scan` | La web pide una búsqueda y consulta el resultado |
| POST | `/agents/:buildingKey/scan/:scanId/result` | El agente entrega el resultado |

## 6. Datos (PostgreSQL 16 + TimescaleDB 2.31)

Imagen propia `siasa-postgres-timescale:16.15-2.31.0` sobre el mismo volumen de antes (sin restaurar los
datos). Migraciones `20261102120000_add_agent_configs` y `20261103120000_add_timeseries_readings`.

```mermaid
erDiagram
  devices ||--o{ readings : "historial"
  devices ||--o{ reading_gaps : "huecos"
  devices ||--o| device_states : "estado en vivo"
  agent_configs ||..o{ devices : "configura (por buildingKey)"

  devices {
    uuid id PK
    string name "empareja directo vs AS-P"
    json metadata "agent.buildingKey · directConnection · umbrales"
  }
  readings {
    string deviceId PK
    string metric PK
    timestamptz time PK
    float value
    enum quality "real | recuperada | estimada"
  }
  reading_gaps {
    uuid id PK
    string deviceId FK
    timestamptz startedAt
    timestamptz endedAt "null mientras sigue abierto"
    string cause
    enum status "open | closed | recovered | partial | estimated | unrecoverable"
  }
  agent_configs {
    string buildingKey PK
    int version
    json config
    int appliedVersion
    string applyError
    json scanRequest
    json scanResult
  }
```

| Dato | Valor observado |
| --- | --- |
| `readings` | Hypertable de 1 día. La llave `(deviceId, metric, time)` evita duplicados en un reenvío. Compresión automática a los 7 días |
| Volumen | ≈1,150 filas por minuto con 14 equipos, ≈400 MB por día antes de comprimir |
| Armónicos | 6 ION7400 × hasta 378 valores × 144 por día ≈ 290 mil filas por día |
| Retención | Todavía no se borra nada; solo se comprime (decisión pendiente) |

### Ciclo de vida de un hueco

```mermaid
stateDiagram-v2
  [*] --> open: más de 45 s sin dato
  open --> closed: vuelve a llegar dato en vivo
  open --> recovered: llega el respaldo y no queda ningún salto de más de 90 s
  closed --> recovered: llega el respaldo completo
  closed --> partial: el respaldo cubre solo una parte
  partial --> recovered: llega el resto
  closed --> estimated: Fase C, por diferencia de contador
  closed --> unrecoverable: Fase C, sin forma de recuperarlo
```

Causas que se registran: *el agente no reporta* (agente, enlace o API caídos), *el equipo no responde*
(el agente reporta pero marca el equipo fuera de línea) y *sin lecturas nuevas del equipo*.

## 7. Flujos principales

### 7.1 Lectura directa con respaldo en disco

```mermaid
sequenceDiagram
  autonumber
  participant M as Medidor
  participant AG as Agente directo
  participant BK as Respaldo en disco
  participant API as API (AgentSync + Timeseries)
  participant GAP as Detector de huecos
  participant DB as TimescaleDB

  loop cada 30 s
    AG->>M: Modbus 03/04
    M-->>AG: registros
    AG->>AG: perfil directo → kW, V, A, %THD · readAt
    alt la API responde
      AG->>API: agent-sync (snapshot + hasta 4 bloques del respaldo)
      API->>DB: readings con su readAt, sin duplicar
      API->>GAP: dato llegó → cierra el hueco abierto
      AG->>BK: borra los bloques confirmados
    else la API no responde
      AG->>BK: escribe el bloque de 5 min (tope 3 días)
      GAP->>DB: después de 45 s abre hueco "el agente no reporta"
    end
  end
  Note over API,GAP: Al llegar el respaldo, reconcile marca el hueco como recovered o partial
```

Prueba hecha (09/11): 4 minutos sin API, **solo para el agente de prueba**. Se guardaron 84 lecturas
(100 KB); al volver se reenviaron 3,115 valores y los 12 huecos quedaron *recovered*, aun después de
reiniciar el agente.

### 7.2 Comparación directo vs AS-P

```mermaid
flowchart LR
  A["igss-escuintla<br/>ANALIZADOR-1 (AS-P)"] --> P{"PilotService.compare<br/>empareja por nombre"}
  B["igss-escuintla-directo<br/>ANALIZADOR-1 (directo)"] --> P
  P --> T["Por métrica: diferencia,<br/>% dentro de tolerancia, sesgo"]
  T --> W["Web · Directo vs AS-P<br/>e Informe comparativo 12/11"]
```

El comparativo ignora los armónicos (`harm_*`), porque solo existen en el camino directo.

### 7.3 Agregar un medidor desde la web

```mermaid
sequenceDiagram
  autonumber
  participant ADM as Administrador (Equipos)
  participant API as AgentsService
  participant AG as Agente directo
  participant M as Red de la sede

  ADM->>API: POST /agents/igss-escuintla-directo/scan (IP e IDs)
  AG->>API: GET control (cada 5 s) → búsqueda pendiente
  AG->>M: lectura 03 por ID · identify.go
  AG->>API: POST scan/:id/result (ION7400, PM2130, generador o "por confirmar")
  ADM->>API: "Agregar" → PUT config con el perfil *-directo
  AG->>API: GET control → versión nueva
  AG->>API: GET config → la aplica sin reiniciar
  AG->>API: POST config/applied
```

## 8. Capa 4: web

| Pantalla | Qué muestra de Gravix |
| --- | --- |
| **Piloto Gravix** ([Gravix.tsx](../apps/web/src/routes/Gravix.tsx)) | Barra de fases e indicadores; equipo en 3D con sus pantallas sobre lecturas reales ([DeviceArt.tsx](../apps/web/src/components/gravix/DeviceArt.tsx)); gráfica con huecos; mapa de huecos de 7 días; conexión directa; Directo vs AS-P; Armónicos y Espectro ([Armonicos.tsx](../apps/web/src/components/gravix/Armonicos.tsx)); Informe comparativo ([InformeComparativo.tsx](../apps/web/src/components/gravix/InformeComparativo.tsx)); Excel |
| **Centro de mando** | Normas y cumplimiento, Predicción y calidad de energía con semáforo. Usa la sede `<sede>-directo` si existe |
| **Equipos** | Descubrir y agregar, topología en vivo (IP y RS-485), configuración, umbrales, "Probar lectura" y ficha del dispositivo |

## 9. Resultado de la Fase B (09/11 – 12/11/2026)

| Qué se midió | Resultado |
| --- | --- |
| Volumen | 14 equipos por camino, ≈2.3 millones de valores |
| Disponibilidad directa | 99.8 – 100 % de los minutos |
| Voltaje | 99.6 – 100 % dentro de ±1 % |
| Frecuencia | 100 % dentro de ±0.05 Hz |
| Potencia y corriente ION7400 (15 min) | 97 – 100 % dentro de ±3 %, sesgo ≤0.2 % |
| Retraso del AS-P | Hasta 1 minuto |
| Lo que el directo corrige | THD de corriente fase A, corriente A del ANALIZADOR-2, flicker, FP y batería del generador |

**Conclusión:** la lectura directa es técnicamente viable para reemplazar al AS-P como fuente de datos.

## 10. Operación

Desde el 20/11, los dos agentes de Escuintla corren en el **Gravix de sede** (Docker `gravix-sede-prueba`).
Los programas de `~/agente-go-escuintla*` están detenidos y **no deben volver a arrancarse**, porque
leerían los mismos medidores dos veces.

| Tarea | Cómo (dentro de `~/gravix-sede-prueba/src/deploy/gravix-sede`) |
| --- | --- |
| Ver si todo corre | `docker compose -p gravix-sede-prueba ps` |
| Log de un agente | `docker compose -p gravix-sede-prueba logs -f --tail 50 agente` (o `agente2`) |
| Arranque después de reiniciar el servidor | Automático (`restart: unless-stopped`) |
| Cambiar la configuración de un agente | Web local de la sede → **Equipos** → Configuración (versión nueva, se aplica sola) |
| Salud de la sede, réplica y alarmas | `GET /api/v1/sede/salud` con la clave de consulta |
| Consumo de las bases | InfluxDB de la sede → Dashboards → "Consumo Gravix de sede" |
| Volver al esquema anterior | `~/gravix-sede-prueba/migr-vuelta-atras.sh` |

## 11. Pendientes para pasar a producción

1. **Corregir el perfil directo:** quitar el estado y los conteos del ATS (registros 411-414) de ANALIZADOR-3 y 4,
   y verificar el factor de potencia de los PM2130 (sale entre 1.05 y 1.42, probablemente codificación de 4 cuadrantes).
2. **Confirmar en la pantalla del medidor:** el THD de corriente de las fases B y C, y la escala de kW, kVA, Hz, RPM,
   carga, aceite y combustible del generador (con el motor encendido).
3. ~~Agregar el agente directo al crontab~~: resuelto. Desde el 20/11 corre en Docker y arranca solo.
4. **Fase C:** verificar cómo se lee la memoria (data recorder) del ION7400 antes de programar la
   recuperación ("recuperado"). En los PM2130, estimar la energía del hueco por diferencia de contador ("estimado").
5. ~~Retención~~: decidida el 23/11. 2 meses en la sede; 1 año de detalle y 5 años de resumen en el InfluxDB central.
6. **Generador Módulos:** todavía no se lee directo.
7. **Confirmar el modelo** PM2130 o EM6400NG+.
8. **Respaldo nocturno de la configuración** (TimescaleDB sin lecturas) de cada sede al central.
9. **Correos:** comparar unas semanas los preparados por Gravix contra los enviados por api-SIASA, antes de que Gravix envíe.
10. **Un solo recolector por sede:** unir el agente general y el directo cuando se retire el AS-P.

## 12. Documentos relacionados

- [api-referencia.md](./api-referencia.md): los 97 endpoints, autenticación, WebSocket y paso de consultas.
- [gravix-sede.md](./gravix-sede.md): instalación y operación del Gravix de sede, alarmas, consumo, InfluxDB central.
- [piloto-gravix.md](./piloto-gravix.md): bitácora, mapa de registros y detalle del comparativo.
- [arquitectura-general.md](./arquitectura-general.md): toda la plataforma.
- [agentes-go-manual.md](./agentes-go-manual.md): operación de los agentes.
- [centro-de-mando.md](./centro-de-mando.md): normas, predicción y pestaña Equipos.

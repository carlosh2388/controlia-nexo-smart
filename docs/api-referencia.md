# Referencia de la API (Nodivo / Gravix)

Estado al **23/11/2026**. Código: `apps/api` (NestJS 10 + Fastify). **97 endpoints REST** en 15 módulos,
más un WebSocket. Esta lista sale de los controladores del código (`*.controller.ts`).

- Arquitectura: [arquitectura-general.md](./arquitectura-general.md) y [gravix-arquitectura.md](./gravix-arquitectura.md).
- Gravix de sede: [gravix-sede.md](./gravix-sede.md).

---

## 1. Dónde corre la API: un mismo código, dos modos

La API es **el mismo código** en el servidor central y en el Gravix de cada sede. La variable `GRAVIX_MODO`
decide qué módulos se cargan (`apps/api/src/app.module.ts`):

| Módulo | Ruta base | `central` (Centro de mando) | `sede` (Gravix de sede) |
| --- | --- | :---: | :---: |
| Autenticación | `/auth` | ✅ | ✅ |
| Usuarios | `/users` | ✅ | ✅ |
| Permisos por perfil | `/access` | ✅ | ✅ |
| API keys | `/api-keys` | ✅ | ✅ |
| Equipos | `/devices` | ✅ | ✅ |
| Agentes Go (configuración remota y búsqueda) | `/agents` | ✅ | ✅ |
| Historial, huecos, normas y predicción | `/pilot` | ✅ | ✅ |
| Eventos de los agentes | `/sites` | ✅ | ✅ |
| **API de la sede para el Centro de mando** | `/sede` | — | ✅ |
| Centro de mando (vista de la red, analítica) | `/centro` | ✅ | — |
| Red, sedes Gravix y módulo de alarmas | `/red` | ✅ | — |
| Asistente Gravix (voz y texto) | `/asistente` | ✅ | — |
| Áreas del edificio (TEC 3) | `/areas` | ✅ | — |
| Automatizaciones (TEC 3) | `/automations` | ✅ | — |
| BACnet (TEC 3) | `/devices/bacnet/...` | ✅ | — |

| | Central (prueba) | Gravix de sede (prueba) |
| --- | --- | --- |
| URL base de la API | `http://192.168.70.4:3010/api/v1` | `http://192.168.70.4:3110/api/v1` |
| A través de la web (nginx) | — | `http://192.168.70.4:5273/api/v1` |
| WebSocket | `ws://192.168.70.4:3010/ws` | `ws://192.168.70.4:5273/ws` |
| Gateway externo (solo `x-api-key`) | Opcional: solo si se define `EXTERNAL_API_PORT` (el `docker-compose.yml` no lo pasa hoy) | — |

Todas las rutas llevan el prefijo **`/api/v1`** (versionado por URI).

## 2. Autenticación y permisos

| Forma | Cabecera | Quién la usa |
| --- | --- | --- |
| **JWT de usuario** | `Authorization: Bearer <accessToken>` | La web. Se obtiene con `POST /auth/login`. Dura 15 min y se renueva con `POST /auth/refresh` (refresh de 7 días). El cliente web lo renueva solo (`apps/web/src/api/client.ts`) |
| **API key** | `x-api-key: siasa_…` | Agentes Go (rol `agent`), el Centro de mando cuando consulta una sede (rol `viewer`), el MCP y las integraciones |

**Roles** (`enum Role`):
- `admin`: todo.
- `operator`: opera, cambia umbrales y busca equipos.
- `viewer`: solo lectura.
- `agent`: solo lo que usa un Agente Go.

**Acciones por perfil** (`ActionGuard`, configurables en *Usuarios y permisos*):
- `excel`: descargar Excel;
- `agentes`: cambiar umbrales y probar conexión;
- `reconocer`: reconocer alarmas.

En las tablas, "**autenticado**" quiere decir cualquier usuario o API key válida.

**Gateway externo** (`external-gateway.ts`): un puerto aparte para sistemas de terceros. Solo acepta
`x-api-key` y **bloquea** `/auth`, `/users` y `/api-keys`.

## 3. Endpoints por módulo

### 3.1 Autenticación: `/auth` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| POST | `/auth/login` | público | Usuario y clave. Devuelve `accessToken`, `refreshToken` y el usuario |
| POST | `/auth/refresh` | público (con refreshToken) | Nuevo `accessToken` |
| POST | `/auth/logout` | público (con refreshToken) | Invalida el refreshToken |
| GET | `/auth/me` | sesión | Usuario de la sesión |

### 3.2 Usuarios: `/users` (central y sede). Solo `admin`
| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/users` | Lista de usuarios |
| POST | `/users` | Crea un usuario (perfil, sedes que ve, pantalla de inicio, correos de alarma) |
| PATCH | `/users/:id` | Edita un usuario |
| POST | `/users/:id/password` | Cambia la clave |
| DELETE | `/users/:id` | Borra un usuario |

### 3.3 Permisos por perfil: `/access` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/access/me` | autenticado | Pestañas, acciones y sedes que ve la sesión; arma el menú |
| GET | `/access/roles` | admin | Matriz de permisos de operator y viewer |
| PUT | `/access/roles/:role` | admin | Cambia pestañas y acciones de un perfil |

### 3.4 API keys: `/api-keys` (central y sede). Solo `admin`
| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/api-keys` | Lista (solo el prefijo, nunca la clave) |
| POST | `/api-keys` | Crea una clave (`name`, `role`). **La clave se muestra una sola vez** |
| DELETE | `/api-keys/:id` | Revoca una clave |

### 3.5 Equipos: `/devices` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/devices` | autenticado | Todos los equipos con su estado (`?protocol=`). En el central **mezcla** los de las sedes Gravix (§4) |
| GET | `/devices/agent-status` | autenticado | Último sync de cada Agente Go. En el central mezcla los de las sedes |
| GET | `/devices/:id` | autenticado | Un equipo |
| GET | `/devices/:id/history` | autenticado | Historial genérico (`device_readings`), `?range=` (lo usa la pestaña Sedes) |
| POST | `/devices` | admin | Alta manual de un equipo |
| PATCH | `/devices/:id` | admin | Edita (nombre, oculto, área…) |
| DELETE | `/devices/:id` | admin | Borra un equipo |
| POST | `/devices/:id/command` | admin, operator | Comando on/off (MQTT, HTTP, eWeLink) |
| **POST** | **`/devices/agent-sync`** | **agent**, admin | **El Agente Go envía aquí sus lecturas** cada 15–30 s (snapshot + backlog) |
| POST | `/devices/home-assistant/discover` · `/import` | admin | Importar desde Home Assistant |
| POST | `/devices/zigbee2mqtt/discover` · `/import` | admin | Importar desde Zigbee2MQTT |
| POST | `/devices/bacnet/discover` · `/import` | admin | Importar desde BACnet (solo central, TEC 3) |
| POST | `/devices/:id/climate` | admin, operator | Comando de clima BACnet (solo central) |

### 3.6 Agentes Go: `/agents` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/agents` | autenticado humano | Agentes, versión de configuración guardada y aplicada, último sync |
| GET | `/agents/:buildingKey/config` | humano, agent | Configuración remota (la web la recibe con secretos enmascarados) |
| PUT | `/agents/:buildingKey/config` | admin | Guarda una versión nueva; el agente la aplica sin reiniciarse |
| POST | `/agents/:buildingKey/config/seed` | agent, admin | Primer arranque: el agente sube su config.yaml como v1 |
| POST | `/agents/:buildingKey/config/applied` | agent | El agente confirma (o rechaza) la versión aplicada |
| GET | `/agents/:buildingKey/control` | agent | El agente pregunta cada 5 s si hay config nueva o búsqueda pedida |
| POST | `/agents/:buildingKey/scan` | admin, operator | Pide una búsqueda de equipos (rangos de IP) |
| GET | `/agents/:buildingKey/scan` | humano | Estado y resultado de la búsqueda |
| POST | `/agents/:buildingKey/scan/:scanId/result` | agent | El agente entrega el resultado |

### 3.7 Historial, huecos, normas y predicción: `/pilot` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/pilot/normas` | humano | Normas de calidad de energía (límites) |
| GET | `/pilot/:buildingKey/devices` | humano | Equipos de energía de un agente, con su pareja directo/EBO y su completitud |
| GET | `/pilot/:buildingKey/cumplimiento` | humano | % de cumplimiento por equipo e indicador (`?dias=&norma=`) |
| GET | `/pilot/devices/:id/series` | humano | Serie de una variable (`?metric=&minutes=`) |
| GET | `/pilot/devices/:id/compare` | humano | Directo vs AS-P (EBO) |
| GET | `/pilot/devices/:id/gaps` | humano | Huecos con causa y estado (`?days=`) |
| GET | `/pilot/devices/:id/espectro` | humano | Espectro de armónicos (`?at=`) |
| GET | `/pilot/devices/:id/pronostico` | humano | Historia por hora + pronóstico con banda |
| GET | `/pilot/devices/:id/umbrales` | humano | Umbrales propios del equipo |
| PUT | `/pilot/devices/:id/umbrales` | admin, operator + acción `agentes` | Guarda umbrales |
| POST | `/pilot/devices/:id/probar` | admin, operator + `agentes` | Lectura Modbus de prueba (solo función 03) |
| GET | `/pilot/devices/:id/excel` | humano + `excel` | Historial en Excel (varias variables, huecos) |
| PUT | `/pilot/devices/:id/connection` | admin | Conexión directa del equipo (IP, unidad) |

### 3.8 Eventos de los agentes: `/sites` (central y sede)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/sites/:buildingKey/events` | autenticado | Eventos que detecta el agente (carga alta, CO₂, puertas…), del más reciente al más antiguo |

### 3.9 API de la sede para el Centro de mando: `/sede` (solo Gravix de sede)
La consulta el central con la **clave del centro** (`viewer`). Las dos escrituras (`PUT alarmas/config`
y `POST alarmas/prueba`) solo las acepta un **admin local** o la **clave del centro**.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/sede/salud` | Versión, agentes (versión, último sync), equipos, última lectura, huecos abiertos, disco, estado de InfluxDB, **réplica al central**, comparativo y motor de alarmas |
| GET | `/sede/vista` | Estado de cada medidor (ok, fuera de línea, en cero…) con kW, V y A, y las alarmas abiertas |
| GET | `/sede/telemetria` | JSON v1 de Telemetría 1 (equipos con su ficha y métricas) |
| GET | `/sede/eventos` | Alarmas de Gravix con las mismas columnas que `api_eventos` de api-SIASA (`?dispositivo=&desde=&hasta=&abiertos=&limite=`) |
| GET | `/sede/alarmas/estado` | Estado del motor de alarmas (como `/estado` de api-SIASA) |
| GET | `/sede/alarmas/config` | Configuración del motor: valores, de dónde salen (centro o .env), última modificación |
| PUT | `/sede/alarmas/config` | Guarda cambios (envío, destinatarios, SMTP, reglas); se aplican sin reiniciar |
| GET | `/sede/alarmas/correos` | Correos de los últimos días (enviados o preparados) |
| GET | `/sede/alarmas/correos/:id` | HTML de un correo |
| GET | `/sede/alarmas/vista-previa` | Correo simulado con datos reales (no se envía) |
| POST | `/sede/alarmas/prueba` | Envía un correo de prueba (solo con el envío activo) |

### 3.10 Centro de mando: `/centro` (solo central)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/centro/vista` | autenticado (filtra por sedes del usuario) | Vista de la red: las 10 sedes de Telemetría 1 (monitoreo central 10.30.10.27) |
| GET | `/centro/analitica` | autenticado | Analítica predictiva: riesgos de desconexión, voltaje, carga y comunicación |
| GET | `/centro/sedes/:sede/eventos` | autenticado | Alarmas de un equipo con la hora de sus correos. Fuente: api-SIASA o Gravix, según el módulo de alarmas |
| GET | `/centro/sedes/:sede/medidores/:medidor/historial` | autenticado | Tendencia de un medidor (foto por minuto, `centro_lecturas`) |
| GET | `/centro/sedes/:sede/medidores/:medidor/excel` | acción `excel` | Ese historial en Excel |

### 3.11 Red, sedes Gravix y módulo "Alarmas y correos": `/red` (solo central)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/red` | humano | Grupos (Telemetría 1, 2, 3) y sedes; de las sedes Gravix, su dirección, el final de la clave y el estado |
| POST | `/red/grupos` | admin | Crea un grupo |
| PATCH | `/red/grupos/:id` | admin | Edita un grupo |
| DELETE | `/red/grupos/:id` | admin | Borra un grupo |
| PUT | `/red/sedes/:id` | admin | Crea o edita una sede (`origen`: central, nodivo o gravix; `url` y `apiKey` de su Gravix, cifrada) |
| DELETE | `/red/sedes/:id` | admin | Quita una sede del Centro de mando |
| POST | `/red/gravix/probar` | admin | Prueba la conexión con un Gravix de sede antes de guardarlo |
| GET | `/red/sedes/:id/telemetria` | humano | JSON v1 de la sede (si es Gravix, lo arma la sede) |
| GET | `/red/sedes/:id/alarmas` | admin | Módulo "Alarmas y correos": fuente, configuración, estado y correos de la sede |
| PUT | `/red/sedes/:id/alarmas` | admin | Cambia la fuente (`api-siasa` o `gravix`) o la configuración del motor de la sede |
| POST | `/red/sedes/:id/alarmas/prueba` | admin | Correo de prueba en la sede |
| GET | `/red/sedes/:id/alarmas/correos/:correoId` | admin | HTML de un correo de la sede (`vista-previa` = simulado) |

### 3.12 Asistente Gravix: `/asistente` (solo central)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/asistente/estado` | humano | Si hay motor de IA configurado (sin él, usa solo comandos fijos) |
| POST | `/asistente/preguntar` | humano | Pregunta por voz o texto sobre la red y el estado de las sedes |

### 3.13 Áreas del edificio: `/areas` (solo central, TEC 3)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/areas/tenants` | autenticado | Edificios (tenants) |
| POST | `/areas/tenants` | admin | Crea un edificio |
| GET | `/areas/all` · `/areas` · `/areas/:id` | autenticado | Áreas y su detalle |
| POST | `/areas` | admin | Crea un área |
| POST | `/areas/upload-image` | admin | Sube la foto de un área (multipart, campo `file`) |

### 3.14 Automatizaciones: `/automations` (solo central, TEC 3)
| Método | Ruta | Permiso | Qué hace |
| --- | --- | --- | --- |
| GET | `/automations` · `/automations/:id` | autenticado | Reglas |
| GET | `/automations/:id/executions` | autenticado | Ejecuciones de una regla |
| POST | `/automations` | admin, operator | Crea una regla |
| PATCH | `/automations/:id` | admin, operator | Edita una regla |
| DELETE | `/automations/:id` | admin | Borra una regla |

## 4. Paso de consultas a las sedes Gravix (solo central)

`apps/api/src/red/gravix-proxy.interceptor.ts`. Cuando la web pide al **central** algo que vive en
una **sede Gravix**, el central se lo pide a esa sede con su clave de consulta y devuelve la respuesta:

| Petición al central | Qué hace |
| --- | --- |
| GET `/pilot/devices/:id/*`, `/devices/:id/*` de un equipo de la sede | Se pide a la sede tal cual (historial, huecos, Excel, armónicos, pronóstico…) |
| GET `/pilot/:buildingKey/devices\|cumplimiento`, `/sites/:buildingKey/events`, `/agents/:buildingKey/*` de un agente de la sede | Se pide a la sede |
| GET `/devices`, `/devices/agent-status`, `/agents` | Respuesta local, cambiando los equipos y agentes de las sedes por los que informa cada sede (cada 15 s) |
| PUT/POST/PATCH/DELETE sobre un equipo o agente de una sede | **409**, con el enlace a la web local de la sede. Los cambios se hacen allá; las alarmas se configuran desde `/red/sedes/:id/alarmas` |

## 5. WebSocket `/ws`

`apps/api/src/realtime/realtime.gateway.ts`.
- **Conexión:** `ws://<host>/ws?token=<accessToken JWT>`. Sin token o con token inválido se cierra con código 4001.
- **Mensajes que envía el servidor:** `{ "type": "device.state", "deviceId", "state", "rawPayload" }` cada vez que cambia un equipo.
- **En la web:** `apps/web/src/ws/useDeviceSocket.ts` refresca las consultas de React Query.

## 6. Ejemplos

```bash
# Login y consulta con JWT
curl -s -X POST http://192.168.70.4:3010/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}'
curl -s http://192.168.70.4:3010/api/v1/red -H "Authorization: Bearer <accessToken>"

# El Centro de mando consultando la salud de una sede (clave de consulta)
curl -s http://192.168.70.4:3110/api/v1/sede/salud -H "x-api-key: <CENTRO_API_KEY>"

# Lo que envía un Agente Go (simplificado)
curl -s -X POST http://gravix:3000/api/v1/devices/agent-sync -H "x-api-key: <AGENT_API_KEY>" \
  -H 'Content-Type: application/json' -d '{"buildingKey":"igss-escuintla-directo","agentVersion":"0.5.5","devices":[...]}'
```

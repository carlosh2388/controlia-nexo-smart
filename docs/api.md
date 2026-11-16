# API

Base URL local: `http://localhost:3010/api/v1`

Base URL servidor: `http://192.168.70.4:3010/api/v1`

## Autenticacion

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| POST | `/auth/login` | Devuelve `accessToken`, `refreshToken` y usuario |
| POST | `/auth/refresh` | Renueva tokens |
| POST | `/auth/logout` | Revoca refresh token |
| GET | `/auth/me` | Usuario autenticado |

La mayoria de rutas usan `Authorization: Bearer <token>`.

## Dispositivos

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/devices` | Lista dispositivos con estado |
| GET | `/devices/:id` | Obtiene un dispositivo |
| POST | `/devices` | Crea dispositivo |
| PATCH | `/devices/:id` | Actualiza dispositivo |
| DELETE | `/devices/:id` | Elimina dispositivo |
| POST | `/devices/:id/command` | Envia comando `on/off` |
| POST | `/devices/home-assistant/discover` | Descubre entidades HA |
| POST | `/devices/home-assistant/import` | Importa entidades HA |
| POST | `/devices/zigbee2mqtt/discover` | Descubre entidades Zigbee2MQTT |
| POST | `/devices/zigbee2mqtt/import` | Importa entidades Zigbee2MQTT |

## Agentes Go (configuracion remota)

Detalle en `docs/agentes-go-manual.md`, seccion 8.1.

| Metodo | Ruta | Quien | Descripcion |
| --- | --- | --- | --- |
| GET | `/agents` | Usuarios | Agentes conocidos, version guardada/aplicada, ultimo sync |
| GET | `/agents/:buildingKey/config` | Usuarios, agente | Config de protocolos (secretos enmascarados salvo para el agente) |
| PUT | `/agents/:buildingKey/config` | admin | Guarda `{ config, baseVersion }` como version nueva (409 si `baseVersion` quedo vieja) |
| POST | `/agents/:buildingKey/config/seed` | agente | Crea la v1 desde el `config.yaml` del agente (no pisa una existente) |
| GET | `/agents/:buildingKey/control` | agente | `{ configVersion, scan }` |
| POST | `/agents/:buildingKey/config/applied` | agente | `{ version, error?, rejected? }` |
| POST | `/agents/:buildingKey/scan` | admin, operator | `{ items: [{ protocol, targets, port?, unitIds? }] }` |
| GET | `/agents/:buildingKey/scan` | Usuarios | Estado y resultados de la ultima busqueda |
| POST | `/agents/:buildingKey/scan/:scanId/result` | agente | Avance/resultado de la busqueda |

## Areas

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/areas` | Devuelve tenant actual y areas con dispositivos |
| GET | `/areas/:id` | Devuelve area por id |

La vista de edificio usa `/areas` para pintar imagenes, poligonos y dispositivos agrupados.

## Automatizaciones

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/automations` | Lista reglas |
| GET | `/automations/:id` | Obtiene regla |
| GET | `/automations/:id/executions` | Historial de ejecuciones |
| POST | `/automations` | Crea regla |
| PATCH | `/automations/:id` | Actualiza regla |
| DELETE | `/automations/:id` | Elimina regla |

Soporta triggers:

- `device_state`: por cambio de estado de dispositivo.
- `schedule`: por hora local `HH:mm` y dias de semana opcionales.

## API Keys y Gateway Externo

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/api-keys` | Lista API keys |
| POST | `/api-keys` | Crea API key |
| DELETE | `/api-keys/:id` | Revoca API key |

Si `EXTERNAL_API_PORT` esta definido, la API levanta un gateway externo que exige `x-api-key` y bloquea rutas de autenticacion/usuarios/keys.


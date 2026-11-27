# Agente Go TEC 3: equipos de la API manejados por un agente

Desde la versión 0.6.0 un Agente Go puede **leer y controlar equipos que ya existen en la API
central** en lugar de que lo haga la API: luces e interruptores de Home Assistant (HTTP), equipos
MQTT / Zigbee2MQTT, sensores LoRaWAN de ChirpStack y aires acondicionados BACnet.

Nada cambia para el usuario: la vista del edificio, las áreas, el historial, las automatizaciones y
los permisos son los mismos. Solo cambia **quién habla con el equipo**.

## Cómo funciona

```
Vista del edificio / automatizaciones          (sin cambios)
        │ orden
        ▼
API central ── ¿quién maneja el equipo? (metadata.gestor.agente)
        ├─ API central → adaptador de siempre (Home Assistant, MQTT, bacnet-bridge)
        └─ Agente TEC3 → cola de órdenes → el agente la toma al instante (consulta larga)
                                              ├─ Home Assistant 10.3.0.25 (HTTP)
                                              ├─ MQTT central (Zigbee2MQTT, home/...)
                                              ├─ ChirpStack 192.168.70.6 (LoRaWAN)
                                              └─ bacnet-bridge → gateway de aires 10.3.0.11
        ▲                                     │
        └── estado y resultado de cada orden ─┘  (POST /devices/agent-sync, externalId "nodivo:<id>")
```

- **Plan** (`GET /agents/:key/plan`): la API le manda al agente los equipos que maneja con la MISMA
  configuración que usan sus adaptadores (plantilla HTTP de estado, tópico MQTT, devEui, puntos
  BACnet, modos y velocidades). El agente lee exactamente lo mismo, sin lógica duplicada.
- **Lectura**: los equipos de un mismo Home Assistant se leen con **una sola consulta** a
  `/api/states` por ciclo (antes la API hacía una por equipo cada 5 s).
- **Estado**: llega a la API por `DeviceStateBus`, el mismo camino de los adaptadores: WebSocket
  en vivo, `device_states`, historial de sensores (una fila por lectura nueva) y automatizaciones.
- **Órdenes** (`GET /agents/:key/ordenes` + `POST .../resultado`): la API arma la orden igual que
  antes (encender, apagar, modo, ventilador, swing, setpoint, rango) y espera hasta 15 s el
  resultado real del equipo. Si falla, la orden queda `failed` con el motivo.

## Seguridad

- El agente solo acepta órdenes para **equipos de su plan**: mismo host HTTP, el tópico de comando
  del equipo, y solo puntos BACnet que pertenecen a ese aire. Opcional: `AGENTE_TEC3_HOSTS` limita
  aún más los hosts.
- Las órdenes **vencen a los 15 s**: una orden que llega tarde no se ejecuta.
- Un aire que no responde **no se marca "apagado"**: se conserva el último estado conocido.
- Solo se pueden pasar equipos a un agente **conectado**.
- **Respaldo automático**: si el agente no se comunica por más de 90 s, la API retoma sola la
  lectura y las órdenes de sus equipos; cuando el agente vuelve, los retoma él.

## Uso

Web → **Equipos → Equipos que maneja** (elegir el agente `tec3`): filtros por protocolo, por quién
lo maneja y búsqueda; marcar equipos y **Pasar al agente** o **Devolver a la API** (solo admin).

Orden recomendado: sensores LoRaWAN y MQTT → 2–3 interruptores de prueba → el resto por área →
un aire de prueba → el resto de los aires → con todo estable, apagar el bacnet-bridge.

## Instalación (servidor central)

En `~/siasa-iot-platform/.env`:

```
COMPOSE_PROFILES=agente-tec3
AGENTE_TEC3_API_KEY=<API key con rol agent>
AGENTE_TEC3_LORAWAN_URL=tcp://192.168.70.6:1883
```

`docker compose up -d agente-tec3`. Usa `LORAWAN_MQTT_USERNAME/PASSWORD`, `BACNET_BRIDGE_URL` y
`BACNET_BRIDGE_TOKEN` del mismo `.env`. Logs: `docker compose logs -f agente-tec3`.

Vuelta atrás: en la web, **Devolver a la API** todos los equipos (o simplemente apagar el agente:
a los 90 s la API los retoma) y `docker compose stop agente-tec3`.

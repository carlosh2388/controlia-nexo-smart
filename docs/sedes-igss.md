# Sedes IGSS en Nodivo (sede modelo: Escuintla)

Monitoreo de las sedes del IGSS: energia (generadores, analizadores ION7400, medidores PM2130,
vigilante del ATS) por **Modbus TCP** y sensores **LoRaWAN** (puertas, calidad de aire, cadena de
frio) por **MQTT** desde ChirpStack. Todo lo recolecta un **Agente Go** por sede, que ademas detecta
**eventos** en tiempo real; la API los guarda como historial y la web los muestra en la pestaña **Sedes**.

Skills para trabajar con esto (Claude Code): `agente-go`, `sede-igss`, `eventos-sede` (en `.claude/skills/`).

## 1. Flujo de datos

```
 Sede (red 10.0.6.x)                                  Central
 ┌──────────────────────────────┐
 │ ION7400 / PM2130 / ATS ─┐    │
 │ (generadores*) ─────────┤    │
 │                 EBO AS-P 10.0.6.26:502 ──Modbus TCP (solo lectura 03/04)──┐
 │                              │                                            │
 │ Sensores LoRaWAN ─ Gateway ─ ChirpStack ─ MQTT 10.0.6.35:1883 ────────────┤
 └──────────────────────────────┘                                            ▼
                                                     ┌─────────────── Agente Go ───────────────┐
                                                     │ modbussource   lorawansource             │
                                                     │   perfiles       °C de WISE (tags)       │
                                                     │        └──── snapshot ───┐               │
                                                     │ events.Engine (reglas) ──┤               │
                                                     │ data/pending-events.json │ (si la API    │
                                                     │ data/state.json          │  no responde) │
                                                     └──────────── POST /devices/agent-sync ────┘
                                                                         │ x-api-key (rol agent)
                                                                         ▼
                                     API Nodivo: Device + DeviceState (ultima lectura)
                                                 DeviceReading (historial, 1/min/equipo)
                                                 SiteEvent (eventos, idempotente)
                                                                         │
                                                                         ▼
                                     Web: Sedes > Energia · Sensores LoRaWAN · Eventos
                                          + "Ver tendencias" por tarjeta (historial + eventos)
```

\* Ver "Generadores" en la seccion 3.

## 2. ¿Que es el Agente Go? (un recolector)

Un binario por sede, sin base de datos propia, que corre en una maquina con acceso a la red de la sede:

| Paso | Que hace | Donde |
|---|---|---|
| Descubrir | Lee cada bloque Modbus configurado y reporta solo los que traen datos validos; registra cada sensor LoRaWAN la primera vez que transmite | `modbussource`, `lorawansource` |
| Leer | Modbus cada 15 s; LoRaWAN en cuanto llega cada uplink | idem |
| Normalizar | Perfiles por modelo (float32 ABCD/CDAB, escalas), conversion 4-20 mA → °C de los WISE con los tags de ChirpStack | `profiles.go`, `addScaledChannels` |
| Detectar eventos | Compara cada lectura con la anterior: transiciones, alarmas con estado, contadores | `internal/events` |
| Resguardar | Si la API/red se cae, guarda los eventos en disco y los reenvia al volver (sin duplicar) | `events/store.go` |
| Reportar | Snapshot + eventos cada 15 s, o al instante si hay un evento critico | `agent.go`, `reporter.go` |

No decide nada de negocio (nombres, areas, usuarios): eso es de la API y de las personas. No
escribe en ningun equipo.

## 3. Energia por Modbus (EBO AS-P)

Config: `apps/Agente_Go/config.igss-escuintla.example.yaml`. Perfiles: `apps/Agente_Go/internal/discovery/modbussource/profiles.go`
(portados de `api-SIASA/modbus_cliente/lectura_Ebo_v2.js`, el lector que ya funcionaba en produccion).

| Equipo | Registros | Perfil | Metricas principales |
|---|---|---|---|
| PM2130-1..7 | 101 + 22·(k-1), 22 regs | `pm2130` | voltage_a/b/c_n, voltage_a_b..., current_a/b/c, frequency, demand_total |
| ANALIZADOR-1 | 255-324 | `ion7400` | active/apparent_power por fase y total, demandas pico, current, power_factor, frequency, flicker, THD, voltajes |
| ANALIZADOR-2..6 | 325, 399, 473, 547, 621 (+74) | `ion7400-b` | idem (calidad desde el indice 22) |
| Vigilante ATS | 695/697 (ANALIZADOR-1), 587/589 (ANALIZADOR-5) | `extra` | s1_commercial_energy_status, s2_generator_energy_status |
| Contadores ATS | 5781/5783 (A-1), 5785/5787 (A-5) | `extra` | s1/s2_*_transition_count |
| Generadores | 5705-5742, 5743-5780 | `generator` | engine_speed, engine_load, fuel_level, coolant_temp, oil_pressure, battery_voltage, gen_kw/kva, frecuencias |

Reglas de decodificacion: registro N = direccion Modbus N-1; float32 ABCD con respaldo CDAB si da
0/invalido; THD y flicker con escala autodetectada; generador int32 CDAB ×0.01. Un bloque que no
pasa la validacion de su perfil (ej. todo en cero) no se reporta: eso es el "autodescubrimiento"
posible en Modbus (el protocolo no permite preguntar "que equipos hay").

### Generadores (estado al 2026-10-08)

Escaneo de solo lectura de todo el EBO de Escuintla (registros 1-12000): el espacio valido termina
en 5787 y **los bloques de generador estan practicamente vacios**: "Generador Módulos" todo en 0;
"Generador Planta Hospital" solo 3 registros con valor (bateria = 27 crudo → 0.27 V con la escala
×0.01 del sistema anterior). Ademas, el `.env` de produccion de `api-SIASA` en Escuintla leia solo
hasta el registro 697, asi que el sistema anterior **nunca leyo los generadores**.

Lo que si es real en el EBO: el **vigilante del ATS** (estado comercial/generador y contadores: al
2026-10-08 ANALIZADOR-1 registra 28 transferencias a generador). Con eso el agente ya genera los
eventos de transferencia. El generador sin datos se reporta como evento `generator.no_data`.

**Para tener metricas de motor reales** hay que leer el controlador del generador directamente por
Modbus (marca/modelo e IP del controlador → un perfil nuevo en `profiles.go`), o configurar el EBO
para que publique esos puntos.

## 4. Sensores LoRaWAN por MQTT (ChirpStack)

El agente se suscribe al broker de ChirpStack (`application/+/device/+/event/up`). No usa la API
REST de ChirpStack. Si ChirpStack se cae, no llega nada (lo detecta `lorawan.site_silent`).

| Modelo (deviceProfileName) | Tarjeta | Lecturas | Configuracion desde tags de ChirpStack |
|---|---|---|---|
| LEO-S592-AQG0-P | Calidad de aire | co2, temperature, humidity, pm2_5, pm10, tvoc, hcho, pirStatus | `threshold_min/max` + `unit=ppm` → limite de CO₂ |
| LEO-S595-MSG0 | Puerta | magnet_status, battery, tamper_status | `sensor_type=door` |
| WISE-4610-S617 / S614T | Cadena de frio | ai0..3_value (mA) → **ai0..3_temperature (°C)** | por canal: `operative_area`, `code`, `category`, `multiplier`, `offset`, `threshold_min/max`, `tolerance` |
| EVA 2310 | Temperatura/humedad | temperature, humidity, battery | `threshold_min/max` + `unit=°C` |

Conversion WISE (hecha por el agente): `°C = mA × multiplier + offset` (Escuintla: 9.5147 y -138.45).
Verificado con datos reales: 11.13 mA → -32.6 °C (ultracongelador, rango -40..-30) y 15.12 mA → 5.4 °C (refrigerador, 2..6).

Todos los tags llegan a la API como `metadata.attributes.tag_*`, y el area de cada sensor sale de `tag_area`.

## 5. Eventos

### Catalogo

| Tipo | Severidad | Cuando | Equipo |
|---|---|---|---|
| `energy.source_generator` | critical | El ATS pasa a generador (S2 0→1) | ION7400 con vigilante |
| `energy.source_commercial` | info | Regresa a comercial (S2 1→0) | idem |
| `energy.generator_transfer_counted` | warning | Sube el contador de transferencias a generador (detecta transferencias cortas aunque no se vea el cambio de estado) | idem |
| `power.phase_loss` / `power.phase_restored` | critical / info | Una fase < 50 % de la mayor | ION7400, PM2130 |
| `power.voltage_out_of_range` / `power.voltage_normal` | warning / info | V fase-neutro fuera de 120 V ±10 % | ION7400, PM2130 |
| `power.frequency_out_of_range` / `power.frequency_normal` | warning / info | Fuera de 59.5–60.5 Hz | ION7400, PM2130 |
| `power.thd_high` / `power.thd_normal` | warning / info | THD de voltaje > 8 % (IEEE 519) | ION7400 |
| `power.overload` / `power.load_normal` | warning / info | kVA > 80 % de `capacityKva` | ION7400 |
| `generator.no_data` / `generator.data_restored` | warning / info | El EBO no publica datos del controlador (bateria ≤ 5 V) | Generador |
| `generator.started` / `generator.stopped` | warning / info | RPM > 100 / vuelve a 0 (con minutos en marcha) | Generador |
| `generator.fuel_low`, `generator.battery_low`, `generator.coolant_high` (+ `_ok`) | critical/warning | < 25 %, < 24 V, > 95 °C | Generador |
| `door.opened` / `door.closed` | info | Cambio de magnet_status (al cerrar, minutos abierta) | LEO-S595 |
| `door.open_too_long` (+ `_cleared`) | warning | Abierta > 10 min | LEO-S595 |
| `door.tamper` (+ `_cleared`) | critical | tamper_status ≠ installed | LEO-S595 |
| `coldchain.out_of_range` / `coldchain.normal` | critical / info | Temperatura de un refrigerador/congelador fuera de su rango por mas de su tolerancia (min) | WISE |
| `io.open_circuit`, `io.out_of_range` (+ cleared/in_range) | warning | Entrada configurada en circuito abierto / fuera de 4-20 mA | WISE |
| `io.sensor_fault` / `io.sensor_ok` | warning | Entrada pegada al borde de la escala (≤ 4.05 o ≥ 19.95 mA): sonda desconectada o dañada. No se evalua como temperatura (4.00 mA daria -100.4 °C) | WISE |
| `air.co2_high` / `air.co2_normal` | warning / info | CO₂ > limite del sensor (tag) o 1000 ppm | LEO-S592 |
| `env.temperature_high/low` / `env.temperature_normal` | warning / info | Fuera del rango del sensor (tags con unit °C) o de `temperatureMin/Max` | EVA, S592 |
| `sensor.battery_low` / `sensor.battery_ok` | warning / info | Bateria < 20 % | LoRaWAN |
| `device.offline` / `device.online` | warning (critical en generador/ION) / info | Modbus: bloque deja de responder. LoRaWAN: sin uplinks > 60 min | Todos |
| `lorawan.site_silent` / `lorawan.site_restored` | critical / info | Ningun sensor LoRaWAN reporta en 15 min (ChirpStack/gateway/broker caido) | Sede |

Umbrales: `events.thresholds` en el config del agente (defaults en `internal/events/events.go`).

### Garantias

- **Una alarma = dos eventos** (entra / sale, con duracion), nunca uno por lectura.
- **Sin duplicados**: cada evento tiene un id generado por el agente; la API lo guarda con
  `createMany(skipDuplicates)` sobre `agentEventId` unico. Reintentar es seguro.
- **Sin perdida** ante caidas de la API/red: `data/pending-events.json` (hasta 20 000 eventos, los
  mas antiguos se envian primero) y `data/state.json` (alarmas activas, contadores) sobreviven reinicios.
- **Inmediato** para lo critico: un evento `critical` adelanta el sync.

### API

- `POST /api/v1/devices/agent-sync` acepta `events: AgentEventDto[]` junto a `devices`.
- `GET /api/v1/sites/:buildingKey/events?from&to&type&severity&deviceId&limit` → `{counts, events}`.
- `GET /api/v1/devices/:id/history?range=1h|24h|today|7d|15d|30d` → historial de lecturas.

## 6. Web (pestaña Sedes)

`apps/web/src/routes/Sedes.tsx`, componentes en `apps/web/src/components/sedes/`:

- **Energia · Modbus**: generador (ilustracion que vibra/echa humo al arrancar + anillos de carga y
  combustible), ION7400 (pantalla LCD en vivo + anillo de carga vs capacidad), PM2130 (LCD con V1-V3 +
  anillo de voltaje). Normal / Compacto.
- **Sensores LoRaWAN · MQTT**: puertas, cadena de frio (un renglon por refrigerador con su rango),
  calidad de aire, otros; panel "Uplinks MQTT en vivo".
- **Eventos**: historial agrupado por dia, filtros por categoria, severidad y rango (24 h / 7 d / 30 d),
  contadores, y acceso directo a las tendencias del equipo.
- **Ver tendencias** (cada tarjeta): metrica + rango, actual/min/max/promedio, lineas de limite,
  tooltip, y los eventos del equipo marcados sobre la grafica y listados debajo.
- Si una sede modelo aun no tiene agente reportando, se muestran datos de demostracion marcados.

## 7. Verificacion real (2026-10-08, desde una PC en la red de la sede)

- 14/15 equipos Modbus con datos coherentes (≈125 V, 59.96 Hz, cargas reales por fase, S1 comercial = 1).
- ~106 sensores LoRaWAN en minutos (LEO-S592, WISE-4610-S617, LEO-S595), con area desde los tags.
- Eventos reales detectados: 2 sensores de puerta reportados como removidos (`tamper_status = uninstalled`),
  perdida de fase C en PM2130-1 (Emergencia), THD > 8 % en analizadores, CO₂ alto, generador sin datos, y
  cadena de frio fuera de rango por mas de su tolerancia: Banco de Sangre "Refrigerador Unidades No
  Liberadas" (HES008) 21.9 °C y "Reactivos Varios" (HES017) 22.0 °C (rango 2-6 °C), Unidosis (HES036)
  -14.3 °C (rango -8..0 °C). Farmacia "Refrigerador 4" (HES028) marca 4.00 mA: falla de sonda.
- Segundo bug encontrado en vivo y corregido: una sonda en 4.00 mA se convertia a -100.4 °C y
  disparaba alarma de cadena de frio; ahora es `io.sensor_fault`.
- Bug encontrado y corregido en la verificacion: los `threshold_min/max` de los LEO-S592 son de CO₂
  (`unit = ppm`); aplicarlos a temperatura generaba alarmas falsas de "temperatura baja".
- Tests del agente: `go test ./...` (modbussource, events, lorawansource).

## 8. Pendientes

- Metricas reales de los generadores (ver seccion 3).
- Confirmar con el equipo de la sede: PM2130-1 (Emergencia) marca fase C en 0 V configurado como trifasico;
  si es bifasico, poner `phase: "Bifásica"` en su `attributes` del config.
- Instalar el agente como servicio en una maquina de la sede o en el servidor central.
- Inventario completo de sensores desde la API de ChirpStack (hoy un sensor solo aparece cuando transmite).

---
name: eventos-sede
description: Catalogo, umbrales e historial de los eventos que detecta el Agente_Go en una sede (transferencias del ATS, generador, voltaje/fases/frecuencia/THD/carga, puertas, cadena de frio, CO2, baterias, sensores sin comunicacion, ChirpStack caido). Usar para agregar o ajustar una regla/alarma, explicar por que aparecio (o no) un evento, cambiar umbrales, o consultar el historial via API.
---

# Eventos de las sedes

Los eventos se detectan **en el agente** (`apps/Agente_Go/internal/events/engine.go`), sobre cada
lectura nueva, y se guardan en la API en la tabla `site_events` (modelo Prisma `SiteEvent`).
Catalogo completo y flujo: `docs/sedes-igss.md`, seccion "Eventos".

## Como funciona una regla

- **Transicion** (sin estado propio): compara con la lectura anterior del mismo equipo
  (`e.prev`) -> `door.opened`, `energy.source_generator`, ...
- **Alarma** (con estado): `em.alarm(externalId, regla, activa, raise, clear)` emite UN evento al
  entrar en condicion y otro al salir (con `durationMinutes`). El estado vive en `State.Active` y se
  guarda en `dataDir/state.json`, asi que reiniciar el agente no duplica alarmas.
- **Contador**: `State.Counters` guarda el ultimo valor (ej. transferencias del vigilante del ATS) y
  emite cuando sube.
- Severidad: `critical` (dispara un sync inmediato a la API), `warning`, `info`.

## Agregar una regla nueva

1. Escribirla en `engine.go` dentro de la funcion de su categoria (`ruleElectrical`,
   `ruleGenerator`, `ruleDoor`, `ruleEnvironment`, `ruleWise`, `ruleBattery`) usando `em.alarm(...)`.
2. Tipo con prefijo de categoria (`energy.`, `power.`, `generator.`, `door.`, `env.`, `air.`,
   `coldchain.`, `io.`, `device.`, `lorawan.`, `sensor.`). La web agrupa por ese prefijo
   (`apps/web/src/components/sedes/eventMeta.tsx`): si se crea un prefijo nuevo, agregarlo ahi.
3. Si tiene umbral, agregarlo a `Thresholds` + `Defaults()` + `Merge()` en `events.go` y
   documentarlo en `config.igss-escuintla.example.yaml` (`events.thresholds`).
4. Test en `engine_test.go` (patron: `NewEngine` -> `Observe` con lecturas -> `has(evs, "tipo")`),
   incluido que NO se repite mientras sigue activa.
5. `go test ./...` y agregar la fila al catalogo en `docs/sedes-igss.md`.

## Umbrales que vienen de ChirpStack (no de la config)

- Sensores con `tag_threshold_min/max`: aplican a la magnitud de `tag_unit`
  (en LEO-S592 es `ppm` -> CO₂, **no** temperatura - un error aqui genera "temperatura baja" falsas).
- WISE de cadena de frio, por canal: `tag_aiN_threshold_min/max` (°C), `tag_aiN_tolerance`
  (minutos de gracia fuera de rango antes de alarmar), `tag_aiN_operative_area` (nombre del refrigerador).

## Consultar el historial

```
GET /api/v1/sites/<buildingKey>/events?from=<ISO>&to=<ISO>&type=<prefijo>&severity=critical&deviceId=<id>&limit=200
```

Respuesta: `{ counts: {critical, warning, info}, events: [{type, severity, message, value, data, occurredAt, deviceName}] }`.
En la web: pestaña **Sedes > Eventos** (filtros por categoria/severidad/rango) y la lista + marcas
en la grafica de **Ver tendencias** de cada equipo.

## Diagnostico rapido

- "No aparece un evento": revisar el log del agente (`[evento] ...`), luego
  `dataDir/pending-events.json` (si hay pendientes, la API no esta respondiendo).
- "Alarma que no se cierra": la condicion sigue activa o el equipo dejo de reportar; ver
  `dataDir/state.json` -> `active`.
- Muchas alarmas de golpe al arrancar por primera vez una sede: es normal (estado inicial real);
  despues solo llegan cambios.

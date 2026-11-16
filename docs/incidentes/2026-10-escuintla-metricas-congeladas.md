# Informe de incidente: métricas eléctricas congeladas en IGSS Escuintla

| | |
|---|---|
| **Sede** | IGSS Escuintla |
| **Equipos afectados** | Medidores ION7400 y PM2130 (leídos a través del EBO AS-P 10.0.6.26) |
| **Período** | 30/09/2026 18:00 al 12/10/2026 18:00 (12 días) |
| **Síntoma** | Todas las métricas de los medidores se quedaron en un solo valor continuo. Ejemplo: HES107 / ION7400-1, "Potencia comercial", fija en ~150 kW |
| **Sistema que entrega los datos** | api-SIASA, contenedor Docker `node-api`, endpoint `/api/ebo/modbus-auto` (puerto 3001) |
| **Fecha del informe** | 13/10/2026 |
| **Estado** | **Causa confirmada y corregida** el 14-15/10/2026. Ver la actualización abajo y la [bitácora de cambios](2026-10-escuintla-bitacora-cambios.md) |

---

## Actualización 15/10/2026: causa confirmada en el servidor

La revisión del log del servidor (10.0.6.33) confirmó la causa y corrige dos datos de este informe:

- **Inicio:** 30/09/2026 **18:33:03 UTC** (12:33 hora de Guatemala). El EBO cerró la conexión (`Port Not Open`) y la lectura de api-SIASA quedó **atascada**: `resetModbus()` esperaba un cierre que nunca se confirmaba. Desde ese momento no hay ninguna otra línea de Modbus en el log.
- **Fin:** **no se recuperó sola.** Volvió con un **reinicio manual** de `node-api` el 13/10/2026 05:19:32 UTC (12/10 23:19 hora de Guatemala). El dato de "0 reinicios desde el 25/09" de la sección 3.1 se tomó antes de ese reinicio.
- **Agravante encontrado:** después del reinicio, el lector v2 (que no se usa) forzaba 4 reconexiones por minuto por un error en el registro 5620, y cada una podía volver a atascar la lectura.
- **Corrección aplicada:** `resetModbus()` ya no puede atascarse (probado: el código original se bloquea y el corregido se recupera en 5 s); el lector v2 se apagó (0 reconexiones); se agregó el monitoreo de eventos (`/api/ebo/modbus-auto/estado`). Detalle completo en la [bitácora de cambios](2026-10-escuintla-bitacora-cambios.md).

Las secciones siguientes se conservan como el análisis original.

---

## 1. Resumen

**La plataforma graficó durante 12 días la última lectura buena que api-SIASA tenía guardada.** api-SIASA dejó de obtener lecturas nuevas del EBO el 30/09 a las 18:00. No se cayó, no se reinició y no avisó: siguió respondiendo cada consulta con esa misma lectura vieja, sin fecha y sin ninguna marca de "dato viejo". La plataforma la guardó como si fuera nueva, y por eso la gráfica es una línea plana.

Hay tres defectos de api-SIASA que, juntos, producen exactamente lo que se ve:

1. **Entrega datos viejos como si fueran nuevos.** Si la lectura del EBO falla o se atrasa, la API devuelve indefinidamente la última lectura buena.
2. **No registra la falla.** Los errores de lectura se guardan solo en memoria; no se escriben en el log.
3. **La lectura se puede atascar.** Cuando el EBO no responde, el programa no corta: reintenta registro por registro, con esperas de 8 s cada una, y mientras tanto no empieza ninguna lectura nueva.

El 12/10 a las 18:00 las lecturas volvieron a funcionar **sin que nadie reiniciara el contenedor**. Eso indica que la causa externa (el EBO o la red hacia el EBO) desapareció en ese momento. Qué fue exactamente se confirma con el log del contenedor y el registro del EBO (sección 7).

**Solución:** cambiar api-SIASA para que registre cada falla, marque la fecha de cada lectura, deje de entregar datos viejos y se reconecte sola cuando la lectura se atasque (sección 6). Si vuelve a pasar antes de aplicar la corrección: `docker restart node-api`.

---

## 2. Cómo llegan los datos a la plataforma

```
ION7400 / PM2130 --> EBO AS-P (10.0.6.26) --Modbus TCP--> api-SIASA (node-api) --HTTP :3001--> plataforma (gráficas)
```

- api-SIASA lee el EBO **cada 1 segundo** (`MODBUS_AUTO_POLL_MS`) y guarda el resultado en memoria (la "lectura guardada").
- Cada consulta de la plataforma a `/api/ebo/modbus-auto` recibe esa lectura guardada.
- **Una sola lectura trae todos los medidores** (ION7400 y PM2130). Por eso se congelaron todos al mismo tiempo.
- La respuesta **no incluye la hora de la lectura**. La plataforma no tiene forma de saber si el dato es nuevo o viejo, y lo guarda con su propia hora.

---

## 3. Hallazgos

### 3.1 El contenedor no se reinició

| Dato (`docker inspect`, 13/10/2026) | Valor |
|---|---|
| Estado | `running` |
| Inicio | `2026-09-25T19:37:41Z` |
| Reinicios | `0` |

El proceso que congeló los datos es el **mismo** que los volvió a entregar bien el 12/10. La recuperación no vino de un reinicio: las lecturas empezaron a funcionar otra vez por sí solas.

### 3.2 Defecto 1: entrega la última lectura buena para siempre

`api-SIASA/index.js`:

- **Líneas 1056-1075 (`pollModbusAutoSnapshot`):** si la lectura falla, conserva la lectura guardada anterior y solo anota el error en memoria.
  ```js
  } else {
    // conserva el último snapshot bueno si esta lectura falla
    modbusAutoSnapshot.error = getModbusAutoError(data) || "modbus_auto_error";
  }
  ```
- **Líneas 3891-3896 (endpoint `/api/ebo/modbus-auto`):** si la lectura guardada ya está vieja, **la entrega igual**. No hay límite de antigüedad.
  ```js
  if (useAuto && hasAnyModbusAutoSnapshot()) {
    ...
    return res.json(formatModbusAutoPayload(modbusAutoSnapshot.data));
  }
  ```
- La respuesta (`formatModbusAutoPayload`, línea 325) **no incluye la hora de la lectura** (`scanned_at`), aunque el lector sí la calcula.

### 3.3 Defecto 2: la falla no deja rastro en el log

- El error de lectura se guarda en `modbusAutoSnapshot.error`, que nadie imprime ni consulta.
- La línea `MODBUS AUTO APIKEY OK` (línea 3937) solo se escribe cuando la API lee el EBO directamente, no cuando responde con la lectura guardada (que es lo normal). Por eso buscarla no muestra nada útil.
- Lo único que sí se escribe es `Modbus conectado a ...` (cada reconexión) y `Error Modbus cliente: ...` (errores del socket). Esas dos líneas son la evidencia que hay que buscar (sección 7).

### 3.4 Defecto 3: la lectura se puede atascar horas

`api-SIASA/modbus_cliente/lectura_Ebo.js` y `modbus_rtu.js`:

- Cada lectura del EBO espera hasta **8 s** de respuesta (`MODBUS_TIMEOUT_MS`).
- Si un bloque de registros no responde, el lector **no se rinde**: lo lee **registro por registro** (líneas 2168-2190), y cada intento fallido hace cierre de conexión + reconexión + reintento (`modbus_rtu.js`, líneas 118-124). Además prueba los dos tipos de registro (holding e input).
- Los timeouts se **ignoran** (líneas 2182-2189): el lector sigue con el siguiente registro sin reportar error.
- Mientras una lectura está en curso, **no empieza otra** (`inFlight`, línea 1057), y la API sigue entregando la lectura guardada.

Resultado: si el EBO acepta la conexión pero no responde (o responde muy lento), una sola lectura puede tardar **horas**, y durante todo ese tiempo la API entrega datos viejos sin avisar.

Agravantes encontrados:

- **Dos lectores comparten la misma conexión.** Al arrancar se activan el lector v1 (cada 1 s) y el v2 (cada 30 s) (líneas 4064-4065), los dos sobre la misma conexión Modbus y la misma cola. Cuando el EBO responde lento, compiten entre sí.
- **El cierre de conexión depende del EBO.** `resetModbus()` espera a que el socket confirme el cierre (`await client.close()`). La librería `modbus-serial` 8.0.23 solo confirma el cierre si el EBO también cierra su lado, o al vencer el timeout del socket. Si el socket ya estaba destruido, la confirmación no llega nunca y la cola de lecturas queda bloqueada.

### 3.5 Lo que se descarta y lo que no

| Hipótesis | Estado |
|---|---|
| Reinicio o caída de `node-api` | **Descartado** (0 reinicios desde el 25/09) |
| Falla de la plataforma que grafica | **Poco probable**: grafica fielmente lo que la API le entregó |
| EBO o red hacia el EBO con problemas entre el 30/09 y el 12/10 | **Sin confirmar.** El Agente Go comenzó a leer el EBO recién el 12/10 17:11 UTC (0 errores desde entonces), así que **no sirve como prueba** de lo que pasó antes. Se confirma con la sección 7 |
| El EBO perdió comunicación con los medidores y retuvo el último valor | **Sin confirmar.** El EBO también congela el último valor si pierde a los medidores. Se descarta revisando las tendencias del propio EBO (sección 7, paso 4) |

Nota: la gráfica muestra una caída a **0 kW** alrededor del 29/09, un día antes del congelamiento. Puede ser un primer síntoma de la misma falla (una lectura incompleta). Conviene revisarla en el log junto con el resto.

---

## 4. Causa raíz

**Causa directa (confirmada en el código):** api-SIASA no controla la antigüedad ni la calidad de los datos que entrega. Desde el 30/09 18:00 no logró completar lecturas nuevas del EBO y siguió entregando la última lectura buena como si fuera actual, sin registrar el error.

**Causa que disparó la falla (por confirmar):** algo hizo que las lecturas al EBO dejaran de completarse el 30/09 a las 18:00 y volvieran a funcionar el 12/10 a las 18:00. Las opciones, de mayor a menor probabilidad según el código:

1. El EBO dejó de responder Modbus (servidor Modbus TCP saturado o colgado, límite de conexiones, reinicio de la AS-P) y la lectura de api-SIASA quedó atascada o fallando en silencio.
2. Se cortó o degradó la red entre el servidor y el EBO.
3. El EBO perdió comunicación con los medidores y retuvo el último valor (en ese caso, el congelamiento venía del EBO y api-SIASA solo lo repitió).

La sección 7 distingue entre las tres.

---

## 5. Impacto

- Durante 12 días, **todas las métricas eléctricas** de ION7400 y PM2130 de Escuintla (potencia, voltajes, corrientes, calidad de energía, transferencia comercial/generador) mostraron un valor fijo.
- Los indicadores de ese período (mínimo, máximo, promedio, consumo) **no son válidos**: el promedio de 113.54 kW de los últimos 30 días incluye 12 días de un valor repetido.
- Cualquier alarma o reporte basado en estos datos no pudo detectar eventos reales (cortes, transferencias a generador, sobrecargas) en ese período.
- **Datos que se pueden recuperar:** el ION7400 guarda su propio historial interno, y si la sede tiene PME/ION (base `ION` en 10.30.39.172), ahí también. Con eso se puede reconstruir el período.

---

## 6. Solución

### 6.1 Si vuelve a pasar antes de la corrección

```bash
docker restart node-api
```

Y verificar que los valores cambian (sección 7, paso 3). Esto devuelve el servicio, pero no evita que se repita.

### 6.2 Corrección en api-SIASA (definitiva)

| # | Cambio | Dónde | Evita |
|---|---|---|---|
| 1 | Escribir en el log cada lectura fallida (máximo 1 línea por minuto) y la duración de cada lectura | `pollModbusAutoSnapshot`, `index.js` | Fallas silenciosas |
| 2 | Incluir `scanned_at` y `stale: true/false` en la respuesta de `/api/ebo/modbus-auto` | `formatModbusAutoPayload`, `index.js` | Que la plataforma guarde datos viejos como nuevos |
| 3 | No entregar lecturas con más de 60 s de antigüedad: responder **503** | endpoint `/api/ebo/modbus-auto` | Líneas planas de días |
| 4 | Tiempo máximo para una lectura completa (p. ej. 30 s); al vencer, se cancela y se libera `inFlight` | `pollModbusAutoSnapshot` | Lecturas atascadas por horas |
| 5 | Vigilante: si no hay una lectura buena en 5 min, destruir el socket (`destroy()`, no `close()`) y reconectar; si sigue fallando, terminar el proceso para que Docker lo reinicie (`restart: unless-stopped`) | `modbus_rtu.js` | Conexión colgada indefinidamente |
| 6 | Activar solo el lector de la versión en uso (v1 o v2), no los dos | `index.js`, líneas 4064-4065 | Competencia por la conexión |
| 7 | Al fallar un bloque, no leer registro por registro si el error es un timeout: cortar la lectura y reintentar en el siguiente ciclo | `lectura_Ebo.js`, líneas 2159-2190 | Lecturas de horas |

Estos mismos archivos existen en las copias de las demás sedes (Gineco, Amatitlán, Palín, Gomera, Mazatenango, Retalhuleu, Santa Lucía, Tiquisate, Villa Nueva, Cobán), así que probablemente tienen el mismo riesgo (no se revisó cada copia línea por línea). Conviene revisarlas y aplicar la corrección en todas.

### 6.3 En la plataforma

- Usar `scanned_at` de la API como hora del dato, y descartar el dato si no cambió desde la consulta anterior.
- Alarma de **"métrica sin cambio"**: si la potencia de un medidor no varía nada en 30 minutos, avisar. En una carga real de un hospital, la potencia nunca queda idéntica tanto tiempo.

---

## 7. Evidencia que falta y cómo obtenerla

Ejecutar en el servidor de la sede y adjuntar el resultado.

```bash
# 1. Actividad de la conexión Modbus, por hora, entre el 29/09 y el 13/10
docker logs --timestamps --since 2026-09-29T00:00:00 --until 2026-10-13T06:00:00 node-api 2>&1 \
  | grep -E "Modbus conectado a|Error Modbus cliente|snapshot modbus-auto-v2|endpoint modbus-auto" \
  | cut -c1-13 | sort | uniq -c

# 2. Detalle alrededor del inicio y del fin (ajustar la hora a UTC: 18:00 Guatemala = 00:00 UTC del día siguiente)
docker logs --timestamps --since 2026-09-30T23:00:00 --until 2026-10-01T02:00:00 node-api 2>&1 | grep -iE "modbus|error" | head -40
docker logs --timestamps --since 2026-10-12T23:00:00 --until 2026-10-13T02:00:00 node-api 2>&1 | grep -iE "modbus|error" | head -40

# 3. Estado actual: ejecutar 2 veces con 30 s de diferencia; los valores deben cambiar
K=$(docker exec node-api printenv MODBUS_AUTO_API_KEY); curl -s -H "x-api-key: $K" http://localhost:3001/api/ebo/modbus-auto | head -c 600; echo

# 4. Versión activa del lector
docker exec node-api sh -c 'grep -E "MODBUS_AUTO_ACTIVE_VERSION|MODBUS_TIMEOUT_MS|MODBUS_AUTO_POLL_MS" /app/.env'
```

Además, fuera del servidor:

5. **Tendencias del EBO** (EcoStruxure WorkStation): abrir la tendencia de la potencia del ION7400-1 entre el 30/09 y el 12/10.
6. **Registro de eventos de la AS-P 10.0.6.26:** reinicios, pérdida de comunicación con los medidores, cambios de configuración el 30/09 y el 12/10.
7. **Hora de la gráfica:** confirmar si la plataforma muestra la hora de Guatemala o UTC.

| Resultado | Conclusión |
|---|---|
| Paso 1: muchas líneas `Modbus conectado a` o `Error Modbus cliente` durante el período | La conexión al EBO fallaba o se reconectaba sin parar: **causa 1 o 2** |
| Paso 1: ninguna línea entre el 30/09 18:00 y el 12/10 18:00 | La lectura quedó **atascada** (defecto 3) sin generar ningún evento |
| Paso 5: la tendencia del EBO **sí varía** en ese período | El EBO tenía los datos bien: la falla fue **solo de api-SIASA** |
| Paso 5: la tendencia del EBO también está **plana** | El EBO perdió a los medidores: **causa 3** |
| Paso 6: reinicio o evento de la AS-P el 30/09 o el 12/10 cerca de las 18:00 | Ese evento disparó la falla o la recuperación |

---

## 8. Cronología

| Fecha | Evento | Fuente |
|---|---|---|
| 25/09/2026 19:37 UTC | Arranca `node-api`; no se vuelve a reiniciar | `docker inspect` |
| ~29/09/2026 | Caída puntual de la potencia a 0 kW | Gráfica de la plataforma |
| 30/09/2026 18:00 | Las métricas de ION7400 y PM2130 quedan en un valor fijo | Gráfica de la plataforma |
| 12/10/2026 17:11 UTC | El Agente Go empieza a leer el mismo EBO: 0 errores, valores cambiando | Log del Agente Go |
| 12/10/2026 18:00 | Las métricas vuelven a cambiar, sin reinicio de `node-api` | Gráfica de la plataforma |

Si la hora de la gráfica es UTC, la recuperación (18:00 UTC) ocurrió **49 minutos después** de que el Agente Go empezara a leer el EBO. Conviene revisar si ese día se hizo algún cambio en el EBO o en la red durante la instalación.

---

## 9. Hallazgo adicional: sensores WISE de cadena de frío

Al revisar el contenedor se encontró otro defecto, independiente de este incidente, en el puente MQTT → BACnet (`bacnet/mqtt_to_bacnet_bridge.js`, líneas 50-53):

- Los alias `aiNraw` y `aiNrawvalue` hacen que el conteo crudo del WISE (~45 000) se publique como si fueran los mA (4-20). El EBO lo convierte a ~432 000 °C.
- El log del 13/10 lo muestra en 3 canales: `b34ebc_ai0_value = 45409` (Clínica de Vacunación), `bb71bb_ai1_value = 45612` y `bb71bb_ai3_value = 45373` (Banco de Sangre).
- **Impacto:** las alarmas de temperatura del EBO no funcionan en esos canales.
- **Corrección:** quitar esos alias, reconstruir y reiniciar `node-api`. El mismo código está en `api-SIASA-Gineco` y `api-SIASA/sedes/Gineco`; la copia de Amatitlán no lo tiene.

---

## 10. Lecciones

- **Toda lectura debe llevar su hora y su calidad** (buena / vieja / error). Un dato sin hora no se puede validar.
- **Una falla silenciosa es peor que una caída.** Si la API hubiera respondido error el 30/09, se habría detectado el mismo día y no 12 días después.
- **Vigilar que las métricas cambien.** Una potencia idéntica por horas en un hospital es señal de falla, no de estabilidad.

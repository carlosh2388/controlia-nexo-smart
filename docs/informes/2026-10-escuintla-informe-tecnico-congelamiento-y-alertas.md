# Informe técnico: congelamiento de métricas eléctricas en IGSS Escuintla y sistema de alertas por correo

| | |
|---|---|
| **Sede** | IGSS Escuintla |
| **Equipos afectados** | Medidores ION7400 y PM2130, leídos a través del EBO AS-P (10.0.6.26) |
| **Período del incidente** | 30/09/2026 18:00 al 12/10/2026 18:00 (12 días) |
| **Sistema responsable de entregar los datos** | api-SIASA (contenedor `node-api`), endpoint `/api/ebo/modbus-auto` |
| **Dirigido a** | Centro de monitoreo, responsables técnicos de SIASA, supervisión |
| **Fecha** | 13/10/2026 |

---

## 1. Resumen

Entre el 30/09 y el 12/10/2026, el dashboard mostró todas las métricas de los medidores ION7400 y PM2130 de Escuintla con **un solo valor fijo**. Por ejemplo, la potencia comercial de HES107 / ION7400-1 se quedó en ~150 kW durante 12 días.

**Causa:** api-SIASA dejó de obtener lecturas nuevas del EBO y siguió entregando la última lectura buena como si fuera actual. No registró el error ni avisó a nadie. El problema se descubrió revisando la gráfica, 12 días después.

**Solución propuesta:** que api-SIASA **detecte por sí misma los eventos** de la lectura y de cada medidor (datos congelados, medidor sin cambios, medidor fuera de línea, pérdida de conexión con el EBO) y **envíe un correo al centro de monitoreo** en el momento en que ocurren, con la causa probable y la acción a seguir. Además, la API reporta su estado en un endpoint y se reconecta sola cuando la lectura se atasca.

---

## 2. Qué ocurrió

### 2.1 Cómo llegan los datos

```
ION7400 / PM2130 --> EBO AS-P 10.0.6.26 --Modbus TCP--> api-SIASA --HTTP :3001--> Dashboard
```

api-SIASA lee el EBO cada segundo, guarda la lectura en memoria y se la entrega al dashboard en cada consulta. Una sola lectura trae **todos** los medidores; por eso se congelaron todos a la vez.

### 2.2 Causa

El código de api-SIASA tiene tres defectos que, juntos, producen exactamente lo que se observó:

| # | Defecto | Dónde | Efecto |
|---|---|---|---|
| 1 | Si la lectura del EBO falla, **entrega la última lectura buena sin límite de tiempo** y sin indicar su hora | `index.js`, líneas 1056-1075 y 3891-3896 | El dashboard guarda datos viejos como nuevos: línea plana |
| 2 | **No escribe la falla en el log**: el error queda solo en memoria | `index.js`, líneas 1066-1069 | Nadie se entera; no queda rastro |
| 3 | Cuando el EBO no responde, la lectura **puede atascarse horas**: ignora los timeouts y reintenta registro por registro con esperas de 8 s, y mientras tanto no empieza otra | `modbus_cliente/lectura_Ebo.js`, líneas 2159-2190; `modbus_rtu.js` | La falla se prolonga sin recuperarse |

El contenedor **no se reinició** en todo el período (corre sin interrupción desde el 25/09/2026, con 0 reinicios). Por eso el 12/10 la recuperación no vino de un reinicio: las lecturas volvieron a completarse solas, lo que indica que la condición externa (el EBO o la red hacia el EBO) se normalizó en ese momento.

### 2.3 Qué falta confirmar

El **disparador** (qué hizo que el EBO dejara de responder el 30/09 a las 18:00) se confirma con el log del contenedor y con las tendencias y el registro de eventos del EBO. El procedimiento está en el [informe de incidente](../incidentes/2026-10-escuintla-metricas-congeladas.md), sección 7. Las opciones son:

1. El EBO dejó de responder Modbus (servidor Modbus TCP saturado o colgado, límite de conexiones, reinicio de la AS-P).
2. Se cortó o degradó la red entre el servidor y el EBO.
3. El EBO perdió comunicación con los medidores y retuvo el último valor.

**Cualquiera de las tres se habría detectado en minutos con el sistema de alertas de la sección 3.**

### 2.4 Impacto

- 12 días sin datos eléctricos válidos de Escuintla: potencia, voltajes, corrientes, calidad de energía y transferencia comercial/generador.
- Los indicadores de ese período (mínimo, máximo, promedio, consumo) no son válidos.
- Ningún evento eléctrico real de ese período (corte, transferencia a generador, sobrecarga) pudo verse en el dashboard.

---

## 3. Solución: detección de eventos y aviso por correo

### 3.1 Cómo funciona

```
                    api-SIASA
 EBO --Modbus--> [ Lectura ] --> [ Detector de eventos ] --> [ Registro ] --> tabla api_eventos (PostgreSQL)
                                        │                                       log [MODBUS-EVENTO]
                                        │
                                        ├--> [ Notificador ] --SMTP--> correo al centro de monitoreo
                                        │
                                        └--> [ Vigilante ] --> reconecta / reinicia si se atasca

 Centro de monitoreo / dashboard --> GET /api/ebo/modbus-auto/estado   (estado general y de cada medidor)
                                 --> GET /api/ebo/modbus-auto/eventos  (historial)
```

Todo corre **dentro de api-SIASA**: no hace falta instalar otro servidor. El detector revisa cada lectura y la compara con la anterior.

### 3.2 Eventos que se detectan

**Eventos de la lectura (afectan a todos los medidores de la sede):**

| Evento | Condición | Severidad | Causa probable |
|---|---|---|---|
| `EBO_SIN_CONEXION` | No se puede abrir la conexión al EBO por más de 2 min | Crítico | Red caída, EBO apagado o puerto 502 bloqueado |
| `DATOS_CONGELADOS` | Sin lectura buena por más de 5 min | Crítico | El EBO no responde Modbus o la lectura está atascada |
| `LECTURA_ATASCADA` | Una lectura lleva más de 60 s en curso | Advertencia | El EBO responde muy lento; el vigilante reconecta |
| `RECONEXIONES_FRECUENTES` | Más de 10 reconexiones en 1 hora | Advertencia | Red inestable o EBO saturado de conexiones |
| `API_REINICIADA` | La API arrancó (por reinicio manual, del vigilante o del servidor) | Informativo | Mantenimiento, corte de energía o corrección automática |
| `LECTURA_RECUPERADA` | Vuelve una lectura buena después de un evento crítico | Informativo | Se cierra el evento e informa cuánto duró |

**Eventos de cada medidor (ION7400, PM2130):**

| Evento | Condición | Severidad | Causa probable |
|---|---|---|---|
| `MEDIDOR_SIN_CAMBIO` | Todas las métricas del medidor idénticas por más de 15 min, con la lectura funcionando | Crítico | El EBO perdió comunicación con el medidor y repite el último valor |
| `MEDIDOR_FUERA_DE_LINEA` | El medidor llega con `online: false` por más de 3 min | Crítico | Medidor apagado, bus RS-485 o dirección Modbus |
| `MEDIDOR_EN_CERO` | Voltajes de las tres fases en 0 por más de 3 min | Crítico | Corte de energía real en ese tablero o falla de lectura |
| `MEDIDOR_VALOR_INVALIDO` | Valores imposibles (por ejemplo, voltaje negativo o mayor a 2 veces el nominal) | Advertencia | Registro mal leído o mapeo incorrecto |
| `MEDIDOR_RECUPERADO` | El medidor vuelve a entregar valores normales | Informativo | Se cierra el evento con su duración |

Las dos reglas que habrían detectado el incidente de Escuintla son `DATOS_CONGELADOS` (a los 5 min) y `MEDIDOR_SIN_CAMBIO` (a los 15 min). Ninguna potencia de un hospital queda idéntica 15 minutos seguidos.

Los tiempos son configurables por sede (sección 3.6).

### 3.3 Aviso por correo

**Cuándo se envía:**

| Situación | Correo |
|---|---|
| Se abre un evento **crítico** | Inmediato |
| Se abre un evento de **advertencia** | Agrupado: un solo correo cada 15 min con todas las advertencias |
| El evento sigue abierto | Recordatorio cada 4 h |
| El evento se cierra | Correo de cierre con la duración total |
| Todos los días a las 07:00 | Resumen diario de la sede (ver 3.5) |

**Para no saturar al centro de monitoreo:**

- Un evento abierto genera **un** correo, no uno por segundo.
- Si se cae la conexión al EBO, se envía **un solo correo** con la causa general (`EBO_SIN_CONEXION`), no uno por cada medidor. Los eventos de los medidores se suprimen mientras haya un evento general abierto.
- Máximo 20 correos por hora por sede; el exceso se agrupa en el siguiente envío.

**Si el correo no sale** (servidor de correo caído, sin red): el evento queda guardado en la tabla con `notificado = false` y se reintenta cada 5 min. La falla de envío se escribe en el log.

**Ejemplo de correo:**

```
De:      SIASA Alertas <alertas-siasa@...>
Para:    centro.monitoreo@...
Asunto:  [CRÍTICO] SIASA Escuintla - HES107 ION7400-1 - Medidor sin cambio desde hace 15 min

Sede:            IGSS Escuintla
Dispositivo:     ION7400-1 (inventario HES107)
Ubicación:       Cuarto eléctrico - Disponibilidad y Calidad de Energía
Evento:          MEDIDOR_SIN_CAMBIO
Desde:           30/09/2026 18:00 (hora de Guatemala)
Detalle:         Todas las métricas idénticas desde hace 15 min.
                 Potencia comercial: 150.2 kW (sin variación)
Estado de la lectura del EBO: OK (última lectura hace 1 s)

Causa probable:  El EBO perdió comunicación con el medidor y repite el último valor.

Qué hacer:
  1. Revisar en WorkStation el estado de comunicación del ION7400-1.
  2. Si el EBO muestra el medidor sin comunicación: revisar el bus RS-485 y la
     alimentación del medidor (técnico de campo).
  3. Si el EBO muestra valores que cambian: escalar a soporte SIASA (falla de api-SIASA).

Estado en vivo:  http://<servidor-escuintla>:3001/api/ebo/modbus-auto/estado
Id. de evento:   ESC-2026-0930-0007
```

### 3.4 Consultar el estado y los eventos

| Endpoint (puerto 3001, con API key) | Devuelve |
|---|---|
| `GET /api/ebo/modbus-auto/estado` | Estado general (`ok`, `lento`, `degradado`, `congelado`), hora de la última lectura buena, último error y **estado de cada medidor** |
| `GET /api/ebo/modbus-auto/eventos?desde=&hasta=&dispositivo=&abiertos=true` | Historial de eventos, filtrable por fecha, medidor o solo abiertos |
| `POST /api/ebo/modbus-auto/alertas/prueba` | Envía un correo de prueba (para verificar la configuración) |

Ejemplo de `/estado`:

```json
{
  "sede": "Escuintla",
  "estado": "ok",
  "ultima_lectura_ok": "2026-10-13T10:15:02-06:00",
  "antiguedad_s": 1,
  "ultimo_error": null,
  "eventos_abiertos": 1,
  "dispositivos": [
    { "id": "ion_7400_1", "nombre": "ION7400-1", "inventario": "HES107", "estado": "sin_cambio",
      "sin_cambio_desde": "2026-10-13T09:58:00-06:00", "evento": "ESC-2026-1013-0002" },
    { "id": "pm_2130_1", "nombre": "PM2130-1", "inventario": "HES112", "estado": "ok" }
  ]
}
```

Además, cada respuesta de `/api/ebo/modbus-auto` incluye la hora de la lectura (`scanned_at`). Si el dato tiene más de 5 min, la API responde **503** en lugar de entregar datos viejos, y el dashboard deja de guardar valores falsos.

### 3.5 Si la API o el servidor se caen

Si la API está caída, no puede mandar el correo. Para cubrir ese caso:

1. **Resumen diario como señal de vida:** todos los días a las 07:00 la API manda un resumen de la sede (eventos de las últimas 24 h y estado de cada medidor). **Si el centro de monitoreo no recibe el resumen de una sede antes de las 07:30, esa sede tiene la API o el servidor caído.**
2. **Vigilante externo (recomendado):** un monitor en un servidor central (Uptime Kuma o un script con cron) consulta `/estado` de cada sede cada minuto y manda correo si no responde. Detalle en el [plan de monitoreo](../operacion/plan-monitoreo-api-siasa.md), sección 3.

### 3.6 Configuración por sede (archivo `.env`)

```ini
# Identificación
SEDE_NOMBRE=Escuintla

# Correo
ALERTAS_CORREO_ACTIVO=true
SMTP_HOST=smtp.<dominio>
SMTP_PORT=587
SMTP_SEGURO=false
SMTP_USUARIO=alertas-siasa@<dominio>
SMTP_CLAVE=********
ALERTAS_CORREO_DE="SIASA Alertas <alertas-siasa@<dominio>>"
ALERTAS_CORREO_PARA=centro.monitoreo@<dominio>
ALERTAS_CORREO_CC=soporte.siasa@<dominio>

# Umbrales (minutos)
ALERTA_CONGELADO_MIN=5
ALERTA_SIN_CAMBIO_MIN=15
ALERTA_FUERA_DE_LINEA_MIN=3
ALERTA_RECORDATORIO_HORAS=4
ALERTA_RESUMEN_DIARIO_HORA=07:00
```

### 3.7 Corrección automática (vigilante)

| Situación | Acción automática | Correo |
|---|---|---|
| Lectura en curso por más de 60 s | Cancela la lectura, destruye la conexión y reconecta | Advertencia `LECTURA_ATASCADA` |
| Sin lectura buena por 10 min, con la red al EBO respondiendo | Reinicia el proceso (Docker lo levanta de nuevo) | Crítico `DATOS_CONGELADOS`, y luego `API_REINICIADA` |
| Timeout en un bloque de registros | Corta la lectura y reintenta en el siguiente ciclo (sin leer registro por registro) | — |

Además se deja **un solo lector activo** (hoy corren dos, v1 y v2, sobre la misma conexión).

---

## 4. Qué hace el centro de monitoreo al recibir un correo

| Evento del correo | Primera verificación | Si se confirma | Escalar a |
|---|---|---|---|
| `EBO_SIN_CONEXION` | ¿Hay red en la sede? ¿El EBO está encendido? | Reportar falla de red o del EBO | Redes del hospital / mantenimiento |
| `DATOS_CONGELADOS` | Abrir `/estado`: ¿el `ultimo_error` dice `Timed out`? | Esperar 10 min: el vigilante reinicia la API. Si no se recupera, reiniciar `node-api` | Soporte SIASA; si persiste, integrador del EBO |
| `LECTURA_ATASCADA` / `RECONEXIONES_FRECUENTES` | ¿Se repite varias veces en el día? | Revisar los clientes conectados al servidor Modbus del EBO | Soporte SIASA |
| `MEDIDOR_SIN_CAMBIO` | WorkStation: estado de comunicación del medidor | Revisar el bus RS-485 y la alimentación del medidor | Técnico de campo |
| `MEDIDOR_FUERA_DE_LINEA` | Pantalla del medidor encendida | Revisar la alimentación y el cableado | Técnico de campo |
| `MEDIDOR_EN_CERO` | ¿Hubo corte de energía en ese tablero? | Si es corte real: protocolo eléctrico del hospital | Mantenimiento eléctrico |
| No llegó el resumen diario | Abrir `/estado` de la sede | Si no responde: servidor o API caídos | Soporte SIASA |

Al cerrar, el correo de cierre trae la duración del evento. El centro de monitoreo lo registra en su bitácora con la causa encontrada y la acción tomada.

---

## 5. Implementación

### 5.1 Fases

| Fase | Trabajo | Duración estimada |
|---|---|---|
| 1 | Estado en vivo, hora en cada respuesta, eventos en el log y en la tabla `api_eventos` | 2 días |
| 2 | Detector de eventos de lectura y de cada medidor | 2 días |
| 3 | Envío de correo (librería `nodemailer`), agrupación, recordatorios, reintentos y resumen diario | 2 días |
| 4 | Vigilante (reconexión y reinicio automático) y un solo lector activo | 1 día |
| 5 | Pruebas en Escuintla (5.3) | 1 día |
| 6 | Despliegue en las demás sedes | 1-2 días |

### 5.2 Requisitos antes de empezar

1. **Una cuenta de correo para enviar** (SMTP): servidor, puerto, usuario y clave. Puede ser del IGSS, de Microsoft 365 o de Google Workspace.
2. **Salida de red desde el servidor de cada sede hacia el servidor de correo** (puerto 587). En la red hospitalaria puede estar bloqueada: hay que confirmarlo con Redes. Si no se permite, la alternativa es que el vigilante central (3.5) sea el que envíe los correos.
3. **Lista de destinatarios:** correo del centro de monitoreo y copia a soporte SIASA.
4. **Rotación de logs** en el `docker-compose.yml` (`max-size: 50m`, `max-file: 10`). El historial completo queda en la tabla `api_eventos`.

### 5.3 Pruebas de aceptación

| Prueba | Cómo | Resultado esperado |
|---|---|---|
| Correo de prueba | `POST /alertas/prueba` | Llega al centro de monitoreo |
| Sin conexión al EBO | Bloquear el puerto 502 hacia 10.0.6.26 durante 10 min | Correo `EBO_SIN_CONEXION` antes de 3 min; correo de cierre al desbloquear |
| Lectura atascada | Simular un EBO que acepta la conexión pero no responde | `LECTURA_ATASCADA`, reconexión automática y, a los 10 min, reinicio |
| Medidor sin cambio | Simular métricas repetidas de un medidor | Correo `MEDIDOR_SIN_CAMBIO` a los 15 min, solo de ese medidor |
| Sin saturación | Bloquear el EBO con 10 medidores configurados | **Un** correo general, no 10 |
| Correo caído | Configurar un SMTP inválido y provocar un evento | Evento guardado con `notificado = false`; se envía al corregir el SMTP |
| Dashboard | Durante la prueba de sin conexión | El dashboard no guarda valores repetidos |

---

## 6. Conclusión

El congelamiento de Escuintla no fue una falla de los medidores: api-SIASA entregó datos viejos durante 12 días sin avisar. La solución propuesta hace que la API **detecte el problema en 5 a 15 minutos, avise por correo al centro de monitoreo con la causa probable y la acción a seguir, y se corrija sola** cuando la falla es suya. Así, un evento como este pasa de 12 días sin detectar a minutos, y queda registrado para el seguimiento.

**Pendiente:** confirmar el disparador del 30/09 con el log del contenedor y los registros del EBO ([informe de incidente](../incidentes/2026-10-escuintla-metricas-congeladas.md), sección 7), y obtener la cuenta de correo y el permiso de red de la sección 5.2.

# Plan de monitoreo de api-SIASA: detectar, diagnosticar y corregir congelamientos

| | |
|---|---|
| **Objetivo** | Que un congelamiento de datos como el de Escuintla (30/09 al 12/10/2026) se detecte en **minutos**, no en días, y que quien lo atienda sepa la causa y qué hacer |
| **Alcance** | api-SIASA (contenedor `node-api`) de todas las sedes, y el dashboard que la consume |
| **Origen** | [Informe de incidente de Escuintla](../incidentes/2026-10-escuintla-metricas-congeladas.md) |

---

## 1. Idea general

Hoy la API tiene tres puntos ciegos: **no dice cuándo fue su última lectura buena, no escribe sus fallas en el log y nadie la vigila desde fuera.** El plan cierra los tres:

```
                       ┌───────────────────────────────────────────┐
EBO --Modbus--> api-SIASA                                          │
                  │  (1) Estado propio: /api/ebo/modbus-auto/estado │
                  │  (2) Eventos: log [MODBUS-EVENTO] + tabla       │
                  │  (3) Vigilante interno: se reconecta sola       │
                  └──────┬──────────────────────┬──────────────────┘
                         │                      │
              (4) Monitor externo        (5) Dashboard
              (Uptime Kuma, cada 1 min)  muestra "última lectura hace X"
                         │
                   Alerta a Telegram / correo
                         │
              (6) Guía de respuesta (sección 5)
```

---

## 2. Qué debe reportar la API (cambios en el código)

### 2.1 Estado en vivo: `GET /api/ebo/modbus-auto/estado`

Endpoint nuevo en el puerto 3001, con la misma API key. Reemplaza al `/health` actual, que siempre responde `ok: true` aunque los datos estén congelados.

```json
{
  "sede": "Escuintla",
  "estado": "congelado",
  "motivo": "sin lectura buena desde hace 3h 12m",
  "ultima_lectura_ok": "2026-09-30T18:00:04-06:00",
  "antiguedad_s": 11520,
  "ultimo_intento": "2026-09-30T21:12:01-06:00",
  "ultimo_error": "Timed out",
  "ultimo_error_en": "2026-09-30T21:11:53-06:00",
  "fallas_consecutivas": 412,
  "lectura_en_curso_desde": "2026-09-30T20:41:10-06:00",
  "duracion_ultima_lectura_ms": 1830,
  "reconexiones_ultima_hora": 37,
  "valores_sin_cambio_desde": null,
  "ebo": { "host": "10.0.6.26", "puerto": 502, "conectado": false },
  "version_lector": 1,
  "proceso_iniciado": "2026-09-25T13:37:41-06:00"
}
```

Valores posibles de `estado`:

| Estado | Condición | Significado |
|---|---|---|
| `ok` | Última lectura buena hace menos de 60 s | Todo normal |
| `lento` | Lecturas tardan más de 15 s | El EBO responde, pero mal |
| `degradado` | Sin lectura buena hace 60 s a 5 min | Falla en curso; puede recuperarse sola |
| `congelado` | Sin lectura buena hace más de 5 min | **Los datos que recibe el dashboard están viejos** |
| `sin_cambio` | Lecturas OK, pero todos los valores idénticos desde hace más de 15 min | El EBO entrega valores retenidos (perdió a los medidores) |

### 2.2 Eventos en el log: prefijo `[MODBUS-EVENTO]`

Una línea JSON por evento, fácil de buscar con `grep`. Se escriben **solo cuando algo cambia** (no cada segundo), para no llenar el log.

| Evento | Cuándo se escribe | Ejemplo de dato clave |
|---|---|---|
| `LECTURA_FALLIDA` | Primera falla, y luego 1 vez por minuto mientras siga fallando | `error`, `fallas_consecutivas` |
| `LECTURA_LENTA` | Una lectura tarda más de 15 s | `duracion_ms` |
| `LECTURA_ATASCADA` | Una lectura lleva más de 60 s en curso | `en_curso_desde` |
| `RECONEXION` | Se reconecta al EBO (máximo 1 línea por minuto, con conteo) | `reconexiones` |
| `DATO_VIEJO` | El estado pasa a `degradado` o `congelado` | `antiguedad_s` |
| `VALORES_SIN_CAMBIO` | Las métricas no cambian en 15 min con lecturas OK | `desde` |
| `RECUPERADO` | Vuelve una lectura buena después de una falla | `duracion_falla_s`, `causa` |
| `VIGILANTE_RECONEXION` | El vigilante interno destruye la conexión y reconecta | `motivo` |
| `VIGILANTE_REINICIO` | El vigilante termina el proceso para que Docker lo reinicie | `motivo` |
| `RESUMEN` | Cada 15 min | lecturas OK/fallidas, duración promedio |

Ejemplo:

```
[MODBUS-EVENTO] {"t":"2026-09-30T18:00:12-06:00","evento":"LECTURA_FALLIDA","error":"Timed out","fallas_consecutivas":1,"ebo":"10.0.6.26:502"}
[MODBUS-EVENTO] {"t":"2026-09-30T18:06:12-06:00","evento":"DATO_VIEJO","estado":"congelado","antiguedad_s":368}
[MODBUS-EVENTO] {"t":"2026-10-12T18:00:40-06:00","evento":"RECUPERADO","duracion_falla_s":1036828,"causa":"Timed out"}
```

### 2.3 Eventos guardados en la base de datos

Los mismos eventos se guardan en una tabla de PostgreSQL (la API ya tiene conexión). Así el historial no se pierde si se borra o rota el log, y el dashboard puede mostrarlo.

```sql
CREATE TABLE IF NOT EXISTS api_eventos (
  id         BIGSERIAL PRIMARY KEY,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sede       TEXT NOT NULL,
  evento     TEXT NOT NULL,
  estado     TEXT,
  detalle    JSONB
);
CREATE INDEX IF NOT EXISTS api_eventos_creado_idx ON api_eventos (creado_en DESC);
```

Endpoint de consulta: `GET /api/ebo/modbus-auto/eventos?desde=2026-09-29&hasta=2026-10-13`.

### 2.4 Hora y calidad en cada respuesta de datos

`/api/ebo/modbus-auto` agrega a su respuesta:

```json
"lectura": { "scanned_at": "2026-10-13T10:15:02-06:00", "antiguedad_s": 1, "estado": "ok" }
```

Y si el dato tiene más de 5 min, responde **503** con el motivo en lugar de entregar datos viejos. El dashboard deja de guardar valores falsos.

### 2.5 Vigilante interno (la API se corrige sola)

| Situación | Acción automática |
|---|---|
| Lectura en curso por más de 60 s | Cancela la lectura, **destruye** el socket (no espera al EBO) y reconecta |
| Sin lectura buena por más de 10 min, con la red al EBO respondiendo | Termina el proceso; Docker lo reinicia (`restart: unless-stopped`) |
| Timeout en un bloque de registros | Corta esa lectura y reintenta en el siguiente ciclo, sin leer registro por registro |

Además: activar **un solo** lector (el de la versión en uso), no v1 y v2 a la vez sobre la misma conexión.

Con esto, el incidente de Escuintla habría durado unos **10 minutos** en lugar de 12 días, salvo que la falla fuera del EBO o de la red. En ese caso la API se mantiene en `congelado` y la alerta del punto 3 lo avisa.

---

## 3. Vigilancia externa y alertas

La API no puede avisar si ella misma está caída. Se necesita un vigilante **fuera** de ella.

### 3.1 Recomendado: Uptime Kuma (un contenedor más en el servidor de la sede o en uno central)

```yaml
# docker-compose.yml (servidor central o de la sede)
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports: ["3002:3001"]
    volumes: ["./uptime-kuma:/app/data"]
```

Monitores a crear por sede:

| Monitor | Tipo | Configuración | Alerta si |
|---|---|---|---|
| API viva | HTTP | `http://<servidor>:3001/api/ebo/modbus-auto/estado`, header `x-api-key` | No responde 2 veces seguidas |
| Datos frescos | HTTP JSON query | Misma URL, expresión `estado`, valor esperado `ok` | Distinto de `ok` por 3 min |
| EBO alcanzable | TCP port | `10.0.6.26:502` | No conecta 3 veces seguidas |
| Servidor | Ping | IP del servidor de la sede | No responde |

Notificaciones: Telegram (la más rápida de configurar), correo o Microsoft Teams. Uptime Kuma también da una página de estado con todas las sedes juntas.

### 3.2 Alternativa sin instalar nada: script con cron

```bash
#!/bin/sh
# /opt/siasa/vigilar_api.sh  -- cron: * * * * * /opt/siasa/vigilar_api.sh
URL="http://localhost:3001/api/ebo/modbus-auto/estado"
K=$(docker exec node-api printenv MODBUS_AUTO_API_KEY)
R=$(curl -s -m 10 -H "x-api-key: $K" "$URL")
ESTADO=$(echo "$R" | sed -n 's/.*"estado":"\([a-z_]*\)".*/\1/p')
[ -z "$ESTADO" ] && ESTADO="api_sin_respuesta"
ANT=$(cat /tmp/siasa_estado 2>/dev/null)
if [ "$ESTADO" != "$ANT" ]; then
  echo "$ESTADO" > /tmp/siasa_estado
  curl -s "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    --data-urlencode chat_id="$TG_CHAT" \
    --data-urlencode text="SIASA Escuintla: $ANT -> $ESTADO. $(echo "$R" | head -c 300)" >/dev/null
fi
```

Solo avisa cuando el estado **cambia** (de `ok` a `congelado` y de vuelta), para no saturar.

---

## 4. Indicador en el dashboard

- En cada tarjeta de medidor: **"Última lectura hace X"**, con la `scanned_at` que manda la API.
- Si la antigüedad es mayor a 5 min: tarjeta en gris con la leyenda **"Dato no actualizado"**, en lugar de mostrar el valor como si fuera actual.
- En las gráficas: **no unir** los puntos cuando falten datos. Un hueco en la gráfica es honesto; una línea plana engaña.
- Panel de eventos de la sede (de la tabla `api_eventos`): fallas, recuperaciones y su duración.

---

## 5. Guía de respuesta: si se congela, qué hacer

### 5.1 Primeros 5 minutos (en el servidor de la sede)

```bash
# A. ¿Qué dice la API de sí misma?
K=$(docker exec node-api printenv MODBUS_AUTO_API_KEY)
curl -s -H "x-api-key: $K" http://localhost:3001/api/ebo/modbus-auto/estado; echo

# B. Últimos eventos
docker logs --since 2h node-api 2>&1 | grep "MODBUS-EVENTO" | tail -20

# C. ¿El servidor llega al EBO?
docker exec node-api node -e "require('net').connect(502,'10.0.6.26').on('connect',function(){console.log('EBO OK');this.end()}).on('error',function(e){console.log('ERROR',e.message)})"

# D. ¿El contenedor está vivo?
docker ps --filter name=node-api --format "{{.Status}}"
```

### 5.2 Diagnóstico según lo que se ve

| Lo que ves | Causa probable | Cómo confirmarla | Qué hacer en ese momento |
|---|---|---|---|
| `curl` del paso A no responde; paso D: contenedor detenido o reiniciándose | **La API está caída** | `docker logs --tail 100 node-api` | `docker compose up -d`. Si se reinicia en bucle, revisar el error del log |
| `estado: congelado`, `ultimo_error` con `ECONNREFUSED` o `EHOSTUNREACH`; paso C: `ERROR` | **Sin red al EBO** o el EBO apagado | `ping 10.0.6.26` desde el servidor | Revisar el switch, el cable y la VLAN, o el EBO. **No sirve reiniciar la API** |
| `estado: congelado` o `lento`, `ultimo_error: Timed out`; paso C: `EBO OK` | **El EBO acepta la conexión pero no responde Modbus** (saturado, demasiadas conexiones, servidor Modbus colgado) | En WorkStation: estado del servidor Modbus TCP de la AS-P y cantidad de clientes conectados | 1) `docker restart node-api`. 2) Si sigue: reiniciar el servidor Modbus de la AS-P o la AS-P, coordinando con mantenimiento |
| `estado: congelado`, `lectura_en_curso_desde` antigua, sin errores | **Lectura atascada** dentro de la API | Evento `LECTURA_ATASCADA` | `docker restart node-api`. Con el vigilante (2.5) esto se corrige solo |
| `estado: sin_cambio` (lecturas OK pero valores idénticos) | **El EBO perdió comunicación con los medidores** y retiene el último valor | En WorkStation: estado de comunicación del ION7400 y PM2130 | Revisar el bus RS-485 o la red de los medidores, y su alimentación. **No es falla de la API** |
| Un solo medidor congelado o en 0, los demás bien | **Ese medidor** o su dirección Modbus | Valor del medidor en su pantalla o en WorkStation | Revisar el medidor y su cableado |
| Estado `ok` y valores cambiando, pero el dashboard plano | **Falla del dashboard** (no consulta o no guarda) | Comparar `scanned_at` de la API con el último punto de la gráfica | Revisar el servicio que consume la API |
| Temperaturas de cadena de frío en ~432 000 °C | **Puente MQTT → BACnet** publica el valor crudo del WISE | `docker logs node-api 2>&1 \| grep "MQTT exposed values" \| tail` (valores de 5 cifras) | Corrección del puente (informe de incidente, sección 9) |

### 5.3 Después de resolver

1. Confirmar `estado: ok` y que los valores cambian (paso A dos veces, con 30 s de diferencia).
2. Exportar los eventos del período: `GET /api/ebo/modbus-auto/eventos?desde=...&hasta=...`.
3. Anotar en la bitácora de incidentes: inicio, fin, causa, acción tomada y quién la tomó.
4. Marcar en el dashboard el período sin datos válidos, para que no se use en reportes.

---

## 6. Seguimiento continuo

| Frecuencia | Qué revisar | Quién |
|---|---|---|
| Diario (automático) | Alertas de Uptime Kuma o Telegram | Soporte SIASA |
| Semanal | Eventos de la semana por sede: fallas, minutos congelados, reconexiones | Responsable técnico |
| Mensual | Disponibilidad de datos por sede (% del tiempo en `ok`); sedes con fallas repetidas | Responsable técnico + supervisión |

Consulta semanal sugerida:

```sql
SELECT sede, evento, count(*) AS veces,
       sum((detalle->>'duracion_falla_s')::int) / 60 AS minutos_sin_datos
FROM api_eventos
WHERE creado_en > now() - interval '7 days'
GROUP BY sede, evento
ORDER BY sede, veces DESC;
```

**Meta:** ningún congelamiento de más de 10 minutos sin alerta, y disponibilidad de datos del 99 % por sede.

---

## 7. Orden de implementación

| Fase | Qué | Esfuerzo | Resultado |
|---|---|---|---|
| 1 | Estado en vivo (2.1), eventos en el log (2.2), hora en cada respuesta (2.4) | 1-2 días | Se puede **ver** la falla y su causa |
| 2 | Vigilante interno y un solo lector (2.5) | 1 día | La API **se corrige sola** en los atascos |
| 3 | Uptime Kuma o script con alertas (3) | Medio día | **Aviso** en minutos |
| 4 | Tabla de eventos (2.3) e indicador en el dashboard (4) | 2-3 días | Historial y datos honestos en pantalla |
| 5 | Aplicar en todas las sedes; rotación de logs en Docker (`max-size: 50m`, `max-file: 10`) | 1-2 días | Cobertura completa |

Probar primero en Escuintla. Para validar, simular una falla: bloquear el puerto 502 hacia el EBO durante 10 minutos y comprobar que llega la alerta, que el estado pasa a `congelado` y que al desbloquear aparece `RECUPERADO`.

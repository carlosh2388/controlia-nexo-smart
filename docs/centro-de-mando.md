# Centro de mando y usuarios con permisos

Pestaña **Centro de mando** de Nodivo (pantalla de inicio): las 10 sedes del IGSS en una sola vista,
con sus equipos reales, alarmas, correos e historial. Instalado en 192.168.70.4 el 10/11/2026.
Mockup aprobado: "Diseño final" (consola estilo EBO + mapa del monitoreo central).

## De dónde salen los datos (todo solo lectura)

| Dato | Fuente | Cada cuánto |
| --- | --- | --- |
| Estado de las 10 sedes, medidores, eventos abiertos, actividad | Monitoreo central `http://10.30.10.27:8080/api/vista` (clave `CENTRAL_CLAVE`) | 15 s |
| Historial de las sedes que se leen por el EBO | Nodivo guarda una foto por minuto en la hypertable `centro_lecturas` (kW, V y A promedio, estado) | 60 s |
| Alarmas de un equipo con la hora de sus correos | API de la sede `GET /api/ebo/modbus-auto/eventos` (columnas `notificado_en` y `cierre_notificado_en`). API keys en `config/centro/sedes.json` | al abrir el equipo |
| Escuintla: equipos 3D, tendencias, huecos, directo vs EBO | Piloto Gravix (`readings` en TimescaleDB, agentes `igss-escuintla` y `igss-escuintla-directo`) | 15-30 s |

No se modifica nada en las sedes (api-SIASA), en el EBO ni en el monitoreo central. Los correos los
siguen enviando las sedes.

## Configuración en el servidor (fuera de git)

- `.env` del proyecto: `CENTRAL_URL=http://10.30.10.27:8080` y `CENTRAL_CLAVE=...` (la misma de
  `~/monitoreo-central/.env` en 10.30.10.27).
- `config/centro/sedes.json` (permiso 600): copia de `~/monitoreo-central/config/sedes.json`
  (`[{ id, nombre, ip, puerto, key, orden }]`). Se monta en el contenedor como
  `/app/config/centro/sedes.json`. Si cambia la API key de una sede, actualizarla aquí también.
- Sin esas variables la pestaña muestra "El centro de mando no está configurado".

## API

| Método | Ruta | Quién | Qué hace |
| --- | --- | --- | --- |
| GET | `/access/me` | usuario | Pestañas, acciones, sedes y pantalla de inicio del usuario (arma el menú) |
| GET / PUT | `/access/roles`, `/access/roles/:role` | admin | Matriz de permisos de Operador (`operator`) y Consulta (`viewer`) |
| GET / POST / PATCH / DELETE | `/users`, `/users/:id` | admin | Mantenimiento de usuarios |
| POST | `/users/:id/password` | admin | Cambia la contraseña y cierra sus sesiones |
| GET | `/centro/vista` | usuario | Vista del monitoreo central, solo con las sedes del usuario |
| GET | `/centro/sedes/:sede/eventos?dispositivo=&dias=` | usuario | Alarmas y correos de un equipo (desde la sede) |
| GET | `/centro/sedes/:sede/medidores/:medidor/historial?minutes=` | usuario | Tendencia guardada en `centro_lecturas` |
| GET | `/centro/sedes/:sede/medidores/:medidor/excel?minutes=&step=` | acción `excel` | Historial en Excel (.xlsx) |
| GET | `/pilot/devices/:id/excel?metrics=&labels=&minutes=&step=` | acción `excel` | Historial Gravix en Excel, con la columna del EBO si el equipo tiene pareja |

| GET | `/pilot/normas` | usuario | Normas disponibles y sus límites (`apps/api/src/timeseries/normas.ts`) |
| GET | `/pilot/:buildingKey/cumplimiento?dias=&norma=` | usuario | % del tiempo dentro del límite por equipo e indicador (promedios de 10 min) |
| GET | `/pilot/devices/:id/pronostico?metric=&dias=&horizonte=` | usuario | Historia horaria + pronóstico con rango probable |
| GET / PUT | `/pilot/devices/:id/umbrales` | PUT: admin/operador + acción `agentes` | Umbrales propios del equipo (en `metadata.umbrales`) |
| POST | `/pilot/devices/:id/probar` | admin/operador + acción `agentes` | Una lectura Modbus función 03 (frecuencia y voltaje, o el bloque del generador) |

El Excel lo genera `apps/api/src/common/xlsx.ts` (sin librerías): hojas Historial, Huecos e
Información, fechas en hora de Guatemala, máximo 50 000 filas por archivo (sube el intervalo solo).

## Perfiles y permisos

| Perfil | Rol en la base | Por defecto |
| --- | --- | --- |
| Administrador | `admin` | Todo, siempre (incluye "Usuarios y permisos") |
| Operador | `operator` | Todas las pestañas que ya tenía; acciones: reconocer, Excel |
| Consulta | `viewer` | Todas las pestañas que ya tenía; sin acciones |

El día de la instalación Operador y Consulta quedaron viendo las mismas pestañas que antes, para no
quitarle nada a nadie: el administrador las ajusta en **Usuarios y permisos**. "Centro de mando" no se
puede quitar (es la pantalla de inicio). Cada usuario tiene además sus **sedes** (vacío = todas), su
**pantalla al entrar** y si está **activo** (inactivo no inicia sesión).

La API también aplica los permisos: las sedes del usuario filtran `/centro/*` y la acción `excel`
protege las descargas. Las pestañas existentes conservan sus controles por rol de siempre.

## Funciones de la pantalla (11/11/2026)

- **Mapa:** rueda o +/− para acercar (hasta 5×), arrastrar para moverse, doble clic acerca, botón
  "Ampliar" (pantalla grande, Esc cierra). Misma proyección que el monitoreo central.
- **Línea de tiempo de incidentes:** 7 días por sede; agrupa los eventos que pasan juntos (menos de
  20 min entre sí) y cierra el incidente con la normalización posterior de la sede.
- **Ranking de sedes:** disponibilidad de 24 h, eventos y críticos de 7 días, equipos en línea,
  respuesta; se ordena por columna.
- **Calidad de energía con semáforo** (equipos leídos directo): desbalance de voltaje y corriente,
  factor de potencia, THD de voltaje y corriente, flicker, frecuencia y carga contra la capacidad del
  transformador, con la recomendación. Por equipo (pestaña) y por sede (tabla).
- **Gráficas interactivas** (`apps/web/src/components/charts/InteractiveChart.tsx`, también en Piloto
  Gravix): mira con fecha/hora y valores, arrastrar para acercar, leyenda para ocultar series, huecos
  sombreados. "Comparar con": la lectura por el EBO, el periodo anterior u otro equipo de la sede.
- **Modo sala de control:** pantalla completa que recorre las sedes con problema (o todas) cada 12 s.

### Colores de alarma (13/11/2026)

| Color | Cuándo |
| --- | --- |
| Rojo | Medidor fuera de línea, voltaje en cero o sede sin respuesta |
| Ámbar | Advertencias, incluidas las de **instrumentación**: `MEDIDOR_VIGILANTES_DESCONECTADOS` (S1 y S2 del ION en cero: los vigilantes de comercial/generador no llegan al medidor) |
| Verde | Operando |

La sede manda los vigilantes como "crítico" y así salen sus correos (no se cambia en la sede). Nodivo
los reclasifica solo para mostrar (`reclasificar` en `apps/web/src/api/centro.ts`). Si la sede tiene
además un medidor caído u otra alarma crítica, sigue en rojo. Al pasar el cursor sobre una sede del
mapa, la ficha lista todas sus alertas abiertas (equipo, área, severidad y desde cuándo).

## Normas, predicción y pestaña Equipos

- **Normas y cumplimiento** (Centro de mando): NTSD Guatemala (valores de referencia, confirmar con
  la resolución vigente de la CNEE), IEEE 519 y EN 50160. Cada indicador se evalúa en promedios de
  10 min y cumple si el 95 % del tiempo está dentro del límite. Usa el edificio `<sede>-directo` si
  existe; los generadores no se evalúan. Resultado en caché 10 min. Hoy solo Escuintla.
- **Predicción** (Centro de mando): perfil por hora y tipo de día (hábil / fin de semana, hora de
  Guatemala) más la tendencia lineal de los promedios diarios; rango ±1.5 desviaciones. La carga se
  muestra en % si el equipo tiene `attributes.capacityKva`. Necesita al menos 2 días de historial.
- **Equipos** (reemplaza las pestañas "Agente Go" y "Configuración"; se ve con el permiso `agente` o
  `config`):
  - *Descubrir y agregar*: pide una búsqueda Modbus al agente (solo agentes con configuración
    remota). Desde el agente 0.5.3 cada ID encontrado viene identificado
    (`modbussource/identify.go`): ION7400 (acepta el bloque 3000×78 y trae su nombre), PM2130
    (rechaza ese bloque, voltaje en 3028; fase C vacía = monofásico) o generador (bloque 4770 con
    batería 18-32 V). "Agregar" escribe un servidor Modbus con el perfil `*-directo` en la
    configuración remota (solo administrador).
  - *Topología en vivo*: una caja por IP; los IDs extra en la misma IP cuelgan del cable RS-485.
  - *Configuración*: conexión directa, "Probar lectura", mapa de registros del perfil y umbrales por
    norma.
  - *Agentes*: las pantallas anteriores (equipos descubiertos y protocolos) sin cambios.

## Alertas en campana (16/11/2026)

- La campana (junto a "En vivo") abre el **Centro de alertas**: activas e historial, filtro por
  severidad, lista + detalle con "Ver equipo" e "Ir a la sede". Reemplaza el banner fijo y el panel de
  alarmas de abajo; queda una franja delgada con los totales.
- En la sede: encabezado con indicadores y su propia campana; pestañas **Equipos / Calidad de energía /
  Eventos**. La ventana del equipo no cambió. El modo sala de control sigue mostrando las alertas.

## Red por fases y sedes nuevas (17/11/2026)

Mockup aprobado: https://claude.ai/artifact/AvVEMWJ1BVjJFoHvqdz5P1 (tablero "Plataforma").

- **Grupos (fases)**: tablas `red_grupos` y `red_sedes` (migración `20261116200000_red_sedes_grupos`).
  Arrancan Telemetría 1, 2 y 3. Las 10 sedes del monitoreo central sin fila en `red_sedes` quedan en
  Telemetría 1. El administrador crea, renombra, colorea, ordena y borra grupos (botón "Grupos" del árbol)
  y cambia la fase de cualquier sede ("Cambiar fase" en la sede).
- **Sedes nuevas** (origen `nodivo`): botón "Nueva sede" del árbol, asistente de 4 pasos: datos y
  plantilla → Agente Go (crea su API key de rol `agent` y arma el `config.yaml` con `remoteConfig: true`,
  o usa uno existente) → descubrir equipos (la misma pantalla de Equipos) → listo. La sede se arma con los
  equipos Modbus de sus agentes (`/pilot/<agente>/devices`) y entra sola al árbol, al mapa, la campana
  (equipo fuera de línea = alerta crítica), el ranking y la sala de control.
- **Mapa**: aro de color por fase y filtro por fase. Clic en una sede despliega sus **ramas** (un punto
  por equipo: ION7400 celeste, PM2130 verde, generador ámbar; rojo si está caído); clic en una rama abre
  ese equipo; doble clic o "Abrir la sede" abre la sede.
- **Ficha del dispositivo**: los campos de la respuesta v1 de Telemetría 1 (`device_id`, `area`,
  `building`, `floor`, `group`, `room`, `fase_energy`, `code_inventory`, `capacity`). Se llena al agregar
  un equipo (Equipos → Descubrir) o después (Equipos → Configuración → "Ficha del dispositivo"). Se guarda
  en los atributos del equipo en la configuración remota del agente (también `code`, `phase`,
  `capacityKva`, que ya usaba la web).
- **JSON v1**: `GET /api/v1/red/sedes/:id/telemetria` (botón "JSON v1" en la sede nueva) devuelve
  `{ devices: [...], lectura }` con el mismo formato de Telemetría 1, ficha y métricas `{ value, unit }`.
- **Agente 0.5.5**: al descubrir lee el modelo que reporta el equipo (registros 50-69). Un equipo que se
  nombra "Power Meter" y no entrega modelo queda **por confirmar** (antes salía como ION7400). La web
  también lo marca así en los resultados viejos. Instalado en `~/agente-go-escuintla-directo` el
  17/11/2026 (respaldo `agente-go.bak-202611170038`). Falta confirmar en sitio en qué registro dan su
  modelo los "Power Meter" de la red 10.0.2.x.

## Pendiente

- "Reconocer alarma" desde Nodivo (hoy las alarmas se cierran solas en la sede al normalizarse).
- Que Nodivo envíe los correos (marca "Recibe los correos de alarmas" ya guardada por usuario).
- Historial de las sedes por EBO: empieza el 10/11/2026 (antes no había).

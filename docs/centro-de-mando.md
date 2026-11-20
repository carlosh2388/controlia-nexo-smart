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

## Asistente Gravix (20/11/2026)

Orbe flotante "G" abajo a la derecha del Centro de mando. Entiende órdenes habladas o escritas en
español, lleva a la pantalla pedida y responde con voz. **Solo lee y navega**: no envía comandos a
ningún equipo ni cambia configuración. Fase 1: no usa IA ni licencias; todo corre en el navegador.

- Código: `apps/web/src/components/asistente/` (`comandos.ts` interpreta la frase, `Gravix.tsx` es el
  panel, la voz y los avisos). En `CentroMando.tsx`, `ejecutarGravix` traduce cada acción a la
  navegación existente; `VentanaEquipo` recibe `tabInicial` para abrir una pestaña concreta.
- Órdenes (con o sin "Gravix" al inicio):
  - "resumen", "¿cómo está la red?", "¿qué necesito hacer?": sedes que responden, medidores en línea,
    críticas, advertencias y sede más afectada; ofrece abrir las alertas ("sí" las abre).
  - "¿cuántas alarmas hay (en Cobán)?", "alarmas de Escuintla" (centro de alertas).
  - "abre Escuintla", "¿cómo está La Gomera?" (abre la sede y dice su estado).
  - "abre el TR 1 de Escuintla en tendencias" (equipo + pestaña: tendencias, calidad, comparativo,
    alarmas, bitácora, información). Sin sede, busca primero en la sede abierta.
  - "mapa" / "volver", "incidentes", "ranking", "normas", "predicción", "alarmas y correos" (solo
    administradores; al resto Gravix le explica que no tiene acceso).
  - "modo sala", "salir del modo sala", "cerrar", "silencio", "silenciar/activar avisos", "ayuda".
  - Consultas que lee en voz alta: "¿qué alarmas hay (en Cobán)?", "¿qué medidores están fuera de
    línea?", "¿qué sedes no responden?".
  - Telemetrías (grupos de la red): "estado por telemetría" / "cómo están las tres telemetrías"
    (una frase por telemetría: sedes, cuántas responden, medidores en línea, críticas y advertencias),
    "cómo está Telemetría 2" (además nombra sus sedes y las que tienen novedades), y las consultas
    anteriores limitadas a una telemetría: "alarmas de Telemetría 1", "¿cuántas alarmas hay en
    Telemetría 3?", "medidores fuera de línea en Telemetría 1", "sedes que no responden en Telemetría 2".
- Voz: elige sola una voz formal en español latino y de tono medio (primero las voces "Natural"
  de Edge), algo pausada. En el panel se puede elegir otra voz y probarla; queda guardada.
- Interruptores (se guardan en el navegador): **Voz de Gravix**, **Avisos con sonido** y **Escucha
  continua** (escucha siempre y solo responde cuando la frase empieza con "Gravix"; decir solo
  "Gravix" lo deja atento 8 s para la siguiente frase).
- Avisos: cuando aparece una alarma **crítica nueva** (no las que ya estaban al abrir la pantalla),
  pitido, aviso hablado y globo con "Ver". Los navegadores no dejan sonar audio ni voz hasta el
  primer clic en la página.
- Limitaciones:
  - El **micrófono solo funciona en HTTPS o en localhost**. Por eso, con HTTPS activo,
    `http://192.168.70.4:5173` **redirige sola** a `https://192.168.70.4:5443` (misma ruta; generado
    por `30-https.sh`; `WEB_HTTP_REDIRECT=0` en el `.env` la desactiva, `WEB_HTTPS_PORT` cambia el
    puerto). Al cambiar de dirección hay que iniciar sesión una vez (la sesión se guarda por
    dirección). Con el micrófono: un clic en el botón, el navegador pide permiso la primera vez,
    escucha la orden y la ejecuta.
  - HTTPS de la web: el contenedor `web` activa el puerto 443 (publicado como 5443) si
    `WEB_HTTPS=1` y existe `config/web-tls/web.crt` + `web.key` (fuera de git). Por ese puerto,
    nginx pasa `/api` y `/ws` a la API (`apps/web/https.conf.tpl`, `apps/web/30-https.sh`), y la web
    usa la misma dirección de la página en vez de `http://...:3010` (`mismoOrigenSiHttps` en
    `apps/web/src/api/client.ts`). En 192.168.70.4 el certificado es autofirmado (825 días):
    ```
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout config/web-tls/web.key \
      -out config/web-tls/web.crt -subj '/CN=192.168.70.4' \
      -addext 'subjectAltName=IP:192.168.70.4,DNS:localhost,IP:127.0.0.1'
    ```
    La primera vez el navegador avisa que la conexión no es privada: "Configuración avanzada" →
    "Continuar a 192.168.70.4". Para quitar el aviso, cada PC (el usuario o TI) descarga el
    certificado público en `https://192.168.70.4:5443/certificado-nodivo.crt`, lo abre → "Instalar
    certificado" → "Equipo local" → "Colocar todos los certificados en el siguiente almacén" →
    "Entidades de certificación raíz de confianza", y reinicia el navegador. La llave privada
    (`web.key`) nunca se publica.
  - El reconocimiento de voz es el de Chrome/Edge y necesita internet (el audio lo procesa el
    servicio del navegador). Firefox no lo trae: queda la caja de texto.
- Base sin IA ni licencias: Gravix funciona con sus reglas, la analítica propia y los datos de la
  pantalla. La IA (Claude) es **opcional** y está apagada mientras el servidor no tenga clave
  (ver "Gravix IA opcional" más abajo).

### Gravix IA con modelo local (Ollama, sin licencia) (20/11/2026) — EN USO

Gravix IA usa el modelo **qwen3.5:4b** del servidor Ollama de la red (`http://192.168.71.201:11434`,
Ollama 0.40.14, con tarjeta gráfica: responde en 2 a 8 s). Sin licencia y sin que los datos salgan de
la red. Si `OLLAMA_URL` tiene valor, tiene prioridad sobre Claude (`ASISTENTE_PROVEEDOR=claude|ollama`
lo fuerza).

- Configuración en el `.env` del servidor (192.168.70.4 ya la tiene; respaldo del `.env` anterior en
  `~/backups/ollama-202611201726/`):
  ```
  OLLAMA_URL=http://192.168.71.201:11434
  OLLAMA_MODELO=qwen3.5:4b
  ```
  Luego `docker compose up -d --no-deps api`. Para apagarla, vaciar `OLLAMA_URL` y recrear la API.
- Cómo responde (`preguntarLocal` en `asistente.service.ts`): el modelo es pequeño, así que **no usa
  herramientas**. La API arma un resumen verificado de unos 15 000 caracteres con la credencial de quien
  pregunta (`contextoCompacto`): puntos clave ya calculados (sedes de más a menos riesgo, lo más
  importante de las 4 peores, equipos con voltaje anómalo), estado actual por sede y por equipo (con su
  riesgo), últimas 24 h, los 15 riesgos principales y las métricas diarias de 14 días. El modelo responde
  solo con eso (`think: false`, temperatura 0.1, `num_ctx` 16384), con un glosario (voltios, vigilantes
  desconectados) para evitar errores. No navega: abrir pantallas lo hace Gravix en el navegador.
- Probado con datos reales: voltaje anómalo de Amatitlán (causa y qué revisar), sede con más riesgo,
  significado de vigilantes desconectados, comparación de consumo entre sedes, demanda máxima de un día.
- Límite: las sedes nuevas leídas por Agentes Go no van en el resumen; el detalle por hora no está
  (el modelo remite a Tendencias del equipo). Es un modelo de 4B: para hipótesis de causa, las
  presenta como hipótesis.

### Gravix IA opcional (Claude, de pago por uso) (20/11/2026)

Se restauró la versión con la API de Claude (antes 4207efb, revertida en 6b80e5a), ahora como
**complemento opcional**: no cambia nada mientras el servidor no tenga clave.

- Encender: agregar `ANTHROPIC_API_KEY=sk-ant-...` al `.env` de `~/siasa-iot-platform` (lo hace el
  responsable; la clave nunca va en git, en el chat ni en la web) y `docker compose up -d --no-deps api`.
  Usar una clave solo para Gravix, creada en la consola de Anthropic, con límite de gasto mensual.
- Apagar para todos: borrar la clave del `.env` y recrear la API. Apagar para un usuario: en el panel,
  interruptor **"Usar IA"** (se guarda en su navegador); desactivado, Gravix queda como sin IA.
- Qué va a la IA: solo lo que la analítica propia no responde (frases que no entiende, o que piden
  "por qué", comparar, periodos como "ayer" / "semana pasada", promedios o máximos). Abrir pantallas,
  pestañas, sedes, equipos, alarmas, consumo, riesgos y el detalle de un riesgo se siguen
  resolviendo en el navegador, sin costo.
- API: `apps/api/src/asistente/` (solo servidor central). `GET /asistente/estado` (`{ disponible }`)
  y `POST /asistente/preguntar`. Claude (`claude-opus-5-5`, esfuerzo `medium`, respaldo automático del
  servidor de Anthropic si rechaza) con herramientas de **solo lectura** que llaman a esta misma API
  **con el token del usuario** (ve solo sus sedes): `red_resumen`, `analitica_riesgos`,
  `centro_eventos`, `centro_historial_medidor`, `piloto_*`, `normas`, `eventos_sede` y `navegar`
  (pantallas del centro y pestañas de la aplicación). Máximo 8 vueltas por pregunta.
- Qué sale del servidor: la pregunta y los datos de energía que las herramientas consultan (sin datos
  de pacientes, contraseñas ni claves). Confirmar con el IGSS que se permite antes de encenderla.

### Conversación (20/11/2026)

- Bienvenida: al entrar al Centro de mando (una vez por sesión del navegador) aparece un globo
  "Buenos días, <usuario>. Soy Gravix… ¿Le ayudo con algo?". Al abrir el panel saluda en voz alta
  según la hora, resume la red en una frase y pregunta "¿Qué desea hacer hoy?".
- Menú (atajos): Revisar alarmas, Estado por telemetría, Consultar una sede, Consumo de energía,
  Generadores en marcha, Equipos fuera de línea. "Menú" / "¿qué puedo hacer?" lo repite.
- Pide el dato que falta: "consultar una sede" → "¿Qué sede desea consultar?" (atajos con las sedes,
  primero las que tienen novedades); "ver una telemetría" → "¿Qué telemetría?" (basta "la 2").
- Recuerda el tema: después de una sede o telemetría, "¿y sus alarmas?", "y el consumo", "esa sede"
  se refieren a ella. Los atajos cambian según el tema (alarmas, consumo, equipos fuera de línea,
  generadores de esa sede; o de esa telemetría).
- Consultas nuevas con las lecturas en pantalla:
  - Consumo: "¿cuánto consume Escuintla?", "consumo de Telemetría 2", "consumo de energía" (red).
    Es la **potencia de este momento** (kW): suma de los analizadores ION7400 de la sede (o de los
    PM2130 si no tiene ION), más lo que entregan sus generadores; para la red o una telemetría, el
    total y las 3 sedes de mayor consumo. El consumo por horas se ve en Tendencias del equipo.
  - Generadores: "generadores en marcha", "generadores de Escuintla": cuáles están en marcha (estado
    "generador en marcha" o más de 0.5 kW) y qué sedes están alimentadas por generador.
  - "Comparar telemetrías" agrega los kW actuales de cada una.
- Cortesías: "gracias" → "¿Desea algo más?"; "eso es todo" / "hasta luego" se despide y cierra el panel.

### Analítica predictiva, todas las pestañas y bienvenida automática (20/11/2026)

- **En toda la aplicación**: Gravix vive en el marco (`GravixGlobal` en `routes/Devices.tsx`), no solo
  en el Centro de mando. Lleva a cualquier pestaña que el perfil pueda ver: "vista operativa",
  "vista del edificio", "gestión inteligente", "abre la pestaña de sedes", "ir a equipos", "piloto
  Gravix", "usuarios y permisos", "centro de mando". El Centro de mando le publica sus datos y su
  navegación en `store/gravix.store.ts`; si se pide algo del centro desde otra pestaña ("abre
  Escuintla"), Gravix cambia de pestaña y lo ejecuta al llegar. No aparece en el Gravix de sede.
- **Bienvenida automática**: al entrar (una vez por sesión del navegador) se abre el panel y saluda
  según la hora de la computadora (buenos días 5:00-11:59, buenas tardes 12:00-18:59, buenas noches
  19:00-4:59), con el nombre del usuario, el estado de la red, el riesgo más alto que encontró la
  analítica y la última sede que consultó; pregunta "¿Qué desea hacer hoy?". El navegador no deja
  hablar antes del primer clic: la voz suena en el primer clic o tecla.
- **Analítica predictiva** (sin servicios externos): `GET /centro/analitica`
  (`apps/api/src/centro/analitica.service.ts`), calculada con `centro_lecturas` (una foto por minuto
  de cada medidor) de los últimos 14 días; se recalcula cada 10 min (consulta de ~2 s).
  - Desconexiones: caídas (fuera de línea / voltaje en cero) por equipo, tiempo medio entre fallas y
    probabilidad de otra caída en 7 días (Poisson con la tasa del periodo, hasta 1.5 veces si en los
    últimos 3 días falló más seguido). Con menos de 15 min sin datos en total son "cortes breves" y
    el riesgo no pasa de medio.
  - Voltaje: desviación contra el nominal deducido (120/127/208/220/230/240/277/480 V), tendencia
    diaria y días estimados para salir de ±5 %; días con caídas por debajo del 90 %. Un medidor a
    más de 15 % de cualquier nominal se compara con el nominal de su sede (el más común entre sus
    medidores sanos) y, con 10 % o más de diferencia, es **"Voltaje anómalo"** (riesgo alto: fase
    caída, fusible de medición abierto o TP mal configurado). El 20/11/2026 marcó PM2130-1 (88 V) y
    PM2130-2 (97 V) de Amatitlán y PM2130-1 y PM2130-7 de Escuintla (83 V contra 127 V).
  - Carga: demanda máxima diaria, crecimiento entre la primera y la segunda mitad del periodo y pico
    proyectado a 7 días (riesgo alto solo con 8 días o más de datos).
  - Comunicación con la sede (huecos de más de 5 min), lecturas congeladas y arranques de generador.
  - `sedes24h`: por sede, lo de las últimas 24 h (desconexiones, cortes de comunicación, caídas de
    tensión, alarmas críticas y advertencias, cambio de consumo contra las 24 h anteriores) y su peor
    riesgo; "crítico" solo por lo ocurrido en esas 24 h. Los vigilantes desconectados cuentan como
    advertencia, igual que en la pantalla.
  - Es una estimación estadística con pocos días de historia: orienta el mantenimiento, no lo reemplaza.
  - `metricas`: por sede y por día (14 días) demanda promedio y máxima (suma de sus ION7400, o de sus
    medidores si no tiene ION), voltaje promedio y minutos sin datos.
- **Pestaña "Analítica"** del Centro de mando (`components/centro/Analitica.tsx`), junto a Predicción:
  filtro por telemetría; indicadores (equipos analizados, riesgos altos/medios/bajos, sedes con
  novedades en 24 h); **métricas por sede de los últimos 14 días** (demanda promedio, demanda máxima,
  voltaje promedio, minutos sin datos) en gráficas pequeñas, una por sede con la misma escala de
  tiempo, valor de hoy y cambio contra el promedio, o en tabla; **últimas 24 horas por sede**; y
  **riesgos de los próximos 7 días** con filtros de nivel y tipo, detalle y "Ver equipo". Gravix la
  abre con "abre la analítica", "muéstrame las métricas" o "indicadores".
- En Gravix: "¿qué puede fallar?", "análisis de Telemetría 1", "¿qué puede fallar en Gineco?",
  "¿cómo están las sedes y sus tendencias en las últimas 24 horas?", "¿qué pasó hoy?"; muestra
  tarjetas de riesgo (nivel, probabilidad, mini gráfica de los últimos días, "¿Por qué?" y "Ver
  equipo") y "explícame el segundo" da el detalle y la recomendación.
- Micrófono: si la página se abrió por `http`, Gravix lo dice y ofrece el botón "Abrir la dirección
  segura" (`https://<servidor>:5443`); antes de escuchar pide el permiso del micrófono y explica cada
  error (bloqueado, sin micrófono, ocupado por otro programa, sin internet para el reconocimiento).
- La web se sirve con `Cache-Control: no-cache` en la página y caché larga solo en `/assets/`
  (nombres versionados): cada publicación llega sin borrar la caché del navegador.

## Pendiente

- "Reconocer alarma" desde Nodivo (hoy las alarmas se cierran solas en la sede al normalizarse).
- Que Nodivo envíe los correos (marca "Recibe los correos de alarmas" ya guardada por usuario).
- Historial de las sedes por EBO: empieza el 10/11/2026 (antes no había).

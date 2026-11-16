# Servidor MCP de SIASA IoT

Permite que Claude (Claude Code, Claude Desktop u otro cliente MCP) **consulte** la API de SIASA:
agentes, dispositivos, eventos de sede, centro de mando y series de tiempo del piloto Gravix.

**Es de solo lectura.** Solo llama endpoints `GET`: no crea, cambia ni borra nada, y no manda comandos a los equipos.

```
Claude ──(MCP, stdio)──► apps/mcp/server.js ──(HTTP + x-api-key)──► API SIASA /api/v1
```

## Herramientas

| Herramienta | Endpoint | Para qué |
| --- | --- | --- |
| `agentes` | `/agents` + `/devices/agent-status` | Sedes, versión de configuración y último sync de cada Agente Go |
| `dispositivos` | `/devices` | Buscar dispositivos por sede, protocolo o nombre (resumido) |
| `dispositivo` | `/devices/:id` | Detalle, estado y últimas lecturas |
| `historial_dispositivo` | `/devices/:id/history` | Historial en un rango: 1h, 24h, today, 7d, 15d o 30d |
| `eventos_sede` | `/sites/:buildingKey/events` | Eventos del Agente Go: planta, puertas, alarmas... |
| `centro_vista` | `/centro/vista` | Vista general del centro de mando |
| `centro_eventos` | `/centro/sedes/:sede/eventos` | Eventos de un dispositivo del centro de mando |
| `centro_historial_medidor` | `/centro/sedes/:sede/medidores/:medidor/historial` | kW, V y A de un medidor |
| `piloto_equipos` | `/pilot/:buildingKey/devices` | Equipos de energía de una sede |
| `piloto_serie` | `/pilot/devices/:id/series` | Serie de tiempo de una métrica (máx. 7 días) |
| `piloto_comparar` | `/pilot/devices/:id/compare` | Lectura directa contra EBO |
| `piloto_huecos` | `/pilot/devices/:id/gaps` | Periodos sin datos |
| `piloto_cumplimiento` | `/pilot/:buildingKey/cumplimiento` | % dentro de norma (NTSD, IEEE 519, EN 50160) |
| `piloto_pronostico` | `/pilot/devices/:id/pronostico` | Pronóstico de una métrica |
| `piloto_espectro` | `/pilot/devices/:id/espectro` | Espectro de armónicos |
| `piloto_umbrales` | `/pilot/devices/:id/umbrales` | Límites configurados para un equipo |
| `normas` | `/pilot/normas` | Catálogo de normas y límites |

Cada respuesta se recorta a 60 000 caracteres para no llenar el contexto de Claude. Si se recorta, pida un rango más corto.

## Instalación

### 1. Instalar dependencias (una vez)

```powershell
cd apps/mcp
npm install
```

### 2. Crear una API key de solo lectura (rol `viewer`)

La web todavía no tiene pantalla para crear API keys, así que se crea por la API con un usuario **admin**:

```powershell
$api = "http://192.168.70.4:3010/api/v1"
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType "application/json" `
  -Body (@{ username = "SU_USUARIO_ADMIN"; password = "SU_CLAVE" } | ConvertTo-Json)
$key = Invoke-RestMethod -Method Post -Uri "$api/api-keys" -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $($login.accessToken)" } `
  -Body (@{ name = "mcp-claude"; role = "viewer" } | ConvertTo-Json)
$key.key   # la clave completa se muestra UNA sola vez: guárdela
```

Para revocarla después, use `GET $api/api-keys` para ver su `id` y luego `DELETE $api/api-keys/<id>`.

### 3. Configurar la conexión

Cree el archivo `apps/mcp/.env`. Ya está en `.gitignore`, así que no se sube a git:

```
SIASA_API_URL=http://192.168.70.4:3010/api/v1
SIASA_API_KEY=siasa_...la clave del paso 2...
SIASA_TIMEOUT_MS=20000
```

`SIASA_API_URL` es `http://localhost:3010/api/v1` si no se indica. También se pueden pasar estos valores como variables de entorno, que tienen prioridad sobre el `.env`.

### 4. Probar la conexión

```powershell
npm run check
# OK: API http://192.168.70.4:3010/api/v1 responde; N agente(s).
```

### 5. Usarlo desde Claude Code

El archivo [`.mcp.json`](../../.mcp.json) de la raíz del repositorio ya registra el servidor como `siasa-iot`.
Al abrir Claude Code en el proyecto, este pide aprobarlo la primera vez. Para ver el estado, escriba `/mcp`.

Algunas preguntas que puede hacer:

- "¿Qué agentes no han sincronizado en la última hora?"
- "Eventos críticos de igss-escuintla de esta semana"
- "Muéstrame el voltaje L-N del tablero principal de Escuintla en las últimas 6 horas"
- "¿Qué porcentaje cumple la NTSD en Escuintla en los últimos 7 días?"

### Claude Desktop (opcional)

En `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "siasa-iot": {
      "command": "node",
      "args": ["E:\\ruta\\al\\repo\\apps\\mcp\\server.js"]
    }
  }
}
```

## Agregar una herramienta

En `server.js`, agregue una llamada a `reg(nombre, título, descripción, esquemaZod, handler)` que use `api(ruta, query)`.
Mantenga el servidor en **solo lectura**. Si algún día se agrega una acción que escriba, por ejemplo cambiar umbrales,
hágalo con una API key aparte de rol `operator` y márquela con `destructiveHint`.

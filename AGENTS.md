# Guia para agentes de codigo (Codex, Claude Code)

Nodivo-SIASA: plataforma IoT (NestJS + Prisma + PostgreSQL en `apps/api`, React + Vite en `apps/web`,
recolector por sede en Go en `apps/Agente_Go`, puente BACnet en `apps/bacnet-bridge`).

## Donde esta cada cosa

- Arquitectura general: `docs/architecture.md`; API: `docs/api.md`; base de datos: `docs/database.md`.
- Agente Go (recolector): manual de operacion `docs/agentes-go-manual.md`; diseño e historial `docs/agente-go.md`.
- Sedes IGSS (Modbus EBO, LoRaWAN/ChirpStack, eventos, pestaña Sedes): `docs/sedes-igss.md`.
- Piloto Gravix (TimescaleDB, historial `readings`, huecos, pestaña Piloto Gravix, despliegue): `docs/piloto-gravix.md`.
- LoRaWAN directo gateway → Agente Go (sin ChirpStack): `docs/lorawan-directo.md`.
- Centro de mando (10 sedes, alarmas/correos, Excel) y usuarios con permisos por perfil: `docs/centro-de-mando.md`.
- Formulas 4-20 mA de los WISE (multiplier/offset por canal en ChirpStack): `docs/formulas-4-20ma.md`.
- Procedimientos paso a paso (`docs/procedimientos/`). Tambien se invocan como skills `agente-go`, `sede-igss`
  y `eventos-sede`: `.agents/skills/` (Codex) y `.claude/skills/` (Claude Code) solo apuntan a estos documentos:
  - `docs/procedimientos/agente-go.md` - compilar, probar, configurar, ejecutar, desplegar el agente.
  - `docs/procedimientos/sede-igss.md` - integrar una sede IGSS (escaneo Modbus de solo lectura, mapeo, config).
  - `docs/procedimientos/eventos-sede.md` - catalogo de eventos, umbrales, agregar reglas, consultar historial.

## Comandos

```
npm run build:api      # nest build (despues de cambiar schema.prisma: cd apps/api && npx prisma generate)
npm run build:web      # tsc -b && vite build
cd apps/Agente_Go && go vet ./... && go test ./...
docker compose up -d --build api web   # stack local: web :5173, API :3010/api/v1
```

## Reglas del proyecto

- Equipos reales de produccion (hospitales IGSS, edificio TEC 3): **no enviar comandos ni escribir
  registros** sin confirmacion explicita por equipo. Lecturas Modbus solo con funciones 03/04.
- Protocolos no documentados: verificar contra datos reales o una implementacion de referencia, no de memoria.
- No subir secretos: `config.yaml` del agente y `.env` estan en `.gitignore`.
- Respuestas y documentacion en español.

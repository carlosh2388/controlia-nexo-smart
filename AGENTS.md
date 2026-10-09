# Guia para agentes de codigo (Codex, Claude Code)

Nodivo-SIASA: plataforma IoT (NestJS + Prisma + PostgreSQL en `apps/api`, React + Vite en `apps/web`,
recolector por sede en Go en `apps/Agente_Go`, puente BACnet en `apps/bacnet-bridge`).

## Donde esta cada cosa

- Arquitectura general: `docs/architecture.md`; API: `docs/api.md`; base de datos: `docs/database.md`.
- Agente Go (recolector): `docs/agente-go.md`.
- Sedes IGSS (Modbus EBO, LoRaWAN/ChirpStack, eventos, pestaña Sedes): `docs/sedes-igss.md`.
- LoRaWAN directo gateway → Agente Go (sin ChirpStack): `docs/lorawan-directo.md`.
- Procedimientos paso a paso (skills de Claude Code, legibles por cualquier agente):
  - `.claude/skills/agente-go/SKILL.md` - compilar, probar, configurar, ejecutar, desplegar el agente.
  - `.claude/skills/sede-igss/SKILL.md` - integrar una sede IGSS (escaneo Modbus de solo lectura, mapeo, config).
  - `.claude/skills/eventos-sede/SKILL.md` - catalogo de eventos, umbrales, agregar reglas, consultar historial.

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

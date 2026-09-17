# ControlIA Nexo Smart

ControlIA Nexo Smart es una plataforma IoT para controlar, visualizar y automatizar dispositivos de un edificio. El proyecto esta organizado como monorepo Node.js con una API NestJS, una aplicacion web React/Vite y servicios Docker para Postgres, Redis y Mosquitto.

## Contenido

- [Arquitectura](./architecture.md)
- [Despliegue](./deployment.md)
- [API](./api.md)
- [Base de Datos](./database.md)
- [Frontend](./frontend.md)
- [Automatizaciones](./automations.md)
- [Operaciones](./operations.md)

## Resumen Tecnico

| Capa | Tecnologia | Rol |
| --- | --- | --- |
| Web | React 18, Vite, Tailwind, React Query, Zustand | Panel de control, vista de edificio, automatizaciones |
| API | NestJS 10, Fastify, Prisma, JWT | Autenticacion, dispositivos, areas, reglas, comandos |
| Tiempo real | WebSocket `ws` | Notifica cambios de estado al frontend |
| Cola | BullMQ + Redis | Despacho asincrono de comandos |
| Datos | PostgreSQL 16 | Usuarios, dispositivos, estados, reglas, areas |
| Broker | Mosquitto MQTT | Mensajeria de dispositivos MQTT/Zigbee2MQTT |
| Runtime | Docker Compose | Ejecucion local/servidor |

## URLs por Defecto

- Web: `http://localhost:5173`
- API interna: `http://localhost:3010/api/v1`
- WebSocket: `ws://localhost:3010/ws`
- Postgres: `localhost:5432`
- Redis: `localhost:6379`
- MQTT: `localhost:1883`

En el servidor SIASA usado durante el despliegue:

- Web: `http://192.168.70.4:5173`
- API: `http://192.168.70.4:3010/api/v1`


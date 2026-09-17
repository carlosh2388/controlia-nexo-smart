# ControlIA Nexo Smart

Plataforma IoT para monitoreo, control y automatizacion de dispositivos en edificio, con API NestJS, frontend React/Vite y runtime Docker.

## Inicio Rapido

```bash
npm install
npm run build:api
npm run build:web
docker-compose up -d --build
```

URLs por defecto:

- Web: `http://localhost:5173`
- API: `http://localhost:3010/api/v1`
- WebSocket: `ws://localhost:3010/ws`

## Documentacion

La documentacion completa esta en [`docs/`](./docs/README.md):

- [Arquitectura](./docs/architecture.md)
- [Despliegue](./docs/deployment.md)
- [API](./docs/api.md)
- [Base de Datos](./docs/database.md)
- [Frontend](./docs/frontend.md)
- [Automatizaciones](./docs/automations.md)
- [Operaciones](./docs/operations.md)


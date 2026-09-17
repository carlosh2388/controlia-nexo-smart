# Operaciones

## Ver Estado del Stack

```bash
ssh api@192.168.70.4
cd ~/siasa-iot-platform
docker-compose ps
```

## Ver Consumo de Recursos

```bash
docker stats --no-stream siasa-iot-platform_api_1 siasa-iot-platform_web_1 siasa-iot-platform_postgres_1 siasa-iot-platform_redis_1 siasa-iot-platform_mosquitto_1
```

Resumen CPU/RAM:

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" siasa-iot-platform_api_1 siasa-iot-platform_web_1 siasa-iot-platform_postgres_1 siasa-iot-platform_redis_1 siasa-iot-platform_mosquitto_1
```

## Logs

```bash
docker-compose logs --tail=100 api
docker-compose logs --tail=100 web
docker-compose logs --tail=100 mosquitto
```

## Reiniciar Servicios

```bash
docker-compose restart api
docker-compose restart web
docker-compose restart
```

## Reconstruir

```bash
docker-compose up -d --build
```

## Validaciones Rapidas

```bash
curl -I http://127.0.0.1:5173/
curl -s -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' \
  http://127.0.0.1:3010/api/v1/auth/login
```

## Backup de Datos

```bash
docker exec siasa-iot-platform_postgres_1 pg_dump -U siasa -d siasa_iot > backup.sql
```

## Restore de Datos

```bash
cat backup.sql | docker exec -i siasa-iot-platform_postgres_1 psql -U siasa -d siasa_iot
```


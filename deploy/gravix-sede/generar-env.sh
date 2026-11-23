#!/bin/sh
# Genera el .env de una sede con claves nuevas. Uso:
#   ./generar-env.sh <codigo-sede> "<Nombre de la sede>" [buildingKey del agente]
# No sobrescribe un .env existente. Las claves no se muestran: quedan solo en .env (permiso 600).
set -eu
cd "$(dirname "$0")"
[ $# -ge 2 ] || { echo "Uso: $0 <codigo-sede> \"<Nombre>\" [buildingKey]"; exit 1; }
[ -e .env ] && { echo ".env ya existe; no se toca."; exit 1; }

clave() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40; }

umask 077
cat > .env <<EOF
# Gravix de sede: ${2}. Generado el $(date -Iseconds). No subir a git.
GRAVIX_VERSION=0.1.0
SEDE_CODIGO=${1}
SEDE_NOMBRE=${2}
AGENT_BUILDING_KEY=${3:-$1}
API_PORT=3010
WEB_PORT=5173
DB_PASSWORD=$(clave)
JWT_ACCESS_SECRET=$(clave)
JWT_REFRESH_SECRET=$(clave)
ADMIN_PASSWORD=$(clave | cut -c1-16)
AGENT_API_KEY=siasa_$(clave)
CENTRO_API_KEY=siasa_$(clave)
AGENT_SYNC_SECONDS=30
AGENT_EVENTS=false
# Alarmas y correos (mismas reglas y variables que api-SIASA; valores de Escuintla).
# ALERTAS_CORREO_ACTIVO=false = modo paralelo: Gravix detecta y prepara los correos, pero NO los envia
# (los sigue enviando api-SIASA). Para que Gravix envie: true + SMTP_* + ALERTAS_CORREO_PARA.
ALARMAS_ACTIVAS=true
ALARMAS_AGENTES=${3:-$1}
ALERTAS_SEDE=${2}
SEDE_PREFIJO=
ALERTAS_ZONA_HORARIA=America/Guatemala
ALERTA_CONGELADO_MIN=5
ALERTA_SIN_CAMBIO_MIN=15
ALERTA_FUERA_DE_LINEA_MIN=3
ALERTA_OFFLINE_SIN_CAMBIO_MIN=5
ALERTA_EN_CERO_MIN=3
ALERTA_TRANSFERENCIA_CONFIRMACION_S=60
ALERTA_RECORDATORIO_HORAS=0
ALERTA_RESUMEN_DIARIO_HORA=07:00
ALERTA_RESUMEN_DIARIO_CORREO=false
MEDIDORES_GENERADOR=
EVENTOS_RETENCION_MESES=12
ALERTAS_CORREO_ACTIVO=false
SMTP_HOST=
SMTP_PORT=587
SMTP_SEGURO=false
SMTP_USUARIO=
SMTP_CLAVE=
ALERTAS_CORREO_DE=
ALERTAS_CORREO_PARA=
ALERTAS_CORREO_CC=
# Dias de detalle que guarda la sede (TimescaleDB e InfluxDB). Lo anterior queda en el InfluxDB central.
SEDE_RETENCION_DIAS=60
# InfluxDB propio de la sede (copia de las lecturas). Web: http://<IP>:INFLUX_PORT, usuario admin.
INFLUX_PORT=8086
INFLUX_URL=http://influxdb:8086
INFLUX_ORG=igss
INFLUX_BUCKET=telemetry
INFLUX_RETENTION=0
INFLUX_ADMIN_PASSWORD=$(clave | cut -c1-16)
INFLUX_TOKEN=$(clave)$(clave)
# Grupo del socket de Docker (lo usa Telegraf para medir el consumo de los contenedores).
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 999)
EOF
echo ".env creado para ${1}. Web de Gravix e InfluxDB: usuario admin (claves en ADMIN_PASSWORD e INFLUX_ADMIN_PASSWORD del .env)."

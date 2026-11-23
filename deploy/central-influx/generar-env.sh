#!/bin/sh
# Genera el .env del InfluxDB central con claves nuevas. No sobrescribe uno existente.
set -eu
cd "$(dirname "$0")"
[ -e .env ] && { echo ".env ya existe; no se toca."; exit 1; }
clave() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40; }
umask 077
cat > .env <<EOF
# InfluxDB central (replica de todas las sedes). Generado el $(date -Iseconds). No subir a git.
CENTRAL_INFLUX_PORT=8086
CENTRAL_INFLUX_ORG=igss
CENTRAL_INFLUX_ADMIN_PASSWORD=$(clave | cut -c1-16)
CENTRAL_INFLUX_TOKEN=$(clave)$(clave)
# Detalle por sede (1 ano) y resumen de 15 min de todas las sedes (5 anos).
CENTRAL_DETALLE_RETENCION=8760h
CENTRAL_RESUMEN_RETENCION=43800h
EOF
echo ".env creado. Web: http://<IP del central>:8086, usuario admin (clave en CENTRAL_INFLUX_ADMIN_PASSWORD)."

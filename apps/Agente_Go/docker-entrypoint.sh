#!/bin/sh
# Arma el config.yaml del agente desde las variables del .env de la sede.
#  - Sin AGENT_CONFIG_BASE: solo lo basico; los protocolos y equipos vienen de la configuracion remota
#    (Equipos en la web) y el agente guarda su copia en /data/remote-config.json.
#  - Con AGENT_CONFIG_BASE=/config/<archivo>.yaml: se usa ese archivo completo (protocolos, umbrales de
#    eventos...), cambiando __BUILDING_KEY__, __API_URL__ y __API_KEY__ por los valores del .env. Sirve
#    para traer un agente que ya existia; la primera vez sube sus protocolos como config remota v1.
set -eu
: "${AGENT_BUILDING_KEY:?falta AGENT_BUILDING_KEY}"
: "${AGENT_API_KEY:?falta AGENT_API_KEY}"
URL="${AGENT_API_URL:-http://gravix:3000/api/v1}"

if [ -n "${AGENT_CONFIG_BASE:-}" ] && [ -f "$AGENT_CONFIG_BASE" ]; then
  sed -e "s|__BUILDING_KEY__|${AGENT_BUILDING_KEY}|g" -e "s|__API_URL__|${URL}|g" -e "s|__API_KEY__|${AGENT_API_KEY}|g" \
    "$AGENT_CONFIG_BASE" > /data/config.yaml
else
  cat > /data/config.yaml <<EOF
buildingKey: "${AGENT_BUILDING_KEY}"
api:
  baseUrl: "${URL}"
  apiKey: "${AGENT_API_KEY}"
syncIntervalSeconds: ${AGENT_SYNC_SECONDS:-30}
remoteConfig: true
dataDir: "/data"
events:
  enabled: ${AGENT_EVENTS:-false}
EOF
fi
chmod 600 /data/config.yaml

exec /usr/local/bin/agente-go -config /data/config.yaml

#!/bin/sh
# Arma el config.yaml del agente desde las variables del .env de la sede. Solo lleva lo basico:
# los protocolos y equipos vienen de la configuracion remota (Equipos en la web) y el agente
# guarda su copia en /data/remote-config.json.
set -eu
: "${AGENT_BUILDING_KEY:?falta AGENT_BUILDING_KEY}"
: "${AGENT_API_KEY:?falta AGENT_API_KEY}"

cat > /data/config.yaml <<EOF
buildingKey: "${AGENT_BUILDING_KEY}"
api:
  baseUrl: "${AGENT_API_URL:-http://gravix:3000/api/v1}"
  apiKey: "${AGENT_API_KEY}"
syncIntervalSeconds: ${AGENT_SYNC_SECONDS:-30}
remoteConfig: true
dataDir: "/data"
events:
  enabled: ${AGENT_EVENTS:-false}
EOF
chmod 600 /data/config.yaml

exec /usr/local/bin/agente-go -config /data/config.yaml

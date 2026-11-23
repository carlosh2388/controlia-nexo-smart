#!/bin/sh
# Replica del InfluxDB de la sede al InfluxDB CENTRAL (lecturas de energia, alarmas y correos).
# Uso (en la VM de la sede, junto al docker-compose.yml):  ./replica-central.sh <archivo .env de la sede>
# El archivo lo genera el central con alta-sede.sh: CENTRAL_URL, CENTRAL_ORG_ID, CENTRAL_BUCKET, CENTRAL_TOKEN.
#  1. Registra el central como "remote" y crea la replica nativa de InfluxDB con cola en disco
#     (REPLICA_COLA_BYTES, 5 GB por defecto: mas de 2 meses sin enlace). Si se cae el enlace, lo
#     pendiente queda en la cola y al volver se envia en orden, aunque la VM se reinicie.
#  2. Copia al central el historial que ya existia en la sede (la replica solo lleva lo nuevo).
set -eu
cd "$(dirname "$0")"
[ $# -eq 1 ] && [ -r "$1" ] || { echo "Uso: $0 <archivo .env de la sede generado por alta-sede.sh>"; exit 1; }
. "$1"
leer() { grep "^$1=" .env | cut -d= -f2-; }
INFLUX_ORG=$(leer INFLUX_ORG); INFLUX_TOKEN=$(leer INFLUX_TOKEN); INFLUX_BUCKET=$(leer INFLUX_BUCKET)
P="${COMPOSE_PROJECT:-gravix-sede}"
I="docker compose -p $P exec -T influxdb influx"
A="-o $INFLUX_ORG -t $INFLUX_TOKEN"
COLA=${REPLICA_COLA_BYTES:-5368709120}
LBID=$($I bucket list $A -n "$INFLUX_BUCKET" --hide-headers | awk '{print $1}')
RID=$($I remote list $A --name central --hide-headers 2>/dev/null | awk '{print $1}')
[ -n "$RID" ] || RID=$($I remote create $A --name central --remote-url "$CENTRAL_URL" --remote-api-token "$CENTRAL_TOKEN" --remote-org-id "$CENTRAL_ORG_ID" --hide-headers | awk '{print $1}')
INICIO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
$I replication list $A --name "central-$CENTRAL_BUCKET" --hide-headers 2>/dev/null | grep -q . || \
  $I replication create $A --name "central-$CENTRAL_BUCKET" --remote-id "$RID" --local-bucket-id "$LBID" --remote-bucket "$CENTRAL_BUCKET" --max-queue-bytes "$COLA" >/dev/null
echo "Replica activa desde $INICIO (cola en disco de $((COLA / 1048576)) MB)."
# Historial anterior: se copia por dias con Flux (from local -> to remoto). Repetirlo no duplica nada.
DESDE=$($I query $A --raw "from(bucket: \"$INFLUX_BUCKET\") |> range(start: 0) |> keep(columns: [\"_time\"]) |> group() |> min(column: \"_time\")" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T' | head -1 | tr -d T)
[ -n "$DESDE" ] || { echo "La sede no tiene historial anterior."; exit 0; }
D=$DESDE
while [ "$(date -d "$D" +%s)" -le "$(date -d "${INICIO%T*}" +%s)" ]; do
  S=$(date -u -d "$D" +%Y-%m-%dT00:00:00Z); E=$(date -u -d "$D +1 day" +%Y-%m-%dT00:00:00Z)
  [ "$(date -d "$E" +%s)" -gt "$(date -d "$INICIO" +%s)" ] && E=$INICIO
  $I query $A --raw "from(bucket: \"$INFLUX_BUCKET\") |> range(start: $S, stop: $E) |> to(host: \"$CENTRAL_URL\", orgID: \"$CENTRAL_ORG_ID\", token: \"$CENTRAL_TOKEN\", bucket: \"$CENTRAL_BUCKET\") |> count() |> group() |> sum()" | grep -oE ',[0-9]+\s*$' | tr -d ', \r' | sed "s/^/  $S: /"
  D=$(date -d "$D +1 day" +%Y-%m-%d)
done
echo "Historial copiado hasta $INICIO."

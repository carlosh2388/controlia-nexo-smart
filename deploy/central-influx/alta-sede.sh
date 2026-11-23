#!/bin/sh
# Alta de una sede en el InfluxDB central. Uso:  ./alta-sede.sh <codigo-sede>
#  1. Crea el bucket <codigo-sede> (detalle, CENTRAL_DETALLE_RETENCION, 1 ano).
#  2. Crea una clave que SOLO puede escribir y leer ese bucket (la usa la replica de la sede).
#  3. Crea la tarea "Resumen 15 min <sede>" que llena el bucket "resumen" (5 anos).
# Deja en ./sedes/<codigo>.env la URL, org ID, clave y bucket para replica-central.sh (permiso 600).
set -eu
cd "$(dirname "$0")"
[ $# -eq 1 ] || { echo "Uso: $0 <codigo-sede>"; exit 1; }
S=$1
. ./.env
P="docker compose -p central-influx"
I="$P exec -T influxdb-central influx"
A="-o $CENTRAL_INFLUX_ORG -t $CENTRAL_INFLUX_TOKEN"
ORGID=$($I org list -t "$CENTRAL_INFLUX_TOKEN" -n "$CENTRAL_INFLUX_ORG" --hide-headers | awk '{print $1}')
[ -n "$ORGID" ] || { echo "No se encontro la organizacion $CENTRAL_INFLUX_ORG"; exit 1; }
$I bucket list $A -n "$S" >/dev/null 2>&1 || $I bucket create $A -n "$S" -r "$CENTRAL_DETALLE_RETENCION" -d "Replica de la sede $S (lecturas, alarmas, correos)" >/dev/null
BID=$($I bucket list $A -n "$S" --hide-headers | awk '{print $1}')
# Si la sede ya tenia clave (alta repetida), se reemplaza: una sola clave activa por sede.
for v in $($I auth list $A --hide-headers | grep "Replica de la sede $S	" | awk '{print $1}'); do
  $I auth delete $A --id "$v" >/dev/null && echo "Clave anterior de $S revocada"
done
TOK=$($I auth create $A --write-bucket "$BID" --read-bucket "$BID" -d "Replica de la sede $S" --json | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] || { echo "No se pudo crear la clave de la sede"; exit 1; }
# Tarea de resumen de 15 min de esta sede -> bucket "resumen"
cat > /tmp/resumen-$S.flux <<EOF
option task = {name: "Resumen 15 min $S", every: 15m, offset: 1m}
datos = from(bucket: "$S")
    |> range(start: -45m)
    |> filter(fn: (r) => r._measurement == "lectura")
datos |> aggregateWindow(every: 15m, fn: mean, createEmpty: false) |> set(key: "_measurement", value: "lectura_15m_prom") |> to(bucket: "resumen")
datos |> aggregateWindow(every: 15m, fn: min, createEmpty: false) |> set(key: "_measurement", value: "lectura_15m_min") |> to(bucket: "resumen")
datos |> aggregateWindow(every: 15m, fn: max, createEmpty: false) |> set(key: "_measurement", value: "lectura_15m_max") |> to(bucket: "resumen")
EOF
docker cp /tmp/resumen-$S.flux "$($P ps -q influxdb-central)":/tmp/resumen-$S.flux
$I task list $A | grep -q "Resumen 15 min $S" || $I task create $A -f /tmp/resumen-$S.flux >/dev/null
mkdir -p sedes
umask 077
cat > sedes/$S.env <<EOF
CENTRAL_URL=http://<IP del central>:$CENTRAL_INFLUX_PORT
CENTRAL_ORG_ID=$ORGID
CENTRAL_BUCKET=$S
CENTRAL_TOKEN=$TOK
EOF
echo "Sede $S dada de alta: bucket $BID, tarea de resumen creada."
echo "Datos para la sede en sedes/$S.env (cambie <IP del central>); en la sede: ./replica-central.sh sedes/$S.env"

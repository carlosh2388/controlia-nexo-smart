#!/bin/sh
# Activa HTTPS (puerto 443 del contenedor) solo si WEB_HTTPS=1 y el certificado esta montado en
# /etc/nginx/certs (web.crt + web.key). Si falta algo, la web sigue igual solo por HTTP.
set -e
if [ "${WEB_HTTPS:-0}" = "1" ] && [ -f /etc/nginx/certs/web.crt ] && [ -f /etc/nginx/certs/web.key ]; then
  cp /etc/nginx/https.conf.tpl /etc/nginx/conf.d/https.conf
  echo "30-https.sh: HTTPS activo (443)"
else
  rm -f /etc/nginx/conf.d/https.conf
  echo "30-https.sh: HTTPS desactivado (WEB_HTTPS=${WEB_HTTPS:-0} o falta /etc/nginx/certs/web.crt)"
fi

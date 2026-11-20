#!/bin/sh
# Activa HTTPS (puerto 443 del contenedor) solo si WEB_HTTPS=1 y el certificado esta montado en
# /etc/nginx/certs (web.crt + web.key). Si falta algo, la web sigue igual solo por HTTP.
# Con HTTPS activo y WEB_HTTP_REDIRECT=1 (por defecto), la direccion http manda a la https
# (puerto publico WEB_HTTPS_PORT, 5443 por defecto): el navegador solo permite el microfono en https.
set -e
if [ "${WEB_HTTPS:-0}" = "1" ] && [ -f /etc/nginx/certs/web.crt ] && [ -f /etc/nginx/certs/web.key ]; then
  cp /etc/nginx/https.conf.tpl /etc/nginx/conf.d/https.conf
  if [ "${WEB_HTTP_REDIRECT:-1}" = "1" ]; then
    cat > /etc/nginx/conf.d/default.conf <<EOF
# Generado por 30-https.sh: la web se usa por https (microfono del asistente Gravix).
server {
  listen 80;
  server_name _;
  location / {
    return 302 https://\$host:${WEB_HTTPS_PORT:-5443}\$request_uri;
  }
}
EOF
    echo "30-https.sh: HTTPS activo (443); http redirige a https puerto ${WEB_HTTPS_PORT:-5443}"
  else
    echo "30-https.sh: HTTPS activo (443); http sigue abierto"
  fi
else
  rm -f /etc/nginx/conf.d/https.conf
  echo "30-https.sh: HTTPS desactivado (WEB_HTTPS=${WEB_HTTPS:-0} o falta /etc/nginx/certs/web.crt)"
fi

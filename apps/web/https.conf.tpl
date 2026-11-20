# HTTPS de la web central (lo activa 30-https.sh solo si WEB_HTTPS=1 y hay certificado).
# El navegador solo deja usar el microfono (asistente Gravix) en HTTPS. Las llamadas a /api y /ws
# pasan por aqui a la API, asi una pagina HTTPS no queda bloqueada por pedir datos por HTTP.
server {
  listen 443 ssl;
  server_name _;

  ssl_certificate /etc/nginx/certs/web.crt;
  ssl_certificate_key /etc/nginx/certs/web.key;
  ssl_protocols TLSv1.2 TLSv1.3;

  root /usr/share/nginx/html;
  index index.html;

  # DNS interno de Docker: con la direccion en una variable, nginx no falla si la API aun no arranca
  # y vuelve a resolver "api" cuando ese contenedor se recrea.
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $api_central http://api:3000;

  location /api/ {
    proxy_pass $api_central;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
    client_max_body_size 50m;
  }

  location /ws {
    proxy_pass $api_central;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}

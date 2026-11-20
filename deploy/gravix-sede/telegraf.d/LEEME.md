# Configuraciones extra de Telegraf

Telegraf carga todos los `*.conf` de esta carpeta, además de `telegraf.conf`.

- `comparativo.conf.ejemplo`: mide las bases del comparativo TimescaleDB vs InfluxDB. Para usarlo,
  copie el archivo como `comparativo.conf` **solo** si el perfil `comparativo` está encendido
  (`COMPOSE_PROFILES=...,comparativo`). Si los contenedores del comparativo no existen, Telegraf
  registraría errores cada 5 minutos.

# PostgreSQL 16 (la misma imagen Debian de siempre, para reutilizar el volumen de datos existente)
# + TimescaleDB completo (licencia "timescale": hypertables, compresion y politicas automaticas).
# El paquete de TimescaleDB que trae el repositorio de PostgreSQL es solo la parte "apache" (sin
# compresion), por eso se instala desde el repositorio de Timescale.
FROM postgres:16.15

ARG TIMESCALEDB_VERSION=2.31.0~debian13-1615

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
 && . /etc/os-release \
 && curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescale.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/timescale.gpg] https://packagecloud.io/timescale/timescaledb/debian/ ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/timescale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      timescaledb-2-postgresql-16=${TIMESCALEDB_VERSION} \
      timescaledb-2-loader-postgresql-16=${TIMESCALEDB_VERSION} \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

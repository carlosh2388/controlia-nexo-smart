# Agente Go en contenedor (Gravix de sede). Contexto de build: apps/Agente_Go.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/agente-go ./cmd/agent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 agente
COPY --from=build /out/agente-go /usr/local/bin/agente-go
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown agente /data
USER agente
VOLUME /data
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

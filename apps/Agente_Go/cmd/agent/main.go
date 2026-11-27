// Agente_Go: un binario por edificio que escucha los protocolos habilitados en su red local
// (MQTT/Zigbee2MQTT, LoRaWAN, BACnet, Modbus TCP, gateways LoRa directos) y reporta lo que descubre
// a la API central de Nodivo via POST /devices/agent-sync. Los protocolos se configuran desde la
// web (config remota); config.yaml solo necesita buildingKey + api. Ver apps/Agente_Go/README.md
// y docs/agentes-go-manual.md.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"agente-go/internal/agent"
	"agente-go/internal/config"
	"agente-go/internal/reporter"
)

const version = "0.6.0"

func main() {
	configPath := flag.String("config", "config.yaml", "ruta al archivo de configuracion (ver config.example.yaml)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	rep := reporter.New(cfg.API.BaseURL, cfg.API.APIKey)
	ag, err := agent.New(cfg, rep, version)
	if err != nil {
		log.Fatalf("agente: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := ag.Run(ctx); err != nil {
		log.Fatalf("agente: %v", err)
	}
}

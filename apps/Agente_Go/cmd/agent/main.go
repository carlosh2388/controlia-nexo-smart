// Agente_Go: un binario por edificio que escucha los protocolos habilitados en su red local
// (Fase 1: MQTT/Zigbee2MQTT) y reporta lo que descubre a la API central de Nodivo via
// POST /devices/agent-sync. Ver apps/Agente_Go/README.md y docs/agente-go.md.
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
	"agente-go/internal/discovery"
	"agente-go/internal/discovery/bacnetsource"
	"agente-go/internal/discovery/lorawansource"
	"agente-go/internal/discovery/mqttsource"
	"agente-go/internal/reporter"
)

const version = "0.1.0"

func main() {
	configPath := flag.String("config", "config.yaml", "ruta al archivo de configuracion (ver config.example.yaml)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	var sources []discovery.Source
	if cfg.MQTT != nil && cfg.MQTT.Enabled {
		sources = append(sources, mqttsource.New(*cfg.MQTT))
	}
	if cfg.LoRaWAN != nil && cfg.LoRaWAN.Enabled {
		sources = append(sources, lorawansource.New(*cfg.LoRaWAN))
	}
	if cfg.BACnet != nil && cfg.BACnet.Enabled {
		for _, dev := range cfg.BACnet.Devices {
			sources = append(sources, bacnetsource.New(*cfg.BACnet, dev))
		}
	}
	// Fase 4 (adaptadores HTTP por fabricante): se agrega aca del mismo modo, como su propio
	// discovery.Source - ver docs/agente-go.md "Como agregar un protocolo nuevo".

	if len(sources) == 0 {
		log.Fatal("ninguna fuente habilitada en la config (agrega mqtt.enabled: true, por ejemplo)")
	}

	rep := reporter.New(cfg.API.BaseURL, cfg.API.APIKey)
	ag := agent.New(cfg, sources, rep, version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := ag.Run(ctx); err != nil {
		log.Fatalf("agente: %v", err)
	}
}

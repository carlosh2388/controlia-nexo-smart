package discovery

import (
	"fmt"
	"os"
)

// ClientID arma un client id MQTT unico por maquina y proceso. Un id fijo hace que dos agentes
// (ej. uno de pruebas en una PC y otro en el servidor) se expulsen mutuamente del mismo broker.
func ClientID(prefix string) string {
	host, _ := os.Hostname()
	if host == "" {
		host = "host"
	}
	return fmt.Sprintf("%s-%s-%d", prefix, host, os.Getpid())
}

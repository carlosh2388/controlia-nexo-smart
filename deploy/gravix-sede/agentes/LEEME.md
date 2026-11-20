# Configuraciones completas de agentes (opcional)

Aquí van los `config.yaml` completos de agentes que ya existían antes del Gravix de sede: protocolos,
LoRaWAN, umbrales de eventos y demás. Se usan con `AGENT_CONFIG_BASE=/config/<archivo>.yaml` (o
`AGENT2_CONFIG_BASE`) en el `.env`.

En el archivo, `buildingKey`, `api.baseUrl` y `api.apiKey` se escriben como `__BUILDING_KEY__`,
`__API_URL__` y `__API_KEY__`, y deben llevar `remoteConfig: true` y `dataDir: "/data"`. El
contenedor los reemplaza al arrancar con los valores del `.env`.

Estos archivos pueden tener claves (por ejemplo, la del broker MQTT de ChirpStack): **no se suben a git**.
Un agente nuevo no necesita archivo: se configura desde la web (Equipos).

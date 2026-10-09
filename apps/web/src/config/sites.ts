/**
 * Sedes que aparecen en la pestaña Sedes. buildingKey debe coincidir con el buildingKey del
 * Agente_Go de esa sede (config.yaml del agente): es como la web sabe que dispositivos son de
 * cada sede. Una sede sin agente todavia se muestra como "pendiente".
 */
export interface SiteConfig {
  key: string;
  name: string;
  buildingKey: string;
  /** Sede modelo: la primera en integrarse, plantilla para las demas. */
  model?: boolean;
  modbus?: { name: string; host: string; port: number; unitId: number };
  lorawan?: { host: string; port: number };
  /** LoRaWAN directo: los gateways apuntan su "Network Server" al Agente Go (UDP), sin ChirpStack. */
  loraDirect?: { port: number };
  /** Etiqueta en el selector de sedes (ej. "pruebas"). */
  tag?: string;
}

export const SITES: SiteConfig[] = [
  {
    key: "escuintla",
    name: "Escuintla",
    buildingKey: "igss-escuintla",
    model: true,
    modbus: { name: "EBO AS-P", host: "10.0.6.26", port: 502, unitId: 1 },
    lorawan: { host: "10.0.6.35", port: 1883 },
  },
  {
    key: "tec3-oficina",
    name: "TEC 3 · Oficina",
    buildingKey: "tec3-oficina",
    tag: "pruebas",
    loraDirect: { port: 1700 },
  },
  { key: "amatitlan", name: "Amatitlán", buildingKey: "igss-amatitlan" },
  { key: "coban", name: "Cobán", buildingKey: "igss-coban" },
  { key: "gineco", name: "Gineco", buildingKey: "igss-gineco" },
  { key: "gomera", name: "La Gomera", buildingKey: "igss-gomera" },
  { key: "mazatenango", name: "Mazatenango", buildingKey: "igss-mazatenango" },
  { key: "palin", name: "Palín", buildingKey: "igss-palin" },
  { key: "retalhuleu", name: "Retalhuleu", buildingKey: "igss-retalhuleu" },
  { key: "santa-lucia", name: "Santa Lucía", buildingKey: "igss-santa-lucia" },
  { key: "tiquisate", name: "Tiquisate", buildingKey: "igss-tiquisate" },
  { key: "villa-nueva", name: "Villa Nueva", buildingKey: "igss-villa-nueva" },
];

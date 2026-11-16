// Prueba del monitor de eventos con datos simulados y umbrales cortos (segundos).
// Uso: node prueba_monitor.js <ruta a eventos_modbus.js>
const path = require("path");
Object.assign(process.env, {
  SEDE_NOMBRE: "Escuintla",
  ALERTAS_CORREO_ACTIVO: "true",
  SMTP_HOST: "smtp.prueba.local",
  ALERTAS_CORREO_PARA: "centro.monitoreo@prueba.local",
  ALERTA_CONGELADO_MIN: "0.05",      // 3 s
  ALERTA_DEGRADADO_S: "1",
  ALERTA_SIN_CAMBIO_MIN: "0.05",     // 3 s
  ALERTA_FUERA_DE_LINEA_MIN: "0.05", // 3 s
  ALERTA_EN_CERO_MIN: "0.05",
  ALERTA_ATASCADA_S: "2",
  VIGILANTE_REINICIO_ACTIVO: "false",
  ALERTA_AGRUPAR_ADVERTENCIAS_MIN: "0.05"
});

const mon = require(path.resolve(process.argv[2]));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let enCursoDesde = null;
let reconexiones = 0;
mon.iniciar({
  obtenerEnCursoDesde: () => enCursoDesde,
  reconectar: (m) => { reconexiones += 1; console.log(`(vigilante llamó reconectar: ${m})`); },
  obtenerTotalReconexiones: () => 0
});

function raw(potencia, { online = true, volt = 120 } = {}) {
  return {
    modbus_ebo: {
      devices: {
        ion_7400_1: { name: "ION7400-1", code_inventory: "HES107", area: "Cuarto eléctrico", status: online ? "online" : "offline",
          metrics: { active_power_total: { value: potencia }, voltage_a_n: { value: volt }, voltage_b_n: { value: volt }, s1_transfer_normal: { value: 1 } } },
        pm_2130_1: { name: "PM2130-1", code_inventory: "HES112", status: "online",
          metrics: { active_power_total: { value: potencia / 10 }, voltage_a_n: { value: 119 } } },
        pm_2130_2: { name: "PM2130-2", code_inventory: "HES113", status: "online", metrics: { active_power_total: { value: potencia / 5 } } },
        pm_2130_3: { name: "PM2130-3", code_inventory: "HES114", status: "online", metrics: { active_power_total: { value: potencia / 3 } } }
      }
    }
  };
}

async function paso(nombre, fn) {
  console.log(`\n========== ${nombre}`);
  await fn();
  mon._evaluarPeriodico();
  mon._agruparAdvertencias();
  await mon._procesarCorreos();
  const e = mon.obtenerEstado();
  console.log(`estado=${e.estado} motivo=${e.motivo} abiertos=[${e.eventos_abiertos.map((x) => `${x.evento}${x.dispositivo ? ":" + x.dispositivo : ""}`).join(", ")}] correo=${e.correo}`);
}

(async () => {
  await paso("1. Lecturas normales", async () => {
    for (let i = 0; i < 3; i++) { mon.lecturaOk(raw(150 + i), 800); await esperar(300); }
  });
  await paso("2. Sin lecturas por 4 s (como el 30/09) -> DATOS_CONGELADOS", async () => {
    mon.lecturaFallida("Port Not Open", 5);
    await esperar(4000);
  });
  await paso("3. Vuelve la lectura -> se cierra DATOS_CONGELADOS", async () => {
    mon.lecturaOk(raw(160), 900);
  });
  await paso("4. Medidor repite el mismo valor 4 s -> 4 medidores sin cambio a la vez -> UN correo agrupado", async () => {
    for (let i = 0; i < 5; i++) { mon.lecturaOk(raw(170), 800); await esperar(900); }
  });
  await paso("5. Valores cambian otra vez -> se cierran", async () => {
    mon.lecturaOk(raw(171), 800);
  });
  await paso("6. ION7400-1 fuera de linea 4 s -> MEDIDOR_FUERA_DE_LINEA", async () => {
    for (let i = 0; i < 5; i++) { mon.lecturaOk(raw(172 + i, { online: false }), 800); await esperar(900); }
  });
  await paso("7. Vuelve en linea", async () => {
    mon.lecturaOk(raw(180), 800);
  });
  await paso("8. Lectura atascada 3 s -> LECTURA_ATASCADA y vigilante reconecta", async () => {
    enCursoDesde = Date.now();
    await esperar(3000);
  });
  await paso("9. Termina la lectura atascada", async () => {
    enCursoDesde = null;
    mon.lecturaOk(raw(181), 800);
  });
  console.log(`\nreconexiones pedidas por el vigilante: ${reconexiones}`);
  console.log("lectura (va en la respuesta del endpoint):", JSON.stringify(mon.infoLectura()));
  process.exit(0);
})();

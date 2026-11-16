// Simula un EBO que corta la conexion con una lectura pendiente (como el 30/09/2026 18:33 UTC)
// y comprueba si la cola de lecturas de modbus_rtu.js se recupera o queda bloqueada.
// Uso: node prueba_reset.js <ruta a modbus_rtu.js>
const net = require("net");
const path = require("path");

const PORT = 15020;
process.env.MODBUS_HOST = "127.0.0.1";
process.env.MODBUS_PORT = String(PORT);
process.env.MODBUS_TIMEOUT_MS = "2000";
process.env.MODBUS_READ_DELAY_MS = "0";

let conexiones = 0;
const server = net.createServer((sock) => {
  conexiones += 1;
  const n = conexiones;
  sock.on("data", (buf) => {
    if (n === 1) {
      // Primera conexion: el "EBO" cierra el socket sin responder.
      sock.destroy();
      return;
    }
    // Conexiones siguientes: responde FC3 con ceros.
    const trans = buf.readUInt16BE(0);
    const unit = buf.readUInt8(6);
    const fc = buf.readUInt8(7);
    const qty = buf.readUInt16BE(10);
    const res = Buffer.alloc(9 + qty * 2);
    res.writeUInt16BE(trans, 0);
    res.writeUInt16BE(0, 2);
    res.writeUInt16BE(3 + qty * 2, 4);
    res.writeUInt8(unit, 6);
    res.writeUInt8(fc, 7);
    res.writeUInt8(qty * 2, 8);
    sock.write(res);
  });
  sock.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", async () => {
  const mod = require(path.resolve(process.argv[2]));
  const inicio = Date.now();
  const limite = setTimeout(() => {
    console.log(`RESULTADO: BLOQUEADO (sin respuesta tras ${(Date.now() - inicio) / 1000}s, conexiones=${conexiones})`);
    process.exit(2);
  }, 30000);

  for (let i = 1; i <= 3; i++) {
    try {
      const r = await mod.readHoldingRegistersForUnit(1, 0, 2);
      console.log(`lectura ${i}: OK ${JSON.stringify(r.data)} (${(Date.now() - inicio) / 1000}s)`);
    } catch (err) {
      console.log(`lectura ${i}: error "${err.message}" (${(Date.now() - inicio) / 1000}s)`);
    }
  }
  clearTimeout(limite);
  console.log(`RESULTADO: RECUPERADO (conexiones=${conexiones}, ${(Date.now() - inicio) / 1000}s)`);
  process.exit(0);
});

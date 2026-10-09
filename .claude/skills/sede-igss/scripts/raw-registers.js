// Lectura SOLO LECTURA de registros crudos de un servidor Modbus TCP, con su decodificacion
// float32 en los dos ordenes de palabra (ABCD y CDAB), para identificar que hay en un bloque.
//
// Uso: node raw-registers.js <host> <registroInicial> <cantidad<=125> [funcion=3|4] [unitId=1]
// Ej.: node raw-registers.js 10.0.6.26 5705 38 3
const net = require("net");

const [host, startArg, qtyArg, fnArg, unitArg] = process.argv.slice(2);
if (!host || !startArg || !qtyArg) {
  console.error("Uso: node raw-registers.js <host> <registro> <cantidad> [funcion=3|4] [unitId=1]");
  process.exit(1);
}
const start = Number(startArg);
const qty = Math.min(125, Number(qtyArg));
const fn = Number(fnArg || 3);
if (fn !== 3 && fn !== 4) {
  console.error("Solo se permiten las funciones de lectura 3 y 4.");
  process.exit(1);
}
const unitId = Number(unitArg || 1);

const sock = net.connect(502, host, () => {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(1, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(6, 4);
  b[6] = unitId;
  b[7] = fn;
  b.writeUInt16BE(start - 1, 8);
  b.writeUInt16BE(qty, 10);
  sock.write(b);
});

let buf = Buffer.alloc(0);
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 7 || buf.length < 6 + buf.readUInt16BE(4)) return;
  const pdu = buf.subarray(7, 6 + buf.readUInt16BE(4));
  if (pdu[0] & 0x80) {
    console.log(`excepcion Modbus ${pdu[1]} (2 = direccion ilegal)`);
    sock.end();
    return;
  }
  const regs = [];
  for (let i = 0; i < pdu[1] / 2; i++) regs.push(pdu.readUInt16BE(2 + i * 2));
  const f32 = (hi, lo) => {
    const x = Buffer.alloc(4);
    x.writeUInt16BE(hi, 0);
    x.writeUInt16BE(lo, 2);
    return x.readFloatBE(0);
  };
  console.log("registro  crudo   | float32 ABCD   float32 CDAB   (desde este registro y el siguiente)");
  regs.forEach((v, i) => {
    const next = regs[i + 1];
    const abcd = next == null ? "" : f32(v, next).toPrecision(6);
    const cdab = next == null ? "" : f32(next, v).toPrecision(6);
    console.log(`${String(start + i).padEnd(9)} ${String(v).padEnd(7)} | ${abcd.padEnd(14)} ${cdab}`);
  });
  sock.end();
});

sock.setTimeout(8000, () => {
  console.log("timeout");
  sock.destroy();
});
sock.on("error", (e) => console.error("error:", e.message));

// Escaneo SOLO LECTURA (funcion 03, holding registers) de un servidor Modbus TCP (EBO AS-P).
// Imprime los rangos de registros con valor distinto de 0. Numeracion del EBO: registro N = direccion N-1.
//
// Uso: node scan-ebo.js <host> <registroDesde> <registroHasta> [tamanoBloque=100] [unitId=1]
// Ej.: node scan-ebo.js 10.0.6.26 1 6000 100
//      node scan-ebo.js 10.0.6.26 5701 5800 1   (zona fina: un bloque grande que cruza el final da excepcion)
const net = require("net");

const [host, fromArg, toArg, chunkArg, unitArg] = process.argv.slice(2);
if (!host || !fromArg || !toArg) {
  console.error("Uso: node scan-ebo.js <host> <desde> <hasta> [bloque=100] [unitId=1]");
  process.exit(1);
}
const from = Number(fromArg);
const to = Number(toArg);
const CH = Math.min(125, Number(chunkArg || 100));
const unitId = Number(unitArg || 1);
const PAUSE_MS = 40; // no saturar el EBO (lo lee tambien el sistema anterior)

const sock = net.connect(502, host);
let tx = 0;
let pending = null;
let buf = Buffer.alloc(0);

sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
    const len = buf.readUInt16BE(4);
    const pdu = buf.subarray(7, 6 + len);
    buf = buf.subarray(6 + len);
    const p = pending;
    pending = null;
    if (p) p(pdu);
  }
});

function read(register, qty) {
  return new Promise((resolve) => {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(++tx, 0);
    b.writeUInt16BE(0, 2);
    b.writeUInt16BE(6, 4);
    b[6] = unitId;
    b[7] = 0x03; // solo lectura
    b.writeUInt16BE(register - 1, 8);
    b.writeUInt16BE(qty, 10);
    pending = resolve;
    sock.write(b);
    setTimeout(() => {
      if (pending === resolve) {
        pending = null;
        resolve(null);
      }
    }, 5000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

sock.on("connect", async () => {
  const nonZero = [];
  let exceptions = 0;
  let timeouts = 0;
  for (let r = from; r <= to; r += CH) {
    const qty = Math.min(CH, to - r + 1);
    const pdu = await read(r, qty);
    await sleep(PAUSE_MS);
    if (!pdu) {
      timeouts++;
      continue;
    }
    if (pdu[0] & 0x80) {
      exceptions++;
      continue;
    }
    for (let i = 0; i < pdu[1] / 2; i++) {
      if (pdu.readUInt16BE(2 + i * 2)) nonZero.push(r + i);
    }
  }
  const runs = [];
  for (const x of nonZero) {
    const last = runs[runs.length - 1];
    if (last && x - last[1] <= 4) last[1] = x;
    else runs.push([x, x]);
  }
  console.log(`registros != 0: ${nonZero.length} · bloques con excepcion: ${exceptions} · timeouts: ${timeouts}`);
  console.log(runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ") || "(ninguno)");
  sock.end();
});

sock.on("error", (e) => {
  console.error("error:", e.message);
  process.exit(1);
});

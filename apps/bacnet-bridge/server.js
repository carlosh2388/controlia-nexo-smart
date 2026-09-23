const http = require("http");
const Bacnet = require("bacstack");
const { ApplicationTags } = Bacnet.enum;

const PORT = parseInt(process.env.BACNET_BRIDGE_PORT || "3099", 10);
const TOKEN = process.env.BACNET_BRIDGE_TOKEN || "";
const BACNET_INTERFACE = process.env.BACNET_INTERFACE || "0.0.0.0";
const BACNET_BROADCAST_ADDRESS = process.env.BACNET_BROADCAST_ADDRESS || "255.255.255.255";
const DEVICE_OBJECT_LIST_PROP = 76;
const OBJECT_NAME_PROP = 77;
const STATE_TEXT_PROP = 110;
const PRESENT_VALUE_PROP = 85;

// El gateway AC Smart 5 solo responde a Who-Is si el puerto origen es exactamente 47808
// (verificado: un puerto efimero no recibe respuesta). bacstack necesita bindear ese puerto fijo.
const client = new Bacnet({
  apduTimeout: 6000,
  interface: BACNET_INTERFACE,
  broadcastAddress: BACNET_BROADCAST_ADDRESS,
  port: 47808,
});

// Serializa todas las llamadas BACnet: un solo socket/cliente compartido entre todas las
// unidades de AC; evita saturar al gateway real con lecturas/escrituras concurrentes.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function whoIs(host, useBroadcast = false) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onIAm = (device) => {
      if (done || device.address !== host) return;
      done = true;
      client.removeListener("iAm", onIAm);
      resolve(device);
    };
    client.on("iAm", onIAm);
    client.whoIs(useBroadcast ? undefined : { address: host });
    setTimeout(() => {
      if (done) return;
      done = true;
      client.removeListener("iAm", onIAm);
      reject(new Error(`Sin respuesta I-Am de ${host} (${useBroadcast ? "broadcast" : "unicast"} timeout)`));
    }, 6000);
  });
}

function readProp(host, obj, propId) {
  return new Promise((resolve, reject) => {
    client.readProperty(host, obj, propId, (err, value) => {
      if (err) return reject(err);
      resolve(value.values);
    });
  });
}

function writeProp(host, obj, propId, values, priority) {
  return new Promise((resolve, reject) => {
    const options = priority ? { priority } : {};
    client.writeProperty(host, obj, propId, values, options, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const UNIT_SUFFIX_RE = /^ac_(.+)_([a-zA-Z]+\d+)$/;

const POINT_KEYS = {
  StartStopCommand: "startStopCommand",
  StartStopStatus: "startStopStatus",
  AirConModeCommand: "modeCommand",
  AirConModeStatus: "modeStatus",
  FanSpeedCommand: "fanCommand",
  FanSpeedStatus: "fanStatus",
  SwingCommand: "swingCommand",
  SwingStatus: "swingStatus",
  SetRoomTemp: "setRoomTemp",
  RoomTemp: "roomTemp",
  TempRangeUpperLimitCommand: "tempRangeUpperCommand",
  TempRangeLowerLimitCommand: "tempRangeLowerCommand",
  TempRangeUpperLimitStatus: "tempRangeUpperStatus",
  TempRangeLowerLimitStatus: "tempRangeLowerStatus",
  Alarm: "alarm",
  MalfunctionCode: "malfunctionCode",
};

async function discover(host) {
  return serialize(async () => {
    let device;
    try {
      device = await whoIs(host);
    } catch (err) {
      console.warn(`[bacnet-bridge] Who-Is unicast fallo para ${host}: ${err.message}; probando broadcast ${BACNET_BROADCAST_ADDRESS}`);
      device = await whoIs(host, true);
    }
    const objListValues = await readProp(host, { type: 8, instance: device.deviceId }, DEVICE_OBJECT_LIST_PROP);
    const allObjects = objListValues.map((o) => o.value).filter((o) => o.type !== 8);

    const named = await mapWithConcurrency(allObjects, 10, async (obj) => {
      try {
        const values = await readProp(host, obj, OBJECT_NAME_PROP);
        return { obj, name: values[0] ? values[0].value : null };
      } catch (e) {
        return { obj, name: null };
      }
    });

    const unitsByKey = new Map();
    for (const { obj, name } of named) {
      if (!name) continue;
      const match = UNIT_SUFFIX_RE.exec(name);
      if (!match) continue;
      const [, pointName, unitKey] = match;
      const pointKey = POINT_KEYS[pointName];
      if (!pointKey) continue;
      if (!unitsByKey.has(unitKey)) unitsByKey.set(unitKey, {});
      unitsByKey.get(unitKey)[pointKey] = { type: obj.type, instance: obj.instance };
    }

    const candidateUnits = [...unitsByKey.entries()].filter(
      ([, points]) => points.startStopCommand && points.setRoomTemp && points.roomTemp,
    );

    const units = await mapWithConcurrency(candidateUnits, 5, async ([unitKey, points]) => {
      let modeStates = null;
      let fanStates = null;
      try {
        if (points.modeCommand) {
          const v = await readProp(host, points.modeCommand, STATE_TEXT_PROP);
          modeStates = v.map((x) => x.value);
        }
      } catch (e) {
        modeStates = null;
      }
      try {
        if (points.fanCommand) {
          const v = await readProp(host, points.fanCommand, STATE_TEXT_PROP);
          fanStates = v.map((x) => x.value);
        }
      } catch (e) {
        fanStates = null;
      }

      const sample = { on: null, roomTemp: null, setRoomTemp: null };
      try {
        const v = await readProp(host, points.startStopStatus || points.startStopCommand, PRESENT_VALUE_PROP);
        sample.on = !!v[0].value;
      } catch (e) {}
      try {
        const v = await readProp(host, points.roomTemp, PRESENT_VALUE_PROP);
        sample.roomTemp = v[0].value;
      } catch (e) {}
      try {
        const v = await readProp(host, points.setRoomTemp, PRESENT_VALUE_PROP);
        sample.setRoomTemp = v[0].value;
      } catch (e) {}

      return { unitKey, points, modeStates, fanStates, sample };
    });

    units.sort((a, b) => a.unitKey.localeCompare(b.unitKey, undefined, { numeric: true }));

    return { deviceId: device.deviceId, vendorId: device.vendorId, host, totalObjects: allObjects.length, units };
  });
}

async function readMany(host, reads) {
  return serialize(() =>
    mapWithConcurrency(reads, 8, async (r) => {
      try {
        const values = await readProp(host, { type: r.type, instance: r.instance }, r.property || PRESENT_VALUE_PROP);
        return { key: r.key, value: values[0] ? values[0].value : null, ok: true };
      } catch (e) {
        return { key: r.key, value: null, ok: false, error: e.message };
      }
    }),
  );
}

function encodeValue(valueType, value) {
  switch (valueType) {
    case "boolean":
      return [{ type: ApplicationTags.BOOLEAN, value: !!value }];
    case "real":
      return [{ type: ApplicationTags.REAL, value: Number(value) }];
    case "enum":
      return [{ type: ApplicationTags.ENUMERATED, value: Number(value) }];
    default:
      throw new Error(`valueType desconocido: ${valueType}`);
  }
}

async function writeOne(host, object, valueType, value, priority) {
  return serialize(() => writeProp(host, object, PRESENT_VALUE_PROP, encodeValue(valueType, value), priority));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  function send(status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  if (req.url === "/health") return send(200, { ok: true });

  if (TOKEN && req.headers["x-bridge-token"] !== TOKEN) {
    return send(401, { error: "token invalido" });
  }

  try {
    const body = req.method === "POST" ? await readBody(req) : {};

    if (req.url === "/discover" && req.method === "POST") {
      const result = await discover(body.host);
      return send(200, result);
    }

    if (req.url === "/read" && req.method === "POST") {
      const result = await readMany(body.host, body.reads || []);
      return send(200, { values: result });
    }

    if (req.url === "/write" && req.method === "POST") {
      await writeOne(body.host, body.object, body.valueType, body.value, body.priority);
      return send(200, { ok: true });
    }

    send(404, { error: "no encontrado" });
  } catch (err) {
    console.error(`[bacnet-bridge] error en ${req.method} ${req.url}:`, err.message);
    send(500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[bacnet-bridge] escuchando en 0.0.0.0:${PORT}${TOKEN ? " (con token)" : " (SIN token, solo para dev)"}`);
});

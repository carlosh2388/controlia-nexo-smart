import { PrismaClient, Role } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function seedAdmin() {
  const username = process.env.SEED_ADMIN_USERNAME || "admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "admin123";

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`El usuario "${username}" ya existe, no se crea de nuevo.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { username, passwordHash, role: Role.admin },
  });

  console.log(`Usuario admin creado: ${username} / ${password} (cambiar la contrasena despues del primer login).`);
}

async function seedAreas() {
  const existingTenants = await prisma.tenant.count();
  if (existingTenants > 0) {
    console.log("Ya hay tenants configurados, no se crean areas iniciales.");
    return;
  }

  const tenant = await prisma.tenant.upsert({
    where: { id: "siasa-tec3-nivel-10" },
    update: {
      name: "SIASA",
      building: "EDIFICIO TEC 3",
      level: "NIVEL 10",
    },
    create: {
      id: "siasa-tec3-nivel-10",
      name: "SIASA",
      building: "EDIFICIO TEC 3",
      level: "NIVEL 10",
    },
  });

  const areas = [
    ["cctv", "CCTV", "cctv.jpg"],
    ["centro-de-monitoreo", "Centro de Monitoreo", "centro-de-monitoreo.jpg"],
    ["coworking", "Coworking", "coworking.jpg"],
    ["cuarto-electrico", "Cuarto Electrico", "cuarto-electrico.jpg"],
    ["esclusa", "Esclusa", "esclusa.jpg"],
    ["estacion-de-cafe", "Estacion de Cafe", "estacion-de-caf.jpg"],
    ["experience-center", "Experience Center", "experience-center.jpg"],
    ["id", "I+D", "id.jpg"],
    ["oficina-1", "Oficina 1", "oficina-1.jpg"],
    ["oficina-2", "Oficina 2", "oficina-2.jpg"],
    ["oficina-3", "Oficina 3", "oficina-3.jpg"],
    ["oficina-4", "Oficina 4", "oficina-4.jpg"],
    ["oficina-5", "Oficina 5", "oficina-5.jpg"],
    ["oficina-6", "Oficina 6", "oficina-6.jpg"],
    ["oficina-7", "Oficina 7", "oficina-7.jpg"],
    ["recepcion", "Recepcion", "recepcion.jpg"],
    ["sala-presidencial", "Sala Presidencial", "sala-presidencial.jpg"],
    ["sala-reuniones", "Sala de Reuniones", "sala-reuniones.jpg"],
    ["telco", "Telco", "telco.jpg"],
  ] as const;

  for (const [index, [slug, name, imageFile]] of areas.entries()) {
    await prisma.area.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug } },
      update: { name, imageFile, order: index + 1 },
      create: {
        tenantId: tenant.id,
        slug,
        name,
        imageFile,
        order: index + 1,
      },
    });
  }

  const areaBySlug = new Map(
    (await prisma.area.findMany({ where: { tenantId: tenant.id } })).map((area) => [area.slug, area.id]),
  );

  const deviceAreaRules: Array<[RegExp, string]> = [
    [/sala presidencial/i, "sala-presidencial"],
    [/recepcion/i, "recepcion"],
    [/oficina3|oficina 3/i, "oficina-3"],
    [/showroom|experience/i, "experience-center"],
    [/\bsala\b/i, "sala-reuniones"],
    [/\bcct\b/i, "centro-de-monitoreo"],
  ];

  const devices = await prisma.device.findMany();
  for (const device of devices) {
    const match = deviceAreaRules.find(([pattern]) => pattern.test(device.name));
    if (!match) continue;

    const areaId = areaBySlug.get(match[1]);
    if (!areaId || device.areaId === areaId) continue;

    await prisma.device.update({
      where: { id: device.id },
      data: { areaId },
    });
  }

  console.log(`Tenant y ${areas.length} areas iniciales configuradas.`);
}

async function main() {
  await seedAdmin();
  await seedAreas();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

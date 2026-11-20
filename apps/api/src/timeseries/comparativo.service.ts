import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import type { ReadingRow } from "./influx-writer.service";

/**
 * Comparativo TimescaleDB vs InfluxDB: escribe cada lectura de energia, ademas de en produccion, en un
 * TimescaleDB aparte (contenedor db-comparativo, misma tabla readings y misma compresion). Su pareja
 * es el InfluxDB del comparativo (InfluxWriterService, destino "comparativo"). Las dos bases arrancan
 * vacias y reciben exactamente las mismas lecturas, para medir cuanto consume cada una.
 *
 * Se activa con COMPARATIVO_DB_URL. Nunca frena ni hace fallar el guardado de produccion: escribe en
 * orden en segundo plano y si la base no responde solo lo registra.
 */
@Injectable()
export class ComparativoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Comparativo");
  private readonly db: PrismaClient | null;
  private cola: Promise<unknown> = Promise.resolve();
  private enCola = 0;
  readonly estado = { escritas: 0, ultimoOk: null as string | null, error: null as string | null };

  constructor(config: ConfigService) {
    const url = config.get<string>("COMPARATIVO_DB_URL");
    this.db = url ? new PrismaClient({ datasourceUrl: url }) : null;
  }

  get activo() {
    return Boolean(this.db);
  }

  async onModuleInit() {
    if (this.db) this.log.log("Comparativo TimescaleDB activo (db-comparativo)");
  }

  async onModuleDestroy() {
    await this.cola.catch(() => undefined);
    await this.db?.$disconnect();
  }

  /** Mismas filas que se guardaron en produccion. */
  guardar(rows: ReadingRow[]) {
    if (!this.db || !rows.length) return;
    if (this.enCola > 500) {
      this.estado.error = "db-comparativo atrasado: se descartan lecturas";
      return;
    }
    this.enCola++;
    const db = this.db;
    this.cola = this.cola
      .then(() => db.reading.createMany({ data: rows, skipDuplicates: true }))
      .then((r) => {
        this.estado.escritas += r.count;
        this.estado.ultimoOk = new Date().toISOString();
        this.estado.error = null;
      })
      .catch((e) => {
        const msg = (e as Error).message.split("\n").pop() ?? "error";
        if (this.estado.error !== msg) this.log.warn(`db-comparativo no recibio lecturas: ${msg}`);
        this.estado.error = msg;
      })
      .finally(() => this.enCola--);
  }
}

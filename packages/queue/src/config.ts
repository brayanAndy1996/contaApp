// Configuración de colas en caliente (CA-4, D12, D19). Se relee `config_sistema` cada ≤ 10 s; una
// lectura fallida o una fila fuera de rango conserva la última configuración válida de esa cola.
import { leerConfig, type ConfigCola } from "@contapp/db";
import {
  RECARGA_CONFIG_MS,
  registrarFallo,
  type DbCola,
  type NombreCola,
  type Reloj,
} from "./tipos.js";

const entero = (v: unknown, min: number, max: number): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Mismos rangos que los CHECK de `config_sistema` (D19: tenant ≤ max(1, global/2)). */
export function configValida(c: ConfigCola): boolean {
  return (
    entero(c.concurrenciaGlobal, 1, 64) &&
    entero(
      c.concurrenciaTenant,
      1,
      Math.max(1, Math.floor(c.concurrenciaGlobal / 2)),
    ) &&
    entero(c.esperaRucMs, 0, 600_000) &&
    entero(c.reintentos, 0, 10) &&
    entero(c.backoffBaseMs, 100, 600_000) &&
    entero(c.maxPendientesTenant, 1, 100_000)
  );
}

export class CacheConfig {
  private vigente = new Map<NombreCola, ConfigCola>();
  private cargadaEn: number | null = null;

  constructor(
    private readonly db: Pick<DbCola, "withSistema">,
    private readonly reloj: Reloj,
    private readonly intervaloMs: number = RECARGA_CONFIG_MS,
  ) {}

  /** Configuración vigente; relee la BD si pasaron `intervaloMs` desde la última lectura buena. */
  async obtener(): Promise<ReadonlyMap<NombreCola, ConfigCola>> {
    const ahora = this.reloj.ahora().getTime();
    if (this.cargadaEn !== null && ahora - this.cargadaEn < this.intervaloMs) {
      return this.vigente;
    }
    let leida: Map<NombreCola, ConfigCola>;
    try {
      leida = (await this.db.withSistema((tx) => leerConfig(tx))) as Map<
        NombreCola,
        ConfigCola
      >;
    } catch {
      registrarFallo("config_sistema no disponible; se conserva la anterior");
      return this.vigente;
    }
    const nueva = new Map(this.vigente);
    for (const [cola, c] of leida) {
      if (configValida(c)) nueva.set(cola, { ...c });
      else
        registrarFallo(
          "config_sistema fuera de rango; se conserva la anterior",
        );
    }
    this.vigente = nueva;
    this.cargadaEn = ahora;
    return this.vigente;
  }
}

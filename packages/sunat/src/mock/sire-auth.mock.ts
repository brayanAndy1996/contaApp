import { createHash } from "node:crypto";
import { ErrorCredencial, ErrorTransitorio } from "../errores.js";
import type { CredencialSire, SireAuth, TokenSire } from "../puertos.js";

export type ModoFalla = "401" | "timeout" | "5xx" | null;

export interface OpcionesMockSireAuth {
  ahora?: () => Date;
  vigenciaMs?: number;
}

const VIGENCIA_POR_DEFECTO_MS = 3_600_000;

/** Adaptador en memoria de `SireAuth` (`SIRE_CLIENT=mock`): tokens deterministas por RUC y llamada. */
export class MockSireAuth implements SireAuth {
  private readonly ahora: () => Date;
  private readonly vigenciaMs: number;
  private readonly exitosas = new Map<string, number>();
  private readonly porRuc = new Map<string, number>();
  private total = 0;
  private modo: ModoFalla = null;
  private restantes: number | null = null;

  constructor(opciones: OpcionesMockSireAuth = {}) {
    this.ahora = opciones.ahora ?? (() => new Date());
    this.vigenciaMs = opciones.vigenciaMs ?? VIGENCIA_POR_DEFECTO_MS;
  }

  get llamadas(): number {
    return this.total;
  }

  llamadasDe(ruc: string): number {
    return this.porRuc.get(ruc) ?? 0;
  }

  /** `veces` omitido: falla hasta `fallar(null)`; con `veces: n`, las siguientes n llamadas. */
  fallar(modo: ModoFalla, opciones: { veces?: number } = {}): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  obtenerToken(credencial: CredencialSire): Promise<TokenSire> {
    this.total += 1;
    this.porRuc.set(credencial.ruc, this.llamadasDe(credencial.ruc) + 1);

    if (this.modo !== null) {
      const modo = this.modo;
      if (this.restantes !== null) {
        this.restantes -= 1;
        if (this.restantes <= 0) {
          this.modo = null;
          this.restantes = null;
        }
      }
      return Promise.reject(
        modo === "401" ? new ErrorCredencial() : new ErrorTransitorio(),
      );
    }

    const numero = (this.exitosas.get(credencial.ruc) ?? 0) + 1;
    this.exitosas.set(credencial.ruc, numero);
    const token = createHash("sha256")
      .update(`mock-sire:${credencial.ruc}:${numero}`)
      .digest("hex");
    return Promise.resolve({
      token: `mock-${token}`,
      expiraEn: new Date(this.ahora().getTime() + this.vigenciaMs),
    });
  }
}

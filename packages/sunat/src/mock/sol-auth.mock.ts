import { ErrorCredencial, ErrorTransitorio } from "../errores.js";
import type { CredencialSol, SolAuth } from "../puertos.js";

export type ModoFallaSol = "401" | "timeout" | "5xx" | null;

/**
 * Adaptador en memoria de `SolAuth` (`SOL_PORTAL=mock`). Resuelve sin valor y sin eco de la credencial.
 *
 * Centinela: `claveSol === "clave-errada"` (exacto, sensible a mayúsculas) -> `ErrorCredencial`, para
 * simular «clave errada» con el stack real sin código.
 *
 * `fallar(modo, {veces?})` fuerza el fallo de todas las llamadas (o de las siguientes `veces`):
 * `"401"` -> `ErrorCredencial`; `"timeout"` y `"5xx"` -> `ErrorTransitorio`.
 */
export class MockSolAuth implements SolAuth {
  private readonly porRuc = new Map<string, number>();
  private total = 0;
  private modo: ModoFallaSol = null;
  private restantes: number | null = null;

  get llamadas(): number {
    return this.total;
  }

  llamadasDe(ruc: string): number {
    return this.porRuc.get(ruc) ?? 0;
  }

  fallar(modo: ModoFallaSol, opciones: { veces?: number } = {}): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  verificar(credencial: CredencialSol): Promise<void> {
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

    if (credencial.claveSol === "clave-errada") {
      return Promise.reject(new ErrorCredencial());
    }
    return Promise.resolve();
  }
}

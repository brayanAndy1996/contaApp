import { createHash } from "node:crypto";
import { ErrorDatos, ErrorTransitorio } from "../errores.js";
import type { ConsultaRuc, DatosRuc } from "../puertos.js";

export type ModoFallaConsultaRuc = "timeout" | "5xx" | "datos" | null;

/**
 * Adaptador en memoria de `ConsultaRuc` (`RUC_CLIENT=mock`). Determinista por RUC: la razón social deriva
 * de un hash del RUC y nunca es la provisional «RUC <ruc>».
 *
 * Centinelas (último dígito del RUC), para simular fallos con el stack real sin código:
 * - termina en `7` -> `ErrorTransitorio` (se reintenta);
 * - termina en `8` -> `ErrorDatos` (no se reintenta).
 *
 * `fallar(modo, {veces?})` fuerza el fallo de todas las llamadas (o de las siguientes `veces`).
 */
export class MockConsultaRuc implements ConsultaRuc {
  private readonly porRuc = new Map<string, number>();
  private total = 0;
  private modo: ModoFallaConsultaRuc = null;
  private restantes: number | null = null;

  get llamadas(): number {
    return this.total;
  }

  llamadasDe(ruc: string): number {
    return this.porRuc.get(ruc) ?? 0;
  }

  fallar(
    modo: ModoFallaConsultaRuc,
    opciones: { veces?: number } = {},
  ): void {
    this.modo = modo;
    this.restantes = modo === null ? null : (opciones.veces ?? null);
  }

  consultar(ruc: string): Promise<DatosRuc> {
    this.total += 1;
    this.porRuc.set(ruc, this.llamadasDe(ruc) + 1);

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
        modo === "datos" ? new ErrorDatos() : new ErrorTransitorio(),
      );
    }

    const ultimo = ruc.slice(-1);
    if (ultimo === "7") return Promise.reject(new ErrorTransitorio());
    if (ultimo === "8") return Promise.reject(new ErrorDatos());

    const sufijo = createHash("sha256")
      .update(`mock-ruc:${ruc}`)
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();
    return Promise.resolve({
      razonSocial: `EMPRESA MOCK ${sufijo} S.A.C.`,
      estado: "ACTIVO",
      condicion: "HABIDO",
    });
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- tx de pg dinámica en pruebas */
// Espía de `CupoUsuarios` (D11) para las pruebas de 005. Aparte de soporte-acceso.ts porque importa
// `CupoUsuariosError` (plan: Contratos, Backend), que crea la implementación (T9/T10): mientras no exista,
// solo falla la prueba que lo usa (cupo.int.spec.ts) y no el resto de las integraciones de acceso.
import { CupoUsuariosError } from "../src/modules/acceso/cupo/cupo-usuarios.js";

export type FaseCupo = "invitar" | "reactivar" | "aceptar";
export interface LlamadaCupo {
  fase: FaseCupo;
  tenantId: string;
  /** xid de la transacción que recibió el espía (solo en invitar y reactivar, que reciben `tx`). */
  xid: string | null;
}
export class CupoEspia {
  llamadas: LlamadaCupo[] = [];
  /** Fases en las que el espía rechaza con `CupoUsuariosError` (409 `cupo_usuarios`). */
  falla = new Set<FaseCupo>();

  async alInvitar(tx: any, tenantId: string): Promise<void> {
    await this.registrar("invitar", tenantId, tx);
  }
  async alReactivar(tx: any, tenantId: string): Promise<void> {
    await this.registrar("reactivar", tenantId, tx);
  }
  async alAceptar(_auth: unknown, tenantId: string): Promise<void> {
    await this.registrar("aceptar", tenantId, null);
  }
  de(fase: FaseCupo, tenantId?: string): LlamadaCupo[] {
    return this.llamadas.filter((l) => l.fase === fase && (tenantId === undefined || l.tenantId === tenantId));
  }
  reiniciar(): void {
    this.llamadas = [];
    this.falla.clear();
  }

  private async registrar(fase: FaseCupo, tenantId: string, tx: any): Promise<void> {
    let xid: string | null = null;
    if (tx) {
      const r = await tx.query("select (txid_current() % 4294967296)::text as xid");
      xid = r.rows[0].xid as string;
    }
    this.llamadas.push({ fase, tenantId, xid });
    if (this.falla.has(fase)) {
      // La clase la crea la implementación (cupo/cupo-usuarios.ts, plan: Contratos Backend).
      throw new CupoUsuariosError();
    }
  }
}

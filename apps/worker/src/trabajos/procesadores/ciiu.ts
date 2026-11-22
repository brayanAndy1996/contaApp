/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T5 (rojo): CIIU del proveedor y del cliente antes de la transacción del XML (spec 027, R-14). Lo implementa T11.
import type { ContappDb } from "@contapp/db";
import type { ConsultaRuc } from "@contapp/sunat";

export interface DepsCiiu {
  db: Pick<ContappDb, "withTenant">;
  consultaRuc: ConsultaRuc;
}

/** Consulta (fuera de transacción) los RUC sin caché o con más de 30 días y los guarda; nunca lanza. */
export async function asegurarCiiu(
  _d: DepsCiiu,
  _estudio: { tenantId: string },
  _rucs: readonly string[],
): Promise<void> {
  throw new Error("spec 027 no implementada: asegurarCiiu (T11)");
}

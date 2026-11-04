// Procesador de `cliente.consultar_ruc` (spec 007b, D1; CA-9). Consulta el padrón por el puerto `ConsultaRuc` SIN
// transacción abierta (008 D6) y después completa estado, condición y la razón social provisional del cliente en un
// `withTenant` corto (`completarDatosRuc` no pisa una razón social editada: la comparación va en el mismo UPDATE).
// Un fallo del puerto sube tal cual al ejecutor, que lo clasifica (transitorio se reintenta, de datos no) y deja el
// cliente intacto. Solo se devuelve un resultado fijo: nada de lo consultado llega a logs ni a `job_registro`.
import { completarDatosRuc, type ContappDb } from "@contapp/db";
import type { ConsultaRuc } from "@contapp/sunat";
import type { Procesador } from "../ejecutor.js";

export interface DepsConsultarRuc {
  db: Pick<ContappDb, "withTenant">;
  consultaRuc: ConsultaRuc;
}

export function consultarRuc(d: DepsConsultarRuc): Procesador {
  return async ({ trabajo }) => {
    const datos = await d.consultaRuc.consultar(trabajo.ruc);
    await d.db.withTenant({ tenantId: trabajo.tenantId }, (tx) =>
      completarDatosRuc(tx, trabajo.clienteId, {
        razonSocial: datos.razonSocial,
        estado: datos.estado,
        condicion: datos.condicion,
      }),
    );
    return { ok: true };
  };
}

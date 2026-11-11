// Antes -> después de una operación masiva de compras (spec 017, CA-5): sale de `compra_version` (inmutable), no de `auditoria`. La
// versión "antes" es la n-1 de la misma compra (null si la operación creó la versión 1). Montos como cadena exacta (`::text`).
import { consultar, type Fila, type TxConsulta } from "../acceso/errores";

export interface VersionCompraAuditada {
  n: number;
  excluida: boolean;
  clasificada: boolean;
  motivo: string | null;
  biDg: string;
  igvDg: string;
  biDgng: string;
  igvDgng: string;
  biDng: string;
  igvDng: string;
  noGravado: string;
  isc: string;
  icbper: string;
  otrosTributos: string;
  total: string;
}

export interface CambioDeCompra {
  compraId: string;
  antes: VersionCompraAuditada | null;
  despues: VersionCompraAuditada;
}

const COLUMNAS = ["n", "excluida", "clasificada", "motivo", "bi_dg", "igv_dg", "bi_dgng", "igv_dgng", "bi_dng", "igv_dng",
  "no_gravado", "isc", "icbper", "otros_tributos", "total"] as const;
const MONTOS = new Set(["bi_dg", "igv_dg", "bi_dgng", "igv_dgng", "bi_dng", "igv_dng", "no_gravado", "isc", "icbper", "otros_tributos", "total"]);

const lista = (alias: string, prefijo: string): string =>
  COLUMNAS.map((c) => `${alias}.${c}${MONTOS.has(c) ? "::text" : ""} as ${prefijo}_${c}`).join(", ");

const SQL_CAMBIOS = `select d.compra_id, ${lista("d", "d")}, ${lista("p", "p")}
  from compra_version d
  left join compra_version p on p.tenant_id = d.tenant_id and p.compra_id = d.compra_id and p.n = d.n - 1
 where d.operacion_id = $1::uuid
 order by d.compra_id`;

const version = (f: Fila, p: "d" | "p"): VersionCompraAuditada => ({
  n: f[`${p}_n`],
  excluida: f[`${p}_excluida`],
  clasificada: f[`${p}_clasificada`],
  motivo: f[`${p}_motivo`],
  biDg: f[`${p}_bi_dg`],
  igvDg: f[`${p}_igv_dg`],
  biDgng: f[`${p}_bi_dgng`],
  igvDgng: f[`${p}_igv_dgng`],
  biDng: f[`${p}_bi_dng`],
  igvDng: f[`${p}_igv_dng`],
  noGravado: f[`${p}_no_gravado`],
  isc: f[`${p}_isc`],
  icbper: f[`${p}_icbper`],
  otrosTributos: f[`${p}_otros_tributos`],
  total: f[`${p}_total`],
});

/** Cambios de cada compra de la operación, por compraId ascendente. Operación de otro estudio o inexistente: []. */
export async function leerCambiosDeOperacion(tx: TxConsulta, operacionId: string): Promise<CambioDeCompra[]> {
  const filas = await consultar(tx, SQL_CAMBIOS, [operacionId]);
  return filas.map((f) => ({
    compraId: f.compra_id,
    antes: f.p_n === null ? null : version(f, "p"),
    despues: version(f, "d"),
  }));
}

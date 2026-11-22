// Palabras aprendidas al excluir una compra con XML (spec 027, R-7). Escribe solo por `gnd_aprender` (0070, backend con usuario):
// todo o nada.
import type { TxConsulta } from "../compras/errores";
import {
  ARGUMENTO_INVALIDO,
  consultarGastos,
  exigirId,
  GastosRepoError,
} from "./errores";

const SQL_APRENDER =
  "select public.gnd_aprender($1::uuid, $2::uuid, $3::jsonb) as r";

/** `gnd_aprender`: palabras guardadas y omitidas (ya existían en el estudio), ambas en el orden recibido. */
export async function aprender(
  tx: TxConsulta,
  e: {
    clienteId: string;
    compraId: string;
    terminos: { termino: string; categoria: string }[];
  },
): Promise<{ guardadas: string[]; omitidas: string[] }> {
  const clienteId = exigirId(e.clienteId);
  const compraId = exigirId(e.compraId);
  if (!Array.isArray(e.terminos))
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const terminos = (e.terminos as unknown[]).map((t) => {
    const { termino, categoria } = Object(t) as {
      termino?: unknown;
      categoria?: unknown;
    };
    if (typeof termino !== "string" || typeof categoria !== "string")
      throw new GastosRepoError(ARGUMENTO_INVALIDO);
    return { termino, categoria };
  });
  const [f] = await consultarGastos(tx, SQL_APRENDER, [
    clienteId,
    compraId,
    JSON.stringify(terminos),
  ]);
  const r = Object(f?.r) as { guardadas?: unknown; omitidas?: unknown };
  return {
    guardadas: Array.isArray(r.guardadas) ? r.guardadas.map(String) : [],
    omitidas: Array.isArray(r.omitidas) ? r.omitidas.map(String) : [],
  };
}

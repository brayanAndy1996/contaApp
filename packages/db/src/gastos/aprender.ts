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

/** `gnd_aprender`: palabras guardadas y omitidas (ya existían en el estudio), ambas en el orden recibido. Cada término puede traer sus
 * frases de excepción ya normalizadas (0072, H-027-2-3); la propia aprendida las guarda. */
export async function aprender(
  tx: TxConsulta,
  e: {
    clienteId: string;
    compraId: string;
    terminos: { termino: string; categoria: string; excepciones?: string[] }[];
  },
): Promise<{ guardadas: string[]; omitidas: string[] }> {
  const clienteId = exigirId(e.clienteId);
  const compraId = exigirId(e.compraId);
  if (!Array.isArray(e.terminos))
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const terminos = (e.terminos as unknown[]).map((t) => {
    const { termino, categoria, excepciones } = Object(t) as {
      termino?: unknown;
      categoria?: unknown;
      excepciones?: unknown;
    };
    if (typeof termino !== "string" || typeof categoria !== "string")
      throw new GastosRepoError(ARGUMENTO_INVALIDO);
    if (excepciones === undefined) return { termino, categoria };
    if (
      !Array.isArray(excepciones) ||
      !excepciones.every((x) => typeof x === "string")
    )
      throw new GastosRepoError(ARGUMENTO_INVALIDO);
    return { termino, categoria, excepciones: [...(excepciones as string[])] };
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

const SQL_SUGERIDAS =
  "select public.gnd_excepciones_sugeridas($1::text[]) as r";

/**
 * `gnd_excepciones_sugeridas` (0072, H-027-2-3): frases de excepción sugeridas para los términos propuestos cuya otra forma es otra
 * palabra («medias» → «media pulgada»). Solo los términos que tienen; sin consultar si no hay términos.
 */
export async function excepcionesSugeridas(
  tx: TxConsulta,
  terminos: readonly string[],
): Promise<Record<string, string[]>> {
  if (
    !Array.isArray(terminos) ||
    !terminos.every((t) => typeof t === "string")
  )
    throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const salida: Record<string, string[]> = {};
  if (terminos.length === 0) return salida;
  const [f] = await consultarGastos(tx, SQL_SUGERIDAS, [[...terminos]]);
  const r: unknown = f?.r;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return salida;
  for (const t of terminos) {
    const frases: unknown = Object.prototype.hasOwnProperty.call(r, t)
      ? (r as Record<string, unknown>)[t]
      : undefined;
    if (Array.isArray(frases) && frases.length > 0)
      salida[t] = frases.map(String);
  }
  return salida;
}

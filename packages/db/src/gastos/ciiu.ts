// Caché de CIIU por estudio (spec 027, R-14). La leen backend y worker; la escribe solo el worker por `gnd_ciiu_guardar` (0070). El
// reloj es el de la BD (`clock_timestamp()`): una fila dura 30 días, también la de «sin dato».
import type { TxConsulta } from "../compras/errores";
import {
  ARGUMENTO_INVALIDO,
  consultarGastos,
  exigirTextos,
  GastosRepoError,
} from "./errores";

const SQL_VIGENTES = `select g.ruc::text as ruc from gnd_ciiu g
  where g.ruc = any($1::bpchar[]) and g.consultado_en > clock_timestamp() - interval '30 days'`;

const SQL_GUARDAR = "select public.gnd_ciiu_guardar($1::jsonb) as n";

/** RUC sin fila en la caché del estudio o con `consultado_en` de más de 30 días (`clock_timestamp()`), sin repetir y en su orden. */
export async function ciiuPendientes(
  tx: TxConsulta,
  rucs: string[],
): Promise<string[]> {
  const unicos = [...new Set(exigirTextos(rucs))];
  if (unicos.length === 0) return [];
  const vigentes = new Set(
    (await consultarGastos(tx, SQL_VIGENTES, [unicos])).map(
      (f) => f.ruc as string,
    ),
  );
  return unicos.filter((r) => !vigentes.has(r));
}

/** `gnd_ciiu_guardar` (worker): hasta 50 entradas; `ciiu = null` es «sin dato». Devuelve cuántas guardó. */
export async function guardarCiiu(
  tx: TxConsulta,
  entradas: { ruc: string; ciiu: string | null }[],
): Promise<number> {
  if (!Array.isArray(entradas)) throw new GastosRepoError(ARGUMENTO_INVALIDO);
  const limpias = (entradas as unknown[]).map((x) => {
    const { ruc, ciiu } = Object(x) as { ruc?: unknown; ciiu?: unknown };
    if (typeof ruc !== "string" || (ciiu !== null && typeof ciiu !== "string"))
      throw new GastosRepoError(ARGUMENTO_INVALIDO);
    return { ruc, ciiu };
  });
  const [f] = await consultarGastos(tx, SQL_GUARDAR, [JSON.stringify(limpias)]);
  return Number(f!.n);
}

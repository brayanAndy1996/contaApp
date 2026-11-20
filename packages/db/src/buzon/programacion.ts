// Programación del buzón SOL (spec 023, D-5, D-6): funciones acotadas de 0055. `candidatosBuzon` y `encolarBuzonProgramados` van
// con la `tx` de withTenant del worker; `elevarPrioridadBuzon`, con la del backend. Errores: BuzonRepoError con solo el SQLSTATE.
import { consultar, type TxConsulta } from "./errores";

export interface CandidatoBuzon {
  clienteId: string;
  ultimaProgramadaEn: Date | null;
}

const SQL_CANDIDATOS =
  "select cliente_id, ultima_programada_en from buzon_candidatos()";
const SQL_ENCOLAR = "select * from encolar_buzon_programados($1::uuid[])";
const SQL_ELEVAR = "select buzon_elevar_prioridad($1::uuid)";

/** Clientes del estudio no archivados, con credencial SOL lista y sin captura viva, con su última franja consumida. */
export async function candidatosBuzon(
  tx: TxConsulta,
): Promise<CandidatoBuzon[]> {
  const r = await consultar(tx, SQL_CANDIDATOS, []);
  return r.rows.map((f) => ({
    clienteId: String(f.cliente_id),
    ultimaProgramadaEn:
      f.ultima_programada_en === null || f.ultima_programada_en === undefined
        ? null
        : f.ultima_programada_en instanceof Date
          ? f.ultima_programada_en
          : new Date(String(f.ultima_programada_en)),
  }));
}

/** Ids de los trabajos creados (los clientes que ya no cumplen se omiten). Con lista vacía no consulta y devuelve []. */
export async function encolarBuzonProgramados(
  tx: TxConsulta,
  clienteIds: string[],
): Promise<string[]> {
  if (clienteIds.length === 0) return [];
  const r = await consultar(tx, SQL_ENCOLAR, [clienteIds]);
  return r.rows.map((f) => String(Object.values(f)[0]));
}

/** `true` si el trabajo era un `sol.buzon.revisar` programado en cola del estudio y pasó a interactivo. */
export async function elevarPrioridadBuzon(
  tx: TxConsulta,
  trabajoId: string,
): Promise<boolean> {
  const f = (await consultar(tx, SQL_ELEVAR, [trabajoId])).rows[0];
  return f !== undefined && Object.values(f)[0] === true;
}

// Ciclo programado de correo (spec 028; R-5, R-12, R-14): funciones de 0074 con la `tx` del worker. `estudiosCorreo`,
// `tomarCicloCorreo`, `renovarCicloCorreo`, `soltarCicloCorreo` y `cerrarResumenCorreo` van con `withSistema` (sin estudio);
// `encolarAvisosCorreo`, `crearResumenesCorreo` y `purgarCorreo`, con `withTenant` del estudio.
import {
  ARGUMENTO_INVALIDO,
  consultarCorreo,
  CorreoRepoError,
  exigirDia,
  exigirEntero,
  type TxConsulta,
} from "./errores";

export interface EstudioCorreo {
  tenantId: string;
  avisos: boolean;
  resumen: boolean;
}

export interface CicloCorreo {
  /** AAAA-MM-DD de Lima del resumen que toca crear en este ciclo; null si no toca. */
  resumenDia: string | null;
}

const SQL = {
  estudios: "select tenant_id, avisos, resumen from sistema.estudios_correo()",
  tomar: "select sistema.correo_ciclo_tomar($1::text) as correo_ciclo_tomar",
  renovar: "select sistema.correo_ciclo_renovar($1::text) as correo_ciclo_renovar",
  soltar: "select sistema.correo_ciclo_soltar($1::text)",
  cerrar: "select sistema.correo_resumen_cerrar($1::text, $2::date)",
  encolar: "select encolar_correo_avisos($1::int) as n",
  crear: "select crear_correo_resumenes($1::date) as n",
  purgar: "select correo_purgar($1::int) as n",
};

/** Dueño del candado: texto de 1 a 200 caracteres; si no, 22023 sin ir a la BD. */
function exigirDueno(v: unknown): string {
  if (typeof v !== "string" || v.length < 1 || v.length > 200)
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/** El único valor de la primera fila, sea cual sea el nombre de su columna. */
const valor = (filas: Record<string, unknown>[]): unknown => {
  const f = filas[0];
  return f === undefined ? undefined : Object.values(f)[0];
};

export async function estudiosCorreo(
  tx: TxConsulta,
): Promise<EstudioCorreo[]> {
  const filas = await consultarCorreo(tx, SQL.estudios, []);
  return filas.map((f) => ({
    tenantId: String(f.tenant_id),
    avisos: f.avisos === true,
    resumen: f.resumen === true,
  }));
}

/** null si otro dueño tiene el candado. */
export async function tomarCicloCorreo(
  tx: TxConsulta,
  dueno: string,
): Promise<CicloCorreo | null> {
  const d = exigirDueno(dueno);
  const r = valor(await consultarCorreo(tx, SQL.tomar, [d]));
  if (r === null || r === undefined || typeof r !== "object") return null;
  const dia = (r as Record<string, unknown>).resumenDia;
  return { resumenDia: typeof dia === "string" ? dia : null };
}

/** false si perdió el candado (otro lo tomó o ya se soltó); vencido pero aún suyo, lo renueva (0076, H-028-2-1). */
export async function renovarCicloCorreo(
  tx: TxConsulta,
  dueno: string,
): Promise<boolean> {
  const d = exigirDueno(dueno);
  return valor(await consultarCorreo(tx, SQL.renovar, [d])) === true;
}

export async function soltarCicloCorreo(
  tx: TxConsulta,
  dueno: string,
): Promise<void> {
  const d = exigirDueno(dueno);
  await consultarCorreo(tx, SQL.soltar, [d]);
}

/** Cierra el día del resumen (`dia` AAAA-MM-DD) solo si `dueno` sigue teniendo el candado. */
export async function cerrarResumenCorreo(
  tx: TxConsulta,
  dueno: string,
  dia: string,
): Promise<void> {
  const d = exigirDueno(dueno);
  const fecha = exigirDia(dia);
  await consultarCorreo(tx, SQL.cerrar, [d, fecha]);
}

/** Cantidad de envíos `aviso` vencidos que pasaron a la cola (a lo sumo `limite`, entero de 1 a 100000). */
export async function encolarAvisosCorreo(
  tx: TxConsulta,
  limite: number,
): Promise<number> {
  const l = exigirEntero(limite, 1, 100_000);
  return Number(valor(await consultarCorreo(tx, SQL.encolar, [l])) ?? 0);
}

/** Cantidad de envíos de resumen o pendientes creados para el día (`dia` AAAA-MM-DD de Lima). */
export async function crearResumenesCorreo(
  tx: TxConsulta,
  dia: string,
): Promise<number> {
  const fecha = exigirDia(dia);
  return Number(valor(await consultarCorreo(tx, SQL.crear, [fecha])) ?? 0);
}

/** Envíos borrados (con sus avisos y tokens) con más de `dias` días; también los avisos diferidos y tokens sueltos. */
export async function purgarCorreo(
  tx: TxConsulta,
  dias: number,
): Promise<number> {
  const d = exigirEntero(dias, 1, 36_500);
  return Number(valor(await consultarCorreo(tx, SQL.purgar, [d])) ?? 0);
}

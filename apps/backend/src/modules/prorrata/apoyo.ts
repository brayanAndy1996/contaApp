// Auxiliares del módulo prorrata (spec 026): periodos en hora de Lima y errores de BD → HTTP. Nada aquí lleva RUC, montos ni motivos
// a un error o a un log (D-7): los errores salen como códigos.
import { ProrrataRepoError } from "@contapp/db";
import { periodoProrrataSchema } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { periodosAImportar } from "../aprendizaje/periodos.js";
import { ProrrataError } from "./errores.js";

export { exigirCliente } from "../compras/apoyo.js";

/** Lima no tiene horario de verano: UTC-5 todo el año (mismo criterio que 025 y el catálogo de la cola). */
const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;

/** Mes en curso en hora de Lima (AAAAMM), con el reloj de `Date` (inyectable en las pruebas). */
export function periodoEnCursoLima(ahoraMs: number): string {
  const lima = new Date(ahoraMs - HUSO_LIMA_MS);
  return `${lima.getUTCFullYear()}${String(lima.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mes anterior al en curso (hora de Lima): el periodo por omisión de la pantalla (R-1). */
export function periodoPorOmision(ahoraMs: number): string {
  return periodosAImportar(1, ahoraMs)[0] as string;
}

/** Periodo de una ruta (historial, manual, usada): AAAAMM con mes 01–12, si no 400 `solicitud_invalida`. */
export function periodoDeRuta(valor: unknown): string {
  const r = periodoProrrataSchema.safeParse(valor);
  if (!r.success) throw new AccesoError("solicitud_invalida");
  return r.data;
}

/**
 * Periodo M de la lectura o de la obtención: mal formado → 400 `solicitud_invalida`; posterior al mes en curso en Lima → 400
 * `periodo_futuro`. Sin periodo (`undefined`), el mes anterior (solo la lectura lo admite).
 */
export function periodoCalculable(valor: unknown, ahoraMs: number, porOmision: boolean): string {
  if (valor === undefined && porOmision) return periodoPorOmision(ahoraMs);
  const periodo = periodoDeRuta(valor);
  if (periodo > periodoEnCursoLima(ahoraMs)) throw new ProrrataError("periodo_futuro");
  return periodo;
}

/**
 * SQLSTATE de las funciones de 0066 → HTTP (plan 026, «HTTP»): `P0002` → 404 (cliente ajeno o inexistente: el mismo 404), `55000` →
 * 409 `cliente_archivado`, `CA409` → 409 `mes_cambiado`, `CA412` → 409 `mes_declarado`, `CA413` → 409 `prorrata_declarada`, `22023` →
 * 400 `solicitud_invalida`. Cualquier otro error pasa tal cual (los interbloqueos los reintenta `conReintentoUnico`; el resto el
 * filtro global lo responde 500 sin detalle).
 */
export function aErrorHttp(e: unknown): unknown {
  if (!(e instanceof ProrrataRepoError)) return e;
  switch (e.codigo) {
    case "P0002":
      return new AccesoError("no_encontrado");
    case "55000":
      return new AccesoError("cliente_archivado");
    case "CA409":
      return new ProrrataError("mes_cambiado");
    case "CA412":
      return new ProrrataError("mes_declarado");
    case "CA413":
      return new ProrrataError("prorrata_declarada");
    case "22023":
      return new AccesoError("solicitud_invalida");
    default:
      return e;
  }
}

/** Instante completo en ISO 8601 UTC (`2026-11-20T15:00:00.000Z`). */
export const aInstante = (f: Date): string => f.toISOString();

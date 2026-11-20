// Cursor de la bandeja (spec 024, plan «Cursor»). Es solo una posición `(fecha, id)` más la huella de los filtros y de la ruta: no
// lleva estudio ni usuario ni es una credencial, así que no se firma; el alcance se aplica siempre en SQL y un cursor armado a mano
// no amplía nada. `f` es la fecha en texto UTC con microsegundos tal como la produjo la BD (nunca pasa por `Date`: se perdería el
// microsegundo y se repetirían u omitirían filas con la misma fecha).
import { createHash } from "node:crypto";
import { esUuid } from "../clientes/contexto.js";
import { BuzonError } from "./errores.js";

export interface PosicionCursor {
  fecha: string;
  id: string;
}

/** Filtros que forman parte de la huella (sin `cursor` ni `limite`), ya normalizados. */
export interface HuellaFiltros {
  atencion: string;
  categoria?: string | undefined;
  leido?: string | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
  archivados?: boolean | undefined;
  responsable?: boolean | undefined;
}

const VERSION = 1;
const LARGO_MAX = 256;
const FECHA_BD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const HUELLA = /^[0-9a-f]{16}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Primeros 16 hex de `sha256` del JSON canónico (orden fijo) de la ruta y los filtros. `ruta`: `global` o `cliente:<id>`. */
export function huellaDe(ruta: string, f: HuellaFiltros): string {
  const canonico = JSON.stringify([
    ruta.toLowerCase(),
    f.atencion,
    f.categoria ?? null,
    f.leido ?? null,
    f.desde ?? null,
    f.hasta ?? null,
    f.archivados === true,
    f.responsable === true,
  ]);
  return createHash("sha256").update(canonico, "utf8").digest("hex").slice(0, 16);
}

/** `base64url(JSON {v, f, i, h})` de la última fila de la página. */
export function codificarCursor(pos: PosicionCursor, huella: string): string {
  return Buffer.from(JSON.stringify({ v: VERSION, f: pos.fecha, i: pos.id, h: huella }), "utf8").toString("base64url");
}

/** La fecha existe en el calendario y tiene la forma exacta de la BD (año ≥ 1, sin desbordes como el 31 de febrero). */
function fechaValida(f: string): boolean {
  if (!FECHA_BD.test(f) || f.startsWith("0000")) return false;
  const ms = new Date(`${f.slice(0, 23)}Z`).getTime();
  return !Number.isNaN(ms) && new Date(ms).toISOString() === `${f.slice(0, 23)}Z`;
}

/**
 * Decodifica el cursor de ESTA consulta. Cualquier otra cosa (largo, base64 o JSON inválidos, versión distinta, claves de más o de
 * menos, fecha o id con otra forma, huella de otros filtros u otra ruta) es 400 `cursor_invalido`.
 */
export function decodificarCursor(cursor: string, huellaEsperada: string): PosicionCursor {
  const invalido = new BuzonError("cursor_invalido");
  if (cursor.length === 0 || cursor.length > LARGO_MAX || !BASE64URL.test(cursor)) throw invalido;
  let valor: unknown;
  try {
    valor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalido;
  }
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) throw invalido;
  const { v, f, i, h, ...resto } = valor as Record<string, unknown>;
  if (Object.keys(resto).length > 0 || v !== VERSION) throw invalido;
  if (typeof f !== "string" || typeof i !== "string" || typeof h !== "string") throw invalido;
  if (!fechaValida(f) || !esUuid(i) || !HUELLA.test(h) || h !== huellaEsperada) throw invalido;
  return { fecha: f, id: i.toLowerCase() };
}

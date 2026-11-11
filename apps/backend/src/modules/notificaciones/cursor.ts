import { AccesoError } from "../acceso/errores.js";

// Spec 017 (CA-12, P-2). Cursor OPACO de las páginas de notificaciones y auditoría: la posición `(instante, id)` de la
// última fila entregada, en JSON base64url. El cliente solo lo devuelve tal cual; uno mal formado es 400.
const MAX_CURSOR = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Posición `(instante, id)` que usan `listarNotificaciones` y `listarAuditoria`. */
export interface PosicionCursor {
  en: Date;
  id: string;
}

export function codificarCursor(p: PosicionCursor): string {
  return Buffer.from(JSON.stringify({ e: p.en.toISOString(), i: p.id }), "utf8").toString("base64url");
}

const invalido = (): never => {
  throw new AccesoError("solicitud_invalida");
};

/** `undefined` = primera página. Todo lo que no sea un cursor emitido por `codificarCursor` es 400 `solicitud_invalida`. */
export function decodificarCursor(cursor: string | undefined): PosicionCursor | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length === 0 || cursor.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalido();
  let crudo: unknown;
  try {
    crudo = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return invalido();
  }
  if (typeof crudo !== "object" || crudo === null || Array.isArray(crudo)) return invalido();
  const claves = Object.keys(crudo).sort();
  const { e, i } = crudo as Record<string, unknown>;
  if (claves.length !== 2 || claves[0] !== "e" || claves[1] !== "i") return invalido();
  if (typeof e !== "string" || !ISO.test(e) || typeof i !== "string" || !UUID.test(i)) return invalido();
  const en = new Date(e);
  if (Number.isNaN(en.getTime())) return invalido();
  return { en, id: i.toLowerCase() };
}

/** Consulta de las dos listas: solo `cursor`; cualquier otra clave (`usuarioId`, `tenantId`, `limite`…) es 400 (CA-4). */
export function leerConsulta(query: unknown): PosicionCursor | undefined {
  const q = query ?? {};
  if (typeof q !== "object" || Array.isArray(q)) return invalido();
  const claves = Object.keys(q);
  if (claves.some((c) => c !== "cursor")) return invalido();
  const cursor = (q as { cursor?: unknown }).cursor;
  if (cursor !== undefined && typeof cursor !== "string") return invalido();
  return decodificarCursor(cursor);
}

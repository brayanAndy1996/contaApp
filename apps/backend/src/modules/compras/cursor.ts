// Cursor opaco del listado de compras (spec 014, D-13): la posición (fecha, serie, número, id) de la última fila entregada, en
// base64url. El servidor lo decodifica con una validación estricta: cualquier otra cosa es un 400 `solicitud_invalida`.
import type { CursorListadoCompras } from "@contapp/db";
import { CURSOR_MAX } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { esUuid } from "../clientes/contexto.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FECHA = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/;
const PARTE = /^[0-9A-Za-z-]{1,20}$/;

export function codificarCursor(c: CursorListadoCompras): string {
  return Buffer.from(JSON.stringify({ f: c.fecha, s: c.serie, n: c.numero, i: c.id }), "utf8").toString("base64url");
}

const parteValida = (v: unknown): v is string => typeof v === "string" && PARTE.test(v);
/** Una fecha que existe en el calendario (el patrón solo comprueba la forma: 2026-02-31 no es una fecha). */
const fechaReal = (v: string): boolean => new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function decodificarCursor(texto: string): CursorListadoCompras {
  const invalido = new AccesoError("solicitud_invalida");
  if (texto.length > CURSOR_MAX || !BASE64URL.test(texto)) throw invalido;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(texto, "base64url").toString("utf8"));
  } catch {
    throw invalido;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalido;
  const { f, s, n, i, ...resto } = v as Record<string, unknown>;
  if (Object.keys(resto).length > 0) throw invalido;
  if (typeof f !== "string" || !FECHA.test(f) || !fechaReal(f) || !parteValida(s) || !parteValida(n) || typeof i !== "string" || !esUuid(i)) {
    throw invalido;
  }
  return { fecha: f, serie: s, numero: n, id: i };
}

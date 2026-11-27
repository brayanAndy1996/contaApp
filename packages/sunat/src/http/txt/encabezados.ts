/**
 * Encabezados del TXT del SIRE (plan 041, Decisiones «Encabezado»; spec CA-5, P-1): las columnas se buscan por NOMBRE
 * normalizado, nunca por posición. Errores con mensaje fijo: no copian el encabezado recibido.
 */
import { ErrorPortalSire } from "../../errores.js";

/** Quita el BOM, NFC, colapsa espacios y tabuladores en uno, recorta y pasa a minúsculas. Tildes y puntuación se conservan. */
export function normalizarEncabezado(texto: string): string {
  return texto.replace(/^﻿+/, "").normalize("NFC").replace(/[ \t]+/g, " ").trim().toLowerCase();
}

/**
 * Índice de cada columna requerida (bajo su nombre normalizado). Requerida ausente o repetida (ya normalizada) ->
 * `ErrorPortalSire("encabezado")`; las columnas que no se piden, aunque estén repetidas, se ignoran.
 */
export function indicesPorEncabezado(encabezado: readonly string[], requeridas: readonly string[]): ReadonlyMap<string, number> {
  if (encabezado.length === 0) throw new ErrorPortalSire("encabezado");
  const pedidas = new Set(requeridas.map(normalizarEncabezado));
  const indices = new Map<string, number>();
  const repetidas = new Set<string>();
  encabezado.forEach((celda, i) => {
    const n = normalizarEncabezado(celda);
    if (!pedidas.has(n)) return;
    if (indices.has(n)) repetidas.add(n);
    else indices.set(n, i);
  });
  if (repetidas.size > 0 || indices.size !== pedidas.size) throw new ErrorPortalSire("encabezado");
  return indices;
}

/** Mismo encabezado (columna a columna, ya normalizado): las partes de un ticket deben coincidir (CA-9). */
export function mismoEncabezado(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((celda, i) => normalizarEncabezado(celda) === normalizarEncabezado(b[i] ?? ""));
}

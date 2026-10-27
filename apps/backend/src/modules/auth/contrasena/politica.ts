import { readFileSync } from "node:fs";
import { longitudContrasenaValida } from "@contapp/shared";
import { ContrasenaInvalidaError, type MotivoContrasena } from "../errores.js";
import type { Hasher } from "./hasher.js";

/** Lee `comunes.txt` (junto a este módulo): una por línea, minúsculas, sin líneas vacías. */
export function cargarComunes(): ReadonlySet<string> {
  const texto = readFileSync(new URL("./comunes.txt", import.meta.url), "utf8");
  const comunes = new Set<string>();
  for (const linea of texto.split(/\r?\n/)) {
    const entrada = linea.trim().toLowerCase();
    if (entrada !== "") comunes.add(entrada);
  }
  return comunes;
}

/** P5: longitud 12..128 puntos de código (se evalúa primero) y no estar en la lista de comunes. */
export function validarContrasena(
  plano: string,
  comunes: ReadonlySet<string>,
): MotivoContrasena | null {
  if (!longitudContrasenaValida(plano)) return "longitud";
  if (comunes.has(plano.toLowerCase())) return "comun";
  return null;
}

/** Política + hash. Función de dominio que reutiliza la spec 005 (invitaciones). */
export async function fijarContrasena(
  plano: string,
  deps: { hasher: Hasher; comunes: ReadonlySet<string> },
): Promise<string> {
  const motivo = validarContrasena(plano, deps.comunes);
  if (motivo !== null) throw new ContrasenaInvalidaError(motivo);
  return deps.hasher.calcular(plano);
}

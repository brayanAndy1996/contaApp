// Periodo de las rutas de archivos (spec 012b): AAAAMM con mes 01 a 12 y sin futuro. El catálogo de la cola solo valida la forma de
// `archivo.generar`, así que lo futuro se rechaza aquí, igual que `periodoSireSchema` de 008 para la descarga.
import { AccesoError } from "../acceso/errores.js";
import { periodoDe } from "../compras/apoyo.js";

const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;

/** Mes en curso (hora de Lima, UTC-5) como AAAAMM; se evalúa en cada petición. */
function periodoEnCurso(ahora: Date = new Date()): string {
  const lima = new Date(ahora.getTime() - HUSO_LIMA_MS);
  return `${lima.getUTCFullYear()}${String(lima.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 400 `solicitud_invalida` si el periodo no es AAAAMM, su mes no es 01 a 12 o es posterior al mes en curso. */
export function periodoArchivoDe(valor: string): string {
  const periodo = periodoDe(valor);
  if (periodo > periodoEnCurso()) throw new AccesoError("solicitud_invalida");
  return periodo;
}

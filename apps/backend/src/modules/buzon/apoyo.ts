// Auxiliares del módulo buzón (spec 023): enfriamiento, credencial SOL, estado de captura y ruta de storage del cliente.
import { leerEstadoCredenciales, type EstadoBuzon as EstadoBuzonFila, type Tx } from "@contapp/db";
import type { EstadoBuzon } from "@contapp/shared";
import { validarRuta } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import { BuzonError } from "./errores.js";

export { exigirCliente, idDe } from "../ventas/apoyo.js";

/** Enfriamiento de «Revisar ahora» por cliente (P-6): desde la última solicitud o captura terminada. */
export const ENFRIAMIENTO_MS = 10 * 60_000;
/** Mensajes por página cuando la petición no trae `limite`. */
export const LIMITE_POR_OMISION = 50;

/**
 * La credencial SOL del cliente debe estar lista: sin ella, 409 `credencial_no_configurada`; marcada inválida, 409
 * `credencial_invalida`. `configurada` (sin verificar) y `verificada` bastan. La de SIRE no cuenta.
 */
export async function exigirCredencialSol(tx: Tx, clienteId: string): Promise<void> {
  const sol = (await leerEstadoCredenciales(tx, clienteId)).find((f) => f.tipo === "sol");
  if (sol === undefined) throw new AccesoError("credencial_no_configurada");
  if (sol.estado === "invalida") throw new BuzonError("credencial_invalida");
}

/**
 * Segundos hasta que vence el enfriamiento (1..600), o `null` si ya pasó o nunca hubo solicitud ni captura. `fallaPorCredencialEn`
 * es cuándo terminó la última captura por credencial inválida (si fue la última): ni ella ni la solicitud que la originó cuentan,
 * es decir, no cuenta ninguna fecha anterior o igual a ese instante; lo posterior sí.
 */
export function esperaDeEnfriamiento(
  estado: EstadoBuzonFila,
  ahora: number,
  fallaPorCredencialEn: Date | null = null,
): number | null {
  const instantes = [estado.ultimaSolicitudEn, estado.ultimaCapturaEn].filter(
    (f): f is Date => f !== null && (fallaPorCredencialEn === null || f.getTime() > fallaPorCredencialEn.getTime()),
  );
  if (instantes.length === 0) return null;
  const fin = Math.max(...instantes.map((f) => f.getTime())) + ENFRIAMIENTO_MS;
  if (fin <= ahora) return null;
  return Math.min(Math.ceil((fin - ahora) / 1000), ENFRIAMIENTO_MS / 1000);
}

/** Estado de captura para la pantalla; sin fila de estado: todo en blanco. `revisarDesde` es el fin del enfriamiento de 10 min. */
export function aEstado(e: EstadoBuzonFila | null, ahora: number): EstadoBuzon {
  if (e === null) return { ultimaCaptura: null, sincronizado: false, revisarDesde: null };
  const instantes = [e.ultimaSolicitudEn, e.ultimaCapturaEn].filter((f): f is Date => f !== null);
  const fin = instantes.length === 0 ? null : Math.max(...instantes.map((f) => f.getTime())) + ENFRIAMIENTO_MS;
  return {
    ultimaCaptura: e.ultimaCapturaEn === null ? null : e.ultimaCapturaEn.toISOString(),
    sincronizado: e.sincronizadoEn !== null,
    revisarDesde: fin !== null && fin > ahora ? new Date(fin).toISOString() : null,
  };
}

/**
 * `true` si `ruta` cumple la gramática de storage y cuelga de `buzon/{estudio}/{cliente}/`. Toda lectura de storage del módulo
 * pasa por aquí antes de `storage.leer`: la ruta sale de una fila y el CHECK de la BD solo valida su forma.
 */
export function rutaDelCliente(ruta: string, tenantId: string, clienteId: string): boolean {
  try {
    validarRuta(ruta);
  } catch {
    return false;
  }
  return ruta.startsWith(`buzon/${tenantId.toLowerCase()}/${clienteId.toLowerCase()}/`);
}

/** MIME de la fila solo si es de la forma `tipo/subtipo`; si no, genérico (el decidido por firma al guardar siempre lo es). */
export function mimeSeguro(mime: string | null): string {
  return mime !== null && /^[a-z]+\/[a-z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

/** `Content-Disposition: attachment` con el nombre ya saneado: respaldo ASCII y `filename*` en RFC 5987. */
export function disposicionAdjunta(nombre: string): string {
  const ascii = nombre.replace(/[^A-Za-z0-9._-]/g, "_");
  const codificado = encodeURIComponent(nombre).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${codificado}`;
}

/** SQLSTATE de un error de la BD (el de un repositorio o el de `pg` directo), o `null`. */
export function sqlstateDe(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { codigo, code } = e as { codigo?: unknown; code?: unknown };
  const valor = typeof codigo === "string" ? codigo : code;
  return typeof valor === "string" && /^[0-9A-Z]{5}$/.test(valor) ? valor : null;
}

/** SQLSTATE de BD que se mapean a la API (spec 024): el interbloqueo y el fallo de serialización se reintentan una vez. */
export function esReintentable(e: unknown): boolean {
  const c = sqlstateDe(e);
  return c === "40P01" || c === "40001";
}

/**
 * Corre una transacción de escritura y la repite UNA vez si falla por interbloqueo (`40P01`) o serialización (`40001`): el orden de
 * bloqueo de 0060 los hace raros, no imposibles. Si falla otra vez, 503 `atenciones_ocupadas`. `fn` abre su propio `withTenant`.
 */
export async function conReintentoUnico<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!esReintentable(e)) throw e;
  }
  try {
    return await fn();
  } catch (e) {
    if (esReintentable(e)) throw new BuzonError("atenciones_ocupadas");
    throw e;
  }
}

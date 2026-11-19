// Auxiliares del módulo buzón (spec 023): enfriamiento, credencial SOL, cursor opaco y ruta de storage del cliente.
import { leerEstadoCredenciales, type EstadoBuzon, type Tx } from "@contapp/db";
import { validarRuta } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import { esUuid } from "../clientes/contexto.js";
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
  estado: EstadoBuzon,
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

/** Cursor opaco de la lista: base64url de `{ f: fecha ISO, i: id }` del último mensaje de la página. */
export function codificarCursor(fecha: Date, id: string): string {
  return Buffer.from(JSON.stringify({ f: fecha.toISOString(), i: id }), "utf8").toString("base64url");
}

/** Decodifica un cursor propio; cualquier otra cosa es 400 `solicitud_invalida` (nunca llega a la consulta). */
export function decodificarCursor(cursor: string): { fecha: Date; id: string } {
  const invalido = new AccesoError("solicitud_invalida");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalido;
  let valor: unknown;
  try {
    valor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalido;
  }
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) throw invalido;
  const { f, i, ...resto } = valor as Record<string, unknown>;
  if (Object.keys(resto).length > 0 || typeof f !== "string" || typeof i !== "string" || !esUuid(i)) throw invalido;
  const fecha = new Date(f);
  if (Number.isNaN(fecha.getTime()) || fecha.toISOString() !== f) throw invalido;
  return { fecha, id: i.toLowerCase() };
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

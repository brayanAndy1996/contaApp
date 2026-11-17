// Spec 023 (CA-8, D-4, P-10): adjuntos del buzón. Nombre saneado, MIME por firma (lo declarado
// no cuenta) y topes por adjunto y por mensaje. El ZIP es opaco: nunca se abre.

export const TOPE_ADJUNTO_BYTES = 20 * 1024 * 1024;
export const TOPE_MENSAJE_BYTES = 50 * 1024 * 1024;

export type AdjuntoRecibido =
  | {
      readonly idSunat: string;
      readonly nombre: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly idSunat: string;
      readonly nombre: string;
      readonly omitido: "tamano";
    };

export type MotivoOmision = "mime" | "tamano" | "tope_mensaje";

export interface AdjuntoAGuardar {
  readonly idSunat: string;
  /** Nombre saneado. */
  readonly nombre: string;
  readonly mime: string;
  readonly ext: string;
  readonly bytes: Uint8Array;
}

export interface AdjuntoOmitido {
  readonly idSunat: string;
  /** Nombre saneado. */
  readonly nombre: string;
  readonly motivo: MotivoOmision;
}

const LARGO_MAXIMO_NOMBRE = 120;
const LARGO_MAXIMO_EXTENSION = 10;
const NOMBRE_POR_DEFECTO = "adjunto";
/** Controles, formato (bidi, ancho cero) y sustitutos sueltos. */
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/** Primeros `largo` puntos de código (no parte un par sustituto). */
function cortar(texto: string, largo: number): string {
  return Array.from(texto).slice(0, largo).join("");
}

function largoEnPuntos(texto: string): number {
  return Array.from(texto).length;
}

export function sanearNombreAdjunto(nombre: string): string {
  const limpio = nombre.normalize("NFC").replace(INVISIBLES, "");
  const corte = Math.max(limpio.lastIndexOf("/"), limpio.lastIndexOf("\\"));
  const base = limpio.slice(corte + 1).trim();
  if (base.length === 0 || base === "." || base === "..") {
    return NOMBRE_POR_DEFECTO;
  }
  if (largoEnPuntos(base) <= LARGO_MAXIMO_NOMBRE) return base;

  // Demasiado largo: conserva la extensión corta y recorta el resto.
  const punto = base.lastIndexOf(".");
  const ext = punto > 0 ? base.slice(punto) : "";
  if (ext.length > 1 && largoEnPuntos(ext) <= LARGO_MAXIMO_EXTENSION) {
    const cuerpo = cortar(
      base.slice(0, punto),
      LARGO_MAXIMO_NOMBRE - largoEnPuntos(ext),
    ).trim();
    if (cuerpo.length > 0) return `${cuerpo}${ext}`;
  }
  const recortado = cortar(base, LARGO_MAXIMO_NOMBRE).trim();
  return recortado.length > 0 ? recortado : NOMBRE_POR_DEFECTO;
}

interface Firma {
  readonly bytes: readonly number[];
  readonly mime: string;
  readonly ext: string;
}

const FIRMAS: readonly Firma[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mime: "application/pdf", ext: "pdf" },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mime: "image/png",
    ext: "png",
  },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", ext: "jpg" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip", ext: "zip" },
  // ZIP vacío (solo el directorio central).
  { bytes: [0x50, 0x4b, 0x05, 0x06], mime: "application/zip", ext: "zip" },
];

/** "<?xml" seguido de espacio, opcionalmente tras el BOM de UTF-8. */
const PROLOGO_XML = [0x3c, 0x3f, 0x78, 0x6d, 0x6c];
const BOM_UTF8 = [0xef, 0xbb, 0xbf];

function empiezaCon(
  bytes: Uint8Array,
  firma: readonly number[],
  desde = 0,
): boolean {
  if (bytes.length < desde + firma.length) return false;
  return firma.every((b, i) => bytes[desde + i] === b);
}

function esXml(bytes: Uint8Array): boolean {
  const inicio = empiezaCon(bytes, BOM_UTF8) ? BOM_UTF8.length : 0;
  if (!empiezaCon(bytes, PROLOGO_XML, inicio)) return false;
  const tras = bytes[inicio + PROLOGO_XML.length];
  return tras === 0x20 || tras === 0x09 || tras === 0x0a || tras === 0x0d;
}

/** Lista blanca por firma: PDF, XML, PNG, JPEG y ZIP opaco; `null` si no está. */
export function mimePorFirma(
  bytes: Uint8Array,
): { mime: string; ext: string } | null {
  for (const f of FIRMAS) {
    if (empiezaCon(bytes, f.bytes)) return { mime: f.mime, ext: f.ext };
  }
  if (esXml(bytes)) return { mime: "application/xml", ext: "xml" };
  return null;
}

/**
 * En orden de llegada: lo omitido por el portal o de más de `TOPE_ADJUNTO_BYTES` → `tamano`;
 * fuera de la lista blanca → `mime`; lo que haría pasar `TOPE_MENSAJE_BYTES` → `tope_mensaje`
 * (uno más chico que venga después sí entra si cabe). Lo omitido no gasta el tope del mensaje.
 */
export function prepararAdjuntos(adjuntos: readonly AdjuntoRecibido[]): {
  guardar: AdjuntoAGuardar[];
  omitidos: AdjuntoOmitido[];
} {
  const guardar: AdjuntoAGuardar[] = [];
  const omitidos: AdjuntoOmitido[] = [];
  let usados = 0;
  for (const a of adjuntos) {
    const nombre = sanearNombreAdjunto(a.nombre);
    if (!("bytes" in a)) {
      omitidos.push({ idSunat: a.idSunat, nombre, motivo: "tamano" });
      continue;
    }
    if (a.bytes.length > TOPE_ADJUNTO_BYTES) {
      omitidos.push({ idSunat: a.idSunat, nombre, motivo: "tamano" });
      continue;
    }
    const tipo = mimePorFirma(a.bytes);
    if (tipo === null) {
      omitidos.push({ idSunat: a.idSunat, nombre, motivo: "mime" });
      continue;
    }
    if (usados + a.bytes.length > TOPE_MENSAJE_BYTES) {
      omitidos.push({ idSunat: a.idSunat, nombre, motivo: "tope_mensaje" });
      continue;
    }
    usados += a.bytes.length;
    guardar.push({
      idSunat: a.idSunat,
      nombre,
      mime: tipo.mime,
      ext: tipo.ext,
      bytes: a.bytes,
    });
  }
  return { guardar, omitidos };
}

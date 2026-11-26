// Spec 028 · cuerpo de la baja de un clic de RFC 8058 (§3.1): el cliente de correo hace `POST` a la URL de `List-Unsubscribe` con el
// campo `List-Unsubscribe=One-Click`, en `multipart/form-data` (SHOULD) o `application/x-www-form-urlencoded` (MAY). H-028-2-8: se aceptan
// las dos formas y nada más. Puro: no registra ni devuelve el cuerpo.

/** Cuerpo exacto en `application/x-www-form-urlencoded`. */
export const CUERPO_UN_CLIC = "List-Unsubscribe=One-Click";

const MULTIPART = /^\s*multipart\/form-data\s*(?:;|$)/i;
/** `boundary` de RFC 2046: 1 a 70 caracteres, entre comillas o como token. */
const LIMITE = /;\s*boundary\s*=\s*(?:"([^"\r\n]{1,70})"|([^\s;"]{1,70}))\s*(?:;|$)/i;
const DISPOSICION = /^form-data\s*;\s*name\s*=\s*(?:"([^"]*)"|([^\s;"]+))\s*$/i;
const CRLF = "\r\n";

/**
 * true solo si `cuerpo` (los bytes que `app.ts` leyó crudos) es la petición de un clic de RFC 8058 para `tipoContenido`: el cuerpo
 * urlencoded exacto o un `multipart/form-data` con una sola parte `name="List-Unsubscribe"` y valor `One-Click` (sin archivo).
 */
export function esCuerpoUnClic(cuerpo: unknown, tipoContenido: string | undefined): boolean {
  if (!Buffer.isBuffer(cuerpo)) return false;
  const texto = cuerpo.toString("latin1");
  if (typeof tipoContenido === "string" && MULTIPART.test(tipoContenido)) {
    const m = LIMITE.exec(tipoContenido);
    const limite = m?.[1] ?? m?.[2];
    return limite !== undefined && multipartUnClic(texto, limite);
  }
  return texto === CUERPO_UN_CLIC;
}

/** Una sola parte (`--límite` CRLF cabeceras CRLF CRLF valor CRLF `--límite--`), sin preámbulo y con a lo sumo un CRLF de epílogo. */
function multipartUnClic(texto: string, limite: string): boolean {
  const delimitador = `--${limite}`;
  const cierre = `${CRLF}${delimitador}--`;
  if (!texto.startsWith(`${delimitador}${CRLF}`)) return false;
  const fin = texto.indexOf(cierre);
  if (fin < 0) return false;
  const epilogo = texto.slice(fin + cierre.length);
  if (epilogo !== "" && epilogo !== CRLF) return false;
  const parte = texto.slice(delimitador.length + CRLF.length, fin);
  if (parte.includes(`${CRLF}${delimitador}`)) return false;
  const corte = parte.indexOf(`${CRLF}${CRLF}`);
  if (corte < 0 || parte.slice(corte + 2 * CRLF.length) !== "One-Click") return false;
  return nombreDeLaParte(parte.slice(0, corte).split(CRLF)) === "List-Unsubscribe";
}

/** Nombre del campo según `Content-Disposition`; null si falta, se repite, trae otra cabecera que no sea `Content-Type: text/plain`. */
function nombreDeLaParte(cabeceras: readonly string[]): string | null {
  let nombre: string | null = null;
  for (const linea of cabeceras) {
    const i = linea.indexOf(":");
    if (i <= 0) return null;
    const campo = linea.slice(0, i).trim().toLowerCase();
    const valor = linea.slice(i + 1).trim();
    if (campo === "content-disposition") {
      const d = DISPOSICION.exec(valor);
      if (d === null || nombre !== null) return null;
      nombre = d[1] ?? d[2] ?? null;
    } else if (campo !== "content-type" || !/^text\/plain\s*(?:;.*)?$/i.test(valor)) {
      return null;
    }
  }
  return nombre;
}

// Entrada de un XML por HTTP (spec 016, D-1, D-3, D-11): del cuerpo crudo a bytes, parser del dominio con sus códigos de error
// y el hash/ruta que se guardan. Puro salvo `randomUUID`: no toca BD ni storage.
import { createHash, randomUUID } from "node:crypto";
import { leerUbl, UblError, type DetalleXml } from "@contapp/domain";
import { rutaXml } from "@contapp/storage";
import { XmlError } from "./errores-xml.js";

/**
 * Los bytes del cuerpo. Con `Content-Type` de XML, `raw()` entrega un `Buffer` (hasta 1 MiB; más es 413 antes del controlador);
 * con otro tipo, o sin cuerpo, `req.body` es otra cosa (`{}`, un objeto JSON) y se lee como un archivo vacío: el parser lo rechaza
 * como `xml_invalido`, sin repetir nada de lo recibido.
 */
export const bytesDeCuerpo = (cuerpo: unknown): Uint8Array => (Buffer.isBuffer(cuerpo) ? cuerpo : new Uint8Array(0));

/** `leerUbl` con su error traducido al de las rutas con XML; cualquier otro error es un defecto y se propaga (500 sin detalle). */
export function leerXml(bytes: Uint8Array): DetalleXml {
  try {
    return leerUbl(bytes);
  } catch (e) {
    if (e instanceof UblError) throw new XmlError(e.codigo);
    throw e;
  }
}

export const sha256De = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

/** Ruta nueva en storage: solo ids del estudio y del cliente y un uuid; nunca nada del archivo ni de quien lo subió. */
export const rutaNueva = (tenantId: string, clienteId: string): string => rutaXml(tenantId, clienteId, randomUUID());

import { RutaStorageError } from "./errores.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_UUID = new RegExp(`^${UUID}$`);
/** Extensiones del buzón (023): adjuntos permitidos por el dominio y `txt` para el contenido del mensaje. Siempre en minúsculas. */
const EXT_BUZON = ["pdf", "xml", "png", "jpg", "zip", "txt"] as const;
const RE_EXT_BUZON = new RegExp(`^(?:${EXT_BUZON.join("|")})$`);
const RE_RUTA = new RegExp(
  `^(?:xml/${UUID}/${UUID}/${UUID}\\.xml|archivos/${UUID}/${UUID}/${UUID}\\.zip|buzon/${UUID}/${UUID}/${UUID}\\.(?:${EXT_BUZON.join("|")}))$`,
);

/** `xml/{tenant}/{cliente}/{uuid}.xml`. Las tres partes deben ser uuid (minúsculas): nada del usuario entra en la ruta. */
export function rutaXml(tenantId: string, clienteId: string, uuid: string): string {
  for (const parte of [tenantId, clienteId, uuid]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  return `xml/${tenantId}/${clienteId}/${uuid}.xml`;
}

/** Devuelve la ruta si cumple `xml/{uuid}/{uuid}/{uuid}.xml`, `archivos/{uuid}/{uuid}/{uuid}.zip` o `buzon/{uuid}/{uuid}/{uuid}.{pdf|xml|png|jpg|zip|txt}`; si no, `RutaStorageError` (sin la ruta). */
export function validarRuta(ruta: string): string {
  if (typeof ruta !== "string" || !RE_RUTA.test(ruta)) throw new RutaStorageError();
  return ruta;
}

/** `archivos/{tenant}/{cliente}/{id}.zip`. Las tres partes deben ser uuid (minúsculas): nada del usuario entra en la ruta. */
export function rutaArchivo(tenantId: string, clienteId: string, id: string): string {
  for (const parte of [tenantId, clienteId, id]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  return `archivos/${tenantId}/${clienteId}/${id}.zip`;
}

/** `buzon/{tenant}/{cliente}/{uuid}.{ext}`. Las tres partes deben ser uuid (minúsculas) y `ext` una de la lista, en minúsculas. */
export function rutaBuzon(tenantId: string, clienteId: string, uuid: string, ext: string): string {
  for (const parte of [tenantId, clienteId, uuid]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  if (typeof ext !== "string" || !RE_EXT_BUZON.test(ext)) throw new RutaStorageError();
  return `buzon/${tenantId}/${clienteId}/${uuid}.${ext}`;
}

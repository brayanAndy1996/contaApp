import { RutaStorageError } from "./errores.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_UUID = new RegExp(`^${UUID}$`);
const RE_RUTA = new RegExp(`^(?:xml/${UUID}/${UUID}/${UUID}\\.xml|archivos/${UUID}/${UUID}/${UUID}\\.zip)$`);

/** `xml/{tenant}/{cliente}/{uuid}.xml`. Las tres partes deben ser uuid (minúsculas): nada del usuario entra en la ruta. */
export function rutaXml(tenantId: string, clienteId: string, uuid: string): string {
  for (const parte of [tenantId, clienteId, uuid]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  return `xml/${tenantId}/${clienteId}/${uuid}.xml`;
}

/** Devuelve la ruta si cumple `xml/{uuid}/{uuid}/{uuid}.xml` o `archivos/{uuid}/{uuid}/{uuid}.zip`; si no, `RutaStorageError` (sin la ruta). */
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

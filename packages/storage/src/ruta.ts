import { RutaStorageError } from "./errores.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_UUID = new RegExp(`^${UUID}$`);
const RE_RUTA = new RegExp(`^xml/${UUID}/${UUID}/${UUID}\\.xml$`);

/** `xml/{tenant}/{cliente}/{uuid}.xml`. Las tres partes deben ser uuid (minúsculas): nada del usuario entra en la ruta. */
export function rutaXml(tenantId: string, clienteId: string, uuid: string): string {
  for (const parte of [tenantId, clienteId, uuid]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  return `xml/${tenantId}/${clienteId}/${uuid}.xml`;
}

/** Devuelve la ruta si cumple la gramática `xml/{uuid}/{uuid}/{uuid}.xml`; si no, `RutaStorageError` (sin la ruta). */
export function validarRuta(ruta: string): string {
  if (typeof ruta !== "string" || !RE_RUTA.test(ruta)) throw new RutaStorageError();
  return ruta;
}

// STUB (012b T3, rojo): lo implementa T9.
export function rutaArchivo(tenantId: string, clienteId: string, id: string): string {
  void [tenantId, clienteId, id];
  throw new Error("no implementado");
}

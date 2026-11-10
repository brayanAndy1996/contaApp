import { z } from "zod";

/**
 * Procedencia del XML guardado de un comprobante (016): `simulado` y `real` vienen del origen del puerto
 * (`origenXmlSchema`, que no cambia); `subido` lo cargó el usuario a mano.
 */
export const origenDocumentoXmlSchema = z.enum(["simulado", "real", "subido"]);

export type OrigenDocumentoXml = z.infer<typeof origenDocumentoXmlSchema>;

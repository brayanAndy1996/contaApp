import { z } from "zod";

/**
 * Procedencia de un XML de comprobante (RF-097b): `simulado` lo produjo un mock (fixture o UBL
 * sintético); `real` lo entregó el proveedor real. Los mocks siempre devuelven `simulado`.
 */
export const origenXmlSchema = z.enum(["simulado", "real"]);

export type OrigenXml = z.infer<typeof origenXmlSchema>;

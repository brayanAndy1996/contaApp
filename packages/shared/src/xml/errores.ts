import { z } from "zod";

// Spec 016. Códigos de error de las rutas con XML (422 y 409). Nunca llevan contenido del XML ni mensajes con datos.

/** Campos de identidad que pueden no coincidir entre el XML y la fila (`xml_ajeno`). */
export const CAMPOS_XML_AJENO = ["ruc", "tipo", "serie", "numero", "receptor"] as const;
export type CampoXmlAjeno = (typeof CAMPOS_XML_AJENO)[number];

export const errorXmlSchema = z.discriminatedUnion("codigo", [
  z.object({ codigo: z.literal("xml_invalido") }),
  z.object({ codigo: z.literal("xml_incompleto") }),
  z.object({ codigo: z.literal("xml_existente") }),
  z.object({
    codigo: z.literal("xml_ajeno"),
    campos: z
      .array(z.enum(CAMPOS_XML_AJENO))
      .min(1)
      .refine((c) => new Set(c).size === c.length, { message: "campos sin repetir" }),
  }),
]);
export type ErrorXml = z.infer<typeof errorXmlSchema>;

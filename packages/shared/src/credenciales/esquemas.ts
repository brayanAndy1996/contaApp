import { z } from "zod";
import { ESTADOS_CREDENCIAL } from "../clientes/esquemas.js";

export const TIPOS_CREDENCIAL = ["sol", "sire_api"] as const;
export type TipoCredencial = (typeof TIPOS_CREDENCIAL)[number];

export const tipoCredencialSchema = z.enum(TIPOS_CREDENCIAL);

const SECRETO_MAX_BYTES = 256;
const SUSTITUTO_SUELTO =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const codificador = new TextEncoder();

/**
 * Texto de 1 a 256 bytes UTF-8, sin sustitutos sueltos. No recorta ni normaliza: lo que llega es lo que
 * se cifra (una clave puede empezar o terminar con espacios).
 */
const textoSecreto = z
  .string()
  .refine((s) => !SUSTITUTO_SUELTO.test(s), {
    message: "UTF-16 mal formado",
  })
  .refine(
    (s) => {
      const n = codificador.encode(s).length;
      return n >= 1 && n <= SECRETO_MAX_BYTES;
    },
    { message: "Largo fuera de 1 a 256 bytes" },
  );

/** Cuerpo del `PUT /clientes/:clienteId/credenciales/sol`. */
export const guardarCredencialSolSchema = z.object({
  usuario: textoSecreto,
  clave: textoSecreto,
});
export type GuardarCredencialSol = z.infer<typeof guardarCredencialSolSchema>;

/** Cuerpo del `PUT /clientes/:clienteId/credenciales/sire_api`. */
export const guardarCredencialSireSchema = z.object({
  clientId: textoSecreto,
  clientSecret: textoSecreto,
});
export type GuardarCredencialSire = z.infer<typeof guardarCredencialSireSchema>;

/** Respuesta del PUT: solo tipo y estado, nunca sobre ni secreto. */
export const guardarCredencialRespuestaSchema = z.object({
  tipo: tipoCredencialSchema,
  estado: z.enum(ESTADOS_CREDENCIAL),
});
export type GuardarCredencialRespuesta = z.infer<
  typeof guardarCredencialRespuestaSchema
>;

/** Elemento del `GET /clientes/:clienteId/credenciales`. */
export const credencialEstadoSchema = z.object({
  tipo: tipoCredencialSchema,
  estado: z.enum(ESTADOS_CREDENCIAL),
  fecha: z.string().nullable(),
  motivo: z.string().nullable(),
});
export type CredencialEstadoDto = z.infer<typeof credencialEstadoSchema>;

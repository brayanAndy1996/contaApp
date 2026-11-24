import { z } from "zod";

// Spec 028 (plan, Contratos: shared). Respuesta de GET y PUT /cuenta/correo. Sin correo, estudio, ids ni motivo del fallo (R-8).
export const preferenciasCorreoVistaSchema = z
  .object({
    buzonCritico: z.boolean(),
    credencialInvalida: z.boolean(),
    planLimite: z.boolean(),
    resumen: z.boolean(),
    todosClientes: z.boolean(),
    todosDisponible: z.boolean(),
    todosIgnorado: z.boolean(),
    invitacionResumen: z.boolean(),
    ultimoEnvioFallido: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type PreferenciasCorreoVista = z.infer<
  typeof preferenciasCorreoVistaSchema
>;

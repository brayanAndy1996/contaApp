import { z } from "zod";
import { ROLES } from "./roles.js";

/** Longitud máxima de un lote de asignación (CA-8). */
export const LOTE_MAX = 500;

const CORREO_MAX = 320;

const rolSchema = z.enum(ROLES);
const tipoAsignacionSchema = z.enum(["responsable", "colaborador"]);
const anteriorSchema = z.enum(["colaborador", "retirar"]);
const lote = z.array(z.uuid()).min(1).max(LOTE_MAX);

// `z.object` descarta las claves desconocidas (CA-4: nada de `tenantId`/`rol` por el cuerpo).

export const invitarSchema = z.object({
  correo: z.string().max(CORREO_MAX),
  rol: rolSchema,
});

export const cambiarRolSchema = z.object({ rol: rolSchema });

export const consultarInvitacionSchema = z.object({ token: z.string() });

export const aceptarInvitacionSchema = z.object({
  token: z.string(),
  nombre: z.string(),
  contrasena: z.string(),
});

export const aceptarConSesionSchema = z.object({ token: z.string() });

export const asignarClienteSchema = z.object({
  tipo: tipoAsignacionSchema,
  anterior: anteriorSchema.optional(),
});

export const asignarPorUsuarioSchema = z.object({
  usuarioId: z.uuid(),
  clienteIds: lote,
  tipo: tipoAsignacionSchema,
  anterior: anteriorSchema.optional(),
});

export const asignarPorClienteSchema = z.object({
  clienteId: z.uuid(),
  usuarioIds: lote,
});

export type InvitarEntrada = z.infer<typeof invitarSchema>;
export type CambiarRolEntrada = z.infer<typeof cambiarRolSchema>;
export type ConsultarInvitacionEntrada = z.infer<
  typeof consultarInvitacionSchema
>;
export type AceptarInvitacionEntrada = z.infer<typeof aceptarInvitacionSchema>;
export type AceptarConSesionEntrada = z.infer<typeof aceptarConSesionSchema>;
export type AsignarClienteEntrada = z.infer<typeof asignarClienteSchema>;
export type AsignarPorUsuarioEntrada = z.infer<typeof asignarPorUsuarioSchema>;
export type AsignarPorClienteEntrada = z.infer<typeof asignarPorClienteSchema>;

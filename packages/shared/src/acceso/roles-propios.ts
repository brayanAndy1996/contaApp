import { z } from "zod";
import { ROLES } from "./roles.js";

// Spec 030 (plan: Contratos: Shared; spec D5, CA-1, CA-2). Esquemas de roles propios del estudio.
// `z.object` descarta las claves desconocidas (CA-4: nada de `tenantId`, `id` ni `nombreClave` por el cuerpo).

export const NOMBRE_ROL_MAX = 40;

/** El rol que se asigna a un miembro o invitación: uno de sistema o uno propio por su id. */
export const rolAsignadoSchema = z.union([
  z.enum(ROLES),
  z.object({ rolId: z.uuid() }),
]);

/** 1..40 caracteres (puntos de código, como `char_length`) sin caracteres de control (C0, DEL, C1). */
const nombreRolSchema = z
  .string()
  .regex(/^\P{Cc}*$/u)
  .refine((s) => {
    const n = [...s].length;
    return n >= 1 && n <= NOMBRE_ROL_MAX;
  });

const alcanceRolSchema = z.enum(["global", "asignado"]);

export const crearRolSchema = z.object({
  nombre: nombreRolSchema,
  alcance: alcanceRolSchema,
  /** Cadenas: catálogo, `plan.gestionar` y U3 los valida `validarCombinacion` (422 con código fijo). */
  permisos: z.array(z.string()),
  baseRolId: z.uuid().optional(),
});

export const editarRolSchema = crearRolSchema.partial();

export type RolAsignado = z.infer<typeof rolAsignadoSchema>;
export type CrearRolEntrada = z.infer<typeof crearRolSchema>;
export type EditarRolEntrada = z.infer<typeof editarRolSchema>;

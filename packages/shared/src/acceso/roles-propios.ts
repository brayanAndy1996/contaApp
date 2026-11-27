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

/**
 * Caracteres que no van en un nombre de rol (T13, ronda 1a): controles (C0, DEL, C1), de formato (Cf: ancho cero, bidi, BOM,
 * guion suave), separadores de línea y de párrafo, todo espacio que no sea el ASCII (NBSP, ideográfico, finos...) y los rellenos
 * invisibles que Unicode clasifica como letras o símbolos (Hangul, braille en blanco, CGJ). Así un nombre no se disfraza de otro
 * («Dueño» + ZWSP, «Lectura» + NBSP) ni queda invisible.
 */
const CARACTER_PROHIBIDO = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u034f\u115f\u1160\u2800\u3164\uffa0]/u;

/** Claves de los roles de sistema (y sus etiquetas) que un rol propio no puede tomar; igual que `rol_nombre_clave_no_sistema` (0082). */
export const NOMBRES_ROL_RESERVADOS: readonly string[] = [
  "dueno",
  "administrador",
  "admin",
  "contador",
  "asistente",
  "lectura",
  "solo lectura",
];

/**
 * Clave de comparación de un nombre de rol, espejo de `rol.nombre_clave` (0082): sin bordes en blanco (Unicode), en NFD sin las
 * marcas combinantes U+0300–U+036F y en minúsculas. «Dueño», « DUEÑO » y «Duen\u0303o» dan la misma clave.
 */
export function claveNombreRol(nombre: string): string {
  return nombre.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** ¿El nombre, normalizado, es el de un rol de sistema? (409 `nombre_duplicado`, como el CHECK de la BD). */
export function esNombreRolReservado(nombre: string): boolean {
  return NOMBRES_ROL_RESERVADOS.includes(claveNombreRol(nombre));
}

/** ¿Tiene algún carácter prohibido (control, formato, separador, espacio no ASCII o relleno invisible)? */
export function nombreRolConCaracterProhibido(nombre: string): boolean {
  return CARACTER_PROHIBIDO.test(nombre);
}

/** 1..40 caracteres (puntos de código, como `char_length`), sin caracteres prohibidos y con algo visible tras quitar los bordes. */
const nombreRolSchema = z
  .string()
  .refine((s) => !nombreRolConCaracterProhibido(s))
  .refine((s) => {
    const n = [...s].length;
    return n >= 1 && n <= NOMBRE_ROL_MAX && s.trim().length > 0;
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

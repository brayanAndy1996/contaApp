import { screen, within } from "@testing-library/react";
import type { Manejador } from "./soporte";
import { rutaSesion, yoDe } from "./acceso";

// Soporte de las pruebas de roles personalizados (spec 030, T4): textos visibles, datos de prueba y
// respuestas simuladas de `/roles`. Es el contrato de T10: las pantallas muestran estos textos exactos
// y usan estas formas de cuerpo. Solo datos de prueba; sin lógica de producción.

/** Textos visibles (U3, U5, U6, U8, U9; CA-2, CA-6). */
export const MENSAJES_ROLES = {
  nombreObligatorio: "Escribe un nombre para el rol.",
  nombreDuplicado: "Ya existe un rol con ese nombre.",
  limiteRoles: "Alcanzaste el límite de 20 roles propios.",
  escalada: "No puedes otorgar permisos ni un alcance que tú no tienes.",
  rolPropio: "No puedes modificar el rol que tienes asignado.",
  permisoInvalido: "El rol incluye un permiso que no existe.",
  sinPropios: "Aún no hay roles propios.",
  rolCreado: "Rol creado.",
  rolGuardado: "Rol guardado.",
  rolEliminado: "Rol eliminado.",
  /** U3: 422 `combinacion_invalida` o validación local; nombra el permiso faltante. */
  falta: (permiso: string) => `Falta el permiso ${permiso}.`,
  /** U5: 409 `rol_en_uso`. */
  enUso: (miembros: number, invitaciones: number) =>
    `No se puede eliminar: tiene ${miembros} miembros y ${invitaciones} invitaciones.`,
  /** U6 y U8: aviso de impacto (siempre con n ≥ 2 en las pruebas). */
  impactoMiembros: (n: number) => `Afecta a ${n} miembros.`,
  impactoSinResponsable: (n: number) =>
    `${n} clientes quedarán sin responsable.`,
  impactoTotp: (n: number) =>
    `${n} miembros deberán activar el segundo factor (TOTP).`,
} as const;

/** Permisos que el formulario ofrece: el catálogo de 01 §4 sin `plan.gestionar` (CA-2): 23. */
export const PERMISOS_OFRECIDOS = [
  "estudio.configurar",
  "usuarios.ver",
  "usuarios.gestionar",
  "roles.gestionar",
  "clientes.ver",
  "clientes.crear",
  "clientes.editar",
  "clientes.archivar",
  "clientes.asignar",
  "credenciales.editar",
  "sire.descargar",
  "sire.clasificar",
  "sire.aprobar_generar",
  "ajustes.crear",
  "ajustes.generar",
  "buzon.ver",
  "buzon.marcar_leido",
  "buzon.atender",
  "reglas.ver",
  "reglas.gestionar",
  "prorrata.ver",
  "prorrata.gestionar",
  "auditoria.ver",
] as const;

/** Un actor con todos los permisos (incluido `plan.gestionar`, que nunca se ofrece en un rol propio). */
export const PERMISOS_ACTOR_TOTAL: string[] = [
  ...PERMISOS_OFRECIDOS,
  "plan.gestionar",
];

// Identificadores con forma de UUID válida (versión 4, variante 8): los esquemas exigen `uuid`.
export const ID_PRACTICANTE = "00000000-0000-4000-8000-0000000000a1";
export const ID_AUDITOR = "00000000-0000-4000-8000-0000000000a2";

export interface RolPropioPrueba {
  id: string;
  nombre: string;
  alcance: "global" | "asignado";
  permisos: string[];
  miembros: number;
  invitaciones: number;
}

export const PRACTICANTE: RolPropioPrueba = {
  id: ID_PRACTICANTE,
  nombre: "Practicante",
  alcance: "asignado",
  permisos: ["clientes.ver", "sire.descargar", "sire.clasificar"],
  miembros: 2,
  invitaciones: 1,
};

export const AUDITOR: RolPropioPrueba = {
  id: ID_AUDITOR,
  nombre: "Auditor",
  alcance: "global",
  permisos: ["usuarios.ver", "clientes.ver", "auditoria.ver"],
  miembros: 0,
  invitaciones: 0,
};

/** Cuerpo de `GET /roles`: los 5 de sistema (solo lectura; permisos abreviados) y los propios. */
export function listaRoles(
  propios: RolPropioPrueba[] = [PRACTICANTE, AUDITOR],
) {
  return {
    sistema: [
      { rol: "dueno", alcance: "global", permisos: [...PERMISOS_ACTOR_TOTAL] },
      {
        rol: "admin",
        alcance: "global",
        permisos: ["clientes.ver", "usuarios.ver", "usuarios.gestionar"],
      },
      {
        rol: "contador",
        alcance: "asignado",
        permisos: ["clientes.ver", "credenciales.editar"],
      },
      {
        rol: "asistente",
        alcance: "asignado",
        permisos: ["clientes.ver", "sire.descargar", "sire.clasificar"],
      },
      { rol: "lectura", alcance: "asignado", permisos: ["clientes.ver"] },
    ],
    propios,
  };
}

/** Rutas base de la pantalla de roles con un actor que gestiona roles. */
export function rutasRoles(
  extra: Record<string, Manejador> = {},
  yo: Record<string, unknown> = yoDe("dueno", PERMISOS_ACTOR_TOTAL),
  propios?: RolPropioPrueba[],
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yo },
    "GET /api/roles": { status: 200, cuerpo: listaRoles(propios) },
    ...extra,
  };
}

/** `GET /acceso/yo` de un miembro con rol propio (plan 030: `rolPropio` y permisos efectivos). */
export function yoPropio(
  permisos: string[],
  alcance: "global" | "asignado",
  rolPropio: { id: string; nombre: string },
) {
  return { rol: "propio", rolPropio, permisos, alcance };
}

/** Casilla de un permiso: su nombre accesible es el propio código (`usuarios.ver`). */
export const casilla = (permiso: string): HTMLInputElement =>
  screen.getByRole("checkbox", { name: permiso });

/** Fila de una tabla con nombre accesible `tabla` que contiene `texto`. */
export function filaDe(tabla: string, texto: string): HTMLElement {
  const encontrada = within(screen.getByRole("table", { name: tabla }))
    .queryAllByRole("row")
    .find((f) => f.textContent?.includes(texto));
  if (!encontrada) throw new Error(`no hay fila con "${texto}" en ${tabla}`);
  return encontrada;
}

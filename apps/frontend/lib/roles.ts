import {
  PERMISOS_ROL_PROPIO,
  REQUISITOS_PERMISO,
  ROLES,
  crearRolSchema,
  nombreRolConCaracterProhibido,
  validarCombinacion,
  type Rol,
} from "@contapp/shared";
import { api } from "./api";
import { MENSAJES, ETIQUETA_ROL, type RolPropioRef } from "./acceso";

// Roles propios del estudio (spec 030): textos, formas de las respuestas de `/roles` y la validación local del
// formulario (U3) con los esquemas de `shared`. Solo presentación: el servidor decide (RNF-007) y vuelve a validar.

export type Alcance = "global" | "asignado";

/** Rol de sistema tal como lo lista `GET /roles` (solo lectura). */
export interface RolSistemaVista {
  rol: Rol;
  alcance: Alcance;
  permisos: string[];
}

export interface RolPropio {
  id: string;
  nombre: string;
  alcance: Alcance;
  permisos: string[];
  miembros: number;
  invitaciones: number;
}

export interface ListaRoles {
  sistema: RolSistemaVista[];
  propios: RolPropio[];
}

/** `GET /roles/asignables`: lo que el actor puede asignar a un miembro o invitación. */
export interface Asignables {
  sistema: Rol[];
  propios: RolPropioRef[];
}

/** `POST /roles/:id/impacto`: vista previa de editar un rol en uso (U6, U8). */
export interface Impacto {
  miembros: number;
  clientesSinResponsable: number;
  miembrosSinTotpExigidos: number;
}

/** Cuerpo de crear (`baseRolId` solo con base propia) o de editar un rol. */
export interface CuerpoRol {
  nombre: string;
  alcance: Alcance;
  permisos: string[];
  baseRolId?: string;
}

export const MENSAJES_ROLES = {
  titulo: "Roles",
  crear: "Crear rol",
  editar: "Editar",
  eliminar: "Eliminar",
  guardar: "Guardar",
  cancelar: "Cancelar",
  confirmar: "Confirmar",
  nombreObligatorio: "Escribe un nombre para el rol.",
  nombreInvalido: "El nombre tiene espacios o caracteres no permitidos.",
  nombreDuplicado: "Ya existe un rol con ese nombre.",
  limiteRoles: "Alcanzaste el límite de 20 roles propios.",
  escalada: MENSAJES.escalada,
  rolPropio: MENSAJES.rolPropio,
  permisoInvalido: "El rol incluye un permiso que no existe.",
  sinPropios: "Aún no hay roles propios.",
  rolCreado: "Rol creado.",
  rolGuardado: "Rol guardado.",
  rolEliminado: "Rol eliminado.",
  falta: (permiso: string) => `Falta el permiso ${permiso}.`,
  enUso: (miembros: number, invitaciones: number) =>
    `No se puede eliminar: tiene ${miembros} miembros y ${invitaciones} invitaciones.`,
  impactoMiembros: (n: number) => `Afecta a ${n} miembros.`,
  impactoSinResponsable: (n: number) => `${n} clientes quedarán sin responsable.`,
  impactoTotp: (n: number) =>
    `${n} miembros deberán activar el segundo factor (TOTP).`,
  cargando: "Cargando…",
  tablaSistema: "Roles de sistema",
  tablaPropios: "Roles propios",
  formulario: "Datos del rol",
  impacto: "Impacto del cambio",
  requiere: (permisos: readonly string[]) => `Requiere ${permisos.join(", ")}`,
} as const;

export const ETIQUETA_ALCANCE: Record<Alcance, string> = {
  global: "Global",
  asignado: "Asignado",
};

/** Permisos que un rol propio puede tener (el catálogo sin `plan.gestionar`, CA-2), en el orden del catálogo. */
export const PERMISOS_OFRECIDOS: readonly string[] = PERMISOS_ROL_PROPIO;

/** Permisos que exige `permiso` (U3), para enseñarlos junto a su casilla. */
export function requisitosDe(permiso: string): readonly string[] {
  return (REQUISITOS_PERMISO as Record<string, readonly string[] | undefined>)[
    permiso
  ] ?? [];
}

/** Permisos agrupados por módulo (lo que va antes del punto), en el orden del catálogo. */
export function permisosPorModulo(): Array<[string, string[]]> {
  const grupos = new Map<string, string[]>();
  for (const p of PERMISOS_OFRECIDOS) {
    const modulo = p.split(".")[0] ?? p;
    grupos.set(modulo, [...(grupos.get(modulo) ?? []), p]);
  }
  return [...grupos.entries()];
}

/** Mensaje de un error de `/roles`; nunca muestra el `codigo` ni detalles internos. */
export function mensajeDeErrorRol(status: number, datos: unknown): string {
  const d = (datos ?? {}) as {
    codigo?: string;
    permiso?: string;
    miembros?: number;
    invitaciones?: number;
  };
  if (status === 403) {
    if (d.codigo === "escalada") return MENSAJES_ROLES.escalada;
    if (d.codigo === "rol_propio") return MENSAJES_ROLES.rolPropio;
    return MENSAJES.sinPermiso;
  }
  if (status === 404) return MENSAJES.noEncontrado;
  if (status === 409) {
    if (d.codigo === "nombre_duplicado") return MENSAJES_ROLES.nombreDuplicado;
    if (d.codigo === "limite_roles") return MENSAJES_ROLES.limiteRoles;
    if (d.codigo === "rol_en_uso")
      return MENSAJES_ROLES.enUso(d.miembros ?? 0, d.invitaciones ?? 0);
    return MENSAJES.errorGeneral;
  }
  if (status === 422) {
    if (d.codigo === "combinacion_invalida" && d.permiso)
      return MENSAJES_ROLES.falta(d.permiso);
    if (d.codigo === "permiso_invalido") return MENSAJES_ROLES.permisoInvalido;
  }
  return MENSAJES.errorGeneral;
}

/**
 * Validación local del formulario con los esquemas de `shared` (nombre, alcance) y U3 (`validarCombinacion`).
 * Devuelve el cuerpo listo o el mensaje a mostrar. No completa ni cambia permisos.
 */
export function validarFormularioRol(
  entrada: CuerpoRol,
): { ok: true; cuerpo: CuerpoRol } | { ok: false; mensaje: string } {
  const nombre = entrada.nombre.trim();
  const { baseRolId, ...resto } = entrada;
  const parseado = crearRolSchema.safeParse({
    ...resto,
    nombre,
    ...(baseRolId ? { baseRolId } : {}),
  });
  if (!parseado.success)
    return {
      ok: false,
      // T13: un nombre con algo escrito pero con caracteres prohibidos (invisibles, NBSP interior...) no es «vacío».
      mensaje:
        nombre.length > 0 && nombreRolConCaracterProhibido(nombre)
          ? MENSAJES_ROLES.nombreInvalido
          : MENSAJES_ROLES.nombreObligatorio,
    };
  const combinacion = validarCombinacion(entrada.permisos, entrada.alcance);
  if (!combinacion.ok)
    return {
      ok: false,
      mensaje:
        combinacion.error === "permiso_invalido"
          ? MENSAJES_ROLES.permisoInvalido
          : MENSAJES_ROLES.falta(combinacion.permiso),
    };
  return { ok: true, cuerpo: { ...parseado.data } as CuerpoRol };
}

/** Valor de un `<option>`: la clave del rol de sistema o el id del propio. */
export const esRolSistema = (valor: string): valor is Rol =>
  (ROLES as readonly string[]).includes(valor);

/** Rol a enviar al servidor (`RolAsignado`): la clave de sistema o `{rolId}`. */
export const rolAsignadoDe = (valor: string): Rol | { rolId: string } =>
  esRolSistema(valor) ? valor : { rolId: valor };

export interface OpcionRol {
  valor: string;
  etiqueta: string;
}

/** Opciones del selector de rol a partir de lo asignable: sistema con su etiqueta y propios con su nombre. */
export const opcionesDeAsignables = (a: Asignables): OpcionRol[] => [
  ...a.sistema.map((r) => ({ valor: r, etiqueta: ETIQUETA_ROL[r] })),
  ...a.propios.map((p) => ({ valor: p.id, etiqueta: p.nombre })),
];

export const cargarRoles = () => api<ListaRoles>("/roles");

/** `null` si falla: el selector vuelve al comportamiento de 005 sin avisar. */
export async function cargarAsignables(): Promise<Asignables | null> {
  try {
    const r = await api<Asignables>("/roles/asignables");
    return r.ok && r.datos ? r.datos : null;
  } catch {
    return null;
  }
}

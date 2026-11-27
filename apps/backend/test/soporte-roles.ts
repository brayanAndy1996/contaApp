/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Soporte de las pruebas HTTP de 030 (T3, rojo). Encima de `soporte-acceso.ts` (005). Fuera de `src/` (no cuenta en la cobertura).
// Solo usa el contrato público de `plan.md#contratos`: HTTP y las tablas `rol`, `rol_permiso`, `membresia.rol_id`, `invitacion.rol_id`.
//
// Contrato del cuerpo (lo fija este archivo; T8/T9 lo confirman):
//  - El rol propio viaja como el valor de `rol`: `{ rol: { rolId } }` en `POST /invitaciones` y `PATCH /usuarios/:id/rol`
//    (`RolAsignado = Rol | { rolId }`: `rol: "contador"` de 005 sigue valiendo). Si T8 lo cambia a `{ rolId }` en la raíz,
//    se ajusta SOLO `rolDe`, `asignar` e `invitar` de este archivo.
//  - `GET /roles` → `{ sistema: [...5], propios: [{ id, nombre, alcance, permisos, miembros, invitaciones }] }`.
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { PERMISOS, type Permiso } from "@contapp/shared";
import type { Actor, Banco } from "./soporte-acceso.js";
import type { Resp } from "./soporte.js";

export type Alcance = "global" | "asignado";

/** Permisos que un rol propio puede tener: el catálogo sin `plan.gestionar` (CA-2). */
export const ASIGNABLES: readonly Permiso[] = PERMISOS.filter((p) => p !== "plan.gestionar");
/** Los que exigen segundo factor en un rol propio (029 U2) y se pueden asignar (`plan.gestionar` no). */
export const SENSIBLES: readonly Permiso[] = ["usuarios.gestionar", "roles.gestionar", "credenciales.editar"];
/** U9. */
export const LIMITE_ROLES = 20;
/** Roles que 005 deja como de sistema (clave y etiqueta del Dueño, etc.). */
export const NOMBRES_DE_SISTEMA = ["Dueño", "DUEÑO", "dueno", "Administrador", "Contador", "Asistente", "Lectura"] as const;

/* ---------------- U3: requisitos de cada permiso ---------------- */
const esDeCliente = (p: string): boolean =>
  p !== "clientes.ver" &&
  (p.startsWith("clientes.") ||
    p.startsWith("sire.") ||
    p.startsWith("ajustes.") ||
    p.startsWith("buzon.") ||
    p.startsWith("reglas.") ||
    p.startsWith("prorrata.") ||
    p === "credenciales.editar");

/** Lo que U3 exige junto con `p` (un paso). */
export function requisitos(p: Permiso): Permiso[] {
  const r: Permiso[] = [];
  if (p === "usuarios.gestionar" || p === "roles.gestionar") r.push("usuarios.ver");
  if (p === "buzon.marcar_leido" || p === "buzon.atender") r.push("buzon.ver");
  if (p === "reglas.gestionar") r.push("reglas.ver");
  if (p === "prorrata.gestionar") r.push("prorrata.ver");
  if (esDeCliente(p)) r.push("clientes.ver");
  return r;
}

/** Los permisos dados más sus requisitos (cierre), en el orden del catálogo. Es lo que U3 acepta. */
export function cerrar(permisos: readonly string[]): Permiso[] {
  const set = new Set<Permiso>(permisos.filter((p): p is Permiso => (PERMISOS as readonly string[]).includes(p)));
  for (let cambio = true; cambio; ) {
    cambio = false;
    for (const p of [...set])
      for (const q of requisitos(p))
        if (!set.has(q)) {
          set.add(q);
          cambio = true;
        }
  }
  return PERMISOS.filter((p) => set.has(p));
}

/** Todos los asignables salvo `p` y lo que lo exige (el rol «le falta solo ese permiso»); ya es un conjunto válido por U3. */
export const todosMenos = (p: Permiso): Permiso[] => ASIGNABLES.filter((q) => q !== p && !cerrar([q]).includes(p));

export const ordenados = (xs: readonly string[]): string[] => [...xs].sort();
export const nombreUnico = (base = "Rol"): string => `${base} ${randomBytes(3).toString("hex")}`;
/** `true` si el texto de la respuesta nombra el valor (id de rol, clave de rol de sistema, etc.). */
export const contiene = (r: Resp, valor: string): boolean => JSON.stringify(r.body ?? r.text).includes(valor);

/* ---------------- HTTP de /roles ---------------- */
export interface OpcionesRol {
  nombre?: string;
  alcance?: Alcance;
  permisos: readonly string[];
  baseRolId?: string;
  /** Claves extra del cuerpo (p. ej. `tenantId`, que debe ignorarse). */
  extra?: Record<string, unknown>;
}
export interface RolCreado {
  id: string;
  nombre: string;
  alcance: Alcance;
  permisos: string[];
}

export const crear = (b: Banco, a: Actor, o: OpcionesRol): Promise<Resp> =>
  b.llamar(a, "POST", "/roles", {
    nombre: o.nombre ?? nombreUnico(),
    alcance: o.alcance ?? "asignado",
    permisos: o.permisos,
    ...(o.baseRolId === undefined ? {} : { baseRolId: o.baseRolId }),
    ...(o.extra ?? {}),
  });

/** Crea y exige 201. Con `u3: true` agrega los requisitos de U3 a `permisos`. */
export async function crearOk(b: Banco, a: Actor, o: OpcionesRol & { u3?: boolean }): Promise<RolCreado> {
  const permisos = o.u3 === true ? cerrar(o.permisos) : o.permisos;
  const r = await crear(b, a, { ...o, permisos });
  expect(r.status, `POST /roles ${JSON.stringify({ ...o, permisos })}: ${r.text}`).toBe(201);
  expect(typeof r.body.id).toBe("string");
  return r.body as RolCreado;
}
export const editar = (b: Banco, a: Actor, id: string, cuerpo: unknown): Promise<Resp> => b.llamar(a, "PATCH", `/roles/${id}`, cuerpo);
export const eliminar = (b: Banco, a: Actor, id: string): Promise<Resp> => b.llamar(a, "DELETE", `/roles/${id}`);
export const impacto = (b: Banco, a: Actor, id: string, cuerpo: unknown = {}): Promise<Resp> => b.llamar(a, "POST", `/roles/${id}/impacto`, cuerpo);
export const listar = (b: Banco, a: Actor): Promise<Resp> => b.llamar(a, "GET", "/roles");
export const asignables = (b: Banco, a: Actor): Promise<Resp> => b.llamar(a, "GET", "/roles/asignables");
/** Los propios de un `GET /roles` ya verificado. */
export const propiosDe = (r: Resp): any[] => r.body.propios as any[];

/* ---------------- Asignar un rol propio ---------------- */
export const rolDe = (rolId: string): { rolId: string } => ({ rolId });
export const asignar = (b: Banco, a: Actor, usuarioId: string, rolId: string): Promise<Resp> =>
  b.llamar(a, "PATCH", `/usuarios/${usuarioId}/rol`, { rol: rolDe(rolId) });
export const asignarSistema = (b: Banco, a: Actor, usuarioId: string, rol: string): Promise<Resp> =>
  b.llamar(a, "PATCH", `/usuarios/${usuarioId}/rol`, { rol });
export const invitar = (b: Banco, a: Actor, correo: string, rolId: string): Promise<Resp> =>
  b.llamar(a, "POST", "/invitaciones", { correo, rol: rolDe(rolId) });

/** Miembro activo (rol de sistema `lectura`) al que `por` le asigna el rol propio; exige 200. */
export async function miembroConRol(b: Banco, por: Actor, rolId: string, o: { sesion?: boolean } = {}): Promise<Actor> {
  const m = await b.miembro(por.tenantId, "lectura", o);
  const r = await asignar(b, por, m.id, rolId);
  expect(r.status, `asignar el rol ${rolId}: ${r.text}`).toBe(200);
  return m;
}

/** Crea un rol (con U3) y un miembro con sesión que lo tiene. */
export async function rolConMiembro(
  b: Banco,
  por: Actor,
  permisos: readonly string[],
  alcance: Alcance = "global",
): Promise<{ rol: RolCreado; miembro: Actor }> {
  const rol = await crearOk(b, por, { permisos, alcance, u3: true });
  return { rol, miembro: await miembroConRol(b, por, rol.id) };
}

/* ---------------- BD ---------------- */
export const membresiaDe = async (b: Banco, tenantId: string, usuarioId: string): Promise<{ rol: string; rol_id: string | null; desactivada_en: Date | null }> =>
  (await b.sql("select rol, rol_id, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [tenantId, usuarioId]))[0];
export const cuentaRoles = async (b: Banco, tenantId: string): Promise<number> =>
  Number((await b.sql("select count(*)::int as n from rol where tenant_id = $1", [tenantId]))[0].n);
export const filaRol = async (b: Banco, id: string): Promise<{ tenant_id: string; nombre: string; alcance: string; actualizado_en: Date } | undefined> =>
  (await b.sql("select tenant_id, nombre, alcance, actualizado_en from rol where id = $1", [id]))[0];
export const permisosEnBd = async (b: Banco, rolId: string): Promise<string[]> =>
  (await b.sql("select permiso from rol_permiso where rol_id = $1 order by permiso", [rolId])).map((f: any) => f.permiso as string);
/** CA-6: membresías o invitaciones del estudio que apuntan a un rol que no existe (o de otro estudio). Debe ser 0. */
export async function huerfanos(b: Banco, tenantId: string): Promise<number> {
  const f = await b.sql(
    `select (select count(*) from membresia m where m.tenant_id = $1 and m.rol_id is not null
              and not exists (select 1 from rol r where r.id = m.rol_id and r.tenant_id = m.tenant_id))
          + (select count(*) from invitacion i where i.tenant_id = $1 and i.rol_id is not null
              and not exists (select 1 from rol r where r.id = i.rol_id and r.tenant_id = i.tenant_id))
          + (select count(*) from membresia m where m.tenant_id = $1 and (m.rol = 'propio') <> (m.rol_id is not null))
          + (select count(*) from invitacion i where i.tenant_id = $1 and (i.rol = 'propio') <> (i.rol_id is not null)) as n`,
    [tenantId],
  );
  return Number(f[0].n);
}
export const duenosActivos = async (b: Banco, tenantId: string): Promise<number> =>
  Number((await b.sql("select count(*)::int as n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [tenantId]))[0].n);
export const cuentaAuditoria = async (b: Banco, tenantId: string, patron = "rol.%"): Promise<number> =>
  Number((await b.sql("select count(*)::int as n from auditoria where tenant_id = $1 and accion like $2", [tenantId, patron]))[0].n);

/** Mensaje de aserción con la respuesta cruda. */
export const msg = (r: Resp, etiqueta = ""): string => `${etiqueta} HTTP ${r.status}: ${r.text}`;
export const uuidInexistente = (): string => randomUUID();

import {
  definicionesDe,
  type DefinicionMiembro,
  type MiembroEstado,
  type TxConsulta,
} from "@contapp/db";
import {
  PERMISOS,
  ROLES,
  permisosEfectivos,
  type Efectivo,
  type Permiso,
  type Rol,
} from "@contapp/shared";

// Spec 030 (D3, plan: Decisiones). Permisos y alcance EFECTIVOS de una membresía leída de la BD: un rol de sistema por la matriz de 005,
// un rol propio por su definición guardada. Puro salvo `releerEfectivos` (una consulta, solo si hay roles propios). Falla cerrado: un rol
// que no se puede resolver da `null` (sin permisos; el TOTP se exige).

const esRolSistema = (r: unknown): r is Rol =>
  typeof r === "string" && (ROLES as readonly string[]).includes(r);
const esPermiso = (p: unknown): p is Permiso =>
  typeof p === "string" && (PERMISOS as readonly string[]).includes(p);

/** Lo que basta para resolver: el rol y, si es propio, su definición. */
export type MembresiaLeida = Pick<DefinicionMiembro, "rol"> &
  Partial<Pick<DefinicionMiembro, "propio">>;

/**
 * Efectivo de una membresía (sistema o propio). `null` si no hay membresía, el rol no está en el catálogo o un propio llega sin su
 * definición. Un permiso fuera del catálogo se descarta y un alcance que no sea `global` cuenta como `asignado`.
 */
export function efectivoDe(m: MembresiaLeida | null | undefined): Efectivo | null {
  if (m === null || m === undefined) return null;
  if (esRolSistema(m.rol)) return permisosEfectivos(m.rol);
  if (m.rol !== "propio" || m.propio === null || m.propio === undefined) return null;
  return permisosEfectivos("propio", {
    permisos: m.propio.permisos.filter(esPermiso),
    alcance: m.propio.alcance === "global" ? "global" : "asignado",
  });
}

/** Miembro ya bloqueado con su `Efectivo` y su rol propio (030). */
export interface MiembroEfectivo {
  estado: MiembroEstado;
  efectivo: Efectivo | null;
  rolId: string | null;
}

/**
 * Tras `bloquearMiembros`: los de rol de sistema se resuelven sin consulta; los de rol propio se releen en UNA consulta
 * (`definicionesDe`), ya con sus filas bloqueadas, así ven la última edición confirmada de su rol (D4).
 */
export async function releerEfectivos(
  tx: TxConsulta,
  bloqueados: ReadonlyMap<string, MiembroEstado>,
): Promise<Map<string, MiembroEfectivo>> {
  const propios = [...bloqueados.values()]
    .filter((m) => m.rol === "propio")
    .map((m) => m.usuarioId);
  const definiciones =
    propios.length === 0 ? new Map<string, DefinicionMiembro>() : await definicionesDe(tx, propios);
  const r = new Map<string, MiembroEfectivo>();
  for (const [id, estado] of bloqueados) {
    const d = estado.rol === "propio" ? definiciones.get(id) : undefined;
    r.set(id, {
      estado,
      efectivo: estado.rol === "propio" ? efectivoDe(d ?? { rol: "propio" }) : efectivoDe(estado),
      rolId: d?.rolId ?? null,
    });
  }
  return r;
}

/** ¿Tiene el permiso? (`null` nunca). */
export function tiene(e: Efectivo | null, p: Permiso): boolean {
  return e !== null && e.permisos.has(p);
}

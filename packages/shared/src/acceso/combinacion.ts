import { PERMISOS, type Permiso } from "./permisos.js";
import type { AlcanceRol } from "./efectivos.js";

// Spec 030 (U3, CA-2). Combinaciones válidas de un rol propio. Sin IO; la API responde 422 con el código y el permiso.

/** Los permisos que un rol propio puede tener: el catálogo sin `plan.gestionar` (U7), en su orden. */
export const PERMISOS_ROL_PROPIO: readonly Permiso[] = PERMISOS.filter(
  (p) => p !== "plan.gestionar",
);

const CLIENTES: readonly Permiso[] = ["clientes.ver"];

/**
 * U3: requisitos de cada permiso (23 reglas). Toda acción exige el `.ver` de su módulo y todo permiso de cliente,
 * `clientes.ver`. Los permisos ausentes no tienen requisitos.
 */
export const REQUISITOS_PERMISO: Readonly<
  Partial<Record<Permiso, readonly Permiso[]>>
> = {
  "usuarios.gestionar": ["usuarios.ver"],
  "roles.gestionar": ["usuarios.ver"],
  "clientes.crear": CLIENTES,
  "clientes.editar": CLIENTES,
  "clientes.archivar": CLIENTES,
  "clientes.asignar": CLIENTES,
  "credenciales.editar": CLIENTES,
  "sire.descargar": CLIENTES,
  "sire.clasificar": CLIENTES,
  "sire.aprobar_generar": CLIENTES,
  "ajustes.crear": CLIENTES,
  "ajustes.generar": CLIENTES,
  "buzon.ver": CLIENTES,
  "buzon.marcar_leido": ["buzon.ver", "clientes.ver"],
  "buzon.atender": ["buzon.ver", "clientes.ver"],
  "reglas.ver": CLIENTES,
  "reglas.gestionar": ["reglas.ver", "clientes.ver"],
  "prorrata.ver": CLIENTES,
  "prorrata.gestionar": ["prorrata.ver", "clientes.ver"],
};

export type ErrorCombinacion = "permiso_invalido" | "combinacion_invalida";

export type ResultadoCombinacion =
  | { ok: true }
  | { ok: false; error: ErrorCombinacion; permiso: string };

const ASIGNABLES: ReadonlySet<string> = new Set(PERMISOS_ROL_PROPIO);

/**
 * U3/CA-2: `permiso_invalido` (fuera del catálogo o `plan.gestionar`; el primero recibido) tiene prioridad sobre
 * `combinacion_invalida` (nombra el requisito faltante, el primero del catálogo). No completa ni muta la entrada.
 * El alcance no cambia el resultado.
 */
export function validarCombinacion(
  permisos: readonly string[],
  alcance: AlcanceRol,
): ResultadoCombinacion {
  void alcance; // U3 no depende del alcance; se recibe por contrato (U4 lo decide `puedeGestionarRol`).
  for (const p of permisos)
    if (!ASIGNABLES.has(p)) return { ok: false, error: "permiso_invalido", permiso: p };
  const tiene = new Set(permisos as readonly Permiso[]);
  const faltan = new Set<Permiso>();
  for (const p of tiene)
    for (const r of REQUISITOS_PERMISO[p] ?? []) if (!tiene.has(r)) faltan.add(r);
  const primero = PERMISOS.find((p) => faltan.has(p));
  return primero === undefined
    ? { ok: true }
    : { ok: false, error: "combinacion_invalida", permiso: primero };
}

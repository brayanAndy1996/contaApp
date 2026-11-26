import type { Permiso, Rol } from "./index.js";

// Spec 030 · T2 (plan: Contratos: Shared, `CASOS_EFECTIVOS`, tabla común TS/SQL). Solo datos y tipos existentes:
// no importa lógica de negocio, así que T6 (BD) puede usarla sin esperar a T7.
// La usan: `efectivos.spec.ts` (TS: `permisosEfectivos`, `alcanceEfectivo`, `puedeSerResponsable`, `factorExigido`) y las
// pruebas de BD de `acceso.permisos_membresia` (SQL: la misma resolución sobre una membresía real).
//
// Un caso describe UNA membresía: el rol de sistema (`rolSistema` = clave) o un rol propio (`rolSistema` null y `propio` con
// sus permisos y alcance guardados). `permisos`/`alcance` son lo EFECTIVO esperado (se comparan como conjunto, sin orden).

export type AlcanceRol = "global" | "asignado";

export interface CasoEfectivo {
  /** Descripción legible; única en la tabla. */
  nombre: string;
  /** Clave del rol de sistema, o `null` si es un rol propio del estudio (U7: nunca cuenta como Dueño). */
  rolSistema: Rol | null;
  /** Lo guardado del rol propio; `null` para un rol de sistema. */
  propio: { permisos: readonly Permiso[]; alcance: AlcanceRol } | null;
  /** Permisos efectivos esperados (conjunto). */
  permisos: readonly Permiso[];
  alcance: AlcanceRol;
  /** `puedeSerResponsable` (D18: tiene `sire.clasificar`). */
  puedeSerResponsable: boolean;
  /** `factorExigido` con `plataforma: false` (U1–U2 de 029: Dueño, Administrador o algún permiso sensible en rol propio). */
  exigeFactor: boolean;
}

/** U3: cada par (permiso, requisito). 23 reglas: 6 de módulo (`.ver`) y 17 de `clientes.ver`. */
export interface ReglaU3 {
  permiso: Permiso;
  requiere: Permiso;
}

export const REGLAS_U3: readonly ReglaU3[] = [
  // Toda acción exige el `.ver` de su módulo (6).
  { permiso: "usuarios.gestionar", requiere: "usuarios.ver" },
  { permiso: "roles.gestionar", requiere: "usuarios.ver" },
  { permiso: "buzon.marcar_leido", requiere: "buzon.ver" },
  { permiso: "buzon.atender", requiere: "buzon.ver" },
  { permiso: "reglas.gestionar", requiere: "reglas.ver" },
  { permiso: "prorrata.gestionar", requiere: "prorrata.ver" },
  // Todo permiso de cliente exige `clientes.ver` (17).
  { permiso: "clientes.crear", requiere: "clientes.ver" },
  { permiso: "clientes.editar", requiere: "clientes.ver" },
  { permiso: "clientes.archivar", requiere: "clientes.ver" },
  { permiso: "clientes.asignar", requiere: "clientes.ver" },
  { permiso: "credenciales.editar", requiere: "clientes.ver" },
  { permiso: "sire.descargar", requiere: "clientes.ver" },
  { permiso: "sire.clasificar", requiere: "clientes.ver" },
  { permiso: "sire.aprobar_generar", requiere: "clientes.ver" },
  { permiso: "ajustes.crear", requiere: "clientes.ver" },
  { permiso: "ajustes.generar", requiere: "clientes.ver" },
  { permiso: "buzon.ver", requiere: "clientes.ver" },
  { permiso: "buzon.marcar_leido", requiere: "clientes.ver" },
  { permiso: "buzon.atender", requiere: "clientes.ver" },
  { permiso: "reglas.ver", requiere: "clientes.ver" },
  { permiso: "reglas.gestionar", requiere: "clientes.ver" },
  { permiso: "prorrata.ver", requiere: "clientes.ver" },
  { permiso: "prorrata.gestionar", requiere: "clientes.ver" },
];

/** Los 23 permisos que un rol propio puede tener (el catálogo menos `plan.gestionar`), en el orden del catálogo. */
export const PERMISOS_ASIGNABLES: readonly Permiso[] = [
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
];

/** Permisos que exigen TOTP en un rol propio (U2 de 029) y pueden estar en un rol propio (sin `plan.gestionar`). */
const SENSIBLES_PROPIOS: readonly Permiso[] = [
  "usuarios.gestionar",
  "roles.gestionar",
  "credenciales.editar",
];

function requisitos(p: Permiso): Permiso[] {
  return REGLAS_U3.filter((r) => r.permiso === p).map((r) => r.requiere);
}

/** El permiso y todos sus requisitos de U3, en el orden del catálogo. */
function conRequisitos(p: Permiso): Permiso[] {
  const juntos = new Set<Permiso>([p, ...requisitos(p)]);
  return PERMISOS_ASIGNABLES.filter((x) => juntos.has(x));
}

function propio(
  nombre: string,
  alcance: AlcanceRol,
  permisos: readonly Permiso[],
): CasoEfectivo {
  return {
    nombre,
    rolSistema: null,
    propio: { permisos, alcance },
    permisos,
    alcance,
    puedeSerResponsable: permisos.includes("sire.clasificar"),
    exigeFactor: permisos.some((p) => SENSIBLES_PROPIOS.includes(p)),
  };
}

const SISTEMA: readonly CasoEfectivo[] = [
  {
    nombre: "sistema: Dueño (24 permisos, global)",
    rolSistema: "dueno",
    propio: null,
    permisos: [
      "estudio.configurar",
      "plan.gestionar",
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
    ],
    alcance: "global",
    puedeSerResponsable: true,
    exigeFactor: true,
  },
  {
    nombre: "sistema: Administrador (23 permisos, sin plan.gestionar, global)",
    rolSistema: "admin",
    propio: null,
    permisos: PERMISOS_ASIGNABLES,
    alcance: "global",
    puedeSerResponsable: true,
    exigeFactor: true,
  },
  {
    nombre: "sistema: Contador (14 permisos, asignado)",
    rolSistema: "contador",
    propio: null,
    permisos: [
      "clientes.ver",
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
    ],
    alcance: "asignado",
    puedeSerResponsable: true,
    exigeFactor: false,
  },
  {
    nombre: "sistema: Asistente (8 permisos, asignado)",
    rolSistema: "asistente",
    propio: null,
    permisos: [
      "clientes.ver",
      "sire.descargar",
      "sire.clasificar",
      "buzon.ver",
      "buzon.marcar_leido",
      "buzon.atender",
      "reglas.ver",
      "prorrata.ver",
    ],
    alcance: "asignado",
    puedeSerResponsable: true,
    exigeFactor: false,
  },
  {
    nombre: "sistema: Lectura (4 permisos, asignado, no puede ser responsable)",
    rolSistema: "lectura",
    propio: null,
    permisos: ["clientes.ver", "buzon.ver", "reglas.ver", "prorrata.ver"],
    alcance: "asignado",
    puedeSerResponsable: false,
    exigeFactor: false,
  },
];

const PROPIOS: readonly CasoEfectivo[] = [
  propio("propio vacío, asignado", "asignado", []),
  propio("propio vacío, global", "global", []),
  // Cada permiso asignable por separado con sus requisitos de U3.
  ...PERMISOS_ASIGNABLES.map((p) =>
    propio(`propio asignado solo con ${p} (+ requisitos U3)`, "asignado", conRequisitos(p)),
  ),
  propio("propio global solo con clientes.ver", "global", ["clientes.ver"]),
  propio("propio global con sire.clasificar (+ clientes.ver)", "global", [
    "clientes.ver",
    "sire.clasificar",
  ]),
  propio("propio global de consulta", "global", [
    "clientes.ver",
    "buzon.ver",
    "reglas.ver",
    "prorrata.ver",
  ]),
  propio("propio asignado con los 23 permisos asignables", "asignado", PERMISOS_ASIGNABLES),
  propio("propio global con los 23 permisos asignables (nunca es Dueño: sin plan.gestionar)", "global", PERMISOS_ASIGNABLES),
  propio("propio global con los tres sensibles y sus requisitos", "global", [
    "usuarios.ver",
    "usuarios.gestionar",
    "roles.gestionar",
    "clientes.ver",
    "credenciales.editar",
  ]),
];

export const CASOS_EFECTIVOS: readonly CasoEfectivo[] = [...SISTEMA, ...PROPIOS];

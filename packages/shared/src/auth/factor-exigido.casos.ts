import type { Permiso, Rol } from "../acceso/index.js";

// Spec 029 (U1, U2; plan: Decisiones «una tabla de casos común prueba ambas»). Tabla de casos de la
// regla de exigencia del segundo factor, para UNA membresía (o el rol de plataforma). La usan:
//   - `seguridad.spec.ts` (TS: `factorExigido`),
//   - las pruebas de BD de `auth.totp_desactivar` (SQL: la misma regla sobre todas las membresías).
// `rolSistema` es la clave del rol de sistema (`dueno`, `admin`, …) o `null` si el rol es propio del
// estudio (U2: solo ahí deciden los permisos). `plataforma` = el usuario es super-admin (006).
export interface CasoFactorExigido {
  /** Descripción legible; única en la tabla. */
  nombre: string;
  plataforma: boolean;
  rolSistema: Rol | null;
  permisos: readonly Permiso[];
  /** Resultado esperado: ¿se exige TOTP verificado? */
  exigido: boolean;
}

export const CASOS_FACTOR_EXIGIDO: readonly CasoFactorExigido[] = [
  // U1: super-admin, Dueño y Administrador.
  {
    nombre: "super-admin (plataforma) sin rol de estudio",
    plataforma: true,
    rolSistema: null,
    permisos: [],
    exigido: true,
  },
  {
    nombre: "super-admin con rol de estudio de solo lectura",
    plataforma: true,
    rolSistema: "lectura",
    permisos: ["clientes.ver"],
    exigido: true,
  },
  {
    nombre: "Dueño",
    plataforma: false,
    rolSistema: "dueno",
    permisos: [
      "estudio.configurar",
      "plan.gestionar",
      "usuarios.gestionar",
      "roles.gestionar",
      "credenciales.editar",
    ],
    exigido: true,
  },
  {
    nombre: "Dueño con la lista de permisos vacía (el rol manda)",
    plataforma: false,
    rolSistema: "dueno",
    permisos: [],
    exigido: true,
  },
  {
    nombre: "Administrador",
    plataforma: false,
    rolSistema: "admin",
    permisos: [
      "estudio.configurar",
      "usuarios.gestionar",
      "roles.gestionar",
      "credenciales.editar",
    ],
    exigido: true,
  },
  {
    nombre: "Administrador con la lista de permisos vacía (el rol manda)",
    plataforma: false,
    rolSistema: "admin",
    permisos: [],
    exigido: true,
  },
  // U1: «opcional el resto» (roles de sistema distintos de Dueño y Administrador).
  {
    nombre:
      "Contador (rol de sistema, tiene credenciales.editar pero U2 solo cubre roles propios)",
    plataforma: false,
    rolSistema: "contador",
    permisos: [
      "clientes.ver",
      "credenciales.editar",
      "sire.descargar",
      "reglas.gestionar",
    ],
    exigido: false,
  },
  {
    nombre: "Asistente",
    plataforma: false,
    rolSistema: "asistente",
    permisos: ["clientes.ver", "sire.descargar", "buzon.atender"],
    exigido: false,
  },
  {
    nombre: "Lectura",
    plataforma: false,
    rolSistema: "lectura",
    permisos: ["clientes.ver", "buzon.ver", "reglas.ver", "prorrata.ver"],
    exigido: false,
  },
  // U2: rol propio (rolSistema null) con alguno de los cuatro permisos sensibles.
  {
    nombre: "rol propio con usuarios.gestionar",
    plataforma: false,
    rolSistema: null,
    permisos: ["clientes.ver", "usuarios.gestionar"],
    exigido: true,
  },
  {
    nombre: "rol propio con roles.gestionar",
    plataforma: false,
    rolSistema: null,
    permisos: ["clientes.ver", "roles.gestionar"],
    exigido: true,
  },
  {
    nombre: "rol propio con plan.gestionar",
    plataforma: false,
    rolSistema: null,
    permisos: ["plan.gestionar"],
    exigido: true,
  },
  {
    nombre: "rol propio con credenciales.editar",
    plataforma: false,
    rolSistema: null,
    permisos: ["credenciales.editar"],
    exigido: true,
  },
  {
    nombre: "rol propio con los cuatro permisos sensibles",
    plataforma: false,
    rolSistema: null,
    permisos: [
      "usuarios.gestionar",
      "roles.gestionar",
      "plan.gestionar",
      "credenciales.editar",
    ],
    exigido: true,
  },
  {
    nombre: "rol propio con un permiso sensible entre muchos otros",
    plataforma: false,
    rolSistema: null,
    permisos: [
      "clientes.ver",
      "clientes.crear",
      "sire.descargar",
      "buzon.ver",
      "reglas.ver",
      "prorrata.ver",
      "auditoria.ver",
      "credenciales.editar",
    ],
    exigido: true,
  },
  // Rol propio sin ellos (incluye permisos parecidos que NO están en U2).
  {
    nombre: "rol propio sin permisos",
    plataforma: false,
    rolSistema: null,
    permisos: [],
    exigido: false,
  },
  {
    nombre: "rol propio de consulta",
    plataforma: false,
    rolSistema: null,
    permisos: ["clientes.ver", "buzon.ver", "reglas.ver", "prorrata.ver"],
    exigido: false,
  },
  {
    nombre: "rol propio con usuarios.ver (no es usuarios.gestionar)",
    plataforma: false,
    rolSistema: null,
    permisos: ["usuarios.ver"],
    exigido: false,
  },
  {
    nombre: "rol propio con estudio.configurar (no está en U2)",
    plataforma: false,
    rolSistema: null,
    permisos: ["estudio.configurar"],
    exigido: false,
  },
  {
    nombre:
      "rol propio con reglas.gestionar y prorrata.gestionar (no están en U2)",
    plataforma: false,
    rolSistema: null,
    permisos: [
      "reglas.gestionar",
      "prorrata.gestionar",
      "sire.aprobar_generar",
      "auditoria.ver",
    ],
    exigido: false,
  },
];

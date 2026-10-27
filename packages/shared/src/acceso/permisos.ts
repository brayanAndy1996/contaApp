/** Catálogo de permisos atómicos (01 §4). Sin IO. */
export const PERMISOS = [
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
  "reglas.ver",
  "reglas.gestionar",
  "prorrata.ver",
  "auditoria.ver",
] as const;

export type Permiso = (typeof PERMISOS)[number];

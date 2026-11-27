import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

/**
 * Catálogo cerrado de acciones (D-3), las 4 de la ronda adversarial R1 (0045: H-017-1 y H-017-2), `credencial.descifrada` (solo la
 * vista, D-6), `sunat.envio` (reservada, R2) las 8 de la spec 021 (0049) las 5 del buzón de la spec 023 (0054) y las 2 de la atención de la spec 024 (0059), las 2 de la 025 (0061) y las 4 de la prorrata de la 026 (0065) y las 8 de gastos no deducibles de la 027 (0069) y la de preferencias de correo de la 028 (0073) y las 3 de roles propios de la 030 (0082).
 */
export const ACCIONES_AUDITORIA_BD = [
  "sesion.ingreso",
  "invitacion.creada",
  "invitacion.revocada",
  "invitacion.modificada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "miembro.eliminado",
  "asignacion.agregada",
  "asignacion.quitada",
  "asignacion.tipo_cambiado",
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  "cliente.eliminado",
  "credencial.guardada",
  "credencial.verificada",
  "credencial.invalidada",
  "credencial.descifrada",
  "propuesta.cargada",
  "compra.operacion",
  "venta.agregada",
  "venta.excluida",
  "venta.restaurada",
  "venta.salto_justificado",
  "xml.subido",
  "periodo.estado_cambiado",
  "archivo.generado",
  "sunat.envio",
  // Spec 021 (0049): reglas aprendidas, interruptores del motor, aporte al catálogo y la versión `historial`.
  "regla.creada",
  "regla.editada",
  "regla.activada",
  "regla.desactivada",
  "regla.eliminada",
  "estudio.regla_motor",
  "estudio.aporte_catalogo",
  "compra.historial",
  // Spec 023 (0054): buzón SOL. `contenido_obtenido` por trigger (actor trabajo); las otras cuatro por buzon_auditar (backend).
  "buzon.captura_solicitada",
  "buzon.apertura_solicitada",
  "buzon.contenido_visto",
  "buzon.adjunto_descargado",
  "buzon.contenido_obtenido",
  // Spec 024 (0059): atención de mensajes, por la función acotada buzon_atencion_aplicar (actor usuario).
  "buzon.atendido",
  "buzon.atencion_deshecha",
  // Spec 025 (0061): importación del historial y candidata descartada, por las funciones acotadas de 0062 (actor usuario).
  "regla.historial_importado",
  "regla.candidata_descartada",
  // Spec 026 (0065): prorrata, por las funciones acotadas de 0066 (`declaraciones_obtenidas` con actor trabajo; las otras tres, usuario).
  "prorrata.declaraciones_obtenidas",
  "prorrata.mes_manual_guardado",
  "prorrata.mes_manual_eliminado",
  "prorrata.usada_guardada",
  // Spec 027 (0069): gastos no deducibles, por las funciones acotadas de 0070 (actor usuario). Los cambios del super-admin quedan en
  // `gnd_global_historial`, no en la auditoría del estudio.
  "gnd.palabra_agregada",
  "gnd.palabra_desactivada",
  "gnd.palabra_reactivada",
  "gnd.palabra_aprendida",
  "gnd.global_desactivada",
  "gnd.global_reactivada",
  "gnd.umbral_cambiado",
  "gnd.categorias_cliente",
  // Spec 028 (0073): preferencias de correo, por `correo_preferencias_fijar` (origen app) y `auth.correo_baja_aplicar` (origen enlace).
  "correo.preferencia_cambiada",
  // Spec 030 (0082): roles propios, por `acceso.rol_guardar` y `acceso.rol_eliminar` (actor usuario; permisos y alcance antes/después).
  "rol.creado",
  "rol.editado",
  "rol.eliminado",
] as const;

const lista = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(", "));

// Spec 017 (D-1, D-2): registro de auditoría de solo agregado. Sin FK a usuario, cliente ni trabajo (un registro no bloquea
// nada). `ocurrida_en` en milisegundos: el cursor de la consulta viaja como Date. RLS (solo FOR SELECT), grants, triggers de
// inmutabilidad y `auditoria_registrar` en 0041; las capturas en 0042. Va aparte del índice del esquema, como 012b–016.
export const auditoria = pgTable(
  "auditoria",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .default(tenantIdPorDefecto)
      .references(() => tenant.id),
    ocurridaEn: timestamp("ocurrida_en", { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('milliseconds', clock_timestamp())`),
    actorTipo: text("actor_tipo").notNull(),
    usuarioId: uuid("usuario_id"),
    trabajoId: uuid("trabajo_id"),
    accion: text("accion").notNull(),
    clienteId: uuid("cliente_id"),
    entidad: text("entidad").notNull(),
    entidadId: uuid("entidad_id"),
    datos: jsonb("datos").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("auditoria_fecha_idx").on(t.tenantId, t.ocurridaEn.desc(), t.id.desc()),
    index("auditoria_cliente_idx").on(t.tenantId, t.clienteId, t.ocurridaEn.desc(), t.id.desc()),
    check(
      "auditoria_actor_coherente",
      sql`(${t.actorTipo} = 'usuario' AND ${t.usuarioId} IS NOT NULL AND ${t.trabajoId} IS NULL) OR (${t.actorTipo} = 'trabajo' AND ${t.trabajoId} IS NOT NULL) OR (${t.actorTipo} = 'sistema' AND ${t.usuarioId} IS NULL AND ${t.trabajoId} IS NULL)`,
    ),
    check("auditoria_accion_valida", sql`${t.accion} IN (${lista(ACCIONES_AUDITORIA_BD)})`),
    check("auditoria_entidad_formato", sql`${t.entidad} ~ '^[a-z][a-z_]{0,62}$'`),
    check("auditoria_ocurrida_en_ms", sql`${t.ocurridaEn} = date_trunc('milliseconds', ${t.ocurridaEn})`),
    check(
      "auditoria_datos_objeto",
      sql`jsonb_typeof(${t.datos}) = 'object' AND pg_column_size(${t.datos}) <= 4096`,
    ),
  ],
);

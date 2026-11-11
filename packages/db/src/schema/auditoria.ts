import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, tenantIdPorDefecto } from "./comun";
import { tenant } from "./plataforma";

/**
 * Catálogo cerrado de acciones (D-3), las 4 de la ronda adversarial R1 (0045: H-017-1 y H-017-2), `credencial.descifrada` (solo la
 * vista, D-6) y `sunat.envio` (reservada, R2).
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

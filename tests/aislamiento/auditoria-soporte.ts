// Soporte de las pruebas de BD de la spec 017 (T2, rojo). No es una prueba (no termina en .spec.ts).
// Siembra con el superusuario (MIGRATIONS_DATABASE_URL: pasa por los triggers y las FK, no por RLS ni grants) y ejecuta la ACCION
// que se audita con el rol de la app (`withTenant` de @contapp/db) o con las funciones `auth.*`. Las filas de auditoria que la
// siembra misma deja (actor `sistema`) son ruido: cada prueba mide solo lo que su accion agrega (`capturar`).
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T2 (T7 lo implementa en las migraciones 0041 y 0042; T8 en packages/db):
//   Tabla `auditoria` (D-1): id uuid v7, tenant_id (FK a tenant), ocurrida_en, actor_tipo usuario|trabajo|sistema, usuario_id,
//     trabajo_id, accion, cliente_id (null), entidad (text), entidad_id (uuid), datos jsonb objeto <= 4096 bytes. Sin FK a
//     usuario, cliente ni trabajo. Una politica FOR SELECT por tenant; GRANT SELECT solo a contapp_backend.
//   `entidad` = nombre de la tabla de origen, y `entidad_id` = su `id`:
//     sesion.ingreso -> 'sesion' (auth.sesion.id) · invitacion.* -> 'invitacion' · miembro.* -> 'membresia' · asignacion.* ->
//     'asignacion' · cliente.* -> 'cliente' (cliente_id = el mismo id) · credencial.* -> 'credencial' · propuesta.cargada ->
//     'propuesta' · compra.operacion -> 'compra_operacion' · venta.agregada -> 'venta' · venta.excluida y venta.restaurada ->
//     'venta_exclusion' · venta.salto_justificado -> 'venta_salto_justificado' · xml.subido -> 'documento_xml' ·
//     periodo.estado_cambiado -> 'compra_periodo' | 'venta_periodo' (esas tablas no tienen id: no se fija entidad_id) ·
//     archivo.generado -> 'archivo_generado'.
//   `datos`: exactamente la lista blanca del plan, con las claves tal cual (camelCase las del plan: `filasRecibidas`,
//     `referenciaId`, `sha256Zip`, `usuarioId`); `cliente.editado.cambios` usa los nombres de columna (`razon_social`,
//     `ventas_mixtas`, ...) con `[antes, despues]`.
//   Funciones nuevas de @contapp/db: marcarOrigenImportacion(tx): Promise<void>; leerCambiosDeOperacion(tx, operacionId):
//     Promise<{ compraId; antes: VersionCompra | null; despues: VersionCompra }[]> por compraId ascendente, con VersionCompra =
//     { n: number; excluida: boolean; clasificada: boolean; biDg; igvDg; biDng; igvDng; total: string; ... } (montos como cadena);
//     listarAuditoria(tx, { antes?: { en: Date; id: string }; limite }): Promise<FilaAuditoria[]> con FilaAuditoria =
//     { id; ocurridaEn: Date; accion; actorTipo; usuarioId | null; trabajoId | null; clienteId | null; entidad; entidadId;
//     datos }. ContextoTenant.trabajoId?: string (uuid validado) fija `app.trabajo_id`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect } from "vitest";
import { EscenarioArchivos } from "./archivos-soporte";
import { abrirAdmin, exportado } from "./auth-soporte";
import { detalleXml, normalizarIdentidad, rutaDe, type IdentidadXml, type OrigenXml } from "./compras-xml-soporte";
import type { ClientePrueba } from "./trabajos-soporte";
import { crearDb, type ContappDb, type ContextoTenant, type Tx } from "./soporte";

export { abrirAdmin, exportado };

/** Las tres tablas nuevas de 017. No se agregan a TABLAS_NEGOCIO: sus bucles hacen INSERT/UPDATE/DELETE genericos por rol. */
export const TABLAS_017 = ["auditoria", "notificacion", "plan_aviso"] as const;

/** Roles de la app: ninguno escribe `auditoria` ni `plan_aviso` (D-2). */
export const ROLES_017 = ["contapp_backend", "contapp_worker", "contapp_app", "contapp_platform"] as const;

/** Catalogo de acciones de D-3 que un trigger captura (25). */
export const ACCIONES_D3 = [
  "sesion.ingreso",
  "invitacion.creada",
  "invitacion.revocada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "asignacion.agregada",
  "asignacion.quitada",
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  "credencial.guardada",
  "credencial.verificada",
  "credencial.invalidada",
  "propuesta.cargada",
  "compra.operacion",
  "venta.agregada",
  "venta.excluida",
  "venta.restaurada",
  "venta.salto_justificado",
  "xml.subido",
  "periodo.estado_cambiado",
  "archivo.generado",
] as const;

/**
 * Acciones que agrega la ronda adversarial R1 (T16): cambio de tipo de asignacion (H-017-1) y las escrituras que los grants permiten y que
 * ahora se auditan (H-017-2). Las cubre `auditoria-correcciones.spec.ts`; T17 las agrega al CHECK (0045), a `shared` y al frontend.
 */
export const ACCIONES_RONDA_R1 = ["asignacion.tipo_cambiado", "miembro.eliminado", "cliente.eliminado", "invitacion.modificada"] as const;

/** El CHECK de `accion` admite ademas las de la ronda R1, la vista de descifrados (D-6) y la reservada `sunat.envio` (R2). */
export const ACCIONES_CATALOGO = [...ACCIONES_D3, ...ACCIONES_RONDA_R1, "credencial.descifrada", "sunat.envio"] as const;

export interface FilaAud {
  id: string;
  tenant_id: string;
  ocurrida_en: Date;
  actor_tipo: "usuario" | "trabajo" | "sistema";
  usuario_id: string | null;
  trabajo_id: string | null;
  accion: string;
  cliente_id: string | null;
  entidad: string;
  entidad_id: string | null;
  datos: Record<string, unknown>;
}

export interface EsperadaAud {
  actorTipo: FilaAud["actor_tipo"];
  usuarioId?: string | null;
  trabajoId?: string | null;
  clienteId?: string | null;
  entidad: string;
  entidadId?: string | null;
  datos: Record<string, unknown>;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export class EscenarioAuditoria extends EscenarioArchivos {
  private backendDb?: ContappDb;
  private workerDb?: ContappDb;

  get backend(): ContappDb {
    return (this.backendDb ??= crearDb("contapp_backend", 4));
  }
  get worker(): ContappDb {
    return (this.workerDb ??= crearDb("contapp_worker", 4));
  }

  /** Cierra los pools propios (la limpieza de datos es `limpiar()`, heredada, que ya borra auditoria/notificacion/plan_aviso). */
  async cerrar(): Promise<void> {
    await Promise.all([this.backendDb?.close(), this.workerDb?.close()].map((p) => p?.catch(() => undefined)));
  }

  comoBackend<T>(tenantId: string, userId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx: ContextoTenant = userId === undefined ? { tenantId } : { tenantId, userId };
    return this.backend.withTenant(ctx, fn);
  }

  comoWorker<T>(
    tenantId: string,
    o: { userId?: string; trabajoId?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const ctx: ContextoTenant = { tenantId, ...o };
    return this.worker.withTenant(ctx, fn);
  }

  /** `documento_xml` sembrado con el superusuario (identidad normalizada, `n` = el siguiente). Devuelve su id. */
  async xml(tenantId: string, c: ClientePrueba | string, id: IdentidadXml, o: { origen?: OrigenXml; subidoPor?: string | null } = {}): Promise<string> {
    const clienteId = typeof c === "string" ? c : c.id;
    const i = normalizarIdentidad(id);
    const origen = o.origen ?? "real";
    const ruta = rutaDe(tenantId, clienteId);
    const r = await this.admin.query(
      `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle, subido_por)
       values ($1, $2, $3, $4, $5, $6,
               (select coalesce(max(n), 0) + 1 from documento_xml
                 where tenant_id = $1 and cliente_id = $2 and ruc_emisor = $3 and tipo = $4 and serie = $5 and numero = $6),
               $7, $8, $9, 1234, $10::jsonb, $11)
       returning id`,
      [tenantId, clienteId, i.rucEmisor, i.tipo, i.serie, i.numero, origen, ruta, createHash("sha256").update(ruta).digest(),
        JSON.stringify(detalleXml()), origen === "subido" ? (o.subidoPor ?? null) : null],
    );
    return r.rows[0].id as string;
  }

  /** Todas las filas de auditoria de un estudio (o de una accion), por (ocurrida_en, id). */
  async filas(tenantId: string, accion?: string): Promise<FilaAud[]> {
    const r = await this.admin.query(
      `select * from auditoria where tenant_id = $1 and ($2::text is null or accion = $2)
        order by ocurrida_en, id`,
      [tenantId, accion ?? null],
    );
    return r.rows as FilaAud[];
  }

  /** Ejecuta `hacer` y devuelve solo las filas de `accion` que agrego (la siembra deja ruido de otras filas). */
  async capturar<T>(
    tenantId: string,
    accion: string,
    hacer: () => Promise<T>,
  ): Promise<{ filas: FilaAud[]; resultado: T }> {
    const previas = new Set((await this.filas(tenantId, accion)).map((f) => f.id));
    const resultado = await hacer();
    const filas = (await this.filas(tenantId, accion)).filter((f) => !previas.has(f.id));
    return { filas, resultado };
  }

  /** Cantidad de filas de auditoria de un estudio. */
  async cuantas(tenantId: string): Promise<number> {
    const r = await this.admin.query("select count(*)::int as n from auditoria where tenant_id = $1", [tenantId]);
    return r.rows[0].n as number;
  }

  /** Un trabajo `ejecutando` del estudio con su `creado_por` (el worker lo usa como `app.trabajo_id`). */
  trabajo(tenantId: string, c: { id: string; ruc: string }, creadoPor: string | null): Promise<string> {
    return this.job(tenantId, c, { estado: "ejecutando", creadoPor, tipo: "archivo.generar", cola: "archivos", canal: "ninguno" });
  }

  /** Credencial con valores centinela reconocibles (ASCII) en el sobre; el id de la fila. */
  async credencialCentinela(tenantId: string, clienteId: string, centinela: string): Promise<string> {
    const r = await this.admin.query(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
       values ($1, $2, 'sol', $3, $4, $5, $6, 'k1', 1) returning id`,
      [tenantId, clienteId, Buffer.from(`ct-${centinela}`), randomBytes(12), randomBytes(16), Buffer.from(`dek-${centinela}`)],
    );
    return r.rows[0].id as string;
  }
}

/** Exactamente una fila de `accion`, con actor, cliente, entidad, entidad_id (si se da) y `datos` EXACTOS (mismas claves). */
export function unaFila(filas: FilaAud[], accion: string, e: EsperadaAud): FilaAud {
  expect(
    filas.map((f) => f.accion),
    `filas nuevas de ${accion}`,
  ).toEqual([accion]);
  const f = filas[0]!;
  const real: Record<string, unknown> = { actorTipo: f.actor_tipo, entidad: f.entidad, datos: f.datos };
  const esperado: Record<string, unknown> = { actorTipo: e.actorTipo, entidad: e.entidad, datos: e.datos };
  if (e.usuarioId !== undefined) (real.usuarioId = f.usuario_id), (esperado.usuarioId = e.usuarioId);
  if (e.trabajoId !== undefined) (real.trabajoId = f.trabajo_id), (esperado.trabajoId = e.trabajoId);
  if (e.clienteId !== undefined) (real.clienteId = f.cliente_id), (esperado.clienteId = e.clienteId);
  if (e.entidadId !== undefined) (real.entidadId = f.entidad_id), (esperado.entidadId = e.entidadId);
  expect(real, accion).toEqual(esperado);
  return f;
}

export const uuidAjeno = (): string => randomUUID();

/** Una sentencia en una transaccion del superusuario que SIEMPRE se revierte; devuelve el SQLSTATE o 'ok' (y las filas). */
export async function enRevertida(
  admin: Pool,
  pasos: (c: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }) => Promise<void>,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await pasos(c);
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

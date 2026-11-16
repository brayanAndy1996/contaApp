/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 021 (T5, rojo). Encima de `soporte-compras.ts`: siembra reglas aprendidas por SQL
// (conexión de migraciones: no pasa por RLS ni por grants, sí por los triggers y las FK), compras «Según historial» por el único
// camino que la BD admite (la función `aplicar_regla_historial` llamada como el worker, dentro de la transacción que crea la
// compra: plan 021, D-6), lecturas de verificación y limpieza de las tablas de solo inserción de 021. No es una prueba ni código
// de producción. Datos sintéticos (RUC de prueba `207…`), sin RUC reales.
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 021, «Contratos: BD»; el mismo de `tests/aislamiento/reglas-soporte.ts`, T3):
//  - `regla_aprendida(tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por,
//    actualizada_por, eliminada_en, eliminada_por)`; `regla_aplicacion(tenant_id, regla_id, compra_id, version_n, periodo)`;
//    `regla_aceptacion(tenant_id, regla_aplicacion_id, regla_id, periodo)`; `regla_confirmacion(tenant_id, regla_id, cliente_id,
//    ruc_proveedor, destino, origen, creada_en)`; `estudio_regla_motor(tenant_id, codigo, activa, actualizada_por)`;
//    `estudio_reglas_config(tenant_id, aportar_catalogo)`.
//  - `public.aplicar_regla_historial(p_compra, p_regla, p_datos jsonb) -> integer` (contapp_worker; `p_datos` = las 11 columnas de
//    monto de la versión 1 consolidada en el destino de la regla, en snake_case y como cadenas).
//  - `public.reglas_historial_vigentes(p_cliente, p_periodo)` (contapp_worker): lo que lee la descarga.
import { randomUUID } from "node:crypto";
import { createDb } from "@contapp/db";
import * as shared from "@contapp/shared";
import {
  abrirBancoCompras,
  base,
  claveCompra,
  COLUMNAS,
  hallazgoIscSinXml,
  hallazgoIscXml,
  montos,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type Montos,
} from "./soporte-compras.js";
import type { Resp } from "./soporte.js";

export { base, hallazgoIscSinXml, hallazgoIscXml, montos, PERIODO };
export type { Actor, BancoCompras, Estudio, Montos };

export type Destino = "DG" | "DGNG" | "DNG";
export const APRENDIDO = "202609";
export const CODIGOS_MOTOR = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"] as const;

/** Rutas de reglas del cliente. */
export const rutaReglas = (clienteId: string): string => `/clientes/${clienteId}/reglas`;
export const RUTA_MOTOR = "/estudio/reglas-motor";

/** Lo que pasa a las columnas del par del destino: los tres BI y los tres IGV sumados en él, el resto igual. */
export function consolidar(m: Montos, destino: Destino): Montos {
  const suma = (a: string, b: string, c: string): string => {
    const t = [a, b, c].reduce((s, x) => s + BigInt(x.replace(".", "")), 0n);
    const neg = t < 0n;
    const d = (neg ? -t : t).toString().padStart(3, "0");
    return `${neg ? "-" : ""}${d.slice(0, -2)}.${d.slice(-2)}`;
  };
  const bi = suma(m.biDg, m.biDgng, m.biDng);
  const igv = suma(m.igvDg, m.igvDgng, m.igvDng);
  return {
    ...m,
    biDg: destino === "DG" ? bi : "0.00",
    igvDg: destino === "DG" ? igv : "0.00",
    biDgng: destino === "DGNG" ? bi : "0.00",
    igvDgng: destino === "DGNG" ? igv : "0.00",
    biDng: destino === "DNG" ? bi : "0.00",
    igvDng: destino === "DNG" ? igv : "0.00",
  };
}

const SQL_MONTO: Record<string, string> = {
  biDg: "bi_dg",
  igvDg: "igv_dg",
  biDgng: "bi_dgng",
  igvDgng: "igv_dgng",
  biDng: "bi_dng",
  igvDng: "igv_dng",
  noGravado: "no_gravado",
  isc: "isc",
  icbper: "icbper",
  otrosTributos: "otros_tributos",
  total: "total",
};
const datosJson = (m: Montos): Record<string, string> =>
  Object.fromEntries(Object.entries(SQL_MONTO).map(([k, sql]) => [sql, (m as Record<string, string>)[k]!]));

export interface OpcionesRegla {
  docTipo?: string;
  docNumero?: string;
  destino?: Destino;
  activa?: boolean;
  version?: number;
  periodoAprendido?: string;
  usuarioId: string;
  eliminada?: boolean;
}

export interface OpcionesSegunHistorial {
  periodo?: string;
  serie: string;
  numero: string;
  docTipo?: string;
  doc?: string;
  razonSocial?: string | null;
  /** Montos de la versión 1 del SIRE (por omisión BI 100.00 + IGV 18.00 en DG). */
  montos?: Partial<Montos>;
  propuestaId: string;
  usuarioId: string;
}

export interface BancoReglas extends BancoCompras {
  /** Cualquier verbo HTTP del contrato de 021 (la base solo trae GET, POST y DELETE). */
  http(a: Actor, metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", ruta: string, cuerpo?: unknown): Promise<Resp>;
  /** Regla aprendida sembrada por SQL; devuelve su id. */
  sembrarRegla(tenantId: string, clienteId: string, o: OpcionesRegla): Promise<string>;
  /**
   * Una compra del SIRE con su versión 1 y la versión 2 `historial` en el destino de la regla, escrita como la escribe el worker
   * (la compra se crea en la misma transacción que llama a `aplicar_regla_historial`). Devuelve el id de la compra.
   */
  sembrarSegunHistorial(tenantId: string, clienteId: string, reglaId: string, o: OpcionesSegunHistorial): Promise<string>;
  /** Marca como aceptada (P-4) la aplicación de la regla a esa compra. */
  aceptarAplicacion(tenantId: string, reglaId: string, compraId: string): Promise<void>;
  /** `estudio_regla_motor` y `estudio_reglas_config` por SQL (interruptor guardado sin pasar por la API). */
  fijarMotorBd(tenantId: string, codigo: string, activa: boolean, usuarioId: string): Promise<void>;
  fijarAporteBd(tenantId: string, aportar: boolean): Promise<void>;
  /** Filas de `regla_aprendida` del cliente (vivas y eliminadas), de la más antigua a la más reciente. */
  reglasBd(clienteId: string): Promise<any[]>;
  /** Filas de `regla_confirmacion` del estudio (el rol de la aplicación no las lee: solo la conexión de migraciones). */
  confirmacionesBd(tenantId: string): Promise<any[]>;
  /** Filas de `auditoria` del estudio con esa acción, de la más antigua a la más reciente. */
  auditoriaDe(tenantId: string, accion: string): Promise<any[]>;
  /** Todo el texto de `auditoria` del estudio (datos): para buscar canarios. */
  textoAuditoria(tenantId: string): Promise<string>;
  /** Lo que la descarga lee del cliente en ese periodo (`reglas_historial_vigentes`, como contapp_worker). */
  reglasParaDescarga(tenantId: string, clienteId: string, periodo: string): Promise<any[]>;
}

export async function abrirBancoReglas(): Promise<BancoReglas> {
  const v = await abrirBancoCompras();
  const sql = v.b.sql;
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de reglas");
  const worker = createDb({ rolApp: "contapp_worker", url, poolMax: 2 });
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  const tenants: string[] = [];

  return {
    ...v,
    estudio: async () => {
      const e = await v.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    http: (a, metodo, ruta, cuerpo) => v.b.c.p.b.llamar(a, metodo, ruta, cuerpo),
    sembrarRegla: async (tenantId, clienteId, o) => {
      const r = await sql(
        `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
           creada_por, actualizada_por, eliminada_en, eliminada_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, case when $10::boolean then now() else null end,
                 case when $10::boolean then $9::uuid else null end)
         returning id`,
        [
          tenantId,
          clienteId,
          o.docTipo ?? "6",
          o.docNumero ?? "20700000011",
          o.destino ?? "DNG",
          o.activa ?? true,
          o.version ?? 1,
          o.periodoAprendido ?? APRENDIDO,
          o.usuarioId,
          o.eliminada ?? false,
        ],
      );
      return r[0].id as string;
    },
    sembrarSegunHistorial: async (tenantId, clienteId, reglaId, o) => {
      const periodo = o.periodo ?? PERIODO;
      const docTipo = o.docTipo ?? "6";
      const doc = o.doc ?? "20700000011";
      const m1 = montos(o.montos ?? { biDg: "100.00", igvDg: "18.00" });
      const [regla] = await sql("select destino from regla_aprendida where id = $1", [reglaId]);
      const destino = regla.destino as Destino;
      return worker.withTenant({ tenantId }, async (tx) => {
        const c = await tx.query(
          `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
             razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
           values ($1, $2, $3, $4, '01', $5, $6, $7, $8, $9, '2026-10-05', 'PEN', null, 'sire', 1) returning id`,
          [
            clienteId,
            periodo,
            o.propuestaId,
            claveCompra("01", o.serie, o.numero, docTipo, doc),
            o.serie,
            o.numero,
            docTipo,
            doc,
            o.razonSocial === undefined ? "PROVEEDOR SINTETICO SAC" : o.razonSocial,
          ],
        );
        const id = c.rows[0].id as string;
        await tx.query(
          `insert into compra_version (compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
             otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
           values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, null, false, 'original', null, null)`,
          [id, ...COLUMNAS.map((k) => m1[k]), m1.total],
        );
        await tx.query("select public.aplicar_regla_historial($1, $2, $3::jsonb)", [
          id,
          reglaId,
          JSON.stringify(datosJson(consolidar(m1, destino))),
        ]);
        return id;
      });
    },
    aceptarAplicacion: async (tenantId, reglaId, compraId) => {
      await sql(
        `insert into regla_aceptacion (tenant_id, regla_aplicacion_id, regla_id, periodo)
         select tenant_id, id, regla_id, periodo from regla_aplicacion where tenant_id = $1 and regla_id = $2 and compra_id = $3`,
        [tenantId, reglaId, compraId],
      );
    },
    fijarMotorBd: async (tenantId, codigo, activa, usuarioId) => {
      await sql(
        `insert into estudio_regla_motor (tenant_id, codigo, activa, actualizada_por) values ($1, $2, $3, $4)
         on conflict (tenant_id, codigo) do update set activa = excluded.activa`,
        [tenantId, codigo, activa, usuarioId],
      );
    },
    fijarAporteBd: async (tenantId, aportar) => {
      await sql(
        `insert into estudio_reglas_config (tenant_id, aportar_catalogo) values ($1, $2)
         on conflict (tenant_id) do update set aportar_catalogo = excluded.aportar_catalogo`,
        [tenantId, aportar],
      );
    },
    reglasBd: (clienteId) =>
      sql(
        `select id, doc_tipo, doc_numero, destino, activa, version::int as version, periodo_aprendido, creada_por, actualizada_por,
                eliminada_en is not null as eliminada
           from regla_aprendida where cliente_id = $1 order by creada_en, id`,
        [clienteId],
      ),
    confirmacionesBd: (tenantId) =>
      sql(
        `select regla_id, cliente_id, ruc_proveedor, destino, origen from regla_confirmacion where tenant_id = $1 order by creada_en, id`,
        [tenantId],
      ),
    auditoriaDe: (tenantId, accion) =>
      sql(
        `select actor_tipo, usuario_id, cliente_id, entidad, entidad_id, datos from auditoria
          where tenant_id = $1 and accion = $2 order by ocurrida_en, id`,
        [tenantId, accion],
      ),
    textoAuditoria: async (tenantId) =>
      (await sql(`select coalesce(string_agg(datos::text, ' '), '') as t from auditoria where tenant_id = $1`, [tenantId]))[0].t,
    reglasParaDescarga: (tenantId, clienteId, periodo) =>
      worker.withTenant({ tenantId }, async (tx) =>
        (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [clienteId, periodo])).rows,
      ),
    cerrar: async () => {
      if (tenants.length > 0) {
        const c = await admin.pool.connect();
        try {
          await c.query("SET session_replication_role = replica");
          // Tablas de solo inserción de 021, de la hija a la madre, antes de que `v.cerrar()` borre compras, clientes y estudios.
          const borrar = [
            "delete from regla_confirmacion where tenant_id = any($1::uuid[])",
            "delete from regla_aceptacion where tenant_id = any($1::uuid[])",
            "delete from regla_aplicacion where tenant_id = any($1::uuid[])",
            "delete from regla_aprendida where tenant_id = any($1::uuid[])",
            "delete from estudio_regla_motor where tenant_id = any($1::uuid[])",
            "delete from estudio_reglas_config where tenant_id = any($1::uuid[])",
          ];
          for (const texto of borrar) await c.query(texto, [tenants]).catch(() => undefined);
        } finally {
          c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
        }
      }
      try {
        await v.cerrar();
      } finally {
        await worker.close();
        await admin.close();
      }
    },
  };
}

/**
 * ¿El valor cumple el esquema `nombre` de `@contapp/shared`? Si el paquete aún no lo exporta (T8), falla con ese motivo claro en
 * vez de un TypeError: así el rojo dice qué falta.
 */
export function cumple(nombre: string, valor: unknown): boolean {
  const esquema = (shared as Record<string, any>)[nombre];
  if (esquema === undefined) throw new Error(`@contapp/shared no exporta ${nombre} (T8)`);
  return esquema.safeParse(valor).success;
}

/** Un identificador de uuid v4 que no existe en ninguna tabla. */
export const inexistente = (): string => randomUUID();

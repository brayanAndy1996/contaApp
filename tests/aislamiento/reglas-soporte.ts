// Soporte de las pruebas de BD de la spec 021 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Siembra reglas aprendidas, interruptores del motor y descargas con el superusuario (MIGRATIONS_DATABASE_URL: pasa por los
// triggers y las FK, no por RLS ni grants) o con el rol del worker, y borra todo al final con `session_replication_role = replica`
// (las tablas de 021 son de solo insercion y las FK compuestas impiden borrar en cualquier orden). Datos sinteticos: sin RUC reales.
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T3 (T9 lo implementa en las migraciones 0047-0049 y en `packages/db/src/reglas/`).
// Tablas y columnas son las de `plan.md` (Contratos: BD). Lo que el plan deja abierto y estas pruebas fijan:
//   SQL (worker, dentro de `withTenant`):
//     public.reglas_historial_vigentes(p_cliente uuid, p_periodo) -> TABLE (regla_id, doc_tipo, doc_numero, destino, version)
//     public.aplicar_regla_historial(p_compra uuid, p_regla uuid, p_datos jsonb) -> integer (siempre 2)
//       `p_datos` = objeto jsonb con las 11 columnas de monto de `compra_version` en snake_case y como CADENAS
//       (bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos, total): la version 1 consolidada
//       en el destino de la regla (ver `consolidar`).
//   TypeScript (`@contapp/db`, todas con la `tx` de withTenant como primer argumento; montos como cadenas, nunca `number`):
//     ReglaFila = { id; clienteId; docTipo; docNumero; destino: 'DG'|'DGNG'|'DNG'; activa: boolean; version: number;
//       periodoAprendido: string; creadaPor: string; creadaEn: Date; actualizadaEn: Date; razonSocial: string | null;
//       aplicada: number; aceptada: number }   (aplicada y aceptada: P-4, contadas desde regla_aplicacion y regla_aceptacion)
//     listarReglas(tx, clienteId): Promise<ReglaFila[]>                      sin eliminadas
//     recordarRegla(tx, { clienteId, compraIds, destino, versionBase: number | null, usuarioId })
//         : Promise<ReglaFila | 'regla_cambiada' | 'proveedores_distintos' | 'no_encontrada'>
//     editarRegla(tx, { clienteId, reglaId, versionBase, destino?, activa?, usuarioId })
//         : Promise<ReglaFila | 'regla_cambiada' | 'no_encontrada'>
//     eliminarRegla(tx, { clienteId, reglaId, versionBase, usuarioId }): Promise<'ok' | 'regla_cambiada' | 'no_encontrada'>
//     leerReglasMotor(tx): Promise<{ filas: { codigo: string; activa: boolean }[]; aportarCatalogo: boolean }>
//         (solo las filas guardadas: sin fila = encendida; sin fila de config = aportar true)
//     fijarReglaMotor(tx, { codigo, activa, usuarioId }): Promise<void>      toma el advisory exclusivo 'reglas_motor'
//     fijarAporte(tx, { aportar, usuarioId }): Promise<void>
//     reglasHistorialVigentes(tx, clienteId, periodo): Promise<{ reglaId; docTipo; docNumero; destino; version }[]>
//     aplicarReglaHistorial(tx, compraId, reglaId, datos: Montos): Promise<number>
//     insertarCompras(tx, ctx, nuevas, { evaluar, historial? }) con `historial(fila: CompraLeida) => { reglaId; datos: Montos } | null`.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { EscenarioAuditoria } from "./auditoria-soporte";
import {
  claveCompra,
  COLUMNAS_MONTO,
  montos,
  SQL_MONTO,
  type ColumnaMonto,
  type Montos,
} from "./compras-soporte";
import type { ClientePrueba } from "./trabajos-soporte";
import type { Tx } from "./soporte";

export { PERIODO } from "./compras-soporte";

/** Periodo en que se aprendieron las reglas sembradas, y periodo de la descarga que las aplica (P-5). */
export const APRENDIDO = "202609";
export const DESCARGA = "202610";

export const DESTINOS = ["DG", "DGNG", "DNG"] as const;
export type Destino = (typeof DESTINOS)[number];

export const CODIGOS_MOTOR = [
  "R-ISC",
  "R-MIX",
  "R-RED",
  "R-NEW",
  "R-GP",
  "R-HIS",
] as const;

export const TABLAS_REGLAS = [
  "regla_aprendida",
  "estudio_regla_motor",
  "estudio_reglas_config",
  "regla_aplicacion",
  "regla_aceptacion",
  "regla_confirmacion",
] as const;

/** Roles con alguna relacion con la app: ninguno lee `regla_confirmacion`. */
export const ROLES_APP = [
  "contapp_backend",
  "contapp_worker",
  "contapp_app",
  "contapp_platform",
  "contapp_enumerador",
  "contapp_auth",
  "contapp_registrador",
] as const;

// ---- Aritmetica en centimos con BigInt: ninguna prueba usa `number` para dinero ------------------------------------------------
const aCentimos = (s: string): bigint => BigInt(s.replace(".", ""));
const deCentimos = (c: bigint): string => {
  const neg = c < 0n;
  const a = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
};
const suma = (...v: string[]): string =>
  deCentimos(v.reduce((s, x) => s + aCentimos(x), 0n));

/** La version 1 consolidada en el destino: los tres BI y los tres IGV sumados en el par del destino; lo demas igual. */
export function consolidar(m: Montos, destino: Destino): Montos {
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

/** `p_datos` de `aplicar_regla_historial`: las columnas de monto en snake_case. */
export function datosJson(m: Montos): Record<string, string> {
  return Object.fromEntries(
    (Object.keys(SQL_MONTO) as (ColumnaMonto | "total")[]).map((k) => [
      SQL_MONTO[k],
      m[k],
    ]),
  );
}

export { COLUMNAS_MONTO, montos };

/** Factura gravada tipica en DG. */
export const FACTURA_DG = montos({ biDg: "1000.00", igvDg: "180.00" });
/** Mixta: 600 en DG y 400 en DGNG (el IGV de cada par), para el caso 21.48/1.61 se usa `MIXTA_CHICA`. */
export const MIXTA = montos({
  biDg: "600.00",
  igvDg: "108.00",
  biDgng: "400.00",
  igvDgng: "72.00",
});
export const MIXTA_CHICA = montos({
  biDg: "21.48",
  igvDg: "1.61",
  noGravado: "8.97",
});

// ---- Compras creadas por el worker (como la descarga) ------------------------------------------------------------------------
export interface FilaDescarga {
  serie?: string;
  numero: string;
  docTipo?: string;
  docNumero?: string;
  razonSocial?: string | null;
  montos?: Montos;
}

/**
 * Inserta, dentro de la transaccion `tx` del worker, una compra `sire` con su version 1 (`original`), como `insertarCompras`.
 * Devuelve su id. La compra queda creada en ESTA transaccion (xmin): la unica que `aplicar_regla_historial` acepta.
 */
export async function compraDelWorker(
  tx: Tx,
  clienteId: string,
  propuestaId: string,
  periodo: string,
  f: FilaDescarga,
): Promise<string> {
  const serie = f.serie ?? "F001";
  const docTipo = f.docTipo ?? "6";
  const docNumero = f.docNumero ?? "20100070970";
  const m = f.montos ?? FACTURA_DG;
  const c = await tx.query(
    `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero, razon_social,
       fecha, moneda, tipo_cambio, origen, version_vigente)
     values ($1, $2, $3, $4, '01', $5, $6, $7, $8, $9, '2026-10-05', 'PEN', null, 'sire', 1) returning id`,
    [
      clienteId,
      periodo,
      propuestaId,
      claveCompra("01", serie, f.numero, docTipo, docNumero),
      serie,
      f.numero,
      docTipo,
      docNumero,
      f.razonSocial === undefined ? "PROVEEDOR SINTETICO SAC" : f.razonSocial,
    ],
  );
  const id = c.rows[0].id as string;
  await tx.query(
    `insert into compra_version (compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
       otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
     values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, null, false, 'original', null, null)`,
    [
      id,
      m.biDg,
      m.igvDg,
      m.biDgng,
      m.igvDgng,
      m.biDng,
      m.igvDng,
      m.noGravado,
      m.isc,
      m.icbper,
      m.otrosTributos,
      m.total,
    ],
  );
  return id;
}

/** `aplicar_regla_historial` tal como lo llama el worker; devuelve el escalar. */
export async function aplicar(
  tx: Tx,
  compraId: string,
  reglaId: string,
  datos: Montos,
): Promise<number> {
  const r = await tx.query(
    "select public.aplicar_regla_historial($1, $2, $3::jsonb) as n",
    [compraId, reglaId, JSON.stringify(datosJson(datos))],
  );
  return Number(r.rows[0].n);
}

/** Resumen comparable de una fila de `compra_version` (para comprobar que la version 1 no cambia). */
export async function md5Version(
  admin: Pool,
  compraId: string,
  n: number,
): Promise<string> {
  const r = await admin.query(
    "select md5(v::text) as h from compra_version v where compra_id = $1 and n = $2",
    [compraId, n],
  );
  return String(r.rows[0]?.h);
}

export interface OpcionesRegla {
  docTipo?: string;
  docNumero?: string;
  destino?: Destino;
  activa?: boolean;
  version?: number;
  periodoAprendido?: string;
  creadaPor?: string | null;
  eliminada?: boolean;
}

export class EscenarioReglas extends EscenarioAuditoria {
  private readonly tenantsReglas = new Set<string>();
  private readonly usuariosRegla = new Map<string, string>();

  /** Regla aprendida sembrada con el superusuario. Devuelve su id. */
  async regla(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesRegla = {},
  ): Promise<string> {
    this.tenantsReglas.add(tenantId);
    let usuario = o.creadaPor;
    if (usuario === undefined) {
      usuario = this.usuariosRegla.get(tenantId);
      if (!usuario) {
        usuario = await this.usuarioDe(tenantId);
        this.usuariosRegla.set(tenantId, usuario);
      }
    }
    const r = await this.admin.query(
      `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
         creada_por, actualizada_por, eliminada_en, eliminada_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, case when $10::boolean then now() else null end,
               case when $10::boolean then $9::uuid else null end)
       returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        o.docTipo ?? "6",
        o.docNumero ?? "20100070970",
        o.destino ?? "DNG",
        o.activa ?? true,
        o.version ?? 1,
        o.periodoAprendido ?? APRENDIDO,
        usuario,
        o.eliminada ?? false,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Interruptor del motor del estudio (sin fila = encendido). */
  async interruptor(
    tenantId: string,
    codigo: string,
    activa: boolean,
  ): Promise<void> {
    this.tenantsReglas.add(tenantId);
    await this.admin.query(
      `insert into estudio_regla_motor (tenant_id, codigo, activa, actualizada_por) values ($1, $2, $3, $4)
       on conflict (tenant_id, codigo) do update set activa = excluded.activa`,
      [tenantId, codigo, activa, await this.usuarioDe(tenantId)],
    );
  }

  /** Aporte de confirmaciones al catalogo (P-10): por defecto encendido. */
  async aporte(tenantId: string, aportar: boolean): Promise<void> {
    this.tenantsReglas.add(tenantId);
    await this.admin.query(
      `insert into estudio_reglas_config (tenant_id, aportar_catalogo) values ($1, $2)
       on conflict (tenant_id) do update set aportar_catalogo = excluded.aportar_catalogo`,
      [tenantId, aportar],
    );
  }

  /** Cliente con un RUC dado (para dos clientes de estudios distintos con el mismo RUC). */
  async clienteConRuc(tenantId: string, ruc: string): Promise<ClientePrueba> {
    const c = await this.cliente(tenantId);
    await this.admin.query("update cliente set ruc = $2 where id = $1", [
      c.id,
      ruc,
    ]);
    return { id: c.id, ruc };
  }

  override async limpiar(): Promise<void> {
    const t = [...this.tenantsReglas, ...this.ea.estudios];
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of [
        "regla_confirmacion",
        "regla_aceptacion",
        "regla_aplicacion",
        "regla_aprendida",
        "estudio_regla_motor",
        "estudio_reglas_config",
      ]) {
        await c
          .query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [t])
          .catch(() => undefined);
      }
    } finally {
      c.release(true);
    }
    await super.limpiar();
  }
}

export const uuidNuevo = (): string => randomUUID();

/** Todas las columnas de monto, en el orden de `COLUMNAS_MONTO`, de una fila de `compra_version` leida de la BD. */
export function montosDeFila(r: Record<string, string>): Montos {
  return montos({
    biDg: r.bi_dg,
    igvDg: r.igv_dg,
    biDgng: r.bi_dgng,
    igvDgng: r.igv_dgng,
    biDng: r.bi_dng,
    igvDng: r.igv_dng,
    noGravado: r.no_gravado,
    isc: r.isc,
    icbper: r.icbper,
    otrosTributos: r.otros_tributos,
    total: r.total,
  });
}

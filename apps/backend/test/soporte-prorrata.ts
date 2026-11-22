/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 026 (T6, rojo): prorrata e IGV estimado. Encima de `soporte-reglas.ts` (que trae `http` con
// PUT, la auditoría y todo lo de ventas y compras). Siembra por SQL con la conexión de migraciones (superusuario: no pasa por RLS ni por
// grants, sí por CHECK, FK y triggers) las obtenciones, las declaraciones (PDT 621), los meses manuales y las prorratas ingresadas, y
// borra todo al cerrar con `session_replication_role = replica` (las cuatro tablas son de solo inserción). No es una prueba ni código de
// producción. Datos sintéticos (RUC de prueba `207…`), ningún RUC real.
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 026, «Contratos: BD», 0065; el mismo de `tests/aislamiento/prorrata-soporte.ts`, T3):
//  - `prorrata_obtencion(id, tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos char(6)[], periodos_sin_declaracion
//    char(6)[], nuevas, obtenida_en)`.
//  - `declaracion_mensual(id, tenant_id, cliente_id, periodo, numero_orden numeric(15,0), fecha_presentacion, tipo, ventas_gravadas_base,
//    ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada NULL, obtencion_id)`.
//  - `prorrata_mes_manual(id, tenant_id, cliente_id, periodo, version, accion guardado|eliminado, gravadas, exportaciones, no_gravadas
//    (NULL si eliminado), motivo, autor, creado_en)`.
//  - `prorrata_usada_manual(id, tenant_id, cliente_id, periodo, version, porcentaje NULL, autor, creado_en)`.
// Hasta que T10 cree las tablas, sembrar da 42P01: la siembra devuelve ids inventados y la prueba falla en la RUTA (404), no aquí (el
// rojo dice «ruta ausente», no «falta una migración»); con las tablas creadas cualquier error de la siembra se propaga.
import { randomUUID } from "node:crypto";
import type { INestApplication, Type } from "@nestjs/common";
import { DiscoveryService, ModulesContainer, Reflector } from "@nestjs/core";
import { createDb } from "@contapp/db";
import { claveDedupe } from "@contapp/queue";
import { vi } from "vitest";
import { META_PERMISO } from "../src/modules/acceso/guards/decoradores.js";
import { rutasDe } from "./auditoria-rutas.js";
import {
  abrirBancoReglas,
  base as rutaComprasPeriodo,
  cumple,
  inexistente,
  montos,
  type Actor,
  type BancoReglas,
  type Estudio,
  type Montos,
} from "./soporte-reglas.js";
import { base as rutaVentasPeriodo, centavos, fila, type FilaV } from "./soporte-ventas.js";
import { p95 } from "./soporte-compras.js";

export { centavos, cumple, fila, inexistente, montos, p95, rutaComprasPeriodo, rutaVentasPeriodo };
export type { Actor, BancoReglas, Estudio, FilaV, Montos };

/** Periodo calculado en casi todas las pruebas (hoy es posterior: nunca es «futuro»). */
export const M = "202610";
/** Los 12 meses que terminan en M, del más antiguo al más reciente (R-1: incluye M). */
export const VENTANA_M = [
  "202511",
  "202512",
  "202601",
  "202602",
  "202603",
  "202604",
  "202605",
  "202606",
  "202607",
  "202608",
  "202609",
  "202610",
] as const;

/** Los 12 meses que terminan en `hasta` (AAAAMM), del más antiguo al más reciente. */
export function ventanaHasta(hasta: string): string[] {
  let a = Number(hasta.slice(0, 4));
  let m = Number(hasta.slice(4));
  const r: string[] = [];
  for (let i = 0; i < 12; i++) {
    r.push(`${a}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      a -= 1;
    }
  }
  return r.reverse();
}

// --- Rutas ----------------------------------------------------------------------------------------------------------------
export const rutaVista = (clienteId: string, periodo?: string): string =>
  `/clientes/${clienteId}/prorrata${periodo === undefined ? "" : `?periodo=${periodo}`}`;
export const rutaHistorial = (clienteId: string, periodo: string): string => `/clientes/${clienteId}/prorrata/meses/${periodo}/historial`;
export const rutaObtener = (clienteId: string): string => `/clientes/${clienteId}/prorrata/declaraciones`;
export const rutaManual = (clienteId: string, periodo: string): string => `/clientes/${clienteId}/prorrata/meses/${periodo}`;
export const rutaEliminar = (clienteId: string, periodo: string): string => `/clientes/${clienteId}/prorrata/meses/${periodo}/eliminar`;
export const rutaUsada = (clienteId: string, periodo: string): string => `/clientes/${clienteId}/prorrata/usada/${periodo}`;

export const NO_ENCONTRADO = { codigo: "no_encontrado" };
export const PERMISO_DENEGADO = { codigo: "permiso_denegado" };

export const TIPO_TRABAJO = "sol.declaraciones.descargar";
export const ACCIONES_026 = [
  "prorrata.declaraciones_obtenidas",
  "prorrata.mes_manual_guardado",
  "prorrata.mes_manual_eliminado",
  "prorrata.usada_guardada",
] as const;
export const TABLAS_026 = ["prorrata_obtencion", "declaracion_mensual", "prorrata_mes_manual", "prorrata_usada_manual"] as const;

/** Las seis rutas de 026 y el permiso que cada una declara (`@Permiso`), ordenadas. */
export const RUTAS_026 = [
  "GET /clientes/:clienteId/prorrata prorrata.ver",
  "GET /clientes/:clienteId/prorrata/meses/:periodo/historial prorrata.ver",
  "POST /clientes/:clienteId/prorrata/declaraciones prorrata.gestionar",
  "PUT /clientes/:clienteId/prorrata/meses/:periodo prorrata.gestionar",
  "POST /clientes/:clienteId/prorrata/meses/:periodo/eliminar prorrata.gestionar",
  "PUT /clientes/:clienteId/prorrata/usada/:periodo prorrata.gestionar",
].sort();

export interface RutaConPermiso {
  metodo: string;
  ruta: string;
  permiso: string | null;
}
/** Las rutas de los controladores registrados que cuelgan de `/clientes/:clienteId/prorrata`, con su permiso. */
export function rutasDeProrrata(app: INestApplication): RutaConPermiso[] {
  const reflector = app.get(Reflector);
  const clases = new DiscoveryService(app.get(ModulesContainer))
    .getControllers()
    .map((w) => w.metatype)
    .filter((m): m is Type => typeof m === "function");
  const salida: RutaConPermiso[] = [];
  for (const clase of clases) {
    for (const r of rutasDe([clase], reflector)) {
      if (!/\/prorrata(\/|$)/.test(r.ruta)) continue;
      const proto = clase.prototype as Record<string, unknown>;
      const permiso = reflector.getAllAndOverride<unknown>(META_PERMISO, [proto[r.handler] as (...a: unknown[]) => unknown, clase]);
      salida.push({ metodo: r.metodo, ruta: r.ruta, permiso: typeof permiso === "string" ? permiso : null });
    }
  }
  return salida;
}

// --- Formas exactas de las respuestas (plan 026, «shared») ---------------------------------------------------------------------
export const CLAVES_VISTA = [
  "periodo",
  "ventana",
  "coeficiente",
  "igvEstimado",
  "diferencia",
  "ultimaObtencion",
  "prorrataUsada",
  "versionUsada",
].sort();
export const CLAVES_MES = [
  "periodo",
  "origen",
  "gravadas",
  "exportaciones",
  "noGravadas",
  "total",
  "avisos",
  "declaracion",
  "manual",
  "versionManual",
  "sireCargado",
].sort();
export const CLAVES_COEFICIENTE_CALCULADO = ["estado", "porcentaje", "numerador", "total", "provisional", "avisos"].sort();
export const CLAVES_IGV_CALCULADO = [
  "estado",
  "igvVentas",
  "creditoDg",
  "igvDgng",
  "creditoDgng",
  "igvDng",
  "resultado",
  "situacion",
  "estadoPeriodoCompras",
].sort();

// --- Canarios (CA-10, D-6, D-7) ------------------------------------------------------------------------------------------------
export const CANARIO = {
  motivo: "MOTIVO-CANARIO-026-Zq",
  gravadas: "7654321.09",
  exportaciones: "2345678.91",
  noGravadas: "3456789.12",
  porcentaje: "63.21",
  ruc: "20700000026",
} as const;
/** Los textos que no pueden aparecer en logs, errores ni auditoría (el motivo y los montos del manual; el RUC va aparte por cliente). */
export const CANARIOS_TEXTO: readonly string[] = [CANARIO.motivo, CANARIO.gravadas, CANARIO.exportaciones, CANARIO.noGravadas];

// --- Siembra --------------------------------------------------------------------------------------------------------------------
export interface DeclSpec {
  periodo: string;
  numeroOrden?: string;
  /** AAAA-MM-DD; por omisión el día 10 del mes siguiente al periodo. */
  fecha?: string;
  tipo?: "original" | "rectificatoria";
  gravadas?: string;
  igv?: string;
  exportaciones?: string;
  noGravadas?: string;
  igvDg?: string;
  igvDgng?: string;
  prorrataUsada?: string | null;
}

/** Día 10 del mes siguiente a `periodo` (fecha de presentación del PDT). */
export function fechaPresentacion(periodo: string): string {
  let a = Number(periodo.slice(0, 4));
  let m = Number(periodo.slice(4)) + 1;
  if (m === 13) {
    m = 1;
    a += 1;
  }
  return `${a}-${String(m).padStart(2, "0")}-10`;
}

/** CA-1: 12 PDT originales, gravadas 100000.00 cada mes, exportaciones 50000.00 solo en 202603 y no gravadas 20000.00 cada mes. */
export function declaracionesCA1(hasta = M): DeclSpec[] {
  return ventanaHasta(hasta).map((periodo, i) => ({
    periodo,
    numeroOrden: String(7000 + i),
    gravadas: "100000.00",
    igv: "18000.00",
    exportaciones: periodo === "202603" ? "50000.00" : "0.00",
    noGravadas: "20000.00",
    igvDg: "9000.00",
    igvDgng: "1800.00",
  }));
}
/** Lo que da `declaracionesCA1`: numerador 1.250.000,00; total 1.490.000,00; 125/149 = 83,8926… → 83,89. */
export const CA1 = { porcentaje: "83.89", numerador: "1250000.00", total: "1490000.00" } as const;

export interface OpcionesObtencion {
  periodoHasta?: string;
  leidos?: readonly string[];
  sinDeclaracion?: readonly string[];
  nuevas?: number;
  /** ISO: instante de la obtención (por omisión el de la BD). */
  obtenidaEn?: string;
}
export interface OpcionesManual {
  periodo: string;
  version?: number;
  accion?: "guardado" | "eliminado";
  gravadas?: string;
  exportaciones?: string;
  noGravadas?: string;
  motivo?: string;
  autor: string;
}
export interface OpcionesUsada {
  periodo?: string;
  version?: number;
  porcentaje?: string | null;
  autor: string;
}

export interface BancoProrrata extends BancoReglas {
  /** Una obtención sembrada; devuelve su id. */
  sembrarObtencion(tenantId: string, clienteId: string, o?: OpcionesObtencion): Promise<string>;
  /** Declaraciones (una fila por presentación) colgadas de UNA obtención nueva (la que lee la ventana de `hasta`); devuelve su id. */
  sembrarDeclaraciones(
    tenantId: string,
    clienteId: string,
    ds: readonly DeclSpec[],
    o?: OpcionesObtencion,
  ): Promise<string>;
  sembrarManual(tenantId: string, clienteId: string, o: OpcionesManual): Promise<string>;
  sembrarUsada(tenantId: string, clienteId: string, o: OpcionesUsada): Promise<string>;
  /** Ventas SIRE de ese periodo con propuesta (el periodo queda «cargado»); devuelve los ids de las filas. */
  sembrarVentasSire(tenantId: string, clienteId: string, periodo: string, filas: readonly FilaV[], usuarioId: string): Promise<string[]>;
  /** Un periodo de ventas «cargado» sin ninguna fila (propuesta de 0 filas). */
  sembrarVentasVacias(tenantId: string, clienteId: string, periodo: string, usuarioId: string): Promise<void>;
  declaracionesBd(clienteId: string, periodo?: string): Promise<any[]>;
  obtencionesBd(clienteId: string): Promise<any[]>;
  manualesBd(clienteId: string, periodo?: string): Promise<any[]>;
  usadasBd(clienteId: string, periodo?: string): Promise<any[]>;
  /** Trabajos `sol.declaraciones.descargar` del cliente, del más antiguo al más reciente. */
  trabajosDescarga(tenantId: string, clienteId: string): Promise<any[]>;
  /** Un trabajo `sol.declaraciones.descargar` sembrado por SQL en ese estado (sin Redis). */
  sembrarTrabajoDescarga(tenantId: string, clienteId: string, periodo: string, estado: "en_cola" | "ejecutando", usuarioId: string): Promise<string>;
  /** Nombre del usuario (el que ve la pantalla como autor). */
  nombreDe(usuarioId: string): Promise<string>;
  archivar(clienteId: string): Promise<void>;
  /** Una sentencia SQL en modo réplica (sin triggers ni RLS): siembras masivas. */
  sqlReplica(texto: string, valores?: unknown[]): Promise<void>;
  /** Lo que 026 guarda de un cliente (más sus ventas y compras y sus trabajos), para comprobar que un intento rechazado no cambió nada. */
  fotoProrrata(tenantId: string, clienteId: string): Promise<unknown>;
  /** Filas de `auditoria` del estudio con alguna de las cuatro acciones de 026, de la más antigua a la más reciente. */
  auditoria026(tenantId: string): Promise<any[]>;
  /** ¿Fallaron las siembras por falta de tablas (T10)? Solo informa el rojo. */
  readonly tablasAusentes: boolean;
}

export async function abrirBancoProrrata(): Promise<BancoProrrata> {
  const v = await abrirBancoReglas();
  const sql = v.b.sql;
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de prorrata");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  const tenants: string[] = [];
  let ausentes = false;

  /** Corre la siembra; si las tablas aún no existen (42P01 o columna ausente) devuelve `ficticio` y lo anota. */
  async function tolerando<T>(fn: () => Promise<T>, ficticio: () => T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "42P01" || code === "42703") {
        ausentes = true;
        return ficticio();
      }
      throw e;
    }
  }
  const lectura = <T>(fn: () => Promise<T>, vacio: T): Promise<T> => tolerando(fn, () => vacio);

  const sembrarObtencion: BancoProrrata["sembrarObtencion"] = (tenantId, clienteId, o = {}) =>
    tolerando(
      async () => {
        const hasta = o.periodoHasta ?? M;
        const r = await sql(
          `insert into prorrata_obtencion (tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos, periodos_sin_declaracion,
             nuevas, obtenida_en)
           values ($1, $2, $3, null, $4::char(6)[], $5::char(6)[], $6, coalesce($7::timestamptz, clock_timestamp())) returning id`,
          [tenantId, clienteId, hasta, [...(o.leidos ?? ventanaHasta(hasta))], [...(o.sinDeclaracion ?? [])], o.nuevas ?? 0, o.obtenidaEn ?? null],
        );
        return r[0].id as string;
      },
      () => randomUUID(),
    );

  const banco: BancoProrrata = {
    ...v,
    estudio: async () => {
      const e = await v.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    get tablasAusentes() {
      return ausentes;
    },
    sembrarObtencion,
    sembrarDeclaraciones: async (tenantId, clienteId, ds, o = {}) => {
      const obtencionId = await sembrarObtencion(tenantId, clienteId, {
        ...o,
        nuevas: o.nuevas ?? ds.length,
      });
      await tolerando(
        async () => {
          for (const d of ds) {
            await sql(
              `insert into declaracion_mensual (tenant_id, cliente_id, periodo, numero_orden, fecha_presentacion, tipo,
                 ventas_gravadas_base, ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada, obtencion_id)
               values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                tenantId,
                clienteId,
                d.periodo,
                d.numeroOrden ?? "1001",
                d.fecha ?? fechaPresentacion(d.periodo),
                d.tipo ?? "original",
                d.gravadas ?? "100000.00",
                d.igv ?? "18000.00",
                d.exportaciones ?? "0.00",
                d.noGravadas ?? "20000.00",
                d.igvDg ?? "9000.00",
                d.igvDgng ?? "1800.00",
                d.prorrataUsada === undefined ? null : d.prorrataUsada,
                obtencionId,
              ],
            );
          }
        },
        () => undefined,
      );
      return obtencionId;
    },
    sembrarManual: (tenantId, clienteId, o) =>
      tolerando(
        async () => {
          const eliminado = o.accion === "eliminado";
          const r = await sql(
            `insert into prorrata_mes_manual (tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo, autor)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
            [
              tenantId,
              clienteId,
              o.periodo,
              o.version ?? 1,
              o.accion ?? "guardado",
              eliminado ? null : (o.gravadas ?? "1000.00"),
              eliminado ? null : (o.exportaciones ?? "0.00"),
              eliminado ? null : (o.noGravadas ?? "200.00"),
              o.motivo ?? "Libro de ventas físico",
              o.autor,
            ],
          );
          return r[0].id as string;
        },
        () => randomUUID(),
      ),
    sembrarUsada: (tenantId, clienteId, o) =>
      tolerando(
        async () => {
          const r = await sql(
            `insert into prorrata_usada_manual (tenant_id, cliente_id, periodo, version, porcentaje, autor)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [tenantId, clienteId, o.periodo ?? M, o.version ?? 1, o.porcentaje === undefined ? "50.00" : o.porcentaje, o.autor],
          );
          return r[0].id as string;
        },
        () => randomUUID(),
      ),
    sembrarVentasSire: (tenantId, clienteId, periodo, filas, usuarioId) =>
      v.sembrarVentas(tenantId, clienteId, [...filas], { usuarioId, periodo }),
    sembrarVentasVacias: async (tenantId, clienteId, periodo, usuarioId) => {
      await v.sembrarPropuesta(tenantId, clienteId, { periodo, libro: "ventas", nuevas: 0, usuarioId });
    },
    declaracionesBd: (clienteId, periodo) =>
      lectura(
        () =>
          sql(
            `select id, periodo, numero_orden::text as numero_orden, fecha_presentacion::text as fecha_presentacion, tipo,
                    ventas_gravadas_base::text as ventas_gravadas_base, exportaciones::text as exportaciones,
                    no_gravadas::text as no_gravadas, prorrata_usada::text as prorrata_usada, obtencion_id
               from declaracion_mensual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, numero_orden`,
            [clienteId, periodo ?? null],
          ),
        [],
      ),
    obtencionesBd: (clienteId) =>
      lectura(
        () =>
          sql(
            `select id, periodo_hasta, trabajo_id, periodos_leidos, periodos_sin_declaracion, nuevas::int as nuevas
               from prorrata_obtencion where cliente_id = $1 order by obtenida_en, id`,
            [clienteId],
          ),
        [],
      ),
    manualesBd: (clienteId, periodo) =>
      lectura(
        () =>
          sql(
            `select id, periodo, version::int as version, accion, gravadas::text as gravadas, exportaciones::text as exportaciones,
                    no_gravadas::text as no_gravadas, motivo, autor
               from prorrata_mes_manual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, version`,
            [clienteId, periodo ?? null],
          ),
        [],
      ),
    usadasBd: (clienteId, periodo) =>
      lectura(
        () =>
          sql(
            `select id, periodo, version::int as version, porcentaje::text as porcentaje, autor
               from prorrata_usada_manual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, version`,
            [clienteId, periodo ?? null],
          ),
        [],
      ),
    trabajosDescarga: async (tenantId, clienteId) => (await v.b.trabajos(tenantId, TIPO_TRABAJO)).filter((t) => t.cliente_id === clienteId),
    sembrarTrabajoDescarga: async (tenantId, clienteId, periodo, estado, usuarioId) => {
      const r = await sql(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
         select $1, c.id, c.ruc, 'sol.declaraciones.descargar', 'sol', 'sol', 'interactivo', $3, jsonb_build_object('periodo', $5::text),
                $6, $4, 3
           from cliente c where c.id = $2 returning id`,
        // La clave real del dedupe de 008 (la misma función que usa producción), no una aleatoria.
        [tenantId, clienteId, estado, usuarioId, periodo, claveDedupe(TIPO_TRABAJO, clienteId, { periodo })],
      );
      return r[0].id as string;
    },
    nombreDe: async (usuarioId) => (await sql("select nombre from usuario where id = $1", [usuarioId]))[0].nombre as string,
    archivar: async (clienteId) => {
      await sql("update cliente set archivado_at = now() where id = $1", [clienteId]);
    },
    sqlReplica: async (texto, valores = []) => {
      const c = await admin.pool.connect();
      try {
        await c.query("SET session_replication_role = replica");
        await c.query(texto, valores);
      } finally {
        c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
      }
    },
    fotoProrrata: async (tenantId, clienteId) => ({
      obtenciones: await banco.obtencionesBd(clienteId),
      declaraciones: await banco.declaracionesBd(clienteId),
      manuales: await banco.manualesBd(clienteId),
      usadas: await banco.usadasBd(clienteId),
      trabajos: (await banco.trabajosDescarga(tenantId, clienteId)).length,
      auditoria: (await banco.auditoria026(tenantId)).filter((f) => f.cliente_id === clienteId).length,
      ventas: await v.conteo(clienteId),
      compras: (await v.compras(clienteId)).length,
    }),
    auditoria026: (tenantId) =>
      sql(
        `select accion, actor_tipo, usuario_id, cliente_id, entidad, entidad_id, datos from auditoria
          where tenant_id = $1 and accion = any($2::text[]) order by ocurrida_en, id`,
        [tenantId, [...ACCIONES_026]],
      ),
    cerrar: async () => {
      if (tenants.length > 0) {
        const c = await admin.pool.connect();
        try {
          await c.query("SET session_replication_role = replica");
          // Tablas de solo inserción de 026, de la hija a la madre, antes de que `v.cerrar()` borre clientes y estudios.
          const borrar = [
            "delete from declaracion_mensual where tenant_id = any($1::uuid[])",
            "delete from prorrata_mes_manual where tenant_id = any($1::uuid[])",
            "delete from prorrata_usada_manual where tenant_id = any($1::uuid[])",
            "delete from prorrata_obtencion where tenant_id = any($1::uuid[])",
          ];
          for (const texto of borrar) await c.query(texto, [tenants]).catch(() => undefined);
        } finally {
          c.release(true);
        }
      }
      try {
        await v.cerrar();
      } finally {
        await admin.close();
      }
    },
  };
  return banco;
}

// --- Reloj ----------------------------------------------------------------------------------------------------------------------
/**
 * Corre `fn` con el reloj de `Date` fijo en `iso` (UTC) y lo restaura. Usar instantes ANTERIORES a hoy: así ninguna sesión parece
 * vencida (las pruebas de 025 siguen la misma regla). «Mes en curso» y periodo por omisión se cuentan en hora de Lima (UTC−5 todo el año).
 */
export async function conReloj<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

// --- Datos de ventas y compras para el IGV estimado -----------------------------------------------------------------------------
/** Una factura de ventas con su IGV al 18 % (base y total derivados). */
export function facturaVenta(serie: string, numero: number, base: string, igv: string, extra: Partial<FilaV> = {}): FilaV {
  const total = (centavos(base) + centavos(igv)).toString().padStart(3, "0");
  return fila(serie, numero, {
    tipo: "01",
    baseGravada: base,
    igv,
    total: `${total.slice(0, -2)}.${total.slice(-2)}`,
    ...extra,
  });
}

/** Una venta PEN sin IGV: exonerada o inafecta (el IGV y la base gravada en 0). */
export function ventaNoGravada(serie: string, numero: number, o: { exonerada?: string; inafecta?: string }): FilaV {
  const e = o.exonerada ?? "0.00";
  const i = o.inafecta ?? "0.00";
  const t = (centavos(e) + centavos(i)).toString().padStart(3, "0");
  return fila(serie, numero, { baseGravada: "0.00", igv: "0.00", exonerada: e, inafecta: i, total: `${t.slice(0, -2)}.${t.slice(-2)}` });
}

/** Una compra con IGV en un solo destino (BI = el IGV × 100/18 aproximado no importa: la prorrata solo mira el IGV). */
export function montosCompra(destino: "DG" | "DGNG" | "DNG", bi: string, igv: string): Partial<Montos> {
  const total = (centavos(bi) + centavos(igv)).toString().padStart(3, "0");
  const t = `${total.slice(0, -2)}.${total.slice(-2)}`;
  if (destino === "DG") return { biDg: bi, igvDg: igv, total: t };
  if (destino === "DGNG") return { biDgng: bi, igvDgng: igv, total: t };
  return { biDng: bi, igvDng: igv, total: t };
}

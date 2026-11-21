/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 025 (T6, rojo): importaciones del historial, candidatas y R-STD. Encima de
// `soporte-reglas.ts` (021). No es una prueba ni código de producción. Datos sintéticos (RUC de prueba `207…`, razones sociales de
// canario), ningún RUC real.
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 025, «Contratos: BD», 0061; el mismo de `packages/db/src/aprendizaje/soporte-prueba.ts`, T4):
//  - `regla_importacion(id, tenant_id, cliente_id, estado 'en_curso'|'completada'|'fallida', periodos char(6)[], periodo_hasta,
//    trabajo_id, solicitada_por, solicitada_en, terminada_en, periodos_leidos, periodos_sin_datos char(6)[], candidatas, sin_criterio,
//    motivo)`.
//  - `regla_candidata(id, tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto, n_dg, n_dgng,
//    n_dng, n_mixto, n_total, periodos_con_proveedor, estado 'pendiente'|'activada'|'descartada'|'reemplazada', destino_elegido,
//    regla_id, resuelta_por, resuelta_en)`, con CHECK de coherencia: `n_total` = suma; con destino propuesto `n[d] >= 2` y `5 n[d] >= 4 total`;
//    `regla_id` y `resuelta_*` solo si no está pendiente.
//  - `regla_aprendida.origen` ('contador' por defecto | 'importacion').
// La siembra va por la conexión de migraciones (no pasa por RLS ni por grants, sí por CHECK, FK y triggers). Hasta que T10 cree las
// tablas, sembrar da 42P01: en ese caso la siembra devuelve ids inventados y la prueba falla en la RUTA (404), no aquí (el rojo dice
// «ruta o campo ausente», no «falta una migración»); con las tablas creadas cualquier error de la siembra se propaga.
import { randomUUID } from "node:crypto";
import type { INestApplication, Type } from "@nestjs/common";
import { DiscoveryService, ModulesContainer, Reflector } from "@nestjs/core";
import { META_PERMISO } from "../src/modules/acceso/guards/decoradores.js";
import { rutasDe } from "./auditoria-rutas.js";
import {
  abrirBancoReglas,
  APRENDIDO,
  base,
  cumple,
  inexistente,
  montos,
  PERIODO,
  rutaReglas,
  type Actor,
  type BancoReglas,
  type Estudio,
  type Montos,
} from "./soporte-reglas.js";

export { abrirBancoReglas, APRENDIDO, base, cumple, inexistente, montos, PERIODO, rutaReglas };
export type { Actor, BancoReglas, Estudio, Montos };

export type Destino = "DG" | "DGNG" | "DNG";
export const DESTINOS: readonly Destino[] = ["DG", "DGNG", "DNG"];

/** Los seis periodos de una importación por defecto: del más reciente al más antiguo (el primero es `periodo_hasta`). */
export const PERIODOS_6 = ["202610", "202609", "202608", "202607", "202606", "202605"] as const;

// --- Rutas ----------------------------------------------------------------------------------------------------------------
export const rutaImportaciones = (clienteId: string): string => `${rutaReglas(clienteId)}/importaciones`;
export const rutaUltima = (clienteId: string): string => `${rutaImportaciones(clienteId)}/ultima`;
export const rutaCandidatas = (clienteId: string): string => `${rutaReglas(clienteId)}/candidatas`;
export const rutaActivar = (clienteId: string): string => `${rutaCandidatas(clienteId)}/activar`;
export const rutaDescartar = (clienteId: string): string => `${rutaCandidatas(clienteId)}/descartar`;
export const rutaReemplazar = (clienteId: string, candidataId: string): string => `${rutaCandidatas(clienteId)}/${candidataId}/reemplazar`;

export const NO_ENCONTRADO = { codigo: "no_encontrado" };
export const PERMISO_DENEGADO = { codigo: "permiso_denegado" };

/** Seis rutas de 025 y el permiso que cada una declara (`@Permiso`). */
export const RUTAS_025 = [
  "GET /clientes/:clienteId/reglas/candidatas reglas.ver",
  "GET /clientes/:clienteId/reglas/importaciones/ultima reglas.ver",
  "POST /clientes/:clienteId/reglas/candidatas/:candidataId/reemplazar reglas.gestionar",
  "POST /clientes/:clienteId/reglas/candidatas/activar reglas.gestionar",
  "POST /clientes/:clienteId/reglas/candidatas/descartar reglas.gestionar",
  "POST /clientes/:clienteId/reglas/importaciones reglas.gestionar",
].sort();

export interface RutaConPermiso {
  metodo: string;
  ruta: string;
  permiso: string | null;
}
/** Las rutas de los controladores registrados que cuelgan de `/reglas/importaciones` o `/reglas/candidatas`, con su permiso. */
export function rutasDeAprendizaje(app: INestApplication): RutaConPermiso[] {
  const reflector = app.get(Reflector);
  const clases = new DiscoveryService(app.get(ModulesContainer))
    .getControllers()
    .map((w) => w.metatype)
    .filter((m): m is Type => typeof m === "function");
  const salida: RutaConPermiso[] = [];
  for (const clase of clases) {
    for (const r of rutasDe([clase], reflector)) {
      if (!/\/reglas\/(importaciones|candidatas)(\/|$)/.test(r.ruta)) continue;
      const proto = clase.prototype as Record<string, unknown>;
      const permiso = reflector.getAllAndOverride<unknown>(META_PERMISO, [proto[r.handler] as (...a: unknown[]) => unknown, clase]);
      salida.push({ metodo: r.metodo, ruta: r.ruta, permiso: typeof permiso === "string" ? permiso : null });
    }
  }
  return salida;
}

/** Los periodos que debe calcular el backend: del mes anterior al de `ahora` (hora de Lima, UTC-5 todo el año) hacia atrás. */
export function periodosEsperados(n: number, ahora: Date = new Date()): string[] {
  const lima = new Date(ahora.getTime() - 5 * 3_600_000);
  let anio = lima.getUTCFullYear();
  let mes = lima.getUTCMonth() + 1; // 1..12, el mes en curso en Lima
  const salida: string[] = [];
  for (let i = 0; i < n; i++) {
    mes -= 1;
    if (mes === 0) {
      mes = 12;
      anio -= 1;
    }
    salida.push(`${anio}${String(mes).padStart(2, "0")}`);
  }
  return salida;
}

// --- Datos de candidatas --------------------------------------------------------------------------------------------------
export interface Conteos {
  DG: number;
  DGNG: number;
  DNG: number;
  mixto: number;
  total: number;
}
const sumar = (c: Omit<Conteos, "total">): Conteos => ({ ...c, total: c.DG + c.DGNG + c.DNG + c.mixto });

/** Conteos que cumplen el umbral de U-2 para `d` (4 de 5 = 80 % justo; 8 de 10; 2 de 2). */
export function conteosPara(d: Destino, variante = 0): Conteos {
  const otro = DESTINOS[(DESTINOS.indexOf(d) + 1) % 3]!;
  const c = { DG: 0, DGNG: 0, DNG: 0, mixto: 0 };
  if (variante % 3 === 0) Object.assign(c, { [d]: 4, mixto: 1 });
  else if (variante % 3 === 1) Object.assign(c, { [d]: 8, [otro]: 1, mixto: 1 });
  else Object.assign(c, { [d]: 2 });
  return sumar(c);
}
/** Sin criterio claro (empate 2-2): no hay destino propuesto. */
export const CONTEOS_SIN_CRITERIO: Conteos = sumar({ DG: 2, DGNG: 0, DNG: 2, mixto: 0 });

export type EstadoCandidata = "pendiente" | "activada" | "descartada" | "reemplazada";
export interface CandidataSpec {
  /** Por omisión, un RUC de prueba distinto por candidata. */
  docTipo?: string;
  docNumero?: string;
  razonSocial?: string | null;
  /** `null` = sin criterio claro. Por omisión `DNG`. */
  destinoPropuesto?: Destino | null;
  conteos?: Conteos;
  periodosConProveedor?: number;
  estado?: EstadoCandidata;
  destinoElegido?: Destino | null;
  reglaId?: string | null;
}
export interface CandidataSembrada {
  id: string;
  docTipo: string;
  docNumero: string;
  razonSocial: string | null;
  destinoPropuesto: Destino | null;
  conteos: Conteos;
  periodosConProveedor: number;
  estado: EstadoCandidata;
}

export interface OpcionesImportacion {
  estado?: "en_curso" | "completada" | "fallida";
  periodos?: readonly string[];
  usuarioId: string;
  trabajoId?: string | null;
  /** Intervalo de SQL («2 days»): hace cuánto se solicitó (por omisión, ahora). */
  solicitadaHace?: string;
  periodosLeidos?: number;
  periodosSinDatos?: readonly string[];
  candidatas?: number;
  sinCriterio?: number;
  motivo?: string | null;
}

export interface ReglaViva {
  id?: string;
  docTipo?: string;
  docNumero: string;
  destino: Destino;
  version?: number;
}

export interface BancoAprendizaje extends BancoReglas {
  /** Importación sembrada (por defecto `completada`, 6 periodos, uno sin datos); devuelve su id. */
  sembrarImportacion(tenantId: string, clienteId: string, o: OpcionesImportacion): Promise<string>;
  /** Candidatas sembradas en una sola sentencia; devuelve sus datos en el orden pedido. */
  sembrarCandidatas(tenantId: string, clienteId: string, importacionId: string, specs: readonly CandidataSpec[], usuarioId: string): Promise<CandidataSembrada[]>;
  /** Reglas vivas sembradas en una sola sentencia (conflictos y activadas); devuelve sus ids en orden. */
  sembrarReglasVivas(tenantId: string, clienteId: string, reglas: readonly ReglaViva[], usuarioId: string): Promise<string[]>;
  /** `regla_importacion` del cliente, de la más antigua a la más reciente. */
  importacionesBd(clienteId: string): Promise<any[]>;
  /** `regla_candidata` del cliente por documento. */
  candidatasBd(clienteId: string): Promise<any[]>;
  /** Una candidata por id (o `undefined`). */
  candidataBd(id: string): Promise<any | undefined>;
  /** `regla_aprendida` del cliente con `origen`, de la más antigua a la más reciente. */
  reglasConOrigen(clienteId: string): Promise<any[]>;
  /** Trabajos `reglas.historial.importar` del estudio de ese cliente. */
  trabajosImportar(tenantId: string, clienteId: string): Promise<any[]>;
  /** Un trabajo de importación en el estado dado (sembrado por SQL: sin Redis). */
  sembrarTrabajoImportar(tenantId: string, clienteId: string, estado: "en_cola" | "ejecutando" | "error", usuarioId: string): Promise<string>;
  /** Perfil fiscal (007a, columnas de 0026) del cliente. */
  fijarPerfil(clienteId: string, p: { zona: "general" | "amazonia"; ventasExoneradas: boolean; ventasMixtas: boolean }): Promise<void>;
  archivar(clienteId: string): Promise<void>;
  /** Lo que 025 guarda de un cliente, para comprobar que un intento rechazado no cambió nada. */
  fotoAprendizaje(tenantId: string, clienteId: string): Promise<unknown>;
  /** ¿Fallaron las siembras por falta de tablas (T10)? Solo informa el rojo. */
  readonly tablasAusentes: boolean;
}

export async function abrirBancoAprendizaje(): Promise<BancoAprendizaje> {
  const v = await abrirBancoReglas();
  const sql = v.b.sql;
  const tenants: string[] = [];
  let ausentes = false;

  /** Corre la siembra; si las tablas aún no existen (42P01) devuelve `ficticio` y lo anota. */
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

  const banco: BancoAprendizaje = {
    ...v,
    estudio: async () => {
      const e = await v.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    get tablasAusentes() {
      return ausentes;
    },
    sembrarImportacion: (tenantId, clienteId, o) =>
      tolerando(
        async () => {
          const estado = o.estado ?? "completada";
          const periodos = [...(o.periodos ?? PERIODOS_6)];
          const sinDatos = [...(o.periodosSinDatos ?? (estado === "completada" ? [periodos[periodos.length - 1]!] : []))];
          const leidos = o.periodosLeidos ?? (estado === "completada" ? periodos.length - sinDatos.length : 0);
          const r = await sql(
            `insert into regla_importacion (tenant_id, cliente_id, estado, periodos, periodo_hasta, trabajo_id, solicitada_por, solicitada_en,
               terminada_en, periodos_leidos, periodos_sin_datos, candidatas, sin_criterio, motivo)
             values ($1, $2, $3, $4::char(6)[], $5, $6, $7, now() - $8::interval,
               case when $3 = 'en_curso' then null else now() - $8::interval + interval '1 minute' end,
               $9, $10::char(6)[], $11, $12, $13) returning id`,
            [
              tenantId,
              clienteId,
              estado,
              periodos,
              periodos[0],
              o.trabajoId ?? null,
              o.usuarioId,
              o.solicitadaHace ?? "0 seconds",
              leidos,
              sinDatos,
              o.candidatas ?? 0,
              o.sinCriterio ?? 0,
              o.motivo === undefined ? (estado === "fallida" ? "credencial_invalida" : null) : o.motivo,
            ],
          );
          return r[0].id as string;
        },
        () => randomUUID(),
      ),
    sembrarCandidatas: (tenantId, clienteId, importacionId, specs, usuarioId) => {
      const filas: CandidataSembrada[] = specs.map((s, i) => {
        const destino = s.destinoPropuesto === undefined ? "DNG" : s.destinoPropuesto;
        return {
          id: randomUUID(),
          docTipo: s.docTipo ?? "6",
          docNumero: s.docNumero ?? `207${String(10_000_000 + i * 7).padStart(8, "0")}`,
          razonSocial: s.razonSocial === undefined ? `PROVEEDOR SINTETICO ${i} SAC` : s.razonSocial,
          destinoPropuesto: destino,
          conteos: s.conteos ?? (destino === null ? CONTEOS_SIN_CRITERIO : conteosPara(destino, i)),
          periodosConProveedor: s.periodosConProveedor ?? 3,
          estado: s.estado ?? "pendiente",
        };
      });
      return tolerando(
        async () => {
          await sql(
            `insert into regla_candidata (id, tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
               n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado, destino_elegido, regla_id, resuelta_por, resuelta_en)
             select x.id, $1, $2, $3, x.dt, x.dn, x.rs, x.dp, x.dg, x.dgng, x.dng, x.mx, x.tt, x.pc, x.st, x.de, x.rid,
                    case when x.st <> 'pendiente' then $4::uuid end, case when x.st <> 'pendiente' then now() end
               from jsonb_to_recordset($5::jsonb)
                 as x(id uuid, dt text, dn text, rs text, dp text, dg int, dgng int, dng int, mx int, tt int, pc int, st text, de text, rid uuid)`,
            [
              tenantId,
              clienteId,
              importacionId,
              usuarioId,
              JSON.stringify(
                filas.map((f, i) => ({
                  id: f.id,
                  dt: f.docTipo,
                  dn: f.docNumero,
                  rs: f.razonSocial,
                  dp: f.destinoPropuesto,
                  dg: f.conteos.DG,
                  dgng: f.conteos.DGNG,
                  dng: f.conteos.DNG,
                  mx: f.conteos.mixto,
                  tt: f.conteos.total,
                  pc: f.periodosConProveedor,
                  st: f.estado,
                  de: specs[i]!.destinoElegido === undefined ? (f.estado === "activada" ? f.destinoPropuesto : null) : specs[i]!.destinoElegido,
                  rid: specs[i]!.reglaId ?? null,
                })),
              ),
            ],
          );
          return filas;
        },
        () => filas,
      );
    },
    sembrarReglasVivas: async (tenantId, clienteId, reglas, usuarioId) => {
      const filas = reglas.map((r) => ({ id: r.id ?? randomUUID(), dt: r.docTipo ?? "6", dn: r.docNumero, d: r.destino, v: r.version ?? 1 }));
      if (filas.length === 0) return [];
      await sql(
        `insert into regla_aprendida (id, tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido, creada_por, actualizada_por)
         select x.id, $1, $2, x.dt, x.dn, x.d, true, x.v, $3, $4, $4
           from jsonb_to_recordset($5::jsonb) as x(id uuid, dt text, dn text, d text, v int)`,
        [tenantId, clienteId, APRENDIDO, usuarioId, JSON.stringify(filas)],
      );
      return filas.map((f) => f.id);
    },
    importacionesBd: (clienteId) =>
      lectura(
        () =>
          sql(
            `select id, estado, periodos, periodo_hasta, trabajo_id, solicitada_por, terminada_en, periodos_leidos, periodos_sin_datos,
                    candidatas, sin_criterio, motivo from regla_importacion where cliente_id = $1 order by solicitada_en, id`,
            [clienteId],
          ),
        [],
      ),
    candidatasBd: (clienteId) =>
      lectura(
        () =>
          sql(
            `select id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto, estado, destino_elegido, regla_id, resuelta_por,
                    n_total, periodos_con_proveedor from regla_candidata where cliente_id = $1 order by doc_tipo, doc_numero`,
            [clienteId],
          ),
        [],
      ),
    candidataBd: async (id) =>
      (
        await lectura(
          () =>
            sql(
              `select id, importacion_id, cliente_id, doc_tipo, doc_numero, destino_propuesto, estado, destino_elegido, regla_id, resuelta_por
                 from regla_candidata where id = $1`,
              [id],
            ),
          [],
        )
      )[0],
    reglasConOrigen: (clienteId) =>
      lectura(
        () =>
          sql(
            `select id, doc_tipo, doc_numero, destino, activa, version::int as version, periodo_aprendido, origen, creada_por, actualizada_por,
                    eliminada_en is not null as eliminada from regla_aprendida where cliente_id = $1 order by creada_en, id`,
            [clienteId],
          ),
        [],
      ),
    trabajosImportar: async (tenantId, clienteId) => (await v.b.trabajos(tenantId, "reglas.historial.importar")).filter((t) => t.cliente_id === clienteId),
    sembrarTrabajoImportar: async (tenantId, clienteId, estado, usuarioId) => {
      const r = await sql(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
         select $1, c.id, c.ruc, 'reglas.historial.importar', 'sire', 'sire', 'interactivo', $3, '{}'::jsonb,
                sha256(convert_to('sembrado-' || gen_random_uuid()::text, 'UTF8')), $4, 3
           from cliente c where c.id = $2 returning id`,
        [tenantId, clienteId, estado, usuarioId],
      );
      return r[0].id as string;
    },
    fijarPerfil: async (clienteId, p) => {
      await sql("update cliente set zona = $2, ventas_exoneradas = $3, ventas_mixtas = $4 where id = $1", [
        clienteId,
        p.zona,
        p.ventasExoneradas,
        p.ventasMixtas,
      ]);
    },
    archivar: async (clienteId) => {
      await sql("update cliente set archivado_at = now() where id = $1", [clienteId]);
    },
    fotoAprendizaje: async (tenantId, clienteId) => ({
      importaciones: await banco.importacionesBd(clienteId),
      candidatas: await banco.candidatasBd(clienteId),
      reglas: await banco.reglasConOrigen(clienteId),
      trabajos: (await banco.trabajosImportar(tenantId, clienteId)).length,
    }),
    cerrar: async () => {
      if (tenants.length > 0) {
        // Las candidatas apuntan a importaciones y a reglas: van antes que `v.cerrar()` (que borra reglas, clientes y estudios).
        await sql("delete from regla_candidata where tenant_id = any($1::uuid[])", [tenants]).catch(() => undefined);
        await sql("delete from regla_importacion where tenant_id = any($1::uuid[])", [tenants]).catch(() => undefined);
      }
      await v.cerrar();
    },
  };
  return banco;
}

/** Claves exactas de `candidataVistaSchema`. */
export const CLAVES_CANDIDATA = [
  "conflicto",
  "conteos",
  "destinoElegido",
  "destinoPropuesto",
  "estado",
  "id",
  "periodosConProveedor",
  "periodosLeidos",
  "proveedor",
  "regla",
].sort();

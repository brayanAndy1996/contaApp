/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Soporte de las pruebas HTTP de 031 (T3, rojo): consulta de auditoría con filtros y `/auditoria/opciones`. Fuera de `src/`.
// Solo usa el contrato público de `plan.md#contratos` (HTTP): `GET /auditoria?usuarioId&clienteId&accion=a&accion=b&desde&hasta&cursor`
// y `GET /auditoria/opciones?q&clienteId`. La «consulta de referencia» (`referencia`) es SQL propio de la prueba, independiente de
// la función de 0088: las fechas `AAAA-MM-DD` son de Lima (UTC−05:00 fijo): de las 00:00 de `desde` a las 00:00 del día siguiente a `hasta`.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor, RolSistema } from "./soporte-acceso.js";
import type { BancoCola, Estudio } from "./soporte-credenciales.js";
import { rolConMiembro, type Alcance } from "./soporte-roles.js";
import type { Resp } from "./soporte.js";

export type Sql = BancoCola["sql"];

/** Parámetros de la consulta (los nombres de la API). `accion` repetida en la URL. */
export interface FiltrosQ {
  usuarioId?: string;
  clienteId?: string;
  accion?: string[];
  desde?: string;
  hasta?: string;
  cursor?: string;
}

/** Cadena de consulta con las claves en el orden dado; `accion` sale repetida. Los valores se codifican. */
export function qs(f: Record<string, string | string[] | undefined>): string {
  const partes: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) partes.push(`${encodeURIComponent(k)}=${encodeURIComponent(x)}`);
  }
  return partes.length === 0 ? "" : `?${partes.join("&")}`;
}

/* ---------------- Lima ---------------- */
const DIA_MS = 86_400_000;
const LIMA_MS = 5 * 3_600_000;
/** `AAAA-MM-DD` de Lima → instante UTC de sus 00:00 (UTC−05:00 fijo). */
export const medianocheLima = (dia: string): Date => new Date(Date.parse(`${dia}T00:00:00.000Z`) + LIMA_MS);
export const rangoRef = (desde?: string, hasta?: string): { desde: Date | null; hastaExclusivo: Date | null } => ({
  desde: desde === undefined ? null : medianocheLima(desde),
  hastaExclusivo: hasta === undefined ? null : new Date(medianocheLima(hasta).getTime() + DIA_MS),
});

/* ---------------- Siembra con instante exacto (ms) ---------------- */
export interface FilaSembrada {
  id: string;
  /** ISO con milisegundos, como sale en `ocurridaEn`. */
  en: string;
}

/** Una fila de `auditoria` en el instante `en` (ISO, milisegundos). Coherente con los CHECK de 0041. */
export async function sembrarEn(
  sql: Sql,
  o: {
    tenantId: string;
    en: string;
    accion?: string;
    usuarioId?: string | null;
    trabajoId?: string | null;
    actorTipo?: "usuario" | "trabajo" | "sistema";
    clienteId?: string | null;
    entidad?: string;
    entidadId?: string;
    datos?: Record<string, unknown>;
  },
): Promise<FilaSembrada> {
  const actorTipo = o.actorTipo ?? (o.usuarioId ? "usuario" : "sistema");
  const f = await sql<{ id: string }>(
    `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, entidad_id, datos)
     values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning id`,
    [
      o.tenantId,
      o.en,
      actorTipo,
      actorTipo === "sistema" ? null : (o.usuarioId ?? null),
      actorTipo === "trabajo" ? (o.trabajoId ?? randomUUID()) : null,
      o.accion ?? "cliente.editado",
      o.clienteId ?? null,
      o.entidad ?? (o.clienteId ? "cliente" : "sesion"),
      o.entidadId ?? o.clienteId ?? randomUUID(),
      JSON.stringify(o.datos ?? {}),
    ],
  );
  return { id: f[0]!.id, en: new Date(o.en).toISOString() };
}

/** Una fila de `auditoria_descifrado` en el instante `en` (ISO, milisegundos). */
export async function sembrarDescifradoEn(
  sql: Sql,
  o: { tenantId: string; clienteId: string; en: string; tipo?: "sol" | "sire_api"; motivo?: string; resultado?: string },
): Promise<FilaSembrada> {
  const f = await sql<{ id: string }>(
    `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::timestamptz) returning id`,
    [o.tenantId, randomUUID(), o.clienteId, o.tipo ?? "sol", o.motivo ?? "sire.propuesta.descargar", o.resultado ?? "ok", o.en],
  );
  return { id: f[0]!.id, en: new Date(o.en).toISOString() };
}

/**
 * Masa para paginar con filtros: `n` filas `cliente.editado` del cliente y `n` descifrados del mismo cliente, con el mismo instante
 * (milisegundos) de dos en dos entre ramas y 3 filas por milisegundo dentro de cada rama (empates que resuelve el id).
 * Devuelve los ids de cada rama.
 */
export async function sembrarMasa(
  sql: Sql,
  o: { tenantId: string; clienteId: string; usuarioId: string; n: number; base?: string },
): Promise<{ auditoria: string[]; descifrados: string[] }> {
  const base = o.base ?? "2026-03-10T12:00:00.000Z";
  const a = await sql<{ id: string }>(
    `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
     select $1, $4::timestamptz - (g / 3) * interval '1 millisecond', 'usuario', $2, 'cliente.editado', $3, 'cliente', $3,
            jsonb_build_object('cambios', jsonb_build_object('razon_social', jsonb_build_array('t3-masa-' || g, 'nueva')))
       from generate_series(1, $5::int) g returning id`,
    [o.tenantId, o.usuarioId, o.clienteId, base, o.n],
  );
  const d = await sql<{ id: string }>(
    `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
     select $1, gen_random_uuid(), $2, 'sol', 'sire.propuesta.descargar', 'ok', $3::timestamptz - (g / 3) * interval '1 millisecond'
       from generate_series(1, $4::int) g returning id`,
    [o.tenantId, o.clienteId, base, o.n],
  );
  return { auditoria: a.map((x) => x.id), descifrados: d.map((x) => x.id) };
}

/* ---------------- Consulta de referencia ---------------- */
/**
 * Ids (más nueva primero, empates por id desc) que debe devolver la consulta con esos filtros, calculados con SQL propio sobre las dos
 * tablas. `clientesVisibles`: lista de clientes del alcance asignado (`null` = todo el estudio). Un descifrado no guarda actor: con
 * `usuarioId` nunca sale; sin `credencial.descifrada` en `accion` tampoco. Las filas sin cliente no salen con alcance asignado (P-5).
 */
export async function referencia(
  sql: Sql,
  tenantId: string,
  f: Pick<FiltrosQ, "usuarioId" | "clienteId" | "accion" | "desde" | "hasta"> = {},
  clientesVisibles: readonly string[] | null = null,
): Promise<string[]> {
  const r = rangoRef(f.desde, f.hasta);
  const filas = await sql<{ id: string }>(
    `select id from (
       select a.id, a.ocurrida_en as t from auditoria a
        where a.tenant_id = $1
          and ($2::uuid is null or a.usuario_id = $2)
          and ($3::uuid is null or a.cliente_id = $3)
          and ($4::text[] is null or a.accion = any($4))
          and ($5::timestamptz is null or a.ocurrida_en >= $5)
          and ($6::timestamptz is null or a.ocurrida_en < $6)
          and ($7::uuid[] is null or a.cliente_id = any($7))
       union all
       select d.id, d.created_at from auditoria_descifrado d
        where d.tenant_id = $1
          and $2::uuid is null
          and ($4::text[] is null or 'credencial.descifrada' = any($4))
          and ($3::uuid is null or d.cliente_id = $3)
          and ($5::timestamptz is null or d.created_at >= $5)
          and ($6::timestamptz is null or d.created_at < $6)
          and ($7::uuid[] is null or d.cliente_id = any($7))
     ) x order by t desc, id desc`,
    [tenantId, f.usuarioId ?? null, f.clienteId ?? null, f.accion ?? null, r.desde, r.hastaExclusivo, clientesVisibles === null ? null : [...clientesVisibles]],
  );
  return filas.map((x) => x.id);
}

/* ---------------- HTTP ---------------- */
export interface Api {
  get(a: Actor, ruta: string): Promise<Resp>;
  /** `GET /auditoria` con filtros; exige 200 y devuelve la página. */
  pagina(a: Actor, f?: FiltrosQ): Promise<{ items: any[]; siguiente: string | null; texto: string }>;
  /** Todas las páginas con los mismos filtros (cada una 200 y ≤ 50 filas, el cursor solo con esos filtros). */
  recorrer(a: Actor, f?: FiltrosQ, max?: number): Promise<{ items: any[]; paginas: any[][]; texto: string }>;
  opciones(a: Actor, p?: Record<string, string | string[] | undefined>): Promise<Resp>;
}

export function api(b: BancoCola): Api {
  const get = (a: Actor, ruta: string): Promise<Resp> => b.c.p.b.llamar(a, "GET", ruta);
  const pagina = async (a: Actor, f: FiltrosQ = {}) => {
    const r = await get(a, `/auditoria${qs({ ...f })}`);
    expect(r.status, `GET /auditoria${qs({ ...f })}: ${r.text}`).toBe(200);
    return { items: r.body.items as any[], siguiente: r.body.siguiente as string | null, texto: r.text };
  };
  return {
    get,
    pagina,
    recorrer: async (a, f = {}, max = 40) => {
      const items: any[] = [];
      const paginas: any[][] = [];
      let texto = "";
      let cursor: string | undefined;
      for (let i = 0; i < max; i++) {
        const p = await pagina(a, { ...f, ...(cursor === undefined ? {} : { cursor }) });
        expect(p.items.length).toBeLessThanOrEqual(50);
        paginas.push(p.items);
        items.push(...p.items);
        texto += `${p.texto}\n`;
        if (p.siguiente === null) return { items, paginas, texto };
        expect(typeof p.siguiente).toBe("string");
        cursor = p.siguiente;
      }
      throw new Error("la consulta de auditoría no termina de paginar");
    },
    opciones: (a, p = {}) => get(a, `/auditoria/opciones${qs(p)}`),
  };
}

/* ---------------- Escenario ---------------- */
export interface Esc {
  E: Estudio;
  dueno: Actor;
  /** Dos clientes del estudio (A y B). */
  A: { id: string; ruc: string; razonSocial: string };
  B: { id: string; ruc: string; razonSocial: string };
  miembro(rol: RolSistema, nombre?: string): Promise<Actor>;
  /** Rol propio con `auditoria.ver` (más lo que pida `extra`) y un miembro con sesión que lo tiene. */
  conRolPropio(alcance: Alcance, extra?: readonly string[], sin?: boolean): Promise<Actor>;
}

/** Estudio nuevo con su Dueño y dos clientes (cada prueba el suyo). Registra el estudio para limpiar al terminar. */
export async function escenario(b: BancoCola, estudios: string[]): Promise<Esc> {
  const E = await b.estudio();
  estudios.push(E.tenantId);
  const sembrar = async (etiqueta: string) => {
    const razonSocial = `${etiqueta} SAC ${randomUUID().slice(0, 6)}`;
    const c = await b.c.sembrar(E.tenantId, { razonSocial });
    return { id: c.id, ruc: c.ruc, razonSocial };
  };
  const A = await sembrar("SAN JUAN");
  const B = await sembrar("SANTA ROSA");
  return {
    E,
    dueno: E.titular,
    A,
    B,
    miembro: async (rol, nombre) => {
      const a = await b.c.p.b.miembro(E.tenantId, rol);
      if (nombre) await b.sql("update usuario set nombre = $2 where id = $1", [a.id, nombre]);
      return a;
    },
    conRolPropio: async (alcance, extra = [], sin = false) => {
      const permisos = sin ? [...extra] : ["auditoria.ver", ...extra];
      const { miembro } = await rolConMiembro(b.c.p.b, E.titular, permisos.length === 0 ? ["clientes.ver"] : permisos, alcance);
      return miembro;
    },
  };
}

export const idsDe = (items: readonly any[]): string[] => items.map((x) => x.id as string);
/** Ids de `items` que están en `ids`, en el orden de `items`. */
export const de = (items: readonly any[], ids: readonly string[]): string[] => idsDe(items).filter((i) => ids.includes(i));
/** Conjunto ordenado (para comparar sin depender del orden de filas que el API genera con microsegundos). */
export const ordenado = (ids: readonly string[]): string[] => [...ids].sort();

// Soporte de las pruebas de BD de la spec 031 (T1, rojo). No es una prueba (no termina en .spec.ts).
// Siembra filas de `auditoria` y de `auditoria_descifrado` con el superusuario (ids y milisegundos controlados) y calcula la
// CONSULTA DE REFERENCIA en JS sobre un volcado de ambas tablas: independiente del SQL que se prueba (D-1, CA-1).
//
// CONTRATO QUE FIJAN LAS PRUEBAS (plan.md#contratos, DB; lo implementa T5 en 0088 y packages/db):
//   listarAuditoria(tx, { antes?, limite?, alcance, filtros? }) con filtros = { usuarioId, clienteId, acciones, desde, hastaExclusivo }
//     (cada uno null = sin filtro; `desde` inclusivo y `hastaExclusivo` exclusivo, sobre milisegundos).
//   opcionesAuditoria(tx, { q, clienteId, alcance }) -> { miembros: {id, nombre, activo}[], clientes: {id, ruc, razonSocial, archivado}[] }
//   auditoria_descifrado_listar(p_antes timestamptz, p_antes_id uuid, p_limite int, p_cliente_id uuid, p_desde timestamptz,
//     p_hasta timestamptz (exclusivo), p_global boolean, p_usuario uuid) -> (id, cliente_id, tipo, motivo, resultado, created_at)
import { randomBytes } from "node:crypto";
import { EscenarioAuditoria, exportado } from "./auditoria-soporte";
import type { Tx } from "./soporte";

export type Alcance = { tipo: "global" } | { tipo: "asignado"; usuarioId: string };

export interface Filtros {
  usuarioId: string | null;
  clienteId: string | null;
  acciones: string[] | null;
  desde: Date | null;
  hastaExclusivo: Date | null;
}

export const SIN_FILTROS: Filtros = { usuarioId: null, clienteId: null, acciones: null, desde: null, hastaExclusivo: null };
export const filtros = (f: Partial<Filtros>): Filtros => ({ ...SIN_FILTROS, ...f });

export interface FilaAuditoria {
  id: string;
  ocurridaEn: Date;
  accion: string;
  actorTipo: string;
  usuarioId: string | null;
  trabajoId: string | null;
  clienteId: string | null;
  entidad: string;
  entidadId: string | null;
  datos: Record<string, unknown>;
}

/** Fila del volcado de referencia: auditoria + descifrados (accion `credencial.descifrada`, sin usuario). */
export interface FilaRef {
  id: string;
  ms: number;
  accion: string;
  usuarioId: string | null;
  clienteId: string | null;
  descifrado: boolean;
}

export interface FilaDescifrado {
  id: string;
  cliente_id: string | null;
  tipo: string | null;
  motivo: string;
  resultado: string;
  created_at: Date;
}

export interface ArgsFuncion {
  antes?: Date | null;
  antesId?: string | null;
  limite?: number | null;
  clienteId?: string | null;
  desde?: Date | null;
  hasta?: Date | null;
  global?: boolean | null;
  usuario?: string | null;
}

export const SQL_FUNCION =
  "select * from auditoria_descifrado_listar($1::timestamptz, $2::uuid, $3::int, $4::uuid, $5::timestamptz, $6::timestamptz, $7::boolean, $8::uuid)";

export const COLUMNAS_FUNCION = ["id", "cliente_id", "tipo", "motivo", "resultado", "created_at"] as const;

/** 00:00 en Lima (UTC-05:00 fijo) del 10 de marzo de 2026. */
export const D1 = Date.UTC(2026, 2, 10, 5, 0, 0);
/** 00:00 en Lima del 11 de marzo de 2026. */
export const D2 = D1 + 86_400_000;
export const H = 3_600_000;
export const iso = (ms: number): string => new Date(ms).toISOString();

export class EscenarioConsulta extends EscenarioAuditoria {
  private readonly marcaIds = randomBytes(4).toString("hex");
  private contadorIds = 0;

  /** uuid con orden creciente por llamada (misma marca de escenario), para fijar los desempates por id entre las dos ramas. */
  id(): string {
    return `0190a031-${this.marcaIds.slice(0, 4)}-7000-8000-${this.marcaIds.slice(4)}${String(++this.contadorIds).padStart(8, "0")}`;
  }

  /** Fila de `auditoria` con milisegundos controlados. Actor: trabajo si hay `trabajo`, usuario si hay `usuario`, si no sistema. */
  async audit(
    tenantId: string,
    o: { ms: number; accion: string; usuario?: string | null; trabajo?: string | null; cliente?: string | null },
  ): Promise<string> {
    const id = this.id();
    const actor = o.trabajo ? "trabajo" : o.usuario ? "usuario" : "sistema";
    await this.admin.query(
      `insert into auditoria (id, tenant_id, ocurrida_en, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, datos)
       values ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, 'cliente', '{}'::jsonb)`,
      [id, tenantId, iso(o.ms), actor, o.usuario ?? null, o.trabajo ?? null, o.accion, o.cliente ?? null],
    );
    return id;
  }

  /** Fila de `auditoria_descifrado`; `en` es un ISO (admite microsegundos: la funcion los trunca a ms). */
  async descifrado(tenantId: string, o: { en: string | number; cliente?: string | null; motivo?: string }): Promise<string> {
    const id = this.id();
    await this.admin.query(
      `insert into auditoria_descifrado (id, tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
       values ($1, $2, gen_random_uuid(), $3, 'sol', $4, 'ok', $5::timestamptz)`,
      [id, tenantId, o.cliente ?? null, o.motivo ?? "verificar", typeof o.en === "number" ? iso(o.en) : o.en],
    );
    return id;
  }

  /** Volcado de ambas tablas del estudio (con el superusuario) para la referencia. */
  async volcado(tenantId: string): Promise<FilaRef[]> {
    const r = await this.admin.query(
      `select id, (extract(epoch from ocurrida_en) * 1000)::bigint as ms, accion, usuario_id, cliente_id, false as descifrado
         from auditoria where tenant_id = $1
       union all
       select id, (extract(epoch from date_trunc('milliseconds', created_at)) * 1000)::bigint, 'credencial.descifrada', null::uuid,
              cliente_id, true
         from auditoria_descifrado where tenant_id = $1`,
      [tenantId],
    );
    return r.rows.map((f) => ({
      id: f.id as string,
      ms: Number(f.ms),
      accion: f.accion as string,
      usuarioId: f.usuario_id as string | null,
      clienteId: f.cliente_id as string | null,
      descifrado: f.descifrado as boolean,
    }));
  }

  /** usuario -> clientes asignados del estudio. */
  async asignaciones(tenantId: string): Promise<Map<string, Set<string>>> {
    const r = await this.admin.query("select usuario_id, cliente_id from asignacion where tenant_id = $1", [tenantId]);
    const m = new Map<string, Set<string>>();
    for (const f of r.rows as { usuario_id: string; cliente_id: string }[]) {
      if (!m.has(f.usuario_id)) m.set(f.usuario_id, new Set());
      m.get(f.usuario_id)!.add(f.cliente_id);
    }
    return m;
  }

  /** Consulta de referencia (JS puro): ids de lo que debe verse, de la mas nueva a la mas vieja por (ms, id). */
  referencia(volcado: FilaRef[], asig: Map<string, Set<string>>, f: Filtros, a: Alcance): string[] {
    const visibles = a.tipo === "global" ? null : (asig.get(a.usuarioId) ?? new Set<string>());
    return volcado
      .filter((r) => {
        if (visibles && (r.clienteId === null || !visibles.has(r.clienteId))) return false;
        if (f.usuarioId !== null && (r.descifrado || r.usuarioId !== f.usuarioId)) return false;
        if (f.clienteId !== null && r.clienteId !== f.clienteId) return false;
        if (f.acciones !== null && !f.acciones.includes(r.accion)) return false;
        if (f.desde !== null && r.ms < f.desde.getTime()) return false;
        if (f.hastaExclusivo !== null && r.ms >= f.hastaExclusivo.getTime()) return false;
        return true;
      })
      .sort((x, y) => y.ms - x.ms || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
      .map((r) => r.id);
  }

  /** Una pagina de `listarAuditoria` con la sesion (tenant, usuario) dada. */
  pagina(
    tenantId: string,
    userId: string | undefined,
    o: { antes?: { en: Date; id: string }; limite?: number; alcance: Alcance; filtros?: Filtros },
  ): Promise<FilaAuditoria[]> {
    const listar = exportado<(tx: Tx, o: unknown) => Promise<FilaAuditoria[]>>("listarAuditoria");
    return this.comoBackend(tenantId, userId, (tx) => listar(tx, o));
  }

  /** Recorre todas las paginas con el cursor (ocurridaEn, id) como lo hace el servicio; devuelve los ids en orden. */
  async recorrer(
    tenantId: string,
    userId: string | undefined,
    o: { alcance: Alcance; filtros?: Filtros },
    limite: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let antes: { en: Date; id: string } | undefined;
    for (let i = 0; i < 2000; i++) {
      const p = await this.pagina(tenantId, userId, { ...o, limite, ...(antes ? { antes } : {}) });
      expectLimite(p.length, limite);
      if (p.length === 0) break;
      ids.push(...p.map((f) => f.id));
      const ult = p[p.length - 1]!;
      antes = { en: new Date(ult.ocurridaEn), id: ult.id };
    }
    return ids;
  }

  /** La funcion de descifrados con la sesion dada (userId undefined = solo estudio). */
  funcion(tenantId: string, userId: string | undefined, a: ArgsFuncion = {}): Promise<FilaDescifrado[]> {
    return this.comoBackend(tenantId, userId, async (tx) => {
      const r = await tx.query(SQL_FUNCION, [
        a.antes ?? null,
        a.antesId ?? null,
        a.limite === undefined ? 50 : a.limite,
        a.clienteId ?? null,
        a.desde ?? null,
        a.hasta ?? null,
        a.global === undefined ? true : a.global,
        a.usuario ?? null,
      ]);
      return r.rows as FilaDescifrado[];
    });
  }
}

function expectLimite(n: number, limite: number): void {
  if (n > Math.min(limite, 50)) throw new Error(`la pagina trajo ${n} filas con limite ${limite}`);
}

// Soporte de las pruebas de BD de la spec 026 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Siembra obtenciones, declaraciones, manuales y prorratas ingresadas con el superusuario (MIGRATIONS_DATABASE_URL: pasa por los
// triggers y las FK, no por RLS ni grants) y llama a las funciones acotadas como backend o worker dentro de `withTenant`. Al final
// borra todo con `session_replication_role = replica` (las tablas son de solo insercion). Datos sinteticos: sin RUC reales.
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T3 (T10 lo implementa en las migraciones 0065-0066; plan 026, Contratos: BD). Donde el plan deja
// abierto un detalle, la decision de T3 esta marcada con [T3]:
//   Tablas (0065), solo de insercion, con las columnas, CHECK, FK compuestas y unicas del plan:
//     prorrata_obtencion(id, tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos, periodos_sin_declaracion, nuevas,
//       obtenida_en)
//     declaracion_mensual(id, tenant_id, cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
//       ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada, obtencion_id)
//     prorrata_mes_manual(id, tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo, autor,
//       creado_en)
//     prorrata_usada_manual(id, tenant_id, cliente_id, periodo, version, porcentaje, autor, creado_en)
//     Backend solo SELECT; worker nada; nadie INSERT, UPDATE ni DELETE directo; UPDATE y DELETE rechazados por trigger (42501) salvo
//     superusuario.
//   Funciones (0066), todas `select ... from public.<f>(...)`. Las del backend exigen app.tenant_id y app.user_id con membresia activa
//   (42501); la del worker solo app.tenant_id (y app.trabajo_id para que el actor de la auditoria sea el trabajo):
//     prorrata_declaraciones_registrar(p_cliente uuid, p_trabajo uuid, p_periodo_hasta char(6), p_leidos char(6)[],
//       p_sin_declaracion char(6)[], p_declaraciones jsonb) -> integer (nuevas)
//       [T3] p_declaraciones = arreglo de {periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base, ventas_gravadas_igv,
//            exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada} en snake_case; los montos y la prorrata, CADENAS
//            decimales (hasta 2 decimales); numero_orden, cadena de 1 a 15 digitos > 0; prorrata_usada, cadena o null.
//     prorrata_mes_manual_guardar(p_cliente uuid, p_periodo char(6), p_gravadas numeric, p_exportaciones numeric,
//       p_no_gravadas numeric, p_motivo text, p_version integer) -> integer (la version nueva = p_version + 1)
//     prorrata_mes_manual_eliminar(p_cliente uuid, p_periodo char(6), p_motivo text, p_version integer) -> integer (version nueva)
//     prorrata_usada_guardar(p_cliente uuid, p_periodo char(6), p_porcentaje numeric, p_version integer) -> integer (version nueva)
//   SQLSTATE: sin estudio, sin usuario, miembro desactivado o de otro estudio, o rol de la app equivocado: 42501; cliente ajeno o
//   inexistente: P0002; archivado: 55000; entradas invalidas: 22023; version distinta: CA409; mes con declaracion: CA412; PDT que
//   trae la prorrata usada: CA413.
//   Auditoria (D-6): prorrata.declaraciones_obtenidas (actor trabajo, cliente, datos {periodo, leidos, sinDeclaracion, nuevas});
//   prorrata.mes_manual_guardado, prorrata.mes_manual_eliminado y prorrata.usada_guardada (actor usuario, cliente, datos
//   {clienteId, periodo, version}). [T3] `leidos` y `sinDeclaracion` pueden ser conteos o arreglos de periodos (AAAAMM): las
//   pruebas aceptan ambos; nunca RUC, montos, porcentajes ni motivos.
import { randomUUID } from "node:crypto";
import type { ContappDb, ContextoTenant } from "./soporte";
import type { ClientePrueba } from "./trabajos-soporte";
import { EscenarioAuditoria } from "./auditoria-soporte";
import {
  barrera,
  codigoDe,
  comoRolSql,
  conExecute,
  conPlazo,
  infoFuncion,
  llamar,
  llamarOk,
  periodosHasta,
  ROLES_APP,
  ROLES_FUNCION,
  type Llamada,
} from "./reglas-importacion-soporte";

export {
  barrera,
  codigoDe,
  comoRolSql,
  conExecute,
  conPlazo,
  infoFuncion,
  llamar,
  llamarOk,
  periodosHasta,
  ROLES_APP,
  ROLES_FUNCION,
};
export type { ClientePrueba, Llamada };

export const TABLAS_PRORRATA = [
  "prorrata_obtencion",
  "declaracion_mensual",
  "prorrata_mes_manual",
  "prorrata_usada_manual",
] as const;

export const ACCIONES_PRORRATA = [
  "prorrata.declaraciones_obtenidas",
  "prorrata.mes_manual_guardado",
  "prorrata.mes_manual_eliminado",
  "prorrata.usada_guardada",
] as const;

/** Firmas (regprocedure) de las cuatro funciones de 0066. */
export const FIRMAS = {
  registrar:
    "prorrata_declaraciones_registrar(uuid,uuid,character,character[],character[],jsonb)",
  guardarManual:
    "prorrata_mes_manual_guardar(uuid,character,numeric,numeric,numeric,text,integer)",
  eliminarManual: "prorrata_mes_manual_eliminar(uuid,character,text,integer)",
  guardarUsada: "prorrata_usada_guardar(uuid,character,numeric,integer)",
} as const;

/** Rol de la app que ejecuta cada funcion. */
export const EJECUTA: Record<
  keyof typeof FIRMAS,
  "contapp_backend" | "contapp_worker"
> = {
  registrar: "contapp_worker",
  guardarManual: "contapp_backend",
  eliminarManual: "contapp_backend",
  guardarUsada: "contapp_backend",
};

export const SQL = {
  registrar:
    "select public.prorrata_declaraciones_registrar($1::uuid, $2::uuid, $3::char(6), $4::char(6)[], $5::char(6)[], $6::jsonb) as n",
  guardarManual:
    "select public.prorrata_mes_manual_guardar($1::uuid, $2::char(6), $3::numeric, $4::numeric, $5::numeric, $6::text, $7::integer) as version",
  eliminarManual:
    "select public.prorrata_mes_manual_eliminar($1::uuid, $2::char(6), $3::text, $4::integer) as version",
  guardarUsada:
    "select public.prorrata_usada_guardar($1::uuid, $2::char(6), $3::numeric, $4::integer) as version",
} as const;

export const TIPO_TRABAJO = "sol.declaraciones.descargar";

/** Valores con los que se buscan filtraciones en la auditoria: montos, porcentaje y motivo reconocibles. */
export const CANARIO = {
  motivo: "MOTIVO-CANARIO-026",
  gravadas: "7654321.09",
  exportaciones: "2345678.91",
  noGravadas: "3456789.12",
  porcentaje: "63.21",
} as const;

// ---- Periodos ------------------------------------------------------------------------------------------------------------------
/** Los 12 meses que terminan en `hasta` (AAAAMM), del mas antiguo al mas reciente (R-1: incluye `hasta`). */
export function ventana(hasta: string): string[] {
  return periodosHasta(hasta, 12).reverse();
}

// ---- Cargas utiles -------------------------------------------------------------------------------------------------------------
export interface OpcionesDecl {
  periodo?: string;
  numeroOrden?: string;
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

/** Una declaracion de `p_declaraciones` (snake_case; montos como cadenas decimales). */
export function decl(o: OpcionesDecl = {}): Record<string, unknown> {
  return {
    periodo: o.periodo ?? "202610",
    numero_orden: o.numeroOrden ?? "1001",
    fecha_presentacion: o.fecha ?? "2026-11-05",
    tipo: o.tipo ?? "original",
    ventas_gravadas_base: o.gravadas ?? "100000.00",
    ventas_gravadas_igv: o.igv ?? "18000.00",
    exportaciones: o.exportaciones ?? "0.00",
    no_gravadas: o.noGravadas ?? "5000.00",
    igv_adq_dg: o.igvDg ?? "9000.00",
    igv_adq_dgng: o.igvDgng ?? "1800.00",
    prorrata_usada: o.prorrataUsada === undefined ? null : o.prorrataUsada,
  };
}

export interface ArgsRegistrar {
  hasta?: string;
  leidos?: string[];
  sinDeclaracion?: string[];
  declaraciones?: unknown;
}

/** Los parametros de `registrar`: por omision lee la ventana completa y declara solo `hasta` (el resto, sin declaracion). */
export function argsRegistrar(
  c: ClientePrueba | string,
  trabajo: string,
  a: ArgsRegistrar = {},
): unknown[] {
  const hasta = a.hasta ?? "202610";
  const declaraciones =
    a.declaraciones === undefined
      ? [decl({ periodo: hasta })]
      : a.declaraciones;
  const leidos = a.leidos ?? ventana(hasta);
  const declarados = new Set(
    Array.isArray(declaraciones)
      ? (declaraciones as { periodo?: string }[]).map((d) => String(d.periodo))
      : [],
  );
  const sin = a.sinDeclaracion ?? leidos.filter((p) => !declarados.has(p));
  return [
    typeof c === "string" ? c : c.id,
    trabajo,
    hasta,
    leidos,
    sin,
    declaraciones === null ? null : JSON.stringify(declaraciones),
  ];
}

// ---- Filas ---------------------------------------------------------------------------------------------------------------------
export interface FilaDecl {
  id: string;
  tenant_id: string;
  cliente_id: string;
  periodo: string;
  numero_orden: string;
  fecha_presentacion: Date;
  tipo: string;
  ventas_gravadas_base: string;
  ventas_gravadas_igv: string;
  exportaciones: string;
  no_gravadas: string;
  igv_adq_dg: string;
  igv_adq_dgng: string;
  prorrata_usada: string | null;
  obtencion_id: string;
}
export interface FilaObtencion {
  id: string;
  tenant_id: string;
  cliente_id: string;
  periodo_hasta: string;
  trabajo_id: string | null;
  periodos_leidos: string[];
  periodos_sin_declaracion: string[];
  nuevas: number;
  obtenida_en: Date;
}
export interface FilaManual {
  id: string;
  cliente_id: string;
  periodo: string;
  version: number;
  accion: string;
  gravadas: string | null;
  exportaciones: string | null;
  no_gravadas: string | null;
  motivo: string;
  autor: string;
  creado_en: Date;
}
export interface FilaUsada {
  id: string;
  cliente_id: string;
  periodo: string;
  version: number;
  porcentaje: string | null;
  autor: string;
  creado_en: Date;
}

export interface OpcionesObtencion {
  periodoHasta?: string;
  leidos?: string[];
  sinDeclaracion?: string[];
  nuevas?: number;
  trabajoId?: string | null;
}
export interface OpcionesManualSembrado {
  periodo?: string;
  version?: number;
  accion?: "guardado" | "eliminado";
  gravadas?: string;
  exportaciones?: string;
  noGravadas?: string;
  motivo?: string;
  autor?: string;
}
export interface OpcionesUsadaSembrada {
  periodo?: string;
  version?: number;
  porcentaje?: string | null;
  autor?: string;
}

/** Tablas que `registrar` nunca debe tocar fuera de lo que declara: ventas, compras y los dos manuales. */
const TABLAS_AJENAS = [
  "venta",
  "compra",
  "compra_version",
  "prorrata_mes_manual",
  "prorrata_usada_manual",
] as const;

export class EscenarioProrrata extends EscenarioAuditoria {
  /** Trabajo `sol.declaraciones.descargar` en ejecucion del cliente (creado por el contador del estudio). */
  async jobDescarga(
    tenantId: string,
    c: ClientePrueba,
    o: {
      periodo?: string;
      estado?: string;
      tipo?: string;
      parametros?: unknown;
    } = {},
  ): Promise<string> {
    return this.job(tenantId, c, {
      tipo: o.tipo ?? TIPO_TRABAJO,
      cola: "sol",
      canal: "sol",
      estado: o.estado ?? "ejecutando",
      parametros: o.parametros ?? { periodo: o.periodo ?? "202610" },
      creadoPor: await this.usuarioDe(tenantId),
    });
  }

  async obtencion(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesObtencion = {},
  ): Promise<string> {
    const hasta = o.periodoHasta ?? "202610";
    const leidos = o.leidos ?? ventana(hasta);
    const r = await this.admin.query(
      `insert into prorrata_obtencion (tenant_id, cliente_id, periodo_hasta, trabajo_id, periodos_leidos, periodos_sin_declaracion, nuevas)
       values ($1, $2, $3, $4, $5::char(6)[], $6::char(6)[], $7) returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        hasta,
        o.trabajoId ?? null,
        leidos,
        o.sinDeclaracion ?? [],
        o.nuevas ?? 0,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Declaracion sembrada; crea antes su obtencion si no se da `obtencionId`. */
  async declaracion(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesDecl & { obtencionId?: string } = {},
  ): Promise<string> {
    const clienteId = typeof c === "string" ? c : c.id;
    const obtencionId =
      o.obtencionId ??
      (await this.obtencion(tenantId, clienteId, {
        periodoHasta: o.periodo ?? "202610",
      }));
    const d = decl(o);
    const r = await this.admin.query(
      `insert into declaracion_mensual (tenant_id, cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
         ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, prorrata_usada, obtencion_id)
       values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [
        tenantId,
        clienteId,
        d.periodo,
        d.numero_orden,
        d.fecha_presentacion,
        d.tipo,
        d.ventas_gravadas_base,
        d.ventas_gravadas_igv,
        d.exportaciones,
        d.no_gravadas,
        d.igv_adq_dg,
        d.igv_adq_dgng,
        d.prorrata_usada,
        obtencionId,
      ],
    );
    return r.rows[0].id as string;
  }

  async manual(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesManualSembrado = {},
  ): Promise<string> {
    const accion = o.accion ?? "guardado";
    const eliminado = accion === "eliminado";
    const r = await this.admin.query(
      `insert into prorrata_mes_manual (tenant_id, cliente_id, periodo, version, accion, gravadas, exportaciones, no_gravadas, motivo, autor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        o.periodo ?? "202610",
        o.version ?? 1,
        accion,
        eliminado ? null : (o.gravadas ?? "1000.00"),
        eliminado ? null : (o.exportaciones ?? "0.00"),
        eliminado ? null : (o.noGravadas ?? "200.00"),
        o.motivo ?? "Sembrado por la prueba",
        o.autor ?? (await this.usuarioDe(tenantId)),
      ],
    );
    return r.rows[0].id as string;
  }

  async usada(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesUsadaSembrada = {},
  ): Promise<string> {
    const r = await this.admin.query(
      `insert into prorrata_usada_manual (tenant_id, cliente_id, periodo, version, porcentaje, autor)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        o.periodo ?? "202610",
        o.version ?? 1,
        o.porcentaje === undefined ? "50.00" : o.porcentaje,
        o.autor ?? (await this.usuarioDe(tenantId)),
      ],
    );
    return r.rows[0].id as string;
  }

  async declaraciones(
    clienteId: string,
    periodo?: string,
  ): Promise<FilaDecl[]> {
    return (
      await this.admin.query(
        `select * from declaracion_mensual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, numero_orden`,
        [clienteId, periodo ?? null],
      )
    ).rows as FilaDecl[];
  }

  async obtenciones(clienteId: string): Promise<FilaObtencion[]> {
    return (
      await this.admin.query(
        `select * from prorrata_obtencion where cliente_id = $1 order by obtenida_en, id`,
        [clienteId],
      )
    ).rows as FilaObtencion[];
  }

  async manuales(clienteId: string, periodo?: string): Promise<FilaManual[]> {
    return (
      await this.admin.query(
        `select * from prorrata_mes_manual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, version`,
        [clienteId, periodo ?? null],
      )
    ).rows as FilaManual[];
  }

  async usadas(clienteId: string, periodo?: string): Promise<FilaUsada[]> {
    return (
      await this.admin.query(
        `select * from prorrata_usada_manual where cliente_id = $1 and ($2::text is null or periodo = $2) order by periodo, version`,
        [clienteId, periodo ?? null],
      )
    ).rows as FilaUsada[];
  }

  /** Cuenta de filas del estudio en las tablas que la funcion del worker no debe tocar. */
  async contadoresAjenos(tenantId: string): Promise<Record<string, number>> {
    const salida: Record<string, number> = {};
    for (const t of TABLAS_AJENAS) {
      salida[t] = Number(
        (
          await this.admin.query(
            `select count(*)::int as n from ${t} where tenant_id = $1`,
            [tenantId],
          )
        ).rows[0].n,
      );
    }
    return salida;
  }

  /** Total de filas de las cuatro tablas del cliente (para comprobar «sin cambios»). */
  async totales(clienteId: string): Promise<Record<string, number>> {
    const salida: Record<string, number> = {};
    for (const t of TABLAS_PRORRATA) {
      salida[t] = Number(
        (
          await this.admin.query(
            `select count(*)::int as n from ${t} where cliente_id = $1`,
            [clienteId],
          )
        ).rows[0].n,
      );
    }
    return salida;
  }

  async archivar(clienteId: string): Promise<void> {
    await this.admin.query(
      "update cliente set archivado_at = now() where id = $1",
      [clienteId],
    );
  }

  override async limpiar(): Promise<void> {
    const t = [...this.ea.estudios];
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of [
        "declaracion_mensual",
        "prorrata_mes_manual",
        "prorrata_usada_manual",
        "prorrata_obtencion",
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

export type DbRol = ContappDb;
export type Ctx = ContextoTenant;
export const idNuevo = (): string => randomUUID();

// Soporte de las pruebas de BD de la spec 025 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Siembra importaciones, candidatas, reglas y trabajos con el superusuario (MIGRATIONS_DATABASE_URL: pasa por los triggers y las FK, no
// por RLS ni grants) y llama a las funciones acotadas como backend o worker dentro de `withTenant`. Al final borra todo con
// `session_replication_role = replica`. Datos sinteticos: sin RUC reales.
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T3 (T10 lo implementa en las migraciones 0061-0062; plan 025, Contratos: BD). Donde el plan deja
// abierto un detalle, la decision de T3 esta marcada con [T3]:
//   Tablas (0061): regla_importacion y regla_candidata con las columnas, CHECK, FK compuestas y unicas del plan; sin INSERT, UPDATE
//     ni DELETE directo para ningun rol de la app; DELETE 42501 por trigger salvo superusuario.
//   regla_aprendida.origen text NOT NULL DEFAULT 'contador' CHECK (contador|importacion); el backend inserta por columnas SIN origen.
//   Funciones (0062), todas `select ... from public.<f>(...)`; las del backend exigen app.tenant_id y app.user_id con membresia activa
//   (42501); las del worker solo app.tenant_id. Los parametros de array van tipados (`char(6)[]`, `uuid[]`, `jsonb`).
//     reglas_importacion_iniciar(p_cliente uuid, p_periodos char(6)[]) -> uuid
//     reglas_importacion_trabajo(p_importacion uuid, p_trabajo uuid)
//     reglas_importacion_completar(p_importacion uuid, p_resumen jsonb, p_candidatas jsonb) -> integer (candidatas insertadas)
//       [T3] p_resumen = {periodos_leidos: int, periodos_sin_datos: char(6)[], candidatas: int, sin_criterio: int}
//       [T3] p_candidatas = arreglo de {doc_tipo, doc_numero, razon_social|null, destino_propuesto|null, n_dg, n_dgng, n_dng, n_mixto,
//            n_total, periodos_con_proveedor} (las columnas de regla_candidata, en snake_case)
//     reglas_importacion_fallar(p_importacion uuid, p_motivo text)
//     reglas_candidatas_activar(p_cliente uuid, p_items jsonb, p_todas uuid) -> TABLE (candidata_id uuid, resultado text, regla_id uuid)
//       [T3] p_items = arreglo de {id: uuid, destino?: DG|DGNG|DNG}; resultado = 'activada' | 'ya_aprendida' | 'conflicto' |
//            'sin_criterio' | 'no_pendiente'; con p_todas solo salen filas de las pendientes con destino propuesto de esa importacion.
//     reglas_candidata_reemplazar(p_cliente uuid, p_candidata uuid, p_destino text, p_version_regla integer)
//       [T3] devuelve la regla (la prueba no lee el retorno: verifica el estado con el superusuario)
//     reglas_candidatas_descartar(p_cliente uuid, p_ids uuid[]) -> TABLE (candidata_id uuid, descartada boolean)
//   Auditoria: regla.historial_importado {importacionId, periodos: n} al iniciar; regla.candidata_descartada {candidataId,
//   importacionId} por candidata descartada; regla.creada con `origen` en datos; regla.editada {destino: {anterior, nuevo}} al reemplazar.
//   [T3] el actor de todas es el usuario de la sesion y el cliente_id es el de la importacion o la candidata.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ContappDb, ContextoTenant, Intento } from "./soporte";
import { comoRol, conExecute, infoFuncion } from "./buzon-soporte";
import { probar, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioReglas, type Destino } from "./reglas-soporte";

export {
  APRENDIDO,
  CODIGOS_MOTOR,
  DESCARGA,
  DESTINOS,
  EscenarioReglas,
  ROLES_APP,
  uuidNuevo,
} from "./reglas-soporte";
export type { Destino } from "./reglas-soporte";
export { barrera, conPlazo, dormir } from "./compras-soporte";
export { conExecute, infoFuncion };
export type { ClientePrueba };

export const TABLAS_IMPORTACION = [
  "regla_importacion",
  "regla_candidata",
] as const;

/** Firmas (regprocedure) de las siete funciones de 0062. */
export const FIRMAS = {
  iniciar: "reglas_importacion_iniciar(uuid,character[])",
  trabajo: "reglas_importacion_trabajo(uuid,uuid)",
  completar: "reglas_importacion_completar(uuid,jsonb,jsonb)",
  fallar: "reglas_importacion_fallar(uuid,text)",
  activar: "reglas_candidatas_activar(uuid,jsonb,uuid)",
  reemplazar: "reglas_candidata_reemplazar(uuid,uuid,text,integer)",
  descartar: "reglas_candidatas_descartar(uuid,uuid[])",
} as const;

/** Rol de la app que ejecuta cada funcion. */
export const EJECUTA: Record<keyof typeof FIRMAS, "contapp_backend" | "contapp_worker"> = {
  iniciar: "contapp_backend",
  trabajo: "contapp_backend",
  completar: "contapp_worker",
  fallar: "contapp_worker",
  activar: "contapp_backend",
  reemplazar: "contapp_backend",
  descartar: "contapp_backend",
};

export const ROLES_FUNCION = [
  "contapp_backend",
  "contapp_worker",
  "contapp_app",
  "contapp_platform",
  "contapp_enumerador",
  "contapp_auth",
  "contapp_registrador",
] as const;

export const SQL = {
  iniciar: "select public.reglas_importacion_iniciar($1::uuid, $2::char(6)[]) as id",
  trabajo: "select * from public.reglas_importacion_trabajo($1::uuid, $2::uuid)",
  completar: "select public.reglas_importacion_completar($1::uuid, $2::jsonb, $3::jsonb) as n",
  fallar: "select * from public.reglas_importacion_fallar($1::uuid, $2::text)",
  activar: "select * from public.reglas_candidatas_activar($1::uuid, $2::jsonb, $3::uuid)",
  reemplazar: "select * from public.reglas_candidata_reemplazar($1::uuid, $2::uuid, $3::text, $4::integer)",
  descartar: "select * from public.reglas_candidatas_descartar($1::uuid, $2::uuid[])",
} as const;

export const MOTIVOS_TRABAJO = [
  "sunat_no_responde",
  "credencial_invalida",
  "datos_invalidos",
  "portal_cambio",
  "interrumpido",
  "acceso_retirado",
  "cancelado_usuario",
  "error_interno",
] as const;

// ---- Llamadas ------------------------------------------------------------------------------------------------------------------
export type Llamada =
  | { ok: true; rows: any[] }
  | { ok: false; code: string; message: string };

class Abortar extends Error {}

/**
 * Una llamada dentro de `withTenant`. Confirma si sale bien (salvo `revertir`); si PG da error, devuelve el SQLSTATE y revierte todo
 * (el error aborta la transaccion, asi que nada de esa transaccion persiste).
 */
export async function llamar(
  db: ContappDb,
  ctx: ContextoTenant,
  sql: string,
  values: unknown[] = [],
  o: { revertir?: boolean } = {},
): Promise<Llamada> {
  let salida: Llamada = { ok: false, code: "", message: "sin ejecutar" };
  try {
    await db.withTenant(ctx, async (tx) => {
      try {
        const r = await tx.query(sql, values);
        salida = { ok: true, rows: r.rows };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        salida = {
          ok: false,
          code: String(err.code ?? ""),
          message: String(err.message ?? ""),
        };
        throw new Abortar();
      }
      if (o.revertir) throw new Abortar();
    });
  } catch (e) {
    if (!(e instanceof Abortar)) throw e;
  }
  return salida;
}

/** Como `llamar`, pero lanza el error de PG con `code`: para las llamadas que deben salir bien y confirmar. */
export async function llamarOk(
  db: ContappDb,
  ctx: ContextoTenant,
  sql: string,
  values: unknown[] = [],
): Promise<any[]> {
  const r = await llamar(db, ctx, sql, values);
  if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
  return r.rows;
}

/** El SQLSTATE de un rechazo; falla (con el mensaje) si la llamada salio bien. */
export function codigoDe(r: Llamada): string {
  return r.ok ? "ok" : r.code;
}

/**
 * Llamada con un rol de la app SIN pasar por `withTenant`, para controlar si hay estudio y usuario en la sesion
 * (`set_config` local) y para ejercer un rol equivocado. Siempre con ROLLBACK.
 */
export async function comoRolSql(
  admin: Pool,
  rol: string,
  ctx: { tenantId?: string | null; userId?: string | null },
  sql: string,
  values: unknown[] = [],
): Promise<Intento & { rows?: any[] }> {
  return comoRol(admin, rol, ctx.tenantId ?? null, async (c) => {
    if (ctx.userId)
      await c.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    return probar(c, sql, values);
  });
}

// ---- Cargas utiles -------------------------------------------------------------------------------------------------------------
export interface OpcionesCarga {
  docTipo?: string;
  docNumero?: string;
  razonSocial?: string | null;
  destino?: Destino | null;
  dg?: number;
  dgng?: number;
  dng?: number;
  mixto?: number;
  total?: number;
  periodos?: number;
}

/** Una candidata de `p_candidatas` (snake_case, como las columnas). Por omision: DNG en 5 de 5 comprobantes. */
export function carga(o: OpcionesCarga = {}): Record<string, unknown> {
  const dg = o.dg ?? 0;
  const dgng = o.dgng ?? 0;
  const dng = o.dng ?? 5;
  const mixto = o.mixto ?? 0;
  return {
    doc_tipo: o.docTipo ?? "6",
    doc_numero: o.docNumero ?? "20100070970",
    razon_social:
      o.razonSocial === undefined ? "PROVEEDOR SINTETICO SAC" : o.razonSocial,
    destino_propuesto: o.destino === undefined ? "DNG" : o.destino,
    n_dg: dg,
    n_dgng: dgng,
    n_dng: dng,
    n_mixto: mixto,
    n_total: o.total ?? dg + dgng + dng + mixto,
    periodos_con_proveedor: o.periodos ?? 3,
  };
}

export function resumen(
  o: {
    leidos?: number;
    sinDatos?: string[];
    candidatas?: number;
    sinCriterio?: number;
  } = {},
): string {
  return JSON.stringify({
    periodos_leidos: o.leidos ?? 6,
    periodos_sin_datos: o.sinDatos ?? [],
    candidatas: o.candidatas ?? 0,
    sin_criterio: o.sinCriterio ?? 0,
  });
}

/** `periodos` de los `n` meses que terminan en `hasta` (AAAAMM), del mas reciente al mas antiguo. */
export function periodosHasta(hasta: string, n: number): string[] {
  let a = Number(hasta.slice(0, 4));
  let m = Number(hasta.slice(4));
  const r: string[] = [];
  for (let i = 0; i < n; i++) {
    r.push(`${a}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      a -= 1;
    }
  }
  return r;
}

// ---- Escenario -----------------------------------------------------------------------------------------------------------------
export interface OpcionesImportacion {
  estado?: "en_curso" | "completada" | "fallida";
  periodoHasta?: string;
  periodos?: string[];
  trabajoId?: string | null;
  solicitadaPor?: string;
  /** Antiguedad de `solicitada_en`, en minutos. */
  haceMin?: number;
  motivo?: string | null;
}

export interface OpcionesCandidata extends OpcionesCarga {
  estado?: "pendiente" | "activada" | "descartada" | "reemplazada";
  destinoElegido?: Destino | null;
  reglaId?: string | null;
  resueltaPor?: string;
}

export interface FilaCandidata {
  id: string;
  estado: string;
  destino_propuesto: string | null;
  destino_elegido: string | null;
  regla_id: string | null;
  resuelta_por: string | null;
  resuelta_en: Date | null;
  importacion_id: string;
}

export interface FilaImportacion {
  id: string;
  estado: string;
  periodos: string[];
  periodo_hasta: string;
  trabajo_id: string | null;
  solicitada_por: string;
  terminada_en: Date | null;
  periodos_leidos: number | null;
  periodos_sin_datos: string[] | null;
  candidatas: number | null;
  sin_criterio: number | null;
  motivo: string | null;
}

/** Tablas de las que `completar`, `activar` y `descartar` no deben tocar nada ajeno a la candidata. */
const TABLAS_AJENAS = [
  "regla_aprendida",
  "compra",
  "compra_version",
  "regla_aplicacion",
  "regla_aceptacion",
  "regla_confirmacion",
] as const;

export class EscenarioImportacion extends EscenarioReglas {
  private consecutivo = 0;
  private readonly tenantsImp = new Set<string>();

  /** Numero de documento unico (RUC sintetico de 11 digitos que empieza en 20). */
  docNuevo(): string {
    return `20${String(700000000 + ++this.consecutivo).padStart(9, "0")}`;
  }

  async importacion(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesImportacion = {},
  ): Promise<string> {
    this.tenantsImp.add(tenantId);
    const estado = o.estado ?? "completada";
    const hasta = o.periodoHasta ?? "202607";
    const periodos = o.periodos ?? periodosHasta(hasta, 6);
    const usuario = o.solicitadaPor ?? (await this.usuarioDe(tenantId));
    const columnas = [
      "tenant_id",
      "cliente_id",
      "estado",
      "periodos",
      "periodo_hasta",
      "trabajo_id",
      "solicitada_por",
      "solicitada_en",
      "terminada_en",
      "motivo",
    ];
    const valores: unknown[] = [
      tenantId,
      typeof c === "string" ? c : c.id,
      estado,
      periodos,
      hasta,
      o.trabajoId ?? null,
      usuario,
      o.haceMin ?? 0,
      o.motivo === undefined ? (estado === "fallida" ? "error_interno" : null) : o.motivo,
    ];
    const marcas = [
      "$1",
      "$2",
      "$3",
      "$4::char(6)[]",
      "$5",
      "$6",
      "$7",
      "now() - make_interval(mins => $8::int)",
      "case when $3 = 'en_curso' then null else now() end",
      "$9",
    ];
    if (estado === "completada") {
      columnas.push("periodos_leidos", "periodos_sin_datos", "candidatas", "sin_criterio");
      marcas.push("$10", "'{}'::char(6)[]", "$11", "$12");
      valores.push(periodos.length, 0, 0);
    }
    const r = await this.admin.query(
      `insert into regla_importacion (${columnas.join(", ")}) values (${marcas.join(", ")}) returning id`,
      valores,
    );
    return r.rows[0].id as string;
  }

  async candidata(
    tenantId: string,
    c: ClientePrueba | string,
    importacionId: string,
    o: OpcionesCandidata = {},
  ): Promise<string> {
    this.tenantsImp.add(tenantId);
    const k = carga(o);
    const estado = o.estado ?? "pendiente";
    const resuelta = estado !== "pendiente";
    const r = await this.admin.query(
      `insert into regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
         n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado, destino_elegido, regla_id, resuelta_por, resuelta_en)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               case when $17::boolean then $18::uuid else null end,
               case when $17::boolean then now() else null end)
       returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        importacionId,
        k.doc_tipo,
        o.docNumero ?? this.docNuevo(),
        k.razon_social,
        k.destino_propuesto,
        k.n_dg,
        k.n_dgng,
        k.n_dng,
        k.n_mixto,
        k.n_total,
        k.periodos_con_proveedor,
        estado,
        o.destinoElegido ?? null,
        o.reglaId ?? null,
        resuelta,
        resuelta ? (o.resueltaPor ?? (await this.usuarioDe(tenantId))) : null,
      ],
    );
    return r.rows[0].id as string;
  }

  /** `n` candidatas pendientes (DNG 5 de 5) con documentos nuevos. Devuelve ids y documentos en el mismo orden. */
  async candidatas(
    tenantId: string,
    c: ClientePrueba | string,
    importacionId: string,
    n: number,
    o: OpcionesCandidata = {},
  ): Promise<{ id: string; docNumero: string }[]> {
    const r: { id: string; docNumero: string }[] = [];
    for (let i = 0; i < n; i++) {
      const docNumero = this.docNuevo();
      r.push({ id: await this.candidata(tenantId, c, importacionId, { ...o, docNumero }), docNumero });
    }
    return r;
  }

  async filaCandidata(id: string): Promise<FilaCandidata> {
    return (await this.admin.query("select * from regla_candidata where id = $1", [id])).rows[0] as FilaCandidata;
  }

  async filaImportacion(id: string): Promise<FilaImportacion> {
    return (await this.admin.query("select * from regla_importacion where id = $1", [id])).rows[0] as FilaImportacion;
  }

  /** Reglas vivas (no eliminadas) del proveedor en el cliente. */
  async reglasVivas(clienteId: string, docNumero: string, docTipo = "6") {
    return (
      await this.admin.query(
        `select * from regla_aprendida where cliente_id = $1 and doc_tipo = $2 and doc_numero = $3 and eliminada_en is null`,
        [clienteId, docTipo, docNumero],
      )
    ).rows as {
      id: string;
      tenant_id: string;
      destino: string;
      activa: boolean;
      version: number;
      periodo_aprendido: string;
      origen: string;
      creada_por: string;
      actualizada_por: string;
    }[];
  }

  /** Cuenta de filas del estudio en las tablas que 025 nunca debe tocar fuera de lo que cada funcion declara. */
  async contadoresAjenos(tenantId: string): Promise<Record<string, number>> {
    const salida: Record<string, number> = {};
    for (const t of TABLAS_AJENAS) {
      salida[t] = Number(
        (await this.admin.query(`select count(*)::int as n from ${t} where tenant_id = $1`, [tenantId])).rows[0].n,
      );
    }
    return salida;
  }

  async archivar(clienteId: string): Promise<void> {
    await this.admin.query("update cliente set archivado_at = now() where id = $1", [clienteId]);
  }

  async cuantasCandidatas(importacionId: string, estado?: string): Promise<number> {
    return Number(
      (
        await this.admin.query(
          "select count(*)::int as n from regla_candidata where importacion_id = $1 and ($2::text is null or estado = $2)",
          [importacionId, estado ?? null],
        )
      ).rows[0].n,
    );
  }

  override async limpiar(): Promise<void> {
    const t = [...this.tenantsImp, ...this.ea.estudios];
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of ["regla_candidata", "regla_importacion"]) {
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

export const idNuevo = (): string => randomUUID();

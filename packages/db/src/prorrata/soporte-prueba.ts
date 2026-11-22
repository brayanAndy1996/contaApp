// Soporte de las pruebas de BD de la spec 026 (T4, rojo): estudio, clientes, trabajos `sol.declaraciones.descargar`, propuestas,
// ventas y exclusiones sembrados con el superusuario (MIGRATIONS_DATABASE_URL: pasa por FK y CHECK, no por RLS ni grants), un
// arnés de contexto (backend con usuario, worker sin usuario) y un oráculo en céntimos (BigInt) de las sumas del SIRE.
// No es una prueba (sin sufijo .spec) ni código de producción (queda fuera de `tsconfig.build.json`). Necesita DATABASE_URL (rol de
// la app) y MIGRATIONS_DATABASE_URL; si faltan, la suite FALLA. Datos sintéticos: ningún RUC ni razón social reales.
//
// Las tablas `declaracion_mensual`, `prorrata_obtencion`, `prorrata_mes_manual` y `prorrata_usada_manual` son las de plan.md
// (0065); esta siembra no las escribe directo: las declaraciones entran por `registrarDeclaraciones` (la API pública del repo).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDb, type ContappDb, type RolApp } from "../client";
import type { Tx } from "../with-tenant";
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import {
  ProrrataRepoError,
  registrarDeclaraciones,
  type DeclaracionNueva,
} from "./index";

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Falla (no salta) si faltan las URLs de la BD. */
export function exigirEntorno(): void {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para las pruebas de BD de la prorrata: ${faltan.join(", ")}`,
    );
  }
}

export function abrirAdmin(): Pool {
  const p = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL,
    max: 4,
  });
  p.on("error", () => undefined);
  return p;
}

export const abrirDb = (rolApp: RolApp): ContappDb =>
  createDb({ rolApp, poolMax: 4 });

// ---- Estudio y clientes ----------------------------------------------------------------------------------------------------
export interface ClienteSembrado {
  id: string;
  ruc: string;
}

export interface Estudio {
  tenantId: string;
  dueno: { id: string; nombre: string };
  /** Cliente archivado (nunca cambia). */
  archivado: ClienteSembrado;
  /** Crea un cliente nuevo del estudio (cada prueba usa el suyo). */
  nuevoCliente(): Promise<ClienteSembrado>;
  limpiar(): Promise<void>;
}

export async function sembrarEstudio(admin: Pool): Promise<Estudio> {
  const marca = randomBytes(3).toString("hex");
  const tenantId = randomUUID();
  const dueno = { id: randomUUID(), nombre: `Dueno T4 ${marca}` };
  let secuencia = 0;
  const prefijo = String(parseInt(marca, 16) % 100_000).padStart(5, "0");

  const crearCliente = async (archivado: boolean): Promise<ClienteSembrado> => {
    const cliente = {
      id: randomUUID(),
      ruc: `3${prefijo}${String(++secuencia).padStart(5, "0")}`,
    };
    await admin.query(
      `insert into cliente (id, tenant_id, ruc, razon_social, archivado_at)
       values ($1, $2, $3, $4, case when $5::boolean then now() else null end)`,
      [
        cliente.id,
        tenantId,
        cliente.ruc,
        `Cliente T4 ${marca}-${secuencia}`,
        archivado,
      ],
    );
    return cliente;
  };

  const limpiar = async (): Promise<void> => {
    const c = await admin.connect();
    try {
      // Sin disparadores (inmutabilidad, solo inserción, último dueño) y cada paso tolera que falte una tabla.
      await c.query("SET session_replication_role = replica");
      const pasos = [
        "delete from prorrata_usada_manual where tenant_id = $1",
        "delete from prorrata_mes_manual where tenant_id = $1",
        "delete from declaracion_mensual where tenant_id = $1",
        "delete from prorrata_obtencion where tenant_id = $1",
        "delete from venta_exclusion where tenant_id = $1",
        "delete from venta where tenant_id = $1",
        "delete from venta_periodo where tenant_id = $1",
        "delete from propuesta where tenant_id = $1",
        "delete from auditoria where tenant_id = $1",
        "delete from job_registro where tenant_id = $1",
        "delete from asignacion where tenant_id = $1",
        "delete from membresia where tenant_id = $1",
        "delete from cliente where tenant_id = $1",
        "delete from suscripcion where tenant_id = $1",
      ];
      for (const sql of pasos)
        await c.query(sql, [tenantId]).catch(() => undefined);
      await c
        .query("delete from usuario where id = $1", [dueno.id])
        .catch(() => undefined);
      await c
        .query("delete from tenant where id = $1", [tenantId])
        .catch(() => undefined);
    } finally {
      c.release(true); // la conexión con session_replication_role = replica no vuelve al pool
    }
  };

  try {
    await admin.query("insert into tenant (id, nombre) values ($1, $2)", [
      tenantId,
      `Estudio T4 ${marca}`,
    ]);
    await admin.query(
      "insert into usuario (id, email, nombre) values ($1, $2, $3)",
      [dueno.id, `t4-${marca}-dueno@ejemplo.test`, dueno.nombre],
    );
    await admin.query(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'dueno')",
      [tenantId, dueno.id],
    );
    const archivado = await crearCliente(true);
    return {
      tenantId,
      dueno,
      archivado,
      nuevoCliente: () => crearCliente(false),
      limpiar,
    };
  } catch (e) {
    await limpiar();
    throw e;
  }
}

/** Fila de `job_registro` `sol.declaraciones.descargar` del cliente y periodo (la que pide la función del worker). */
export async function sembrarTrabajo(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  periodo: string,
  tipo = "sol.declaraciones.descargar",
): Promise<string> {
  const r = await admin.query(
    `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
     values ($1, $2, $3, $4, 'sol', 'sol', 'interactivo', 'ejecutando', $5::jsonb, $6, $7, 3) returning id`,
    [
      e.tenantId,
      c.id,
      c.ruc,
      tipo,
      JSON.stringify({ periodo }),
      randomBytes(32),
      e.dueno.id,
    ],
  );
  return r.rows[0].id as string;
}

// ---- Declaraciones ---------------------------------------------------------------------------------------------------------
/** Ventana de 12 meses que termina en `hasta` (AAAAMM), de la más antigua a la más reciente (R-1). */
export function ventana(hasta: string): string[] {
  const anio = Number(hasta.slice(0, 4));
  const mes = Number(hasta.slice(4));
  return Array.from({ length: 12 }, (_, i) => {
    const total = anio * 12 + (mes - 1) - (11 - i);
    return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
  });
}

/** Una presentación válida del periodo; `o` pisa los valores por omisión. */
export function declaracion(
  periodo: string,
  o: Partial<DeclaracionNueva> = {},
): DeclaracionNueva {
  return {
    periodo,
    numeroOrden: "1",
    fechaPresentacion: `${periodo.slice(0, 4)}-${periodo.slice(4)}-15`,
    tipo: "original",
    ventasGravadasBase: "10000.00",
    ventasGravadasIgv: "1800.00",
    exportaciones: "0.00",
    noGravadas: "500.00",
    igvAdquisicionesDg: "900.00",
    igvAdquisicionesDgng: "90.00",
    prorrataUsada: null,
    ...o,
  };
}

/**
 * Registra una obtención por el repo (como el worker, sin usuario): `leidos` (todos los de la ventana de `hasta` por omisión),
 * `sinDeclaracion` y las presentaciones. Devuelve las nuevas. Siembra su propio trabajo.
 */
export async function registrarComoWorker(
  admin: Pool,
  worker: ContappDb,
  e: Estudio,
  c: ClienteSembrado,
  o: {
    hasta: string;
    declaraciones: DeclaracionNueva[];
    leidos?: string[];
    sinDeclaracion?: string[];
  },
): Promise<number> {
  const trabajoId = await sembrarTrabajo(admin, e, c, o.hasta);
  const leidos = o.leidos ?? ventana(o.hasta);
  const conDeclaracion = new Set(o.declaraciones.map((d) => d.periodo));
  const sinDeclaracion =
    o.sinDeclaracion ?? leidos.filter((p) => !conDeclaracion.has(p));
  return worker.withTenant({ tenantId: e.tenantId }, (tx: Tx) =>
    registrarDeclaraciones(tx, {
      clienteId: c.id,
      trabajoId,
      periodoHasta: o.hasta,
      leidos,
      sinDeclaracion,
      declaraciones: o.declaraciones,
    }),
  );
}

// ---- Ventas ----------------------------------------------------------------------------------------------------------------
export interface FilaVentaSembrada {
  tipo?: string; // «01» por omisión; «07» = nota de crédito (montos negativos)
  moneda?: "PEN" | "USD";
  tipoCambio?: string | null; // solo USD; «3.750»
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  /** `manual` no lleva propuesta. */
  origen?: "sire" | "manual";
  /** Excluida (exclusión vigente) o excluida y luego restaurada (vuelve a sumar). */
  exclusion?: "excluida" | "restaurada";
}

export interface FilaSembrada extends Required<
  Omit<FilaVentaSembrada, "exclusion" | "tipoCambio">
> {
  id: string;
  tipoCambio: string | null;
  exclusion: "excluida" | "restaurada" | null;
}

/** Suma de dos decimales «-1234.56» en céntimos exactos (BigInt). */
export const aCentimos = (s: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (m === null) throw new Error(`monto inválido en la prueba: ${s}`);
  const v = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] === "-" ? -v : v;
};

export const deCentimos = (c: bigint): string => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
};

/**
 * Siembra un periodo de ventas: la propuesta (si `cargado` y hay al menos una fila `sire`, o si `soloPropuesta`) y las filas. Un
 * periodo «cargado sin filas» es una propuesta de 0 filas. Devuelve las filas sembradas con su id.
 */
export async function sembrarVentas(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  periodo: string,
  filas: FilaVentaSembrada[],
  o: { propuesta?: boolean } = {},
): Promise<FilaSembrada[]> {
  const conPropuesta = o.propuesta ?? true;
  let propuestaId: string | null = null;
  if (conPropuesta) {
    propuestaId = randomUUID();
    const nSire = filas.filter((f) => (f.origen ?? "sire") === "sire").length;
    await admin.query(
      `insert into propuesta (id, tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas, filas_iguales,
         filas_distintas, usuario_id)
       values ($1, $2, $3, $4, 'ventas', 'api', $5, $6, $6, 0, 0, $7)`,
      [
        propuestaId,
        e.tenantId,
        c.id,
        periodo,
        randomBytes(32).toString("hex"),
        nSire,
        e.dueno.id,
      ],
    );
  }
  const sembradas: FilaSembrada[] = [];
  let n = 0;
  for (const f of filas) {
    const origen = f.origen ?? "sire";
    const moneda = f.moneda ?? "PEN";
    const tc = moneda === "USD" ? (f.tipoCambio ?? null) : null;
    const id = randomUUID();
    n++;
    // El total no importa a la prorrata; si la suma de columnas se sale de NUMERIC(14,2), va en cero.
    const suma =
      aCentimos(f.baseGravada) +
      aCentimos(f.igv) +
      aCentimos(f.exonerada) +
      aCentimos(f.inafecta);
    const total = deCentimos(
      suma > 99_999_999_999_999n || suma < -99_999_999_999_999n ? 0n : suma,
    );
    await admin.query(
      `insert into venta (id, tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, fecha,
         tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total)
       values ($1::uuid, $2::uuid, $3::uuid, $4::char(6), $5::uuid, $6, $7, $8, 'F001', $9, ($4::text || '15')::date, '6', '20000000001', $10, $11::numeric,
         $12::numeric, $13::numeric, $14::numeric, $15::numeric, 7.77, 0.50, 3.33, $16::numeric)`,
      [
        id,
        e.tenantId,
        c.id,
        periodo,
        origen === "sire" ? propuestaId : null,
        origen,
        `${f.tipo ?? "01"}-F001-${String(n).padStart(6, "0")}-${id.slice(0, 4)}`,
        f.tipo ?? "01",
        String(n).padStart(6, "0"),
        moneda,
        tc,
        f.baseGravada,
        f.igv,
        f.exonerada,
        f.inafecta,
        total,
      ],
    );
    if (f.exclusion !== undefined) {
      await admin.query(
        `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por)
         values ($1, $2, $3, $4, 'Prueba de exclusion', $5)`,
        [e.tenantId, c.id, periodo, id, e.dueno.id],
      );
      if (f.exclusion === "restaurada")
        await admin.query(
          `update venta_exclusion set restaurada_por = $3, restaurada_en = now()
             where tenant_id = $1 and venta_id = $2 and restaurada_en is null`,
          [e.tenantId, id, e.dueno.id],
        );
    }
    sembradas.push({
      id,
      tipo: f.tipo ?? "01",
      moneda,
      tipoCambio: tc,
      baseGravada: f.baseGravada,
      igv: f.igv,
      exonerada: f.exonerada,
      inafecta: f.inafecta,
      origen,
      exclusion: f.exclusion ?? null,
    });
  }
  return sembradas;
}

/** Volumen para el rendimiento: `n` ventas del periodo (una cada 50 en USD con tipo de cambio), con una sola sentencia. */
export async function sembrarVolumen(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  periodo: string,
  n: number,
): Promise<void> {
  const propuestaId = randomUUID();
  await admin.query(
    `insert into propuesta (id, tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas, filas_iguales,
       filas_distintas, usuario_id)
     values ($1, $2, $3, $4, 'ventas', 'api', $5, $6, $6, 0, 0, $7)`,
    [
      propuestaId,
      e.tenantId,
      c.id,
      periodo,
      randomBytes(32).toString("hex"),
      n,
      e.dueno.id,
    ],
  );
  await admin.query(
    `insert into venta (tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, fecha,
       tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total)
     select $1::uuid, $2::uuid, $3::char(6), $4::uuid, 'sire', '01-F001-' || lpad(g::text, 6, '0'), '01', 'F001', lpad(g::text, 6, '0'), ($3::text || '15')::date,
       '6', '20000000001', case when g % 50 = 0 then 'USD' else 'PEN' end,
       case when g % 50 = 0 then 3.750 else null end,
       100.00 + (g % 97), 18.00 + (g % 17), (g % 5) * 1.00, (g % 3) * 2.00, 0, 0, 0, 0
       from generate_series(1, $5::int) g`,
    [e.tenantId, c.id, periodo, propuestaId, n],
  );
}

// ---- Oráculo de las sumas del SIRE -----------------------------------------------------------------------------------------
export interface SumasPen {
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
}

/** Sumas PEN exactas (céntimos) de las filas que cuentan: PEN y sin exclusión vigente. */
export function oraculoPen(filas: readonly FilaSembrada[]): SumasPen {
  const s = { baseGravada: 0n, igv: 0n, exonerada: 0n, inafecta: 0n };
  for (const f of filas) {
    if (f.moneda !== "PEN" || f.exclusion === "excluida") continue;
    s.baseGravada += aCentimos(f.baseGravada);
    s.igv += aCentimos(f.igv);
    s.exonerada += aCentimos(f.exonerada);
    s.inafecta += aCentimos(f.inafecta);
  }
  return {
    baseGravada: deCentimos(s.baseGravada),
    igv: deCentimos(s.igv),
    exonerada: deCentimos(s.exonerada),
    inafecta: deCentimos(s.inafecta),
  };
}

export interface FilaUsdEsperada {
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  tipoCambio: string | null;
}

/** Filas USD que cuentan (sin exclusión vigente), con su tipo de cambio, en un orden canónico para comparar. */
export function oraculoUsd(filas: readonly FilaSembrada[]): FilaUsdEsperada[] {
  return filas
    .filter((f) => f.moneda === "USD" && f.exclusion !== "excluida")
    .map((f) => ({
      baseGravada: f.baseGravada,
      igv: f.igv,
      exonerada: f.exonerada,
      inafecta: f.inafecta,
      tipoCambio: f.tipoCambio,
    }))
    .sort(porClaveUsd);
}

export const claveUsd = (f: FilaUsdEsperada): string =>
  [f.baseGravada, f.igv, f.exonerada, f.inafecta, f.tipoCambio ?? "null"].join(
    "|",
  );
export const porClaveUsd = (a: FilaUsdEsperada, b: FilaUsdEsperada): number =>
  claveUsd(a) < claveUsd(b) ? -1 : claveUsd(a) > claveUsd(b) ? 1 : 0;

// ---- Arnés común de las suites ---------------------------------------------------------------------------------------------
export interface Arnes {
  admin: Pool;
  backend: ContappDb;
  worker: ContappDb;
  /** Estudio de las pruebas y otro estudio (nunca debe verse desde A). */
  A: Estudio;
  B: Estudio;
  /** Backend con el dueño como usuario. */
  comoDueno<T>(fn: (tx: Tx) => Promise<T>, e?: Estudio): Promise<T>;
  /** Backend sin usuario en el contexto. */
  sinUsuario<T>(fn: (tx: Tx) => Promise<T>, e?: Estudio): Promise<T>;
  /** Worker (sin usuario). */
  comoWorker<T>(fn: (tx: Tx) => Promise<T>, e?: Estudio): Promise<T>;
  cerrar(): Promise<void>;
}

export async function abrirArnes(): Promise<Arnes> {
  exigirEntorno();
  const admin = abrirAdmin();
  const backend = abrirDb("contapp_backend");
  const worker = abrirDb("contapp_worker");
  const limpiezas: Array<() => Promise<void>> = [];
  try {
    const A = await sembrarEstudio(admin);
    limpiezas.push(A.limpiar);
    const B = await sembrarEstudio(admin);
    limpiezas.push(B.limpiar);
    return {
      admin,
      backend,
      worker,
      A,
      B,
      comoDueno: (fn, e = A) =>
        backend.withTenant({ tenantId: e.tenantId, userId: e.dueno.id }, fn),
      sinUsuario: (fn, e = A) =>
        backend.withTenant({ tenantId: e.tenantId }, fn),
      comoWorker: (fn, e = A) =>
        worker.withTenant({ tenantId: e.tenantId }, fn),
      cerrar: async () => {
        for (const l of limpiezas) await l().catch(() => undefined);
        await backend.close();
        await worker.close();
        await admin.end();
      },
    };
  } catch (e) {
    for (const l of limpiezas) await l().catch(() => undefined);
    await backend.close();
    await worker.close();
    await admin.end();
    throw e;
  }
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Espera un ProrrataRepoError; si el repo lanza otra cosa (p. ej. «no implementado»), la deja subir tal cual. */
export async function falla(p: Promise<unknown>): Promise<ProrrataRepoError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ProrrataRepoError)) throw e;
    return e;
  }
  throw new Error("se esperaba un ProrrataRepoError y no falló");
}

/**
 * Traducción de errores con una `tx` falsa: de todo error de `pg` solo queda el SQLSTATE, nunca el mensaje, el detalle, la tabla,
 * la columna ni el canario (RUC, montos o motivo); un error sin SQLSTATE sale como «desconocido».
 */
export function pruebasTraduccion(
  llamadas: Array<[string, (tx: never) => Promise<unknown>]>,
): void {
  const CANARIO = "CANARIO-RUC-20100070970-MONTO-987654.32-MOTIVO";
  describe.each(llamadas)("traducción de errores: %s", (_nombre, llamar) => {
    it.each(["P0002", "55000", "CA409", "CA412", "CA413", "22023", "42501"])(
      "conserva solo el SQLSTATE %s",
      async (codigo) => {
        const { tx } = txFalso(errorPg(codigo, CANARIO));
        const e = await llamar(tx).then(
          () => null,
          (x: unknown) => x,
        );
        if (!(e instanceof ProrrataRepoError)) throw e ?? new Error("no falló");
        expect(e.codigo).toBe(codigo);
        expect(e.message).not.toContain(CANARIO);
        expect(
          JSON.stringify({ ...e, message: e.message, stack: undefined }),
        ).not.toContain(CANARIO);
        expect(
          Object.keys(e).filter((k) =>
            [
              "detail",
              "where",
              "constraint",
              "table",
              "column",
              "cause",
            ].includes(k),
          ),
        ).toEqual([]);
      },
    );

    it("un error sin SQLSTATE sale como «desconocido», sin filtrar el mensaje", async () => {
      const { tx } = txFalso(new Error(`fallo con ${CANARIO}`));
      const e = await llamar(tx).then(
        () => null,
        (x: unknown) => x,
      );
      if (!(e instanceof ProrrataRepoError)) throw e ?? new Error("no falló");
      expect(e.codigo).toBe("desconocido");
      expect(e.message).not.toContain(CANARIO);
    });
  });
}

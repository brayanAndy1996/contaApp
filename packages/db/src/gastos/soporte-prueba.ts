// Soporte de las pruebas de BD de la spec 027 (T4, rojo): estudios, clientes, compras con versiones, periodos, XML, diccionario
// propio, umbral, categorías y caché de CIIU sembrados con el superusuario (MIGRATIONS_DATABASE_URL: pasa por FK y CHECK, no por
// RLS ni grants), un arnés de contexto (backend con usuario, sin usuario y worker) y un espía de consultas.
// No es una prueba (sin sufijo .spec) ni código de producción (queda fuera de `tsconfig.build.json`). Necesita DATABASE_URL (rol de
// la app) y MIGRATIONS_DATABASE_URL; si faltan, la suite FALLA. Datos sintéticos: ningún RUC ni razón social reales.
//
// LIMPIEZA (lección de 026: si un estudio de prueba deja filas en una tabla con FK a `tenant`, `planes.spec.ts` falla en CI): con
// `session_replication_role = replica` (sin disparadores de inmutabilidad ni FK) se borra, para el estudio, TODA tabla pública con
// columna `tenant_id` (descubierta en `information_schema`, de modo que cubre las cinco tablas nuevas de 0069: `gnd_palabra_estudio`,
// `gnd_global_desactivada`, `gnd_config`, `gnd_cliente_categorias` y `gnd_ciiu`, y cualquiera que se agregue después) y luego el
// usuario y el estudio. Si el estudio sigue existiendo al final, `limpiar` lanza (no se traga el error): una fuga se ve.
//
// Las tablas `gnd_*` son las de plan.md (0069); esta siembra las escribe directo (superusuario) solo para armar el estado previo de
// la prueba: lo que se prueba entra por el repositorio.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDb, type ContappDb, type RolApp } from "../client";
import type { Tx } from "../with-tenant";
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { GastosRepoError } from "./index";

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Falla (no salta) si faltan las URLs de la BD. */
export function exigirEntorno(): void {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para las pruebas de BD de gastos no deducibles: ${faltan.join(", ")}`,
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

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Las seis categorías cerradas de 011 (`CATEGORIAS_GND`). */
export const CATEGORIAS = [
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const;

// ---- Periodos (AAAAMM) -----------------------------------------------------------------------------------------------------
/** `periodo` menos `k` meses (k puede ser negativo). */
export function restar(periodo: string, k: number): string {
  const total =
    Number(periodo.slice(0, 4)) * 12 + (Number(periodo.slice(4)) - 1) - k;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
}

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

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

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
      await c.query("SET session_replication_role = replica");
      const tablas = await c.query(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
          order by c.table_name`,
      );
      for (const { table_name: tabla } of tablas.rows as Array<{
        table_name: string;
      }>) {
        if (!IDENTIFICADOR.test(tabla)) continue;
        // eslint-disable-next-line sql-crudo/sin-sql-crudo -- identificador de information_schema validado con IDENTIFICADOR; solo en la limpieza de la prueba
        await c.query(`delete from public."${tabla}" where tenant_id = $1`, [
          tenantId,
        ]);
      }
      await c.query("delete from usuario where id = $1", [dueno.id]);
      await c.query("delete from tenant where id = $1", [tenantId]);
      const quedan = await c.query("select 1 from tenant where id = $1", [
        tenantId,
      ]);
      if (quedan.rowCount !== 0)
        throw new Error("la limpieza no pudo borrar el estudio de la prueba");
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
    await limpiar().catch(() => undefined);
    throw e;
  }
}

// ---- Compras, versiones, periodos y XML ------------------------------------------------------------------------------------
export interface ProveedorSembrado {
  tipo: string;
  numero: string;
}

/** Proveedor por omisión de las pruebas (RUC sintético). */
export const PROVEEDOR: ProveedorSembrado = {
  tipo: "6",
  numero: "20100070970",
};

export interface OpcionesCompra {
  periodo: string;
  proveedor?: ProveedorSembrado;
  /** `excluida` de cada versión 1..k; por omisión una sola versión no excluida. */
  versiones?: boolean[];
  /** Puntero a la versión vigente (1..k); por omisión la última (deshacer lo puede mover hacia atrás). */
  vigente?: number;
  descartada?: boolean;
  serie?: string;
  numero?: string;
}

export interface CompraSembrada {
  id: string;
  periodo: string;
  serie: string;
  numero: string;
  proveedor: ProveedorSembrado;
}

let consecutivo = 0;

const SQL_COMPRA = `insert into compra (id, tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, origen, version_vigente, descartada_en)
  values ($1, $2, $3, $4::char(6), null, $5, '01', $6, $7, $8, $9, 'PROVEEDOR SINTETICO SAC',
    (substr($4::text, 1, 4) || '-' || substr($4::text, 5, 2) || '-15')::date, 'PEN', 'agregada', $10,
    case when $11::boolean then now() else null end)`;

const SQL_VERSION = `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado,
    isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion)
  values ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $4, $5, false, $6)`;

/** Compra agregada a mano con sus versiones (superusuario: sin RLS ni grants; los disparadores sí). */
export async function sembrarCompra(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  o: OpcionesCompra,
): Promise<CompraSembrada> {
  const proveedor = o.proveedor ?? PROVEEDOR;
  const versiones = o.versiones ?? [false];
  const vigente = o.vigente ?? versiones.length;
  const n = ++consecutivo;
  const serie = o.serie ?? "F001";
  const numero = o.numero ?? String(1000 + n);
  const id = randomUUID();
  const cx = await admin.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(SQL_COMPRA, [
      id,
      e.tenantId,
      c.id,
      o.periodo,
      `01|${serie}|${numero}|${proveedor.tipo}|${proveedor.numero}|${randomUUID()}`,
      serie,
      numero,
      proveedor.tipo,
      proveedor.numero,
      vigente,
      o.descartada === true,
    ]);
    for (const [i, excluida] of versiones.entries())
      await cx.query(SQL_VERSION, [
        e.tenantId,
        id,
        i + 1,
        excluida,
        excluida ? "Prueba de exclusion" : null,
        i === 0 ? "agregada" : excluida ? "excluir" : "restaurar",
      ]);
    await cx.query("COMMIT");
  } catch (x) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw x;
  } finally {
    cx.release();
  }
  return { id, periodo: o.periodo, serie, numero, proveedor };
}

/** Estado del periodo de compras (sin fila equivale a `abierto`). */
export async function fijarEstadoPeriodo(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  periodo: string,
  estado: "abierto" | "revisado" | "generado",
): Promise<void> {
  await admin.query(
    `insert into compra_periodo (tenant_id, cliente_id, periodo, estado) values ($1, $2, $3, $4)
     on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado`,
    [e.tenantId, c.id, periodo, estado],
  );
}

/** XML `n` del comprobante de la compra con las glosas dadas (el `detalle` mínimo que lee el repositorio: `items[].descripcion`). */
export async function sembrarXml(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  compra: CompraSembrada,
  glosas: string[],
  o: { n?: number; origen?: "simulado" | "real" | "subido" } = {},
): Promise<void> {
  const origen = o.origen ?? "simulado";
  const detalle = {
    raiz: "Invoice",
    fecha: "2026-10-07",
    moneda: "PEN",
    monedaUnica: true,
    identidad: {
      tipo: "01",
      serie: compra.serie,
      numero: compra.numero,
      emisor: {
        ruc: compra.proveedor.numero,
        razonSocial: "PROVEEDOR SINTETICO SAC",
      },
      receptor: { tipoDoc: "6", numero: c.ruc },
    },
    items: glosas.map((descripcion) => ({
      descripcion,
      cantidad: "1",
      unidad: "NIU",
      precioUnitario: "10.00",
      valor: "10.00",
      afectacion: "gravado",
      igv: "1.80",
      isc: "0.00",
      icbper: "0.00",
    })),
  };
  await admin.query(
    `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle, subido_por)
     values ($1, $2, $3, '01', $4, $5, $6, $7, $8, $9, 100, $10::jsonb, $11)`,
    [
      e.tenantId,
      c.id,
      compra.proveedor.numero,
      compra.serie,
      compra.numero,
      o.n ?? 1,
      origen,
      `xml/${e.tenantId}/${c.id}/${randomUUID()}.xml`,
      randomBytes(32),
      JSON.stringify(detalle),
      origen === "subido" ? e.dueno.id : null,
    ],
  );
}

// ---- Diccionario, umbral, categorías y CIIU (estado previo de la prueba) ---------------------------------------------------
/** Palabra válida y única por llamada (`^[a-z0-9]{3,40}$`). */
export const palabraUnica = (): string => `t4${randomBytes(5).toString("hex")}`;

export async function sembrarPropia(
  admin: Pool,
  e: Estudio,
  o: {
    palabra?: string;
    categoria?: string;
    excepciones?: string[];
    activa?: boolean;
    version?: number;
  } = {},
): Promise<{ id: string; palabra: string }> {
  const palabra = o.palabra ?? palabraUnica();
  const r = await admin.query(
    `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
     values ($1, $2, $3, $4::text[], 'manual', $5, $6, $7) returning id`,
    [
      e.tenantId,
      palabra,
      o.categoria ?? "juguetes",
      o.excepciones ?? [],
      o.activa ?? true,
      o.version ?? 1,
      e.dueno.id,
    ],
  );
  return { id: r.rows[0].id as string, palabra };
}

/** `n` propias activas en una sola sentencia (para el límite de 2.000). */
export async function sembrarPropiasEnBloque(
  admin: Pool,
  e: Estudio,
  n: number,
): Promise<void> {
  await admin.query(
    `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
     select $1, 'lim' || g, 'juguetes', '{}'::text[], 'manual', true, 1, $2 from generate_series(1, $3::int) g`,
    [e.tenantId, e.dueno.id, n],
  );
}

/** Id de una palabra global de la semilla. */
export async function idGlobal(admin: Pool, palabra: string): Promise<string> {
  const r = await admin.query(
    "select id from gnd_palabra_global where palabra = $1",
    [palabra],
  );
  if (r.rows[0] === undefined)
    throw new Error(`la semilla no trae la palabra global «${palabra}»`);
  return r.rows[0].id as string;
}

export async function desactivarGlobalDelEstudio(
  admin: Pool,
  e: Estudio,
  palabraGlobalId: string,
): Promise<void> {
  await admin.query(
    `insert into gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id) values ($1, $2, $3)`,
    [e.tenantId, palabraGlobalId, e.dueno.id],
  );
}

export async function fijarConfig(
  admin: Pool,
  e: Estudio,
  umbral: number,
  version = 1,
): Promise<void> {
  await admin.query(
    `insert into gnd_config (tenant_id, umbral, version) values ($1, $2, $3)
     on conflict (tenant_id) do update set umbral = excluded.umbral, version = excluded.version`,
    [e.tenantId, umbral, version],
  );
}

export async function fijarCategoriasDelCliente(
  admin: Pool,
  e: Estudio,
  c: ClienteSembrado,
  permitidas: string[],
  quitadas: string[],
  version = 1,
): Promise<void> {
  await admin.query(
    `insert into gnd_cliente_categorias (tenant_id, cliente_id, permitidas, quitadas, version)
     values ($1, $2, $3::text[], $4::text[], $5)
     on conflict (tenant_id, cliente_id) do update set permitidas = excluded.permitidas, quitadas = excluded.quitadas,
       version = excluded.version`,
    [e.tenantId, c.id, permitidas, quitadas, version],
  );
}

/** Fila de la caché de CIIU con `consultado_en` a `antiguedad` (intervalo de PostgreSQL, p. ej. «29 days») del reloj de la BD. */
export async function sembrarCiiu(
  admin: Pool,
  e: Estudio,
  ruc: string,
  ciiu: string | null,
  antiguedad = "0 seconds",
): Promise<void> {
  await admin.query(
    `insert into gnd_ciiu (tenant_id, ruc, ciiu, consultado_en) values ($1, $2, $3, clock_timestamp() - $4::interval)
     on conflict (tenant_id, ruc) do update set ciiu = excluded.ciiu, consultado_en = excluded.consultado_en`,
    [e.tenantId, ruc, ciiu, antiguedad],
  );
}

// ---- Arnés común de las suites ---------------------------------------------------------------------------------------------
export interface Arnes {
  admin: Pool;
  backend: ContappDb;
  worker: ContappDb;
  /** Estudio de las pruebas y otro estudio (nunca debe verse desde A). */
  A: Estudio;
  B: Estudio;
  /** Estudio nuevo, limpio al cerrar el arnés (para las pruebas que cambian el estado de todo el estudio). */
  nuevoEstudio(): Promise<Estudio>;
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
  const cerrarTodo = async (): Promise<unknown[]> => {
    const errores: unknown[] = [];
    for (const l of limpiezas) await l().catch((x: unknown) => errores.push(x));
    await backend.close();
    await worker.close();
    await admin.end();
    return errores;
  };
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
      nuevoEstudio: async () => {
        const e = await sembrarEstudio(admin);
        limpiezas.push(e.limpiar);
        return e;
      },
      comoDueno: (fn, e = A) =>
        backend.withTenant({ tenantId: e.tenantId, userId: e.dueno.id }, fn),
      sinUsuario: (fn, e = A) =>
        backend.withTenant({ tenantId: e.tenantId }, fn),
      comoWorker: (fn, e = A) =>
        worker.withTenant({ tenantId: e.tenantId }, fn),
      cerrar: async () => {
        const errores = await cerrarTodo();
        if (errores.length > 0) throw errores[0];
      },
    };
  } catch (x) {
    await cerrarTodo();
    throw x;
  }
}

/** Cuenta las consultas que pasan por `tx` (la `tx` real sigue ejecutándolas). */
export function espiar(tx: Tx): { tx: Tx; consultas: () => number } {
  let n = 0;
  const original = tx.query.bind(tx);
  const envuelta = new Proxy(tx, {
    get(destino, prop, receptor) {
      if (prop === "query")
        return (...args: unknown[]) => {
          n++;
          return (original as (...a: unknown[]) => unknown)(...args);
        };
      return Reflect.get(destino, prop, receptor) as unknown;
    },
  });
  return { tx: envuelta, consultas: () => n };
}

/** Espera un GastosRepoError; si el repo lanza otra cosa (p. ej. «no implementado»), la deja subir tal cual. */
export async function falla(p: Promise<unknown>): Promise<GastosRepoError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof GastosRepoError)) throw e;
    return e;
  }
  throw new Error("se esperaba un GastosRepoError y no falló");
}

/**
 * Traducción de errores con una `tx` falsa: de todo error de `pg` solo queda el SQLSTATE, nunca el mensaje, el detalle, la tabla,
 * la columna ni el canario (palabra, RUC o glosa del estudio); un error sin SQLSTATE sale como «desconocido».
 */
export function pruebasTraduccion(
  llamadas: Array<[string, (tx: never) => Promise<unknown>]>,
): void {
  const CANARIO = "CANARIO-GLOSA-ZAPATILLA-RUC-20100070970-PALABRA";
  describe.each(llamadas)("traducción de errores: %s", (_nombre, llamar) => {
    it.each([
      "P0002",
      "55000",
      "CA409",
      "CA420",
      "CA421",
      "CA422",
      "CA423",
      "22023",
      "42501",
    ])("conserva solo el SQLSTATE %s", async (codigo) => {
      const { tx } = txFalso(errorPg(codigo, CANARIO));
      const e = await llamar(tx).then(
        () => null,
        (x: unknown) => x,
      );
      if (!(e instanceof GastosRepoError)) throw e ?? new Error("no falló");
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
    });

    it("un error sin SQLSTATE sale como «desconocido», sin filtrar el mensaje", async () => {
      const { tx } = txFalso(new Error(`fallo con ${CANARIO}`));
      const e = await llamar(tx).then(
        () => null,
        (x: unknown) => x,
      );
      if (!(e instanceof GastosRepoError)) throw e ?? new Error("no falló");
      expect(e.codigo).toBe("desconocido");
      expect(e.message).not.toContain(CANARIO);
    });
  });
}

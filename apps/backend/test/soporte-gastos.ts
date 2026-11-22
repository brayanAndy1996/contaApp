/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 027 (T6, rojo): gastos no deducibles (R-GP completo). Encima de `soporte-reglas.ts` (que trae
// `http` con PUT, la auditoría, las compras del fixture y el XML). Siembra por SQL con la conexión de migraciones (superusuario: no pasa por
// RLS ni por grants, sí por CHECK, FK y triggers) el diccionario del estudio, el umbral, el ajuste de categorías por cliente y la caché de
// CIIU; lee de vuelta lo guardado y crea un super-admin real. No es una prueba ni código de producción. Datos sintéticos (RUC `207…`).
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 027, «Contratos: BD», 0069; el mismo de `tests/aislamiento/gnd-soporte.ts`, T3):
//  - `gnd_palabra_global(id, palabra text único ^[a-z0-9]{3,40}$, categoria, excepciones text[], activa, version >= 1, actualizada_en)` y
//    `gnd_global_historial(id, palabra_global_id, accion agregada|editada, antes jsonb, despues jsonb, usuario_id, ocurrida_en)` (solo inserción).
//  - `gnd_palabra_estudio(id, tenant_id, palabra, categoria, excepciones, origen manual|aprendida, activa, version >= 1, creado_por,
//    compra_origen_id NULL (NOT NULL si aprendida), creada_en, actualizada_en)`, única `(tenant_id, palabra)`.
//  - `gnd_global_desactivada(tenant_id, palabra_global_id, usuario_id, desactivada_en)`; `gnd_config(tenant_id, umbral 1..20, version >= 1)`
//    (sin fila = umbral 3 y versión 0); `gnd_cliente_categorias(tenant_id, cliente_id, permitidas text[], quitadas text[], version >= 1)`;
//    `gnd_ciiu(tenant_id, ruc char(11), ciiu char(4) NULL, consultado_en)`.
// Hasta que T10 cree las tablas, sembrar da 42P01/42703: la siembra devuelve valores inventados y la prueba falla en la RUTA (404), no aquí
// (el rojo dice «ruta ausente», no «falta una migración»); con las tablas creadas cualquier error de la siembra se propaga.
import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplication, Type } from "@nestjs/common";
import { DiscoveryService, ModulesContainer, Reflector } from "@nestjs/core";
import { createDb } from "@contapp/db";
import { META_PERMISO } from "../src/modules/acceso/guards/decoradores.js";
import { rutasDe } from "./auditoria-rutas.js";
import {
  abrirBancoReglas,
  base,
  cumple,
  inexistente,
  montos,
  PERIODO,
  type Actor,
  type BancoReglas,
  type Estudio,
} from "./soporte-reglas.js";
import type { Resp, UsuarioPrueba } from "./soporte.js";
import { bytes, cambiar, pedirXml, xmlDe, type NombreXml } from "./soporte-xml.js";

export { base, cumple, inexistente, montos, PERIODO };
export type { Actor, BancoReglas, Estudio, Resp };

export interface SuperAdmin extends UsuarioPrueba {
  cookie: string;
  csrf: string;
}

// --- Contrato fijo ----------------------------------------------------------------------------------------------------------------
export const CATEGORIAS = ["calzado-ropa", "juguetes", "entretenimiento", "alimentos-personales", "cuidado-personal", "utiles-escolares"] as const;
export const LIMITE_PROPIAS = 2000;
export const UMBRAL_POR_DEFECTO = 3;
export const TABLAS_ESTUDIO_027 = ["gnd_palabra_estudio", "gnd_global_desactivada", "gnd_config", "gnd_cliente_categorias", "gnd_ciiu"] as const;
export const ACCIONES_027 = [
  "gnd.palabra_agregada",
  "gnd.palabra_desactivada",
  "gnd.palabra_reactivada",
  "gnd.palabra_aprendida",
  "gnd.global_desactivada",
  "gnd.global_reactivada",
  "gnd.umbral_cambiado",
  "gnd.categorias_cliente",
] as const;

export const NO_ENCONTRADO = { codigo: "no_encontrado" };
export const PERMISO_DENEGADO = { codigo: "permiso_denegado" };
export const SOLICITUD_INVALIDA = { codigo: "solicitud_invalida" };
export const TIPO_REEVALUAR = "compras.reevaluar";

// --- Rutas ------------------------------------------------------------------------------------------------------------------------
export const RUTA_GASTOS = "/estudio/reglas-motor/gastos";
export const rutaUmbral = (): string => `${RUTA_GASTOS}/umbral`;
export const rutaPalabras = (): string => `${RUTA_GASTOS}/palabras`;
export const rutaPalabra = (id: string): string => `${RUTA_GASTOS}/palabras/${id}`;
export const rutaGlobal = (id: string): string => `${RUTA_GASTOS}/globales/${id}`;
export const rutaCategorias = (clienteId: string): string => `/clientes/${clienteId}/gastos/categorias`;
export const rutaAprender = (clienteId: string, periodo: string, compraId: string): string =>
  `/clientes/${clienteId}/periodos/${periodo}/gastos/aprender/${compraId}`;
export const rutaReevaluar = (clienteId: string, periodo: string): string => `/clientes/${clienteId}/periodos/${periodo}/gastos/reevaluar`;
export const RUTA_PLATAFORMA = "/plataforma/diccionario";
export const rutaPlataformaPalabra = (id: string): string => `${RUTA_PLATAFORMA}/${id}`;
export const rutaPlataformaHistorial = (consulta = ""): string => `${RUTA_PLATAFORMA}/historial${consulta}`;

/** Las 14 rutas de 027 y el permiso que cada una declara (`@Permiso`; «-» = solo super-admin), ordenadas. */
export const RUTAS_027 = [
  "GET /estudio/reglas-motor/gastos reglas.ver",
  "PUT /estudio/reglas-motor/gastos/umbral reglas.gestionar",
  "POST /estudio/reglas-motor/gastos/palabras reglas.gestionar",
  "PUT /estudio/reglas-motor/gastos/palabras/:id reglas.gestionar",
  "PUT /estudio/reglas-motor/gastos/globales/:id reglas.gestionar",
  "GET /clientes/:clienteId/gastos/categorias reglas.ver",
  "PUT /clientes/:clienteId/gastos/categorias reglas.gestionar",
  "GET /clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId reglas.gestionar",
  "POST /clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId reglas.gestionar",
  "POST /clientes/:clienteId/periodos/:periodo/gastos/reevaluar sire.clasificar",
  "GET /plataforma/diccionario -",
  "POST /plataforma/diccionario -",
  "PUT /plataforma/diccionario/:id -",
  "GET /plataforma/diccionario/historial -",
].sort();

export interface RutaConPermiso {
  metodo: string;
  ruta: string;
  permiso: string | null;
}
/** Las rutas de los controladores registrados que son de 027 (gastos del estudio, del cliente y del diccionario de plataforma). */
export function rutasDeGastos(app: INestApplication): RutaConPermiso[] {
  const reflector = app.get(Reflector);
  const clases = new DiscoveryService(app.get(ModulesContainer))
    .getControllers()
    .map((w) => w.metatype)
    .filter((m): m is Type => typeof m === "function");
  const salida: RutaConPermiso[] = [];
  for (const clase of clases) {
    for (const r of rutasDe([clase], reflector)) {
      if (!/\/gastos(\/|$)/.test(r.ruta) && !/^\/plataforma\/diccionario(\/|$)/.test(r.ruta)) continue;
      const proto = clase.prototype as Record<string, unknown>;
      const permiso = reflector.getAllAndOverride<unknown>(META_PERMISO, [proto[r.handler] as (...a: unknown[]) => unknown, clase]);
      salida.push({ metodo: r.metodo, ruta: r.ruta, permiso: typeof permiso === "string" ? permiso : null });
    }
  }
  return salida;
}

// --- Canarios (CA-11, CA-14) ------------------------------------------------------------------------------------------------------
/** Texto de la glosa que nunca debe salir en errores, auditoría ni `resultado` de trabajo (salvo la palabra del diccionario). */
export const CANARIO_GLOSA = "GLOSA-CANARIO-027-Zq";
export const CANARIO_RUC = "20700000027";

// --- Siembra ----------------------------------------------------------------------------------------------------------------------
export interface OpcionesPropia {
  palabra: string;
  categoria?: string;
  excepciones?: string[];
  origen?: "manual" | "aprendida";
  activa?: boolean;
  version?: number;
  creadoPor: string;
  /** Obligatorio si `origen = "aprendida"`. */
  compraOrigenId?: string | null;
}

export interface BancoGastos extends BancoReglas {
  /** Una palabra propia sembrada; devuelve su id. */
  sembrarPropia(tenantId: string, o: OpcionesPropia): Promise<string>;
  /** `n` palabras propias activas `zzp00001…` en una sola sentencia (para el límite de 2.000). */
  sembrarPropiasMasivas(tenantId: string, n: number, creadoPor: string): Promise<void>;
  sembrarConfig(tenantId: string, umbral: number, version?: number): Promise<void>;
  sembrarCategorias(tenantId: string, clienteId: string, permitidas: readonly string[], quitadas: readonly string[], version?: number): Promise<void>;
  sembrarCiiu(tenantId: string, ruc: string, ciiu: string | null, consultadoEn?: string): Promise<void>;
  /** El estudio desactiva una global (por su texto normalizado). */
  desactivarGlobalBd(tenantId: string, palabra: string, usuarioId: string): Promise<void>;
  /** Id de una palabra global (la semilla o una creada por la prueba); inventado si aún no existe la tabla. */
  idGlobal(palabra: string): Promise<string>;
  /** Palabra global nueva para un estudio de la prueba (la limpieza la borra junto con su historial). */
  palabraGlobalNueva(): string;
  /** Una global sembrada por SQL (`palabraGlobalNueva` por omisión); devuelve su texto y su id. */
  sembrarGlobal(o?: { palabra?: string; categoria?: string; excepciones?: string[]; activa?: boolean }): Promise<{ palabra: string; id: string }>;
  propiasBd(tenantId: string): Promise<any[]>;
  desactivadasBd(tenantId: string): Promise<string[]>;
  configBd(tenantId: string): Promise<any[]>;
  categoriasBd(tenantId: string, clienteId?: string): Promise<any[]>;
  ciiuBd(tenantId: string): Promise<any[]>;
  globalBd(palabra: string): Promise<any | null>;
  historialGlobalBd(palabra: string): Promise<any[]>;
  /** Filas de `auditoria` del estudio con alguna de las ocho acciones de 027, de la más antigua a la más reciente. */
  auditoria027(tenantId: string): Promise<any[]>;
  /** Lo que 027 guarda de un estudio (las cinco tablas y la auditoría de 027) para comprobar que un intento rechazado no cambió nada. */
  fotoGastos(tenantId: string): Promise<unknown>;
  /** Trabajos `compras.reevaluar` del cliente, del más antiguo al más reciente. */
  trabajosReevaluar(tenantId: string, clienteId: string): Promise<any[]>;
  /** Evaluaciones de una compra: [versión, n]. */
  evaluaciones(compraId: string): Promise<{ version_n: number; n: number }[]>;
  /** Hallazgos R-GP de la ÚLTIMA evaluación de la versión vigente de la compra (`[]` si no hay). */
  hallazgosGp(compraId: string): Promise<any[]>;
  /** Super-admin con sesión viva y sin membresías. */
  superAdmin(): Promise<SuperAdmin>;
  /** Petición como `a` a una ruta de plataforma (sin estudio activo). */
  plataforma(a: { cookie: string; csrf: string }, metodo: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown): Promise<Resp>;
  archivar(clienteId: string): Promise<void>;
  nombreDe(usuarioId: string): Promise<string>;
  /** ¿Fallaron las siembras por falta de tablas (T10)? Solo informa el rojo. */
  readonly tablasAusentes: boolean;
}

export async function abrirBancoGastos(): Promise<BancoGastos> {
  const v = await abrirBancoReglas();
  const sql = v.b.sql;
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de gastos");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  const admins: string[] = [];
  const globalesCreadas: string[] = [];
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

  const propiasBd: BancoGastos["propiasBd"] = (tenantId) =>
    lectura(
      () =>
        sql(
          `select id, palabra, categoria, excepciones, origen, activa, version::int as version, creado_por, compra_origen_id
             from gnd_palabra_estudio where tenant_id = $1 order by palabra`,
          [tenantId],
        ),
      [],
    );
  const desactivadasBd: BancoGastos["desactivadasBd"] = (tenantId) =>
    lectura(
      async () =>
        (
          await sql(
            `select g.palabra from gnd_global_desactivada d join gnd_palabra_global g on g.id = d.palabra_global_id
              where d.tenant_id = $1 order by g.palabra`,
            [tenantId],
          )
        ).map((f: any) => f.palabra as string),
      [],
    );
  const configBd: BancoGastos["configBd"] = (tenantId) =>
    lectura(() => sql("select umbral::int as umbral, version::int as version from gnd_config where tenant_id = $1", [tenantId]), []);
  const categoriasBd: BancoGastos["categoriasBd"] = (tenantId, clienteId) =>
    lectura(
      () =>
        sql(
          `select cliente_id, permitidas, quitadas, version::int as version from gnd_cliente_categorias
            where tenant_id = $1 and ($2::uuid is null or cliente_id = $2) order by cliente_id`,
          [tenantId, clienteId ?? null],
        ),
      [],
    );
  const ciiuBd: BancoGastos["ciiuBd"] = (tenantId) =>
    lectura(() => sql("select ruc, ciiu from gnd_ciiu where tenant_id = $1 order by ruc", [tenantId]), []);
  const auditoria027: BancoGastos["auditoria027"] = (tenantId) =>
    sql(
      `select accion, actor_tipo, usuario_id, cliente_id, entidad, entidad_id, datos from auditoria
        where tenant_id = $1 and accion = any($2::text[]) order by ocurrida_en, id`,
      [tenantId, [...ACCIONES_027]],
    );

  const banco: BancoGastos = {
    ...v,
    get tablasAusentes() {
      return ausentes;
    },
    sembrarPropia: (tenantId, o) =>
      tolerando(
        async () => {
          const r = await sql(
            `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por, compra_origen_id)
             values ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) returning id`,
            [
              tenantId,
              o.palabra,
              o.categoria ?? "entretenimiento",
              o.excepciones ?? [],
              o.origen ?? "manual",
              o.activa ?? true,
              o.version ?? 1,
              o.creadoPor,
              o.compraOrigenId ?? null,
            ],
          );
          return r[0].id as string;
        },
        () => randomUUID(),
      ),
    sembrarPropiasMasivas: (tenantId, n, creadoPor) =>
      tolerando(
        async () => {
          await sql(
            `insert into gnd_palabra_estudio (tenant_id, palabra, categoria, excepciones, origen, activa, version, creado_por)
             select $1, 'zzp' || lpad(g::text, 5, '0'), 'juguetes', '{}', 'manual', true, 1, $3
               from generate_series(1, $2::int) g`,
            [tenantId, n, creadoPor],
          );
        },
        () => undefined,
      ),
    sembrarConfig: (tenantId, umbral, version = 1) =>
      tolerando(
        async () => {
          await sql(
            `insert into gnd_config (tenant_id, umbral, version) values ($1, $2, $3)
             on conflict (tenant_id) do update set umbral = excluded.umbral, version = excluded.version`,
            [tenantId, umbral, version],
          );
        },
        () => undefined,
      ),
    sembrarCategorias: (tenantId, clienteId, permitidas, quitadas, version = 1) =>
      tolerando(
        async () => {
          await sql(
            `insert into gnd_cliente_categorias (tenant_id, cliente_id, permitidas, quitadas, version) values ($1, $2, $3::text[], $4::text[], $5)
             on conflict (tenant_id, cliente_id) do update set permitidas = excluded.permitidas, quitadas = excluded.quitadas, version = excluded.version`,
            [tenantId, clienteId, [...permitidas], [...quitadas], version],
          );
        },
        () => undefined,
      ),
    sembrarCiiu: (tenantId, ruc, ciiu, consultadoEn) =>
      tolerando(
        async () => {
          await sql(
            `insert into gnd_ciiu (tenant_id, ruc, ciiu, consultado_en) values ($1, $2, $3, coalesce($4::timestamptz, clock_timestamp()))
             on conflict (tenant_id, ruc) do update set ciiu = excluded.ciiu, consultado_en = excluded.consultado_en`,
            [tenantId, ruc, ciiu, consultadoEn ?? null],
          );
        },
        () => undefined,
      ),
    desactivarGlobalBd: (tenantId, palabra, usuarioId) =>
      tolerando(
        async () => {
          await sql(
            `insert into gnd_global_desactivada (tenant_id, palabra_global_id, usuario_id)
             select $1, id, $3 from gnd_palabra_global where palabra = $2`,
            [tenantId, palabra, usuarioId],
          );
        },
        () => undefined,
      ),
    idGlobal: (palabra) =>
      tolerando(
        async () => {
          const r = await sql("select id from gnd_palabra_global where palabra = $1", [palabra]);
          if (r.length === 0) throw new Error(`la palabra global ${palabra} no existe (¿semilla de 0069?)`);
          return r[0].id as string;
        },
        () => randomUUID(),
      ),
    palabraGlobalNueva: () => {
      const p = `zq${randomBytes(4).toString("hex")}`;
      globalesCreadas.push(p);
      return p;
    },
    sembrarGlobal: async (o = {}) => {
      const palabra = o.palabra ?? banco.palabraGlobalNueva();
      const id = await tolerando(
        async () => {
          const r = await sql(
            `insert into gnd_palabra_global (palabra, categoria, excepciones, activa, version) values ($1, $2, $3::text[], $4, 1) returning id`,
            [palabra, o.categoria ?? "entretenimiento", o.excepciones ?? [], o.activa ?? true],
          );
          return r[0].id as string;
        },
        () => randomUUID(),
      );
      return { palabra, id };
    },
    propiasBd,
    desactivadasBd,
    configBd,
    categoriasBd,
    ciiuBd,
    globalBd: (palabra) =>
      lectura(
        async () => {
          const r = await sql(
            `select id, palabra, categoria, excepciones, activa, version::int as version from gnd_palabra_global where palabra = $1`,
            [palabra],
          );
          return (r[0] as any) ?? null;
        },
        null,
      ),
    historialGlobalBd: (palabra) =>
      lectura(
        () =>
          sql(
            `select h.accion, h.antes, h.despues, h.usuario_id from gnd_global_historial h join gnd_palabra_global g on g.id = h.palabra_global_id
              where g.palabra = $1 order by h.ocurrida_en, h.id`,
            [palabra],
          ),
        [],
      ),
    auditoria027,
    fotoGastos: async (tenantId) => ({
      propias: await propiasBd(tenantId),
      desactivadas: await desactivadasBd(tenantId),
      config: await configBd(tenantId),
      categorias: await categoriasBd(tenantId),
      ciiu: await ciiuBd(tenantId),
      auditoria: (await auditoria027(tenantId)).length,
    }),
    trabajosReevaluar: async (tenantId, clienteId) => (await v.b.trabajos(tenantId, TIPO_REEVALUAR)).filter((t: any) => t.cliente_id === clienteId),
    evaluaciones: (compraId) =>
      sql("select version_n::int as version_n, n::int as n from compra_evaluacion where compra_id = $1 order by version_n, n", [compraId]),
    hallazgosGp: async (compraId) => {
      const r = await sql(
        `select h.sugerencia, h.requiere_confirmacion, h.version_n::int as version_n, h.evaluacion_n::int as evaluacion_n
           from compra_hallazgo h join compra c on c.id = h.compra_id and c.version_vigente = h.version_n
          where h.compra_id = $1 and h.regla = 'R-GP'
            and h.evaluacion_n = (select max(e.n) from compra_evaluacion e where e.compra_id = h.compra_id and e.version_n = h.version_n)`,
        [compraId],
      );
      return r as any[];
    },
    superAdmin: async () => {
      const h = v.b.c.p.b.h;
      const u = await h.crearUsuario({ estudios: [] });
      await sql("insert into admin_plataforma (usuario_id) values ($1)", [u.id]);
      admins.push(u.id);
      const s = await h.entrar(u);
      return { ...u, cookie: s.cookie, csrf: s.csrf };
    },
    plataforma: (a, metodo, ruta, cuerpo) => v.b.c.p.como(a, metodo, ruta, cuerpo),
    archivar: async (clienteId) => {
      await sql("update cliente set archivado_at = now() where id = $1", [clienteId]);
    },
    nombreDe: async (usuarioId) => (await sql("select nombre from usuario where id = $1", [usuarioId]))[0].nombre as string,
    cerrar: async () => {
      // Lo del super-admin y las globales de la prueba: el historial es de solo inserción (se borra con `replica`) y apunta a usuario y palabra.
      if (admins.length > 0 || globalesCreadas.length > 0) {
        const c = await admin.pool.connect();
        try {
          await c.query("SET session_replication_role = replica");
          await c
            .query(
              `delete from gnd_global_historial where usuario_id = any($1::uuid[])
                 or palabra_global_id in (select id from gnd_palabra_global where palabra = any($2::text[]))`,
              [admins, globalesCreadas],
            )
            .catch(() => undefined);
          await c.query("delete from gnd_palabra_global where palabra = any($1::text[])", [globalesCreadas]).catch(() => undefined);
          await c.query("delete from admin_plataforma where usuario_id = any($1::uuid[])", [admins]).catch(() => undefined);
        } finally {
          c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
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

// --- Compras con XML ---------------------------------------------------------------------------------------------------------------
export interface OpcionesCompraXml {
  /** XML del fixture que se sube (por omisión la zapatilla F001-5070). */
  xml?: NombreXml;
  /** Reemplazos de texto del XML (la glosa del ítem, por ejemplo); cada uno debe cambiar algo. */
  cambios?: ReadonlyArray<readonly [string, string]>;
  /** Clase CIIU del cliente y del proveedor que el worker dejó en la caché del estudio. */
  ciiuCliente?: string | null;
  ciiuProveedor?: string | null;
  /** El proveedor del XML ya tiene historial (una compra de 202609 sembrada; sin R-NEW ni S5). Por omisión sí. */
  conocidos?: boolean;
  /** Ajuste de categorías del cliente guardado ANTES de subir el XML (versión 1). */
  categoriasCliente?: { permitidas: readonly string[]; quitadas: readonly string[] };
  /** No sube el XML (la compra queda sin XML). */
  sinXml?: boolean;
  /** San Juan (R-ISC aceptada) y la mixta (R-MIX aceptada) ya corregidas: el previo de 012 queda apto. */
  corregido?: boolean;
}
/** Las correcciones del fixture que dejan el previo de 012 apto (las mismas de `previo.int.spec.ts`). */
export const CORRECCIONES = {
  "F001-1040": [{ montos: { biDg: "0.00", isc: "770.00" }, accion: "sugerencia" }],
  "F001-2056": [{ montos: { biDg: "8.97", noGravado: "12.51" }, accion: "sugerencia" }],
};
export const NUMERO_XML: Record<NombreXml, string> = {
  "1040": "F001-1040",
  "2056": "F001-2056",
  "3064": "F001-3064",
  "4062": "F001-4062",
  "5070": "F001-5070",
};
export const GLOSA_ZAPATILLA = "Par de zapatillas deportivas de prueba (PRUEBA)";
/** La glosa (Description del ítem) de cada XML del fixture: el texto que `cambios` reemplaza para probar otras palabras. */
export const GLOSA_XML: Record<NombreXml, string> = {
  "1040": "Producto de prueba con ISC (PRUEBA)",
  "2056": "Producto gravado de prueba (PRUEBA)",
  "3064": "Abarrotes de prueba (PRUEBA)",
  "4062": "Servicio de prueba en dólares (PRUEBA)",
  "5070": GLOSA_ZAPATILLA,
};
export const RUC_PROVEEDOR_XML: Record<NombreXml, string> = {
  "1040": "20700000011",
  "2056": "20700000045",
  "3064": "20700000053",
  "4062": "20700000061",
  "5070": "20700000070",
};

/**
 * Un cliente nuevo del estudio con el fixture de 009 y, de una de sus compras, el XML subido (con el CIIU sembrado en la caché ANTES de
 * subirlo: el backend nunca consulta el CIIU, solo lo lee). Devuelve el cliente, el id de esa compra y todos los ids del fixture.
 */
export async function compraConXml(
  v: BancoGastos,
  E: Estudio,
  actor: Actor,
  o: OpcionesCompraXml = {},
  clienteOpc: Parameters<BancoGastos["cliente"]>[1] = {},
): Promise<{ c: { id: string; ruc: string }; id: string; ids: Record<string, string> }> {
  const nombre = o.xml ?? "5070";
  const c = await v.cliente(E, { responsable: actor.id, ...clienteOpc });
  if (o.categoriasCliente) await v.sembrarCategorias(E.tenantId, c.id, o.categoriasCliente.permitidas, o.categoriasCliente.quitadas, 1);
  if (o.ciiuCliente !== undefined) await v.sembrarCiiu(E.tenantId, c.ruc, o.ciiuCliente);
  if (o.ciiuProveedor !== undefined) await v.sembrarCiiu(E.tenantId, RUC_PROVEEDOR_XML[nombre], o.ciiuProveedor);
  const ids = await v.sembrarFixture(E.tenantId, c.id, {
    usuarioId: E.titular.id,
    conocidos: o.conocidos ?? true,
    ...(o.corregido ? { versiones: CORRECCIONES } : {}),
  });
  const id = ids[NUMERO_XML[nombre]]!;
  // `conocidos`: el proveedor del XML tiene además una compra en otro periodo (historial real). `sembrarFixture` solo omite R-NEW en los
  // hallazgos iniciales; el contexto de R-GP (S5) se arma con las compras guardadas, así que sin esta fila el proveedor sería nuevo.
  if (o.conocidos ?? true) {
    await v.sembrarCompra(E.tenantId, c.id, { periodo: "202609", serie: "F009", numero: "1", doc: RUC_PROVEEDOR_XML[nombre], usuarioId: E.titular.id });
  }
  if (!o.sinXml) {
    let xml = xmlDe(nombre, c.ruc);
    for (const [de, a] of o.cambios ?? []) xml = cambiar(xml, de, a);
    const r = await pedirXml(v, actor, "POST", `${base(c.id)}/${id}/xml`, bytes(xml));
    if (r.status !== 200) throw new Error(`subir el XML de prueba respondió ${r.status}: ${r.texto}`);
  }
  return { c, id, ids };
}

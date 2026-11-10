// Spec 016 (T12a, rojo): funcion acotada con la que el worker encola `xml.obtener` sin tener INSERT en job_registro.
// Contexto: 0018 deja al worker SIN INSERT (trabajos.spec.ts, «contapp_worker: sin INSERT»); 016 necesita que el worker encole
// lotes tras la descarga (encolar-xml.ts, T12). Decision del usuario (2026-11-10): migracion 0037 con una funcion SECURITY
// DEFINER que solo puede encolar `xml.obtener`; el worker recibe EXECUTE y sigue sin INSERT directo.
// Cada archivo crea sus estudios, clientes y trabajos con el rol administrativo y los borra al final (EscenarioTrabajos). Las
// pruebas que tocan config_sistema (cola xml) restauran los valores en `finally` y en afterAll.
//
// CONTRATO QUE FIJAN ESTAS PRUEBAS (lo implementa el backend en la migracion 0037; no se edita 0018):
//
//   public.encolar_xml_obtener(p_cliente_id uuid, p_periodo text, p_compra_ids uuid[], p_creado_por uuid)
//     RETURNS TABLE (id uuid, nuevo boolean, estado text, creado_en timestamptz)
//
//   - SECURITY DEFINER, VOLATILE, SET search_path = pg_catalog, pg_temp (todo calificado). Dueño: un rol que no es superusuario
//     ni tiene BYPASSRLS ni es contapp_worker/backend/app/platform (la RLS FORCE de job_registro sigue aplicando dentro). Debe
//     tener INSERT de las columnas de 0018 que usa `encolar`, SELECT de cliente(id, ruc) y de config_sistema.
//   - EXECUTE solo para contapp_worker: se revoca de PUBLIC y no se concede a contapp_backend (el backend ya encola con
//     `encolar` y su INSERT por columnas; la funcion no le aporta nada), contapp_platform ni contapp_app.
//   - El estudio SALE SIEMPRE de app.tenant_id (withTenant): no hay argumento de estudio, tipo, cola, canal, prioridad,
//     estado ni max_intentos. Los parametros del trabajo son tipados (periodo, uuid[]): no admiten claves extra ni otro tipo.
//   - Crea UN trabajo en_cola con tipo 'xml.obtener', cola 'xml', canal 'ninguno', prioridad 'programado', intentos 0,
//     max_intentos = config_sistema(xml).reintentos + 1 (igual que `encolar`), ruc leido de cliente,
//     creado_por = p_creado_por (puede ser NULL), parametros = {"compraIds": p_compra_ids, "periodo": p_periodo} y
//     clave_dedupe = sha256(JSON canonico de ["xml.obtener", cliente, parametros]) = `claveDedupe` de @contapp/queue (asi
//     deduplica contra el lote que encole el backend con la misma clave). No comprueba que las compras existan (como `encolar`).
//   - Retorno: una fila (id, nuevo, estado, creado_en). nuevo = false y id/estado/creado_en del trabajo VIVO (en_cola o
//     ejecutando) del estudio con la misma clave, sin insertar nada ni consultar el tope (el dedupe va antes que el tope). Un
//     trabajo terminado (completado, error, cancelado) no bloquea. Sin carrera: dos llamadas simultaneas iguales dan un solo
//     trabajo (una con nuevo = true y otra false).
//   - Tope: si los en_cola de la cola xml del estudio ya son >= config_sistema(xml).max_pendientes_tenant, no inserta y
//     lanza 53400. El tope es atomico (dos llamadas simultaneas con un solo cupo: una entra y la otra 53400).
//   - Errores (SQLSTATE; el mensaje es fijo y NUNCA repite ids, periodo ni ruc):
//       22023  parametro invalido: algun argumento obligatorio NULL, p_compra_ids vacio / con mas de 100 / con NULL /
//              desordenado / con repetidos (orden ascendente por uuid, como el catalogo), o p_periodo que no cumple
//              ^[0-9]{4}(0[1-9]|1[0-2])$ (sin espacios ni saltos de linea)
//       42501  sesion sin estudio (app.tenant_id vacio, p. ej. withSistema) o rol sin EXECUTE
//       23503  p_cliente_id que no existe en el estudio de la sesion (inexistente o de otro estudio) o p_creado_por que no es
//              miembro del estudio de la sesion
//       53400  cola xml llena
//   - Llamarla con otra firma (otro numero de argumentos, un tipo de trabajo, jsonb) da 42883: no existe.
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import { abrirPool, enRollback, type ContappDb, type Tx } from "./soporte";
import {
  conSistema,
  crearDb,
  enTx,
  EscenarioTrabajos,
  probar,
  UUID,
  type ClientePrueba,
} from "./trabajos-soporte";

let admin: Pool;
let pool: Pool; // contapp_app (login, sin SET ROLE)
let et: EscenarioTrabajos;
const dbs: ContappDb[] = [];
let workerDb: ContappDb;
let X: string; // estudio principal (casi todo en rollback)
let Y: string; // otro estudio
let T: string; // tope: pendientes sembrados
let K: string; // lo que se confirma de verdad (visibilidad entre estudios, carreras de dedupe)
let R: string; // carrera por el ultimo cupo del tope
let cx: ClientePrueba;
let cy: ClientePrueba;
let ct: ClientePrueba;
let ck: ClientePrueba;
let cr: ClientePrueba;
let ux: string; // miembro de X
let uy: string; // miembro de Y
let ORIG: { reintentos: number; max_pendientes_tenant: number };

beforeAll(async () => {
  admin = abrirAdmin(6);
  pool = abrirPool(2);
  et = new EscenarioTrabajos(admin);
  X = (await et.estudio()).id;
  Y = (await et.estudio()).id;
  T = (await et.estudio()).id;
  K = (await et.estudio()).id;
  R = (await et.estudio()).id;
  cx = await et.cliente(X);
  cy = await et.cliente(Y);
  ct = await et.cliente(T);
  ck = await et.cliente(K);
  cr = await et.cliente(R);
  ux = (await et.miembro(X, "contador")).id;
  uy = (await et.miembro(Y, "contador")).id;
  ORIG = (
    await admin.query(
      "select reintentos, max_pendientes_tenant from config_sistema where cola = 'xml'",
    )
  ).rows[0];
  workerDb = crearDb("contapp_worker", 3);
  dbs.push(workerDb);
});
afterAll(async () => {
  if (ORIG) await restaurarConfig();
  await et?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await pool?.end();
  await admin?.end();
});

// ---- ayudas ------------------------------------------------------------------------------------------------------------
const adm = async (sql: string, v: unknown[] = []) =>
  (await admin.query(sql, v)).rows;
const consulta = adm;

const PERIODO = "202406";
const SQL_LLAMAR =
  "select * from public.encolar_xml_obtener($1::uuid, $2::text, $3::uuid[], $4::uuid)";
/** `n` uuid v4 en minuscula, ordenados ascendente (el orden del catalogo y de uuid en PostgreSQL). */
const ids = (n: number): string[] =>
  Array.from({ length: n }, () => randomUUID()).sort();

interface FilaEncolada {
  id: string;
  nuevo: boolean;
  estado: string;
  creado_en: Date;
}
type Q = Pick<Tx, "query">;

const llamar = (
  c: Q,
  cliente: string | null,
  periodo: string | null,
  lote: string[] | null,
  creadoPor: string | null = null,
) => probar(c, SQL_LLAMAR, [cliente, periodo, lote, creadoPor]);

/** Llama y exige exito; devuelve la unica fila del retorno. */
async function ok(
  c: Q,
  cliente: string,
  lote: string[],
  creadoPor: string | null = null,
  periodo = PERIODO,
): Promise<FilaEncolada> {
  const r = await llamar(c, cliente, periodo, lote, creadoPor);
  if (!r.ok) throw new Error(`la llamada fallo: ${r.code} ${r.message}`);
  expect(r.rows).toHaveLength(1);
  return r.rows![0] as FilaEncolada;
}

const clave = (cliente: string, periodo: string, lote: string[]): Buffer =>
  createHash("sha256")
    .update(
      JSON.stringify(["xml.obtener", cliente, { compraIds: lote, periodo }]),
      "utf8",
    )
    .digest();

const leer = async (tx: Q, id: string) =>
  (await tx.query("select * from job_registro where id = $1", [id])).rows[0];
const contarXml = async (tx: Q) =>
  Number(
    (
      await tx.query(
        "select count(*) as n from job_registro where tipo = 'xml.obtener'",
      )
    ).rows[0].n,
  );
const pendientesXml = async (tx: Q) =>
  Number(
    (
      await tx.query(
        "select count(*) as n from job_registro where cola = 'xml' and estado = 'en_cola'",
      )
    ).rows[0].n,
  );

/** Un trabajo `xml.obtener` vivo/terminado sembrado como lo dejaria el backend (interactivo, clave del catalogo). */
const sembrarXml = (
  tenant: string,
  c: ClientePrueba,
  lote: string[],
  estado: string,
  prioridad = "interactivo",
) =>
  et.job(tenant, c, {
    tipo: "xml.obtener",
    cola: "xml",
    canal: "ninguno",
    prioridad,
    estado,
    parametros: { periodo: PERIODO, compraIds: lote },
    claveDedupe: clave(c.id, PERIODO, lote),
    maxIntentos: 4,
  });

async function ponerConfig(reintentos: number, max: number) {
  await admin.query(
    "update config_sistema set reintentos = $1::smallint, max_pendientes_tenant = $2::int, actualizado_en = now() where cola = 'xml'",
    [reintentos, max],
  );
}
const restaurarConfig = () =>
  ponerConfig(ORIG.reintentos, ORIG.max_pendientes_tenant);
async function conConfig<T>(
  c: { reintentos?: number; max?: number },
  fn: () => Promise<T>,
): Promise<T> {
  await ponerConfig(
    c.reintentos ?? ORIG.reintentos,
    c.max ?? ORIG.max_pendientes_tenant,
  );
  try {
    return await fn();
  } finally {
    await restaurarConfig();
  }
}

const enWorker = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  enRollback(workerDb, { tenantId }, fn);

// =================================================================================================
describe("encolar_xml_obtener: catalogo (firma, atributos y privilegios)", () => {
  const donde = `p.pronamespace = to_regnamespace('public') and p.proname = 'encolar_xml_obtener'`;

  it("existe UNA sola funcion en public, con la firma y el retorno del contrato", async () => {
    const r = await consulta(
      `select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as retorna
         from pg_proc p where ${donde}`,
    );
    expect(r).toEqual([
      {
        args: "p_cliente_id uuid, p_periodo text, p_compra_ids uuid[], p_creado_por uuid",
        retorna:
          "TABLE(id uuid, nuevo boolean, estado text, creado_en timestamp with time zone)",
      },
    ]);
  });

  it("no recibe tipo, cola, canal, prioridad, estado, max_intentos ni estudio: el tipo no se puede pasar", async () => {
    const r = await consulta(
      `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p where ${donde}`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].args).not.toMatch(
      /tipo|cola|canal|prioridad|estado|max_|intento|tenant|estudio|jsonb|bytea|clave|dedupe/i,
    );
  });

  it("SECURITY DEFINER, VOLATILE y search_path = pg_catalog, pg_temp", async () => {
    const r = await consulta(
      `select p.prosecdef, p.provolatile, p.proconfig from pg_proc p where ${donde}`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].prosecdef).toBe(true);
    expect(r[0].provolatile).toBe("v");
    const sp = (r[0].proconfig as string[] | null)?.find((x) =>
      x.startsWith("search_path="),
    );
    expect(sp).toMatch(/^search_path=pg_catalog,\s*pg_temp$/);
  });

  it("el dueño no es superusuario ni tiene BYPASSRLS ni es un rol de la app (la RLS de job_registro sigue aplicando)", async () => {
    const r = await consulta(
      `select o.rolname, o.rolsuper, o.rolbypassrls from pg_proc p join pg_roles o on o.oid = p.proowner where ${donde}`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].rolsuper).toBe(false);
    expect(r[0].rolbypassrls).toBe(false);
    expect([
      "contapp_worker",
      "contapp_backend",
      "contapp_app",
      "contapp_platform",
    ]).not.toContain(r[0].rolname);
  });

  it("EXECUTE solo para contapp_worker: ni PUBLIC, ni backend, ni platform, ni contapp_app", async () => {
    const r = await consulta(
      `select has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as publico
         from pg_proc p where ${donde}`,
    );
    expect(r).toEqual([
      {
        worker: true,
        backend: false,
        platform: false,
        app: false,
        publico: false,
      },
    ]);
  });

  it("el worker llega a la funcion por USAGE de public y no puede crear objetos ahi (nada que la sustituya)", async () => {
    const r = await consulta(
      `select has_schema_privilege('contapp_worker', 'public', 'USAGE') as uso,
              has_schema_privilege('contapp_worker', 'public', 'CREATE') as crea`,
    );
    expect(r).toEqual([{ uso: true, crea: false }]);
  });
});

// =================================================================================================
describe("el worker sigue SIN INSERT directo en job_registro (mantiene y amplia 0018)", () => {
  const tieneAlguna = async (rol: string, priv: string) =>
    (
      await consulta(
        "select has_any_column_privilege($1, to_regclass('public.job_registro'), $2) as v",
        [rol, priv],
      )
    )[0].v as boolean;
  const tienePrivTabla = async (rol: string, priv: string) =>
    (
      await consulta(
        "select has_table_privilege($1, to_regclass('public.job_registro'), $2) as v",
        [rol, priv],
      )
    )[0].v as boolean;

  it("contapp_worker: sin INSERT (tabla ni columna), TRUNCATE, REFERENCES ni TRIGGER; solo SELECT, UPDATE por columna y DELETE", async () => {
    expect(await tieneAlguna("contapp_worker", "INSERT")).toBe(false);
    for (const p of ["INSERT", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(await tienePrivTabla("contapp_worker", p), p).toBe(false);
    }
    expect(await tieneAlguna("contapp_worker", "REFERENCES")).toBe(false);
    const upd = await consulta(
      `select a.attname from pg_attribute a
        where a.attrelid = to_regclass('public.job_registro') and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('contapp_worker', a.attrelid, a.attname, 'UPDATE') order by 1`,
    );
    expect(upd.map((x) => x.attname)).toEqual(
      [
        "actualizado_en",
        "disponible_desde",
        "estado",
        "intentos",
        "iniciado_en",
        "motivo",
        "resultado",
        "terminado_en",
      ].sort(),
    );
  });

  it("la funcion de 0037 no toca los grants de la tabla: la ACL nombra solo a backend, enumerador y worker", async () => {
    // Exige que la funcion exista, para que esta guarda no pase en vacio antes de la migracion.
    expect(
      (
        await consulta(
          "select to_regprocedure('public.encolar_xml_obtener(uuid,text,uuid[],uuid)') is not null as v",
        )
      )[0].v,
      "la funcion existe",
    ).toBe(true);
    const r = await consulta(
      `select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as quien
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass('public.job_registro') and a.grantee <> c.relowner
       union
       select distinct case when a2.grantee = 0 then 'PUBLIC' else a2.grantee::regrole::text end
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2 join pg_class c2 on c2.oid = at.attrelid
        where at.attrelid = to_regclass('public.job_registro') and at.attnum > 0 and a2.grantee <> c2.relowner
        order by 1`,
    );
    expect(r.map((x) => x.quien)).toEqual([
      "contapp_backend",
      "contapp_enumerador",
      "contapp_worker",
    ]);
  });

  it("un INSERT del worker (todas las columnas validas) sigue dando 42501, antes y despues de llamar a la funcion", async () => {
    const insertar = (tx: Q) =>
      probar(
        tx,
        `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
         values ($1, $2, 'xml.obtener', 'xml', 'ninguno', 'programado', 'en_cola', '{}'::jsonb, $3, null, 4)`,
        [cx.id, cx.ruc, createHash("sha256").update(randomUUID()).digest()],
      );
    await enWorker(X, async (tx) => {
      const antes = await insertar(tx);
      expect(antes).toMatchObject({ ok: false, code: "42501" });
      await ok(tx, cx.id, ids(2)); // la funcion existe y funciona (rojo hasta 0037)
      const despues = await insertar(tx);
      expect(despues).toMatchObject({ ok: false, code: "42501" });
    });
  });
});

// =================================================================================================
describe("encolar_xml_obtener: el worker encola dentro de su estudio", () => {
  it("crea un trabajo xml.obtener con cola, canal, prioridad e intentos del catalogo y devuelve (id, nuevo, estado, creado_en)", async () => {
    const lote = ids(3);
    await enWorker(X, async (tx) => {
      const f = await ok(tx, cx.id, lote, ux);
      expect(Object.keys(f).sort()).toEqual([
        "creado_en",
        "estado",
        "id",
        "nuevo",
      ]);
      expect(f.id).toMatch(UUID);
      expect(f.nuevo).toBe(true);
      expect(f.estado).toBe("en_cola");
      const t = await leer(tx, f.id);
      expect(t).toMatchObject({
        tenant_id: X,
        cliente_id: cx.id,
        ruc: cx.ruc,
        tipo: "xml.obtener",
        cola: "xml",
        canal: "ninguno",
        prioridad: "programado",
        estado: "en_cola",
        intentos: 0,
        max_intentos: ORIG.reintentos + 1,
        creado_por: ux,
        motivo: null,
        resultado: null,
      });
      expect(t.parametros).toEqual({ compraIds: lote, periodo: PERIODO });
      expect(new Date(f.creado_en).getTime()).toBe(t.creado_en.getTime());
    });
  });

  it("max_intentos sale de config_sistema (reintentos + 1), no de una constante", async () => {
    await conConfig({ reintentos: 1 }, async () => {
      await enWorker(X, async (tx) => {
        const f = await ok(tx, cx.id, ids(2));
        expect((await leer(tx, f.id)).max_intentos).toBe(2);
      });
    });
  });

  it("clave_dedupe = SHA-256 del JSON canonico de [tipo, cliente, parametros] (la misma que calcula `claveDedupe`)", async () => {
    const lote = ids(4);
    await enWorker(X, async (tx) => {
      const f = await ok(tx, cx.id, lote);
      const t = await leer(tx, f.id);
      expect(Buffer.compare(t.clave_dedupe, clave(cx.id, PERIODO, lote))).toBe(
        0,
      );
    });
  });

  it("creado_por NULL es valido (trabajo programado sin creador)", async () => {
    await enWorker(X, async (tx) => {
      const f = await ok(tx, cx.id, ids(2), null);
      expect((await leer(tx, f.id)).creado_por).toBeNull();
    });
  });

  it.each([1, 100])(
    "acepta un lote de %i compra(s) (el parametros de 100 uuid cabe en el CHECK de 4096 octetos)",
    async (n) => {
      const lote = ids(n);
      await enWorker(X, async (tx) => {
        const f = await ok(tx, cx.id, lote);
        expect((await leer(tx, f.id)).parametros.compraIds).toEqual(lote);
      });
    },
  );

  it("el retorno no expone la clave de dedupe, el RUC ni los parametros", async () => {
    await enWorker(X, async (tx) => {
      const f = await ok(tx, cx.id, ids(2));
      const texto = JSON.stringify(f);
      expect(texto).not.toContain(cx.ruc);
      expect(Object.keys(f)).not.toContain("clave_dedupe");
      expect(Object.keys(f)).not.toContain("parametros");
    });
  });

  it("el trabajo creado en un estudio no lo ve otro estudio (tenant_id sale de la sesion)", async () => {
    const lote = ids(2);
    const f = await workerDb.withTenant({ tenantId: K }, (tx) =>
      ok(tx, ck.id, lote),
    );
    const fila = await adm(
      "select tenant_id, cliente_id from job_registro where id = $1",
      [f.id],
    );
    expect(fila).toEqual([{ tenant_id: K, cliente_id: ck.id }]);
    const desdeY = await workerDb.withTenant({ tenantId: Y }, async (tx) => {
      const r = await tx.query(
        "select count(*)::int as n from job_registro where id = $1",
        [f.id],
      );
      return r.rows[0].n as number;
    });
    expect(desdeY).toBe(0);
  });
});

// =================================================================================================
describe("encolar_xml_obtener: rechaza lo que no es un lote canonico de xml.obtener", () => {
  const dup = ids(3);
  const casos: [string, () => string[] | null][] = [
    ["lote vacio", () => []],
    ["101 compras", () => ids(101)],
    ["lote NULL", () => null],
    ["un elemento NULL", () => [null as unknown as string]],
    ["desordenado", () => [...ids(3)].reverse()],
    ["repetido adyacente", () => [dup[0]!, dup[0]!, dup[1]!]],
    ["repetido no adyacente", () => [dup[0]!, dup[1]!, dup[0]!]],
  ];
  it.each(casos)("22023 con %s, sin crear nada", async (_n, lote) => {
    await enWorker(X, async (tx) => {
      const antes = await contarXml(tx);
      const r = await llamar(tx, cx.id, PERIODO, lote());
      expect(r).toMatchObject({ ok: false, code: "22023" });
      expect(await contarXml(tx)).toBe(antes);
    });
  });

  const periodos: [string, string | null][] = [
    ["NULL", null],
    ["vacio", ""],
    ["solo el año", "2024"],
    ["mes 00", "202400"],
    ["mes 13", "202413"],
    ["con guion", "2024-06"],
    ["con letras", "20240A"],
    ["con espacio al inicio", " 202406"],
    ["con espacio al final", "202406 "],
    ["con salto de linea final", "202406\n"],
    ["digitos de ancho completo", "２０２４０６"],
    ["largo", "2024061"],
  ];
  it.each(periodos)("22023 con periodo %s, sin crear nada", async (_n, p) => {
    await enWorker(X, async (tx) => {
      const antes = await contarXml(tx);
      const r = await llamar(tx, cx.id, p, ids(2));
      expect(r).toMatchObject({ ok: false, code: "22023" });
      expect(await contarXml(tx)).toBe(antes);
    });
  });

  it("22023 con cliente NULL", async () => {
    await enWorker(X, async (tx) => {
      expect(await llamar(tx, null, PERIODO, ids(2))).toMatchObject({
        ok: false,
        code: "22023",
      });
    });
  });

  it("el tipo (y cualquier otro campo) no se puede pasar: otra firma da 42883", async () => {
    await enWorker(X, async (tx) => {
      const lote = ids(2);
      // sin esto el 42883 de abajo pasaria en vacio mientras la funcion no exista
      await ok(tx, cx.id, ids(2));
      // un quinto argumento con un tipo de trabajo
      expect(
        await probar(
          tx,
          "select * from public.encolar_xml_obtener($1::uuid, $2::text, $3::uuid[], $4::uuid, $5::text)",
          [cx.id, PERIODO, lote, null, "sire.propuesta.descargar"],
        ),
      ).toMatchObject({ ok: false, code: "42883" });
      // parametros como jsonb (claves extra)
      expect(
        await probar(
          tx,
          "select * from public.encolar_xml_obtener($1::uuid, $2::jsonb)",
          [cx.id, JSON.stringify({ periodo: PERIODO, compraIds: lote, x: 1 })],
        ),
      ).toMatchObject({ ok: false, code: "42883" });
      // sin creado_por
      expect(
        await probar(
          tx,
          "select * from public.encolar_xml_obtener($1::uuid, $2::text, $3::uuid[])",
          [cx.id, PERIODO, lote],
        ),
      ).toMatchObject({ ok: false, code: "42883" });
    });
  });

  it("todo lo que la funcion crea es xml.obtener de la cola xml, canal ninguno, programado (nada mas sale de ella)", async () => {
    await enWorker(X, async (tx) => {
      const creados: string[] = [];
      for (let i = 0; i < 3; i++)
        creados.push((await ok(tx, cx.id, ids(2 + i))).id);
      const r = await tx.query(
        `select distinct tipo, cola, canal, prioridad, estado from job_registro where id = any($1::uuid[])`,
        [creados],
      );
      expect(r.rows).toEqual([
        {
          tipo: "xml.obtener",
          cola: "xml",
          canal: "ninguno",
          prioridad: "programado",
          estado: "en_cola",
        },
      ]);
    });
  });

  it("el mensaje de error es fijo: no repite los ids, el periodo ni el RUC", async () => {
    const lote = [...ids(3)].reverse(); // desordenado
    const canario = "CANARIO-PERIODO-7731";
    await enWorker(X, async (tx) => {
      const mal = await llamar(tx, cx.id, PERIODO, lote);
      const malPeriodo = await llamar(tx, cx.id, canario, ids(2));
      for (const r of [mal, malPeriodo]) {
        expect(r).toMatchObject({ ok: false, code: "22023" });
        if (r.ok) continue;
        for (const secreto of [...lote, canario, cx.ruc, cx.id])
          expect(r.message).not.toContain(secreto);
      }
    });
  });
});

// =================================================================================================
describe("encolar_xml_obtener: cliente, creador y estudio de la sesion", () => {
  it("23503 con un cliente de OTRO estudio (la sesion es X, el cliente es de Y) y no crea nada", async () => {
    await enWorker(X, async (tx) => {
      const antes = await contarXml(tx);
      expect(await llamar(tx, cy.id, PERIODO, ids(2))).toMatchObject({
        ok: false,
        code: "23503",
      });
      expect(await contarXml(tx)).toBe(antes);
    });
    await enWorker(Y, async (tx) => {
      expect(await llamar(tx, cx.id, PERIODO, ids(2))).toMatchObject({
        ok: false,
        code: "23503",
      });
    });
    // ni siquiera el estudio dueño del cliente gana una fila
    expect(
      await adm(
        "select 1 from job_registro where tipo = 'xml.obtener' and tenant_id = $1 and cliente_id = $2",
        [Y, cx.id],
      ),
    ).toEqual([]);
  });

  it("23503 con un cliente inexistente", async () => {
    await enWorker(X, async (tx) => {
      expect(await llamar(tx, randomUUID(), PERIODO, ids(2))).toMatchObject({
        ok: false,
        code: "23503",
      });
    });
  });

  it("23503 con un creado_por que es miembro de otro estudio o que no existe", async () => {
    await enWorker(X, async (tx) => {
      expect(await llamar(tx, cx.id, PERIODO, ids(2), uy)).toMatchObject({
        ok: false,
        code: "23503",
      });
      expect(
        await llamar(tx, cx.id, PERIODO, ids(2), randomUUID()),
      ).toMatchObject({ ok: false, code: "23503" });
    });
  });

  it("42501 sin estudio en la sesion: withSistema (worker sin app.tenant_id) no puede encolar", async () => {
    const sis = conSistema("contapp_worker");
    dbs.push(sis);
    const r = await sis.withSistema((tx) => llamar(tx, cx.id, PERIODO, ids(2)));
    expect(r).toMatchObject({ ok: false, code: "42501" });
  });

  it("42501 con app.tenant_id vacio, aunque el cliente exista", async () => {
    const r = await enTx(admin, "contapp_worker", async (c) => {
      await c.query("select set_config('app.tenant_id', '', true)");
      return llamar(c, cx.id, PERIODO, ids(2));
    });
    expect(r).toMatchObject({ ok: false, code: "42501" });
  });
});

// =================================================================================================
describe("encolar_xml_obtener: deduplicacion (clave_dedupe)", () => {
  it("la misma llamada dos veces: la segunda devuelve el mismo trabajo con nuevo = false y no inserta", async () => {
    const lote = ids(3);
    await enWorker(X, async (tx) => {
      const a = await ok(tx, cx.id, lote);
      const antes = await contarXml(tx);
      const b = await ok(tx, cx.id, lote);
      expect(a.nuevo).toBe(true);
      expect(b.nuevo).toBe(false);
      expect(b.id).toBe(a.id);
      expect(b.estado).toBe("en_cola");
      expect(new Date(b.creado_en).getTime()).toBe(
        new Date(a.creado_en).getTime(),
      );
      expect(await contarXml(tx)).toBe(antes);
    });
  });

  it.each(["en_cola", "ejecutando"])(
    "un lote %s encolado antes por el backend (interactivo) es el vivo: nuevo = false, sin segundo trabajo",
    async (estado) => {
      const lote = ids(2);
      const previo = await sembrarXml(X, cx, lote, estado);
      await enWorker(X, async (tx) => {
        const antes = await contarXml(tx);
        const f = await ok(tx, cx.id, lote);
        expect(f.nuevo).toBe(false);
        expect(f.id).toBe(previo);
        expect(f.estado).toBe(estado);
        expect(await contarXml(tx)).toBe(antes);
        expect((await leer(tx, previo)).prioridad).toBe("interactivo");
      });
    },
  );

  it.each(["completado", "error", "cancelado"])(
    "un lote %s no bloquea: se encola uno nuevo",
    async (estado) => {
      const lote = ids(2);
      const previo = await sembrarXml(X, cx, lote, estado);
      await enWorker(X, async (tx) => {
        const f = await ok(tx, cx.id, lote);
        expect(f.nuevo).toBe(true);
        expect(f.id).not.toBe(previo);
      });
    },
  );

  it("otro periodo, otros ids u otro cliente no deduplican", async () => {
    const lote = ids(2);
    const otroCliente = await et.cliente(X);
    await enWorker(X, async (tx) => {
      const base = await ok(tx, cx.id, lote);
      const otroPeriodo = await ok(tx, cx.id, lote, null, "202407");
      const otrosIds = await ok(tx, cx.id, ids(2));
      const cliente2 = await ok(tx, otroCliente.id, lote);
      const todos = [base, otroPeriodo, otrosIds, cliente2];
      expect(todos.map((f) => f.nuevo)).toEqual([true, true, true, true]);
      expect(new Set(todos.map((f) => f.id)).size).toBe(4);
    });
  });

  it("dos llamadas simultaneas iguales (transacciones distintas) dejan un solo trabajo vivo", async () => {
    const lote = ids(3);
    const [a, b] = await Promise.all([
      workerDb.withTenant({ tenantId: K }, (tx) => ok(tx, ck.id, lote)),
      workerDb.withTenant({ tenantId: K }, (tx) => ok(tx, ck.id, lote)),
    ]);
    expect([a.nuevo, b.nuevo].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    const n = await adm(
      `select count(*)::int as n from job_registro where tenant_id = $1 and clave_dedupe = $2 and estado in ('en_cola','ejecutando')`,
      [K, clave(ck.id, PERIODO, lote)],
    );
    expect(n[0].n).toBe(1);
  });
});

// =================================================================================================
describe("encolar_xml_obtener: tope de pendientes de la cola xml (max_pendientes_tenant)", () => {
  beforeAll(async () => {
    // T: 2 en_cola de la cola xml (los unicos que cuentan) y 9 que no: otra cola, ejecutando y completado.
    for (let i = 0; i < 2; i++) await et.job(T, ct, tipoXml("en_cola"));
    for (let i = 0; i < 3; i++)
      await et.job(T, ct, { cola: "sire", estado: "en_cola" });
    for (let i = 0; i < 3; i++) await et.job(T, ct, tipoXml("ejecutando"));
    for (let i = 0; i < 3; i++) await et.job(T, ct, tipoXml("completado"));
  });
  function tipoXml(estado: string) {
    return {
      tipo: "xml.obtener",
      cola: "xml",
      canal: "ninguno",
      prioridad: "programado",
      estado,
    };
  }

  it("con el tope alcanzado (en_cola xml del estudio >= max): 53400 y no inserta", async () => {
    await conConfig({ max: 2 }, () =>
      enWorker(T, async (tx) => {
        expect(await pendientesXml(tx)).toBe(2);
        const r = await llamar(tx, ct.id, PERIODO, ids(2));
        expect(r).toMatchObject({ ok: false, code: "53400" });
        expect(await pendientesXml(tx)).toBe(2);
      }),
    );
  });

  it("solo cuentan los en_cola de la cola xml: otra cola, ejecutando y terminados no llenan el cupo", async () => {
    await conConfig({ max: 3 }, () =>
      enWorker(T, async (tx) => {
        const f = await ok(tx, ct.id, ids(2));
        expect(f.nuevo).toBe(true);
        expect(await pendientesXml(tx)).toBe(3);
      }),
    );
  });

  it("el ultimo cupo se concede y el siguiente lote distinto ya no cabe (53400, sin dejar fila)", async () => {
    await conConfig({ max: 3 }, () =>
      enWorker(T, async (tx) => {
        await ok(tx, ct.id, ids(2)); // 2 -> 3
        const r = await llamar(tx, ct.id, PERIODO, ids(2));
        expect(r).toMatchObject({ ok: false, code: "53400" });
        expect(await pendientesXml(tx)).toBe(3);
      }),
    );
  });

  it("el dedupe va antes que el tope: con la cola llena, repetir un lote vivo devuelve el vivo (nuevo = false), no 53400", async () => {
    const lote = ids(2);
    await conConfig({ max: 3 }, () =>
      enWorker(T, async (tx) => {
        const a = await ok(tx, ct.id, lote); // llena la cola (3 de 3)
        const b = await ok(tx, ct.id, lote);
        expect(b).toMatchObject({ nuevo: false, id: a.id });
        expect(await pendientesXml(tx)).toBe(3);
      }),
    );
  });

  it("el tope es por estudio: con T lleno, Y (sin pendientes) sigue encolando", async () => {
    await conConfig({ max: 2 }, async () => {
      await enWorker(T, async (tx) => {
        expect(await llamar(tx, ct.id, PERIODO, ids(2))).toMatchObject({
          ok: false,
          code: "53400",
        });
      });
      await enWorker(Y, async (tx) => {
        const f = await ok(tx, cy.id, ids(2));
        expect(f.nuevo).toBe(true);
      });
    });
  });

  it("el tope es atomico: con un solo cupo y dos llamadas simultaneas distintas, una entra y la otra recibe 53400", async () => {
    await et.job(R, cr, tipoXml("en_cola")); // 1 pendiente; max = 2
    await conConfig({ max: 2 }, async () => {
      const [a, b] = await Promise.all([
        workerDb.withTenant({ tenantId: R }, (tx) =>
          llamar(tx, cr.id, PERIODO, ids(2)),
        ),
        workerDb.withTenant({ tenantId: R }, (tx) =>
          llamar(tx, cr.id, PERIODO, ids(3)),
        ),
      ]);
      const codigos = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
      expect(codigos).toEqual(["53400", "ok"]);
      const n = await adm(
        "select count(*)::int as n from job_registro where tenant_id = $1 and cola = 'xml' and estado = 'en_cola'",
        [R],
      );
      expect(n[0].n).toBe(2);
    });
  });
});

// =================================================================================================
describe("encolar_xml_obtener: ningun otro rol puede ejecutarla (backend, platform, contapp_app, PUBLIC)", () => {
  const llamarComo = (rol: string) =>
    enTx(admin, rol, async (c) => {
      // con estudio en la sesion: lo que falla es el privilegio, no el contexto
      await c.query("select set_config('app.tenant_id', $1, true)", [X]);
      return probar(c, SQL_LLAMAR, [cx.id, PERIODO, ids(2), null]);
    });

  it.each(["contapp_backend", "contapp_platform", "contapp_app"])(
    "%s recibe 42501 aun con estudio en la sesion",
    async (rol) => {
      expect(await llamarComo(rol)).toMatchObject({ ok: false, code: "42501" });
    },
  );

  it("la conexion contapp_app sin SET ROLE (PUBLIC) recibe 42501", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await probar(c, SQL_LLAMAR, [cx.id, PERIODO, ids(2), null]);
      expect(r).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("el backend sigue encolando por su INSERT de columnas, sin la funcion (no se le quita nada)", async () => {
    const backend = crearDb("contapp_backend", 2);
    dbs.push(backend);
    await enRollback(backend, { tenantId: X }, async (tx) => {
      const r = await probar(
        tx,
        `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
         values ($1, $2, 'xml.obtener', 'xml', 'ninguno', 'interactivo', 'en_cola', '{}'::jsonb, $3, null, 4)`,
        [cx.id, cx.ruc, createHash("sha256").update(randomUUID()).digest()],
      );
      expect(r.ok).toBe(true);
    });
  });
});

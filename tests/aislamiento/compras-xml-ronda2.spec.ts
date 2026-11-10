// Spec 016 · T22 · correcciones de la ronda adversarial 2, parte de BD (rojo). Decisiones del orquestador sobre T21:
//   H-016-8  El worker NO tiene ningún privilegio UPDATE sobre `compra` (se revoca el `GRANT UPDATE (version_vigente)` de 0036):
//            no puede mover el puntero, ni siquiera a una versión que existe. La re-evaluación desde el worker sigue funcionando
//            con un bloqueo de fila que no necesita UPDATE (función SECURITY DEFINER acotada, advisory u otro).
//   H-016-9  La clave del candado del tope de `xml` usa el estudio normalizado (uuid canónico, minúsculas), tanto en
//            `encolar_xml_obtener` (0037) como en `insertarTrabajo` (registro.ts): con el estudio en mayúsculas en
//            `app.tenant_id` el candado es el mismo y el tope se respeta bajo concurrencia.
// Las pruebas de "se mantiene" (backend conserva sus grants, el worker re-evalúa sin UPDATE) pasan hoy: son la red de seguridad
// de la corrección. Las demás fallan hoy por la causa del hallazgo. No repite `compras-xml-r2.adv.spec.ts` (T21): es la versión
// no adversarial que fija el comportamiento correcto.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, probar, type ClientePrueba } from "./trabajos-soporte";
import { claveCompra, INSERTAR_VERSION, montos, MONTOS_DG, PERIODO, valoresVersion } from "./compras-soporte";
import {
  EscenarioXml,
  insertarCompras,
  evaluacionesDe,
  evaluadorXml,
  punteroDe,
  reevaluarCompra,
  versionesN,
} from "./compras-xml-soporte";

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let cx: ClientePrueba;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  cx = await ec.cliente(X);
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 8);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

let consecutivo = 8000;
const numero = () => String(++consecutivo);

const privTabla = async (rol: string, tabla: string, priv: string) =>
  (
    await admin.query(
      "select has_table_privilege($1::name, $2::regclass, $3::text) as v",
      [rol, `public.${tabla}`, priv],
    )
  ).rows[0].v as boolean;
const privColumna = async (rol: string, tabla: string, col: string, priv: string) =>
  (
    await admin.query(
      "select has_column_privilege($1::name, $2::regclass, $3::text, $4::text) as v",
      [rol, `public.${tabla}`, col, priv],
    )
  ).rows[0].v as boolean;

// =================================================================================================
describe("H-016-8 · el worker no tiene UPDATE sobre compra (0036 lo concedía para version_vigente)", () => {
  it("catálogo: ni UPDATE de tabla ni de ninguna columna de compra para contapp_worker", async () => {
    const columnas = (
      await admin.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'compra' order by ordinal_position",
      )
    ).rows.map((r) => r.column_name as string);
    expect(columnas).toContain("version_vigente");
    expect(await privTabla("contapp_worker", "compra", "UPDATE")).toBe(false);
    const conUpdate: string[] = [];
    for (const col of columnas)
      if (await privColumna("contapp_worker", "compra", col, "UPDATE")) conUpdate.push(col);
    expect(
      conUpdate,
      "columnas de compra con UPDATE para el worker (0036 le dejó version_vigente)",
    ).toEqual([]);
  });

  it("se mantiene: el backend conserva su UPDATE de (version_vigente, descartada_en) y ambos roles siguen con SELECT/INSERT", async () => {
    for (const col of ["version_vigente", "descartada_en"])
      expect(await privColumna("contapp_backend", "compra", col, "UPDATE"), col).toBe(true);
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      for (const priv of ["SELECT", "INSERT"]) {
        expect(await privTabla(rol, "compra", priv), `${rol} ${priv} compra`).toBe(true);
        expect(await privTabla(rol, "compra_version", priv), `${rol} ${priv} compra_version`).toBe(true);
      }
      // compra_version sigue inmutable para todos.
      expect(await privTabla(rol, "compra_version", "UPDATE"), `${rol} UPDATE compra_version`).toBe(false);
      expect(await privTabla(rol, "compra_version", "DELETE"), `${rol} DELETE compra_version`).toBe(false);
    }
  });

  it("el worker no puede mover version_vigente, ni siquiera a una versión que existe (42501) y el puntero queda", async () => {
    const s = await ec.compra(X, cx, { serie: "F001", numero: numero() });
    await ec.version(X, s.id, 2); // existe: el trigger de 0034 no lo frena; solo el privilegio
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      probar(tx, "update compra set version_vigente = 2 where id = $1", [s.id]),
    );
    expect(r).toMatchObject({ ok: false, code: "42501" });
    expect(await punteroDe(admin, s.id)).toBe(1);
  });

  it("el worker no puede ni un UPDATE neutro de version_vigente ni tocar descartada_en (42501), con o sin fila visible", async () => {
    const s = await ec.compra(X, cx, { origen: "agregada", serie: "F001", numero: numero() });
    const r = await worker.withTenant({ tenantId: X }, async (tx) => ({
      neutro: await probar(tx, "update compra set version_vigente = version_vigente where id = $1", [s.id]),
      descartar: await probar(tx, "update compra set descartada_en = now() where id = $1", [s.id]),
      sinFilas: await probar(tx, "update compra set version_vigente = version_vigente where false"),
    }));
    expect(r.neutro).toMatchObject({ ok: false, code: "42501" });
    expect(r.descartar).toMatchObject({ ok: false, code: "42501" });
    expect(r.sinFilas, "el privilegio se comprueba antes que las filas").toMatchObject({ ok: false, code: "42501" });
  });

  it("el worker no puede escribir una versión con montos propios y apuntar a ella (la transacción entera falla y no queda versión)", async () => {
    const c = await ec.cliente(X);
    const s = await ec.compraXml(X, c, { serie: "F001", numero: numero() });
    await ec.estadoPeriodo(X, c, PERIODO, "generado", ux);
    let codigoError = "ok";
    try {
      await worker.withTenant({ tenantId: X }, async (tx) => {
        await tx.query(INSERTAR_VERSION, valoresVersion(s.id, 2, { montos: { biDg: "1.00", igvDg: "0.18" } }));
        await tx.query("update compra set version_vigente = 2 where id = $1", [s.id]);
      });
    } catch (e) {
      codigoError = String((e as { code?: string }).code ?? "sin_codigo");
    }
    expect(codigoError).toBe("42501");
    expect(await punteroDe(admin, s.id)).toBe(1);
    expect(await versionesN(admin, s.id)).toEqual([1]);
  });

  it("aunque la versión forjada quede confirmada, el puntero no se mueve a ella en otra transacción del worker", async () => {
    const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
    // Lo que el worker puede hacer con su INSERT en compra_version: dejar la fila (el hallazgo H-016-8 trata el puntero).
    await worker.withTenant({ tenantId: X }, (tx) =>
      tx.query(INSERTAR_VERSION, valoresVersion(s.id, 2, { montos: { biDg: "1.00", igvDg: "0.18" } })),
    );
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      probar(tx, "update compra set version_vigente = 2 where id = $1", [s.id]),
    );
    expect(r).toMatchObject({ ok: false, code: "42501" });
    expect(await punteroDe(admin, s.id), "la versión vigente sigue siendo la del SIRE").toBe(1);
  });
});

// =================================================================================================
describe("H-016-8 · se mantiene: la re-evaluación desde el worker funciona sin ningún UPDATE sobre compra", () => {
  it("reevaluarCompra con el rol worker inserta la evaluación n + 1 de la versión vigente, sin versión nueva y sin mover el puntero", async () => {
    const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
    const { evaluar } = evaluadorXml();
    await worker.withTenant({ tenantId: X }, (tx) => reevaluarCompra(tx, s.id, { evaluar }));
    expect((await evaluacionesDe(admin, s.id)).map((e) => [e.version_n, e.n])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(await versionesN(admin, s.id)).toEqual([1]);
    expect(await punteroDe(admin, s.id)).toBe(1);
  });

  it("tres re-evaluaciones del worker a la vez sobre la misma compra se serializan: sin choque de n y sin interbloqueo", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
      const { evaluar } = evaluadorXml();
      const r = await Promise.allSettled(
        [0, 1, 2].map(() =>
          worker.withTenant({ tenantId: X }, (tx) => reevaluarCompra(tx, s.id, { evaluar })),
        ),
      );
      expect(
        r.map((x) => (x.status === "fulfilled" ? "ok" : String((x.reason as { code?: string }).code))),
        `ronda ${ronda}`,
      ).toEqual(["ok", "ok", "ok"]);
      expect((await evaluacionesDe(admin, s.id)).map((e) => e.n), `ronda ${ronda}`).toEqual([1, 2, 3, 4]);
    }
  });

  it("una compra descartada o de otro estudio sigue dando no_encontrada al worker (la corrección no abre filas)", async () => {
    const agregada = await ec.compra(X, cx, { origen: "agregada", serie: "F001", numero: numero() });
    await admin.query("update compra set descartada_en = now() where id = $1", [agregada.id]);
    const otroEstudio = (await ec.estudio()).id;
    const co = await ec.cliente(otroEstudio);
    const ajena = await ec.compraXml(otroEstudio, co, { serie: "F001", numero: numero() });
    const { evaluar } = evaluadorXml();
    for (const id of [agregada.id, ajena.id]) {
      const codigo = await worker
        .withTenant({ tenantId: X }, (tx) => reevaluarCompra(tx, id, { evaluar }))
        .then(() => "ok")
        .catch((e: { codigo?: string; code?: string }) => String(e.codigo ?? e.code));
      expect(codigo, id).toBe("no_encontrada");
    }
    expect(await evaluacionesDe(admin, ajena.id)).toHaveLength(1);
  });
});

// =================================================================================================
// El worker necesita INSERT en compra_version solo para la versión 1 de las compras que crea la descarga (`insertarCompras`).
// Decisión del orquestador (parte de H-016-8): su INSERT queda acotado a `n = 1` y a una compra creada en la MISMA transacción
// y sin versiones previas. Un `n = 2` huérfano deja el puntero en 1, pero el backend calcula `n = version_vigente + 1` y chocaría
// con `compra_version_compra_n_unique` (23505) en la siguiente edición, descarte o deshacer de esa compra.
// Error esperado: 42501 (la restricción la impone un trigger BEFORE INSERT o una política RLS con WITH CHECK, que corre antes
// que la unicidad: por eso `n = 1` repetido también da 42501 y no 23505). La restricción es solo del rol worker: el backend
// escribe versiones nuevas con normalidad (las cubren las pruebas de 014).
describe("H-016-8 · el INSERT del worker en compra_version queda acotado a n = 1 de una compra creada en la misma transacción", () => {
  const codigoDe = (p: Promise<unknown>) =>
    p.then(() => "ok").catch((e: { code?: string }) => String(e.code ?? "sin_codigo"));

  it("n = 2 sobre una compra existente: 42501 y no queda la versión huérfana", async () => {
    const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
    const r = await codigoDe(
      worker.withTenant({ tenantId: X }, (tx) =>
        tx.query(INSERTAR_VERSION, valoresVersion(s.id, 2, { montos: { biDg: "1.00", igvDg: "0.18" } })),
      ),
    );
    expect(r).toBe("42501");
    expect(await versionesN(admin, s.id)).toEqual([1]);
  });

  it("n = 1 sobre una compra existente que ya tiene versión 1: 42501 (antes que la unicidad, que daría 23505)", async () => {
    const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
    const r = await codigoDe(
      worker.withTenant({ tenantId: X }, (tx) => tx.query(INSERTAR_VERSION, valoresVersion(s.id, 1))),
    );
    expect(r).toBe("42501");
    expect(await versionesN(admin, s.id)).toEqual([1]);
  });

  it("n = 1 sobre una compra de una transacción anterior, aunque aún no tenga versiones: 42501", async () => {
    const propuestaId = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
    const numeroC = numero();
    const id = (
      await admin.query(
        `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
                             fecha, moneda, origen, version_vigente)
         values ($1, $2, $3, $4, $5, '01', 'F001', $6, '6', '20100070970', '2026-10-05', 'PEN', 'sire', 1) returning id`,
        [X, cx.id, PERIODO, propuestaId, claveCompra("01", "F001", numeroC, "6", "20100070970"), numeroC],
      )
    ).rows[0].id as string;
    const r = await codigoDe(
      worker.withTenant({ tenantId: X }, (tx) => tx.query(INSERTAR_VERSION, valoresVersion(id, 1))),
    );
    expect(r, "la compra no se creó en esta transacción").toBe("42501");
    expect(await versionesN(admin, id)).toEqual([]);
  });

  it("n >= 2 sobre una compra creada en la misma transacción también se rechaza (42501)", async () => {
    const propuestaId = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
    const numeroC = numero();
    const r = await codigoDe(
      worker.withTenant({ tenantId: X }, async (tx) => {
        const id = (
          await tx.query(
            `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
                                 fecha, moneda, origen, version_vigente)
             values ($1, $2, $3, $4, '01', 'F001', $5, '6', '20100070970', '2026-10-05', 'PEN', 'sire', 1) returning id`,
            [cx.id, PERIODO, propuestaId, claveCompra("01", "F001", numeroC, "6", "20100070970"), numeroC],
          )
        ).rows[0].id as string;
        await tx.query(INSERTAR_VERSION, valoresVersion(id, 2));
      }),
    );
    expect(r).toBe("42501");
  });

  it("se mantiene: la descarga normal (insertarCompras con el rol worker) crea la compra con su versión 1 y su evaluación 1", async () => {
    const c = await ec.cliente(X);
    const propuestaId = await ec.propuesta(X, c, { libro: "compras", nuevas: 2 });
    const nueva = () => {
      const n = numero();
      return {
        clave: claveCompra("01", "F001", n, "6", "20100070970"),
        tipoDoc: "01",
        serie: "F001",
        numero: n,
        docTipo: "6",
        docNumero: "20100070970",
        razonSocial: "PROVEEDOR SINTETICO SAC",
        fecha: "2026-10-05",
        moneda: "PEN" as const,
        tipoCambio: null,
        montos: montos(MONTOS_DG),
      };
    };
    const { evaluar } = evaluadorXml();
    const ids = await worker.withTenant({ tenantId: X }, (tx) =>
      insertarCompras(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, [nueva(), nueva()], { evaluar }),
    );
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(await versionesN(admin, id)).toEqual([1]);
      expect(await punteroDe(admin, id)).toBe(1);
      expect((await evaluacionesDe(admin, id)).map((e) => [e.version_n, e.n])).toEqual([[1, 1]]);
    }
  });
});

// =================================================================================================
describe("H-016-9 · el candado del tope usa el estudio normalizado (encolar_xml_obtener y registro.ts)", () => {
  const SQL = "select * from public.encolar_xml_obtener($1::uuid, $2::text, $3::uuid[], $4::uuid)";
  const lote = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();
  class Revertir extends Error {}

  let ORIG: { max_pendientes_tenant: number };
  let T: string;
  let ct: ClientePrueba;

  beforeAll(async () => {
    ORIG = (
      await admin.query("select max_pendientes_tenant from config_sistema where cola = 'xml'")
    ).rows[0];
    T = (await ec.estudio()).id;
    ct = await ec.cliente(T);
  });

  const conTope = async <R>(max: number, fn: () => Promise<R>): Promise<R> => {
    await admin.query("update config_sistema set max_pendientes_tenant = $1 where cola = 'xml'", [max]);
    try {
      return await fn();
    } finally {
      await admin.query("update config_sistema set max_pendientes_tenant = $1 where cola = 'xml'", [
        ORIG.max_pendientes_tenant,
      ]);
    }
  };
  const enColaXml = async (tenantId: string): Promise<number> =>
    (
      await admin.query(
        "select count(*)::int as n from job_registro where tenant_id = $1 and cola = 'xml' and estado = 'en_cola'",
        [tenantId],
      )
    ).rows[0].n as number;

  /** Los candados de aviso (advisory) que la sesión tiene tomados, como texto estable. */
  const candados = async (tx: Tx): Promise<string[]> =>
    (
      await tx.query(
        `select classid::text || ':' || objid::text as k from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid() and granted order by 1`,
      )
    ).rows.map((r) => r.k as string);

  /** Ejecuta `fn` en una transacción que siempre se revierte; devuelve los candados que tomó. `mayusculas` reescribe app.tenant_id. */
  async function candadoDe(
    db: ContappDb,
    mayusculas: boolean,
    fn: (tx: Tx) => Promise<unknown>,
  ): Promise<string[]> {
    let tomados: string[] = [];
    await db
      .withTenant({ tenantId: T }, async (tx) => {
        if (mayusculas) await tx.query("select set_config('app.tenant_id', upper($1), true)", [T]);
        await fn(tx);
        tomados = await candados(tx);
        throw new Revertir();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Revertir)) throw e;
      });
    return tomados;
  }

  const porFuncion = (mayusculas: boolean) =>
    candadoDe(worker, mayusculas, (tx) => tx.query(SQL, [ct.id, "202610", lote(2), null]));
  const porRegistro = (mayusculas: boolean) =>
    candadoDe(backend, mayusculas, async (tx) => {
      const insertarTrabajo = exportado<(tx: Tx, e: unknown) => Promise<unknown>>("insertarTrabajo");
      await insertarTrabajo(tx, {
        clienteId: ct.id,
        ruc: ct.ruc,
        tipo: "xml.obtener",
        cola: "xml",
        canal: "ninguno",
        prioridad: "programado",
        parametros: { periodo: "202610", compraIds: lote(1) },
        claveDedupe: randomBytes(32),
        creadoPor: null,
        maxIntentos: 3,
        maxPendientes: 100_000,
      });
    });

  it("la función toma UN candado y es el mismo con el estudio en minúsculas o en mayúsculas", async () => {
    expect(T.toUpperCase()).not.toBe(T);
    const minusculas = await porFuncion(false);
    const mayusculas = await porFuncion(true);
    expect(minusculas).toHaveLength(1);
    expect(mayusculas, "la clave del candado debe salir del estudio normalizado").toEqual(minusculas);
  });

  it("insertarTrabajo (registro.ts) toma UN candado y es el mismo con el estudio en minúsculas o en mayúsculas", async () => {
    const minusculas = await porRegistro(false);
    const mayusculas = await porRegistro(true);
    expect(minusculas).toHaveLength(1);
    expect(mayusculas, "la clave del candado debe salir del estudio normalizado").toEqual(minusculas);
  });

  it("se mantiene: la función (worker) y registro.ts (backend) comparten el candado del estudio y la cola xml", async () => {
    const [deFuncion, deRegistro] = [await porFuncion(false), await porRegistro(false)];
    expect(deFuncion).toHaveLength(1);
    expect(deRegistro).toEqual(deFuncion);
  });

  it("con el estudio en mayúsculas en una de las sesiones, el último cupo del tope no se reparte dos veces", async () => {
    await ec.job(T, ct, {
      tipo: "xml.obtener",
      cola: "xml",
      canal: "ninguno",
      prioridad: "programado",
      estado: "en_cola",
    }); // 1 pendiente; tope 2: queda UN cupo
    await conTope(2, async () => {
      let soltar!: () => void;
      const espera = new Promise<void>((r) => (soltar = r));
      let avisar!: () => void;
      const primeraDentro = new Promise<void>((r) => (avisar = r));
      const primera = worker.withTenant({ tenantId: T }, async (tx) => {
        const r = await probar(tx, SQL, [ct.id, "202610", lote(2), null]);
        avisar();
        await espera; // retiene el candado sin confirmar
        return r;
      });
      await primeraDentro;
      const segunda = worker.withTenant({ tenantId: T }, async (tx) => {
        await tx.query("select set_config('app.tenant_id', upper($1), true)", [T]);
        return probar(tx, SQL, [ct.id, "202610", lote(3), null]);
      });
      const temprano = await Promise.race([
        segunda.then((r) => (r.ok ? "ok" : r.code)),
        new Promise<string>((r) => setTimeout(() => r("espera"), 1500)),
      ]);
      soltar();
      const [a, b] = await Promise.all([primera, segunda]);
      const codigos = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
      expect(temprano, "la segunda debe esperar el candado de la primera").toBe("espera");
      expect(await enColaXml(T), "nunca más pendientes que el tope").toBeLessThanOrEqual(2);
      expect(codigos).toEqual(["53400", "ok"]);
    });
  });
});

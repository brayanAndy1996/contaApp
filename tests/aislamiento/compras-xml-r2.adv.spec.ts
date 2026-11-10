// Spec 016 · T21 · ronda adversarial 2 (BD): re-evaluación, puntero de la fila y encolado del worker.
// Ataca los desvíos aceptados en la implementación: el GRANT UPDATE (version_vigente) ON compra al worker (0036, T11) y la función
// SECURITY DEFINER `encolar_xml_obtener` (0037, T12b); además, la llegada del XML contra rehacer y las dos llegadas del mismo XML
// (worker y subida). No repite T5 (`compras-xml-*.spec.ts`) ni T12a (`trabajos-encolar-xml.spec.ts`).
// Una prueba en rojo es un hallazgo H-016-n (informe de T21); en verde, la defensa aguanta.
// Hallazgos: A1 y A2 -> H-016-8 · A4 -> H-016-9. En verde: A3, A5, A6, A7.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, probar, type ClientePrueba } from "./trabajos-soporte";
import {
  INSERTAR_VERSION,
  PERIODO,
  transformarFalso,
  valoresVersion,
} from "./compras-soporte";
import {
  aplicarAccion,
  deshacer,
  entradaXml,
  EscenarioXml,
  evaluacionesDe,
  evaluadorXml,
  guardarDocumentoXml,
  punteroDe,
  reevaluarCompra,
  versionesN,
  xmlsDe,
  type EvaluarConXml,
} from "./compras-xml-soporte";

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let ux: string;
let cx: ClientePrueba;
let cy: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 8);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

let consecutivo = 7000;
const numero = () => String(++consecutivo);

/** Código de lo que lanza una promesa (`codigo` de 014 o `code` de pg), o 'ok'. */
async function codigo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    const x = e as { codigo?: string; code?: string };
    return String(x.codigo ?? x.code ?? "sin_codigo");
  }
}

/** Lo que un worker comprometido (o con un defecto) haría con su grant: versión con montos propios y el puntero a ella. */
const forjarVersion = (tenantId: string, compraId: string, n: number) =>
  worker.withTenant({ tenantId }, async (tx) => {
    await tx.query(
      INSERTAR_VERSION,
      valoresVersion(compraId, n, {
        montos: { biDg: "1.00", igvDg: "0.18" },
      }),
    );
    await tx.query("update compra set version_vigente = $2 where id = $1", [
      compraId,
      n,
    ]);
  });

// =================================================================================================
describe("T21 · GRANT UPDATE (version_vigente) del worker (0036): el puntero solo lo mueve quien escribe versiones de 014", () => {
  it("A1 · el worker no puede reescribir los montos de una compra (versión propia + puntero) con el periodo generado, sin operación ni deshacer", async () => {
    const c = await ec.cliente(X);
    const s = await ec.compraXml(X, c, { serie: "F001", numero: numero() });
    await ec.estadoPeriodo(X, c, PERIODO, "generado", ux);
    const r = await codigo(forjarVersion(X, s.id, 2));
    expect(
      r,
      "el worker (sin UPDATE en 0032) no debe poder mover el puntero a una versión que él mismo escribió",
    ).toBe("42501");
    expect(await punteroDe(admin, s.id)).toBe(1);
    expect(await versionesN(admin, s.id)).toEqual([1]);
  });

  it("A2 · el worker no puede mover el puntero de una compra agregada ya descartada (D-7: descartada no se reabre ni cambia)", async () => {
    const s = await ec.compra(X, cx, {
      origen: "agregada",
      serie: "F001",
      numero: numero(),
      periodo: "202609",
    });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      s.id,
    ]);
    const r = await codigo(forjarVersion(X, s.id, 2));
    expect(r, "una compra descartada no debe cambiar de versión vigente").toBe(
      "42501",
    );
    expect(await punteroDe(admin, s.id)).toBe(1);
  });

  it("A3 · el trigger de 0034 y la RLS acotan el grant: versión de otra compra, retroceso, descartada_en, identidad y otro estudio", async () => {
    const p = await ec.compra(X, cx, { serie: "F001", numero: numero() });
    const q = await ec.compra(X, cx, { serie: "F001", numero: numero() });
    await ec.version(X, q.id, 2); // solo Q tiene versión 2
    const r2 = await ec.compra(X, cx, { serie: "F001", numero: numero() });
    await ec.version(X, r2.id, 2);
    const ajena = await ec.compra(Y, cy, { serie: "F001", numero: numero() });
    await ec.version(Y, ajena.id, 2);

    const intentos = await worker.withTenant({ tenantId: X }, async (tx) => ({
      versionAjena: await probar(
        tx,
        "update compra set version_vigente = 2 where id = $1",
        [p.id],
      ),
      retroceso: await probar(
        tx,
        "update compra set version_vigente = 1 where id = $1",
        [r2.id],
      ),
      descartar: await probar(
        tx,
        "update compra set descartada_en = now() where id = $1",
        [p.id],
      ),
      identidad: await probar(
        tx,
        "update compra set razon_social = 'X' where id = $1",
        [p.id],
      ),
      otroEstudio: await probar(
        tx,
        "update compra set version_vigente = version_vigente where id = $1",
        [ajena.id],
      ),
    }));
    expect(intentos.versionAjena).toMatchObject({ ok: false, code: "42501" });
    expect(intentos.retroceso).toMatchObject({ ok: false, code: "42501" });
    expect(intentos.descartar).toMatchObject({ ok: false, code: "42501" });
    expect(intentos.identidad).toMatchObject({ ok: false, code: "42501" });
    // H-016-8: sin privilegio UPDATE sobre compra, el worker falla antes de mirar filas (RLS incluida): 42501, no 0 filas.
    expect(intentos.otroEstudio).toMatchObject({ ok: false, code: "42501" });
    expect(await punteroDe(admin, p.id)).toBe(1);
    expect(await punteroDe(admin, r2.id)).toBe(2);
  });
});

// =================================================================================================
describe("T21 · encolar_xml_obtener (0037): escalar con la función SECURITY DEFINER", () => {
  const SQL = "select * from public.encolar_xml_obtener($1::uuid, $2::text, $3::uuid[], $4::uuid)";
  const lote = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();
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

  it("A4 · el tope atómico no se salta escribiendo el mismo estudio de otra forma (mayúsculas) en app.tenant_id", async () => {
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
      // 1) Encola con el estudio en su forma canónica y RETIENE el candado (estudio, cola) sin confirmar.
      const primera = worker.withTenant({ tenantId: T }, async (tx) => {
        const r = await probar(tx, SQL, [ct.id, "202610", lote(2), null]);
        avisar();
        await espera;
        return r;
      });
      await primeraDentro;
      // 2) La misma sesión del worker, el mismo estudio en mayúsculas: la RLS lo acepta (::uuid), el candado no es el mismo.
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
      expect(await enColaXml(T), "nunca más pendientes que el tope").toBeLessThanOrEqual(2);
      expect(codigos).toEqual(["53400", "ok"]);
      expect(
        temprano,
        "la segunda debe esperar el candado (estudio, cola) de la primera",
      ).toBe("espera");
    });
  });

  it("A5 · search_path y objetos temporales no la desvían: con tablas pg_temp que imitan config/cliente/job, sigue usando public", async () => {
    const T2 = (await ec.estudio()).id;
    const c2 = await ec.cliente(T2);
    await ec.job(T2, c2, {
      tipo: "xml.obtener",
      cola: "xml",
      canal: "ninguno",
      prioridad: "programado",
      estado: "en_cola",
    });
    await conTope(1, async () => {
      const r = await worker.withTenant({ tenantId: T2 }, async (tx) => {
        const temp = await probar(
          tx,
          "create temp table config_sistema (cola text, reintentos int, max_pendientes_tenant int)",
        );
        if (temp.ok) {
          await tx.query("insert into pg_temp.config_sistema values ('xml', 9, 100000)");
          await tx.query("create temp table job_registro (like public.job_registro)");
          await tx.query("create temp table cliente (tenant_id uuid, id uuid, ruc text)");
        }
        await tx.query("set local search_path = pg_temp, public");
        const llamada = await probar(tx, SQL, [c2.id, "202610", lote(2), null]);
        const sombra =
          temp.ok
            ? Number((await tx.query("select count(*)::int as n from pg_temp.job_registro")).rows[0].n)
            : 0;
        return { temp, llamada, sombra };
      });
      // Sin TEMP (42501) o con él: la función usa config_sistema de public (tope 1 ya lleno) y no escribe en la sombra.
      expect(r.llamada).toMatchObject({ ok: false, code: "53400" });
      expect(r.sombra).toBe(0);
    });
    expect(await enColaXml(T2)).toBe(1);
  });
});

// =================================================================================================
describe("T21 · llegada del XML contra rehacer y dos llegadas del mismo XML (D-5, P-6, CA-8)", () => {
  const rehacer = (tx: Tx, e: unknown, f: unknown) =>
    exportado<(tx: Tx, e: unknown, f: unknown) => Promise<unknown>>("rehacer")(tx, e, f);

  it("A6 · 5 rondas: rehacer y la llegada del XML a la vez, en ambos órdenes; sin 40P01 y la versión final evaluada con el XML", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const usuario = (await ec.miembro(X, "contador")).id;
      const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
      const { evaluar } = evaluadorXml();
      await backend.withTenant({ tenantId: X }, (tx) =>
        aplicarAccion(
          tx,
          {
            compraId: s.id,
            versionBase: 1,
            accion: "editar",
            parametros: { tipo: "bi", valor: "900.00" },
            usuarioId: usuario,
          },
          { transformar: transformarFalso, evaluar },
        ),
      );
      await backend.withTenant({ tenantId: X }, (tx) =>
        deshacer(tx, { clienteId: cx.id, periodo: PERIODO, usuarioId: usuario }, { evaluar }),
      );
      const desfase = ronda % 2 === 0 ? 0 : 8;
      const llegada = worker.withTenant({ tenantId: X }, async (tx) => {
        if (ronda % 2 === 1) await new Promise((r) => setTimeout(r, desfase));
        const g = await guardarDocumentoXml(tx, entradaXml(X, cx.id, s.identidad, { origen: "real" }));
        await reevaluarCompra(tx, s.id, { evaluar });
        return g;
      });
      const repone = backend.withTenant({ tenantId: X }, async (tx) => {
        if (ronda % 2 === 0) await new Promise((r) => setTimeout(r, 8));
        return rehacer(tx, { clienteId: cx.id, periodo: PERIODO, usuarioId: usuario }, { evaluar });
      });
      const r = await Promise.allSettled([llegada, repone]);
      expect(
        r.map((x) => (x.status === "fulfilled" ? "ok" : String((x.reason as { code?: string }).code))),
        `ronda ${ronda}`,
      ).toEqual(["ok", "ok"]);
      expect(await versionesN(admin, s.id), `ronda ${ronda}`).toEqual([1, 2, 3, 4]);
      const xml = (await xmlsDe(admin, cx.id, s.identidad))[0]!;
      const ultima = (await evaluacionesDe(admin, s.id)).filter((e) => e.version_n === 4).at(-1)!;
      expect(ultima.documento_xml_id, `ronda ${ronda}: la versión 4 queda evaluada con el XML`).toBe(xml.id);
    }
  });

  it("A7 · 10 rondas: el worker (simulado) y la subida (subido) llegan a la vez; la última evaluación usa SIEMPRE el XML vigente", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const s = await ec.compraXml(X, cx, { serie: "F001", numero: numero() });
      const evaluar: EvaluarConXml = evaluadorXml().evaluar;
      const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const delWorker = worker.withTenant({ tenantId: X }, async (tx) => {
        if (ronda % 2 === 1) await espera(ronda);
        const g = await guardarDocumentoXml(tx, entradaXml(X, cx.id, s.identidad, { origen: "simulado" }));
        if (g !== "existente_no_simulado") await reevaluarCompra(tx, s.id, { evaluar });
        return g;
      });
      const subida = backend.withTenant({ tenantId: X }, async (tx) => {
        if (ronda % 2 === 0) await espera(ronda);
        const g = await guardarDocumentoXml(
          tx,
          entradaXml(X, cx.id, s.identidad, { origen: "subido", subidoPor: ux }),
        );
        if (g !== "existente_no_simulado") await reevaluarCompra(tx, s.id, { evaluar });
        return g;
      });
      const r = await Promise.allSettled([delWorker, subida]);
      expect(r.map((x) => x.status), `ronda ${ronda}`).toEqual(["fulfilled", "fulfilled"]);
      const xmls = await xmlsDe(admin, cx.id, s.identidad);
      const vigente = xmls.at(-1)!;
      expect(vigente.origen, `ronda ${ronda}: el subido siempre queda vigente`).toBe("subido");
      const ultima = (await evaluacionesDe(admin, s.id)).at(-1)!;
      expect(ultima.documento_xml_id, `ronda ${ronda}: la última evaluación usa el vigente`).toBe(vigente.id);
    }
  });
});

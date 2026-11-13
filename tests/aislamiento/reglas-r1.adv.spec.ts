// Spec 021 · T16: ronda adversarial 1 sobre la BD de reglas aprendidas (caja blanca: 0048 `aplicar_regla_historial`,
// `reglas_historial_vigentes`; 0049 `regla_aceptar_periodo`; trigger `periodo_worker_acotado` de 0039). Frentes: la función acotada
// del worker como última cerca de D-7, cambio de estudio a mitad de la transacción, qué cuenta como «aceptada» y confirmación para
// el catálogo (P-1, P-4, D-3), el worker que intenta fabricar aceptaciones, y canarios en los errores de las funciones (D-10).
// Una prueba marcada `it.fails` es un hallazgo H-021-1-n (convención de 022 T3); las demás quedan como regresión.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { enRollback, type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  aplicar,
  compraDelWorker,
  consolidar,
  datosJson,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  montos,
  type Destino,
  type Montos,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Y: string;
let ux: string;
let errSiembra: unknown;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioReglas(admin);
  try {
    X = (await ec.estudio()).id;
    Y = (await ec.estudio()).id;
    ux = await ec.usuarioDe(X);
  } catch (e) {
    errSiembra = e;
  }
  worker = crearDb("contapp_worker", 3);
  backend = crearDb("contapp_backend", 3);
});
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

let consecutivo = 0;
const doc = () => `20${String(810000000 + ++consecutivo)}`;
const num = () => String(9100 + ++consecutivo);

/** SQLSTATE de una sentencia dentro de un SAVEPOINT (o 'ok'), sin abortar la transacción. */
async function estado(tx: Tx, sql: string, valores: unknown[]): Promise<string> {
  await tx.query("SAVEPOINT adv");
  try {
    await tx.query(sql, valores);
    await tx.query("RELEASE SAVEPOINT adv");
    return "ok";
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT adv");
    return String((e as { code?: string }).code ?? "sin_codigo");
  }
}
const SQL_APLICAR = "select public.aplicar_regla_historial($1, $2, $3::jsonb)";

// ===================================================================================================================
// aplicar_regla_historial: la última cerca de D-7 (falla cerrado)
// ===================================================================================================================

describe("R1 · aplicar_regla_historial no crea una versión `historial` que no mueve nada (D-6, D-7, CA-4)", () => {
  /** Compra nueva del proveedor con la versión 1 `m`, regla DNG; intenta aplicar con la consolidación exacta en DNG. */
  async function intentarNoOp(m: Montos): Promise<string> {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    return enRollback(worker, { tenantId: X }, async (tx) => {
      const compra = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d, montos: m });
      return estado(tx, SQL_APLICAR, [compra, regla, JSON.stringify(datosJson(consolidar(m, "DNG")))]);
    });
  }

  // H-021-1-3: la función no exige base gravada ≠ 0; una fila solo con no gravado sale de «sin clasificar» con la etiqueta.
  it.fails("H-021-1-3 · compra sin base gravada (solo no gravado): 42501, nunca la versión 2 `historial` clasificada", async () => {
    expect(await intentarNoOp(montos({ noGravado: "500.00" }))).toBe("42501");
  });

  // H-021-1-4: la función no exige que algo cambie; con la versión 1 ya en el destino crea una versión 2 idéntica y clasificada.
  it.fails("H-021-1-4 · versión 1 ya en el destino de la regla: 42501, nunca una versión 2 idéntica marcada «Según historial»", async () => {
    expect(await intentarNoOp(montos({ biDng: "1000.00", igvDng: "180.00" }))).toBe("42501");
  });
});

describe("R1 · cambio de estudio (set_config) a mitad de la transacción del worker (CA-5, D-6)", () => {
  it("compra creada en X: bajo Y no se lee la regla de X ni se aplica la de Y; al volver a X, sí (control)", async () => {
    const cx = await ec.cliente(X);
    const cy = await ec.cliente(Y);
    const propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const reglaX = await ec.regla(X, cx, { docNumero: d, destino: "DNG" });
    const reglaY = await ec.regla(Y, cy, { docNumero: d, destino: "DNG" });
    const datos = JSON.stringify(datosJson(consolidar(FACTURA_DG, "DNG")));
    const r = await enRollback(worker, { tenantId: X }, async (tx) => {
      const compra = await compraDelWorker(tx, cx.id, propX, DESCARGA, { numero: num(), docNumero: d });
      await tx.query("select set_config('app.tenant_id', $1, true)", [Y]);
      const vigentesY = (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [cx.id, DESCARGA])).rows;
      const conReglaY = await estado(tx, SQL_APLICAR, [compra, reglaY, datos]);
      const conReglaX = await estado(tx, SQL_APLICAR, [compra, reglaX, datos]);
      await tx.query("select set_config('app.tenant_id', $1, true)", [X]);
      const control = await estado(tx, SQL_APLICAR, [compra, reglaX, datos]);
      return { vigentesY, conReglaY, conReglaX, control };
    });
    expect(r).toEqual({ vigentesY: [], conReglaY: "42501", conReglaX: "42501", control: "ok" });
  });
});

// ===================================================================================================================
// regla_aceptar_periodo: qué cuenta como aceptada y como confirmación para el catálogo (P-1, P-4, D-3)
// ===================================================================================================================

const fijarEstadoPeriodo = (tx: Tx, clienteId: string, periodo: string, desde: string, hacia: string, usuarioId: string) =>
  exportado<(tx: Tx, c: string, p: string, d: string, h: string, u: string) => Promise<unknown>>("fijarEstadoPeriodo")(
    tx,
    clienteId,
    periodo,
    desde,
    hacia,
    usuarioId,
  );

interface Escenario {
  c: ClientePrueba;
  regla: string;
  compras: string[];
}

/** Cliente con una regla DNG y `n` compras de 202610 con versión 2 `historial` (por la función real de 0048), periodo abierto. */
async function escenario(n: number, destino: Destino = "DNG"): Promise<Escenario> {
  const c = await ec.cliente(X);
  const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
  const d = doc();
  const regla = await ec.regla(X, c, { docNumero: d, destino });
  await ec.estadoPeriodo(X, c, DESCARGA, "abierto", null);
  const compras = await worker.withTenant({ tenantId: X }, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { serie: "F88", numero: num(), docNumero: d });
      await aplicar(tx, id, regla, consolidar(FACTURA_DG, destino));
      ids.push(id);
    }
    return ids;
  });
  return { c, regla, compras };
}
const revisar = (e: Escenario) =>
  backend.withTenant({ tenantId: X, userId: ux }, (tx) => fijarEstadoPeriodo(tx, e.c.id, DESCARGA, "abierto", "revisado", ux));
const aceptadas = async (regla: string): Promise<string[]> =>
  (
    await admin.query(
      `select p.compra_id from regla_aceptacion a join regla_aplicacion p on p.id = a.regla_aplicacion_id
        where a.regla_id = $1 order by p.compra_id`,
      [regla],
    )
  ).rows.map((r) => r.compra_id as string);
const confirmacionesAceptadas = async (regla: string): Promise<{ destino: string }[]> =>
  (await admin.query("select destino from regla_confirmacion where regla_id = $1 and origen = 'aceptada'", [regla])).rows;

describe("R1 · regla_aceptar_periodo (P-1: «una clasificación manual sin Recordar no cuenta»)", () => {
  // H-021-1-5: el trigger compara la versión vigente con el destino ACTUAL de la regla y no mira si sigue siendo la versión
  // `historial`: tras editar la regla (DNG → DG), la fila que el contador movió a mano a DG cuenta como aceptada y aporta una
  // confirmación `aceptada` DG al catálogo entre estudios (033).
  it.fails("H-021-1-5 · regla editada DNG → DG después de la descarga y fila movida a DG a mano: no es aceptada ni confirma DG", async () => {
    const e = await escenario(2);
    await admin.query("update regla_aprendida set destino = 'DG', version = version + 1 where id = $1", [e.regla]);
    await ec.version(X, e.compras[0]!, 3, { accion: "editar", usuarioId: ux, montos: consolidar(FACTURA_DG, "DG") });
    await revisar(e);
    expect(await aceptadas(e.regla)).not.toContain(e.compras[0]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });

  // H-021-1-6: una fila «Según historial» que el contador excluyó del registro (versión vigente `excluida = true`) cuenta como
  // aceptada y confirma el destino para el catálogo, aunque el contador rechazó la fila.
  it.fails("H-021-1-6 · fila «Según historial» excluida después: no es aceptada ni deja confirmación", async () => {
    const e = await escenario(1);
    await ec.version(X, e.compras[0]!, 3, { accion: "excluir", excluida: true, motivo: "no corresponde", usuarioId: ux });
    await revisar(e);
    expect(await aceptadas(e.regla)).toEqual([]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });

  it("el worker no puede pasar el periodo a `revisado` (ni crearlo así) para fabricar aceptaciones y confirmaciones", async () => {
    const e = await escenario(2);
    const r = await enRollback(worker, { tenantId: X }, async (tx) => ({
      actualizar: await estado(
        tx,
        "update compra_periodo set estado = 'revisado', marcado_por = $3, marcado_en = now() where cliente_id = $1 and periodo = $2",
        [e.c.id, DESCARGA, ux],
      ),
      crear: await estado(
        tx,
        "insert into compra_periodo (cliente_id, periodo, estado, marcado_por, marcado_en) values ($1, '202611', 'revisado', $2, now())",
        [e.c.id, ux],
      ),
    }));
    expect(r).toEqual({ actualizar: "42501", crear: "42501" });
    expect(await aceptadas(e.regla)).toEqual([]);
    expect(await confirmacionesAceptadas(e.regla)).toEqual([]);
  });
});

// ===================================================================================================================
// Canarios en los errores de las funciones acotadas (D-10, CA-13)
// ===================================================================================================================

describe("R1 · canarios en los errores de las funciones (D-10)", () => {
  it("con RUC y montos como entrada, los rechazos de aplicar_regla_historial y reglas_historial_vigentes no los repiten", async () => {
    const c = await ec.cliente(X);
    const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const d = doc();
    const regla = await ec.regla(X, c, { docNumero: d, destino: "DNG" });
    const canarioMonto = "987654.32";
    const errores = await enRollback(worker, { tenantId: X }, async (tx) => {
      const compra = await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: num(), docNumero: d });
      const sal: { code?: string; message?: string; detail?: string; hint?: string; where?: string }[] = [];
      for (const [sql, valores] of [
        [SQL_APLICAR, [compra, regla, JSON.stringify({ ...datosJson(consolidar(FACTURA_DG, "DNG")), bi_dng: canarioMonto })]],
        [SQL_APLICAR, [compra, regla, JSON.stringify({ ...datosJson(consolidar(FACTURA_DG, "DNG")), ruc: d })]],
        [SQL_APLICAR, [compra, regla, JSON.stringify({ ...datosJson(consolidar(FACTURA_DG, "DNG")), isc: d })]],
        ["select * from public.reglas_historial_vigentes($1, $2)", [c.id, d]],
      ] as const) {
        await tx.query("SAVEPOINT adv");
        try {
          await tx.query(sql, [...valores]);
          sal.push({ code: "ok" });
        } catch (err) {
          const x = err as { code?: string; message?: string; detail?: string; hint?: string; where?: string };
          sal.push({ code: x.code, message: x.message, detail: x.detail, hint: x.hint, where: x.where });
        }
        await tx.query("ROLLBACK TO SAVEPOINT adv");
      }
      return sal;
    });
    expect(errores.map((x) => x.code)).toEqual(["42501", "42501", "42501", "22023"]);
    const texto = JSON.stringify(errores);
    expect(texto).not.toContain(d);
    expect(texto).not.toContain(canarioMonto);
    expect(texto).not.toContain(c.id);
  });
});

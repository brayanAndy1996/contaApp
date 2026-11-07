// Spec 014 (T6, rojo): estado del periodo, entrega a 012b y lecturas del persistidor contra la BD real (CA-10, CA-12, CA-14,
// CA-17; D-4, D-9, D-10, D-18, plan «Contrato real de 013» puntos 4, 8 y 9). Funciones de prueba para lo que inyecta quien llama.
//
// FIRMAS que fija (T12). Todas con la `tx` de `withTenant` como primer argumento; montos y fechas como cadenas.
//   leerEstadoPeriodo(tx, clienteId, periodo, opciones?: { compartido?: boolean }): Promise<EstadoPeriodo>
//   fijarEstadoPeriodo(tx, clienteId, periodo, desde, hacia, usuarioId): Promise<EstadoPeriodo | null>
//       EstadoPeriodo = { estado: 'abierto' | 'revisado' | 'generado'; marcadoPor: string | null; marcadoEn: Date | null }.
//       Sin fila el estado es abierto. `compartido: true` crea la fila si falta (INSERT ... ON CONFLICT DO NOTHING) y la lee con
//       FOR SHARE. fijarEstadoPeriodo es compare-and-set con FOR UPDATE: null si el estado vigente no era `desde`; fija
//       marcado_por y marcado_en. Un estado fuera de los tres valores lanza.
//   leerFilasReemplazo(tx, clienteId, periodo, aFila: (c: CompraLeida) => T): Promise<{ original: T[]; vigente: T[] }>
//       `aFila` la inyecta quien llama (por lo comun aFilaReemplazo de dominio). original: la version 1 de las compras de origen
//       sire (todas, tambien las que despues se excluyeron; version = 1, excluida = false). vigente: la version vigente de las
//       compras vivas (sire y agregadas, excluidas incluidas con excluida = true; las descartadas no). Orden por clave.
//   leerExistentesCompras(tx, clienteId, periodo): Promise<{ clave: string; origen: 'sire' | 'manual'; campos: Record<string, string> }[]>
//       Las vivas del periodo (excluidas incluidas, descartadas no). `agregada` se informa como `manual` (013, punto 8). `campos`
//       salen de la VERSION 1 (nunca de la vigente): fecha, moneda, tipoCambio ('' si no hay), el documento del proveedor, las 10
//       columnas de montos y total, todas cadenas con la escala de la columna; nunca la razon social (D-18).
//       Se llama con el bloqueo advisory tomado; se llama `leerExistentesCompras` (no `leerExistentes`) porque 013 ya exporta ese
//       nombre para ventas desde `@contapp/db`.
//   leerProveedoresConocidos(tx, clienteId, periodo): Promise<{ tipo: string; numero: string }[]>
//       Documentos distintos de los proveedores de las compras vivas o excluidas del cliente en OTROS periodos (sin el periodo
//       consultado, sin las descartadas), ordenados por (tipo, numero). Sin historial: [] (todos los proveedores son nuevos, DU-7).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  codigoDe,
  conPlazo,
  contarFilas,
  COLUMNAS_MONTO,
  EscenarioCompras,
  MONTOS_DG,
  PERIODO,
  type CompraLeida,
} from "./compras-soporte";

interface EstadoPeriodo {
  estado: "abierto" | "revisado" | "generado";
  marcadoPor: string | null;
  marcadoEn: Date | null;
}
interface Existente {
  clave: string;
  origen: "sire" | "manual";
  campos: Record<string, string>;
}
const leerEstadoPeriodo = (
  tx: Tx,
  c: string,
  p: string,
  o?: { compartido?: boolean },
) =>
  exportado<
    (tx: Tx, c: string, p: string, o?: unknown) => Promise<EstadoPeriodo>
  >("leerEstadoPeriodo")(tx, c, p, o);
const fijarEstadoPeriodo = (
  tx: Tx,
  c: string,
  p: string,
  desde: string,
  hacia: string,
  u: string,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string,
      h: string,
      u: string,
    ) => Promise<EstadoPeriodo | null>
  >("fijarEstadoPeriodo")(tx, c, p, desde, hacia, u);
const leerFilasReemplazo = <T>(
  tx: Tx,
  c: string,
  p: string,
  aFila: (x: CompraLeida) => T,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      f: (x: CompraLeida) => T,
    ) => Promise<{ original: T[]; vigente: T[] }>
  >("leerFilasReemplazo")(tx, c, p, aFila);
const leerExistentesCompras = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<Existente[]>>(
    "leerExistentesCompras",
  )(tx, c, p);
const leerProveedoresConocidos = (tx: Tx, c: string, p: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
    ) => Promise<{ tipo: string; numero: string }[]>
  >("leerProveedoresConocidos")(tx, c, p);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let ux: string;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  ux = await ec.usuarioDe(X);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const estadoEn = async (c: ClientePrueba, periodo = PERIODO) =>
  (
    await admin.query(
      "select estado, marcado_por from compra_periodo where cliente_id = $1 and periodo = $2",
      [c.id, periodo],
    )
  ).rows;

/** Mantiene una transaccion abierta (con lo que haga `fn` dentro) hasta que se llame a `soltar`. */
function sostener<T>(db: ContappDb, fn: (tx: Tx) => Promise<T>) {
  let soltar!: () => void;
  let adentro!: () => void;
  const espera = new Promise<void>((r) => (soltar = r));
  const dentro = new Promise<void>((r) => (adentro = r));
  const fin = db.withTenant({ tenantId: X }, async (tx) => {
    const v = await fn(tx);
    adentro();
    await espera;
    return v;
  });
  return {
    dentro: Promise.race([dentro, fin.then(() => undefined)]),
    soltar,
    fin,
  };
}

// =================================================================================================
describe("estado del periodo (D-9, DU-4, CA-12)", () => {
  it("sin fila el periodo esta abierto y leer sin compartido no crea nada; con compartido crea la fila una sola vez", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) => leerEstadoPeriodo(tx, c.id, PERIODO)),
    ).toEqual({ estado: "abierto", marcadoPor: null, marcadoEn: null });
    expect(await estadoEn(c)).toEqual([]);
    expect(
      (
        await comoBackend((tx) =>
          leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
        )
      ).estado,
    ).toBe("abierto");
    expect(
      (
        await comoBackend((tx) =>
          leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
        )
      ).estado,
    ).toBe("abierto");
    expect(await estadoEn(c)).toEqual([
      { estado: "abierto", marcado_por: null },
    ]);
  });

  it("lee el estado sembrado con quien lo marco y cuando", async () => {
    const c = await ec.cliente(X);
    await ec.estadoPeriodo(X, c, PERIODO, "revisado", ux);
    const e = await comoBackend((tx) =>
      leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
    );
    expect(e).toEqual({
      estado: "revisado",
      marcadoPor: ux,
      marcadoEn: expect.any(Date),
    });
  });

  it("compare-and-set: abierto -> revisado marca quien y cuando (aun sin fila previa); repetirlo devuelve null y no cambia nada", async () => {
    const c = await ec.cliente(X);
    const r = await comoBackend((tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(r).toEqual({
      estado: "revisado",
      marcadoPor: ux,
      marcadoEn: expect.any(Date),
    });
    expect(await estadoEn(c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
    expect(
      await comoBackend((tx) =>
        fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux),
      ),
    ).toBeNull();
    expect(
      await comoBackend((tx) =>
        fijarEstadoPeriodo(tx, c.id, PERIODO, "generado", "abierto", ux),
      ),
      "el estado esperado no es el vigente",
    ).toBeNull();
    expect(await estadoEn(c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
  });

  it("reabrir: revisado -> abierto y generado -> abierto; el worker (012b) marca generado", async () => {
    const c = await ec.cliente(X);
    await comoBackend((tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(
      (
        await comoBackend((tx) =>
          fijarEstadoPeriodo(tx, c.id, PERIODO, "revisado", "abierto", ux),
        )
      )?.estado,
    ).toBe("abierto");
    await comoBackend((tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    const g = await worker.withTenant({ tenantId: X }, (tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "revisado", "generado", ux),
    );
    expect(g?.estado).toBe("generado");
    expect(
      (
        await comoBackend((tx) =>
          fijarEstadoPeriodo(tx, c.id, PERIODO, "generado", "abierto", ux),
        )
      )?.estado,
    ).toBe("abierto");
  });

  it("un estado fuera de abierto, revisado y generado no se guarda", async () => {
    const c = await ec.cliente(X);
    expect(
      await codigoDe(
        comoBackend((tx) =>
          fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "cerrado", ux),
        ),
      ),
    ).not.toBe("ok");
    expect(await estadoEn(c)).not.toContainEqual({
      estado: "cerrado",
      marcado_por: ux,
    });
  });

  it("20 rondas: dos cambios simultaneos abierto -> revisado, uno gana y el otro recibe null", async () => {
    for (let ronda = 0; ronda < 20; ronda++) {
      const c = await ec.cliente(X);
      const llegar = barrera(2);
      const cambiar = () =>
        comoBackend(async (tx) => {
          await llegar();
          return fijarEstadoPeriodo(
            tx,
            c.id,
            PERIODO,
            "abierto",
            "revisado",
            ux,
          );
        });
      const r = await Promise.all([cambiar(), cambiar()]);
      expect(
        r.filter((x) => x !== null),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      expect(await estadoEn(c)).toEqual([
        { estado: "revisado", marcado_por: ux },
      ]);
    }
  });

  it("FOR SHARE frente a FOR UPDATE: cambiar el estado espera a quien lo esta leyendo en una accion, y viceversa", async () => {
    const c = await ec.cliente(X);
    await ec.estadoPeriodo(X, c, PERIODO, "abierto");
    // 1) una accion en curso (FOR SHARE, sin confirmar) retiene el cambio de estado.
    const accion = sostener(backend, (tx) =>
      leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
    );
    await accion.dentro;
    const cambio = comoBackend((tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(
      await conPlazo(cambio, 500),
      "el cambio de estado debe esperar a la accion",
    ).toBe("pendiente");
    accion.soltar();
    await accion.fin;
    expect((await cambio)?.estado).toBe("revisado");
    // 2) un cambio de estado en curso (FOR UPDATE, sin confirmar) retiene a la accion siguiente, que luego ve el estado nuevo.
    const reabrir = sostener(backend, (tx) =>
      fijarEstadoPeriodo(tx, c.id, PERIODO, "revisado", "abierto", ux),
    );
    await reabrir.dentro;
    const siguiente = comoBackend((tx) =>
      leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
    );
    expect(
      await conPlazo(siguiente, 500),
      "la accion debe esperar al cambio de estado",
    ).toBe("pendiente");
    reabrir.soltar();
    await reabrir.fin;
    expect((await siguiente).estado).toBe("abierto");
  });

  it("dos acciones (FOR SHARE) no se bloquean entre si", async () => {
    const c = await ec.cliente(X);
    await ec.estadoPeriodo(X, c, PERIODO, "abierto");
    const una = sostener(backend, (tx) =>
      leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
    );
    await una.dentro;
    const otra = comoBackend((tx) =>
      leerEstadoPeriodo(tx, c.id, PERIODO, { compartido: true }),
    );
    expect(await conPlazo(otra, 1500)).not.toBe("pendiente");
    una.soltar();
    await una.fin;
  });
});

// =================================================================================================
describe("leerFilasReemplazo · entrega a 012b (D-10, CA-14)", () => {
  it("original = version 1 de las filas del SIRE; vigente = version vigente de las vivas (excluidas con su estado, agregadas dentro, descartadas fuera)", async () => {
    const c = await ec.cliente(X);
    const s1 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "1",
      propuestaId: propX,
      montos: MONTOS_DG,
    });
    const s2 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "2",
      propuestaId: propX,
      montos: MONTOS_DG,
    });
    await ec.version(X, s2.id, 2, {
      montos: { biDg: "900.00", igvDg: "162.00" },
      clasificada: true,
    });
    const s3 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "3",
      propuestaId: propX,
      montos: MONTOS_DG,
    });
    await ec.version(X, s3.id, 2, {
      excluida: true,
      motivo: "zapatillas",
      accion: "excluir",
    });
    const s4 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "4",
      propuestaId: propX,
      moneda: "USD",
      tipoCambio: "3.456",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
    const a1 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "5",
      origen: "agregada",
      montos: MONTOS_DG,
    });
    const a2 = await ec.compra(X, c, {
      serie: "FL01",
      numero: "6",
      origen: "agregada",
      montos: MONTOS_DG,
    });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      a2.id,
    ]);
    await ec.compra(X, c, {
      serie: "FL01",
      numero: "7",
      periodo: "202609",
      propuestaId: propX,
    });
    await ec.compra(X, cx, { serie: "FL01", numero: "8", propuestaId: propX });

    const r = await comoBackend((tx) =>
      leerFilasReemplazo(tx, c.id, PERIODO, (x) => x),
    );
    const por = (xs: CompraLeida[]) =>
      Object.fromEntries(xs.map((x) => [x.id, x]));
    const original = por(r.original);
    expect(
      Object.keys(original).sort(),
      "original: solo las del SIRE, tambien la que despues se excluyo",
    ).toEqual([s1.id, s2.id, s3.id, s4.id].sort());
    for (const x of r.original)
      expect(x, x.id).toMatchObject({
        version: 1,
        excluida: false,
        origen: "sire",
        periodo: PERIODO,
        clienteId: c.id,
      });
    expect(original[s2.id].montos).toEqual(MONTOS_DG);
    expect(original[s4.id]).toMatchObject({
      moneda: "USD",
      tipoCambio: "3.456",
    });

    const vigente = por(r.vigente);
    expect(
      Object.keys(vigente).sort(),
      "vigente: las vivas; la descartada no",
    ).toEqual([s1.id, s2.id, s3.id, s4.id, a1.id].sort());
    expect(vigente[s1.id]).toMatchObject({ version: 1, excluida: false });
    expect(vigente[s2.id]).toMatchObject({
      version: 2,
      excluida: false,
      clasificada: true,
    });
    expect(vigente[s2.id].montos).toMatchObject({
      biDg: "900.00",
      igvDg: "162.00",
      total: "1062.00",
    });
    expect(vigente[s3.id]).toMatchObject({
      version: 2,
      excluida: true,
      motivo: "zapatillas",
    });
    expect(vigente[a1.id]).toMatchObject({
      origen: "agregada",
      propuestaId: null,
      version: 1,
    });
    expect(vigente[s1.id]).toMatchObject({
      propuestaId: propX,
      serie: "FL01",
      numero: "1",
      tipoDoc: "01",
      docTipo: "6",
      docNumero: "20100070970",
    });
  });

  it("los montos y el tipo de cambio llegan como cadenas exactas (ningun number) y el resultado de aFila pasa tal cual", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, {
      serie: "FL02",
      numero: "1",
      propuestaId: propX,
      moneda: "USD",
      tipoCambio: "3.456",
      montos: { biDg: "21.48", igvDg: "1.61", noGravado: "8.97" },
    });
    const r = await comoBackend((tx) =>
      leerFilasReemplazo(tx, c.id, PERIODO, (x) => ({
        marca: x.clave,
        ...x.montos,
        tc: x.tipoCambio,
      })),
    );
    expect(r.vigente).toHaveLength(1);
    expect(r.vigente[0]).toMatchObject({
      biDg: "21.48",
      igvDg: "1.61",
      noGravado: "8.97",
      total: "32.06",
      tc: "3.456",
    });
    for (const k of COLUMNAS_MONTO)
      expect(typeof (r.vigente[0] as Record<string, unknown>)[k], k).toBe(
        "string",
      );
  });

  it("un periodo sin compras devuelve listas vacias; el estudio ajeno no ve las filas", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) =>
        leerFilasReemplazo(tx, c.id, PERIODO, (x) => x),
      ),
    ).toEqual({ original: [], vigente: [] });
    const f = await ec.compra(X, c, {
      serie: "FL03",
      numero: "1",
      propuestaId: propX,
    });
    const ajeno = await backend.withTenant({ tenantId: Y }, (tx) =>
      leerFilasReemplazo(tx, c.id, PERIODO, (x) => x),
    );
    expect(ajeno).toEqual({ original: [], vigente: [] });
    expect(f.id).toBeTruthy();
  });
});

// =================================================================================================
describe("leerExistentesCompras · lo que compara la descarga repetida (D-18, DU-2, CA-17)", () => {
  it("toma los campos de la VERSION 1 aunque la fila se haya corregido; las agregadas salen como manual; las descartadas no salen; las excluidas si", async () => {
    const c = await ec.cliente(X);
    const s1 = await ec.compra(X, c, {
      serie: "FE01",
      numero: "1",
      propuestaId: propX,
      montos: MONTOS_DG,
      razonSocial: "CANARIO-RAZON SAC",
    });
    await ec.version(X, s1.id, 2, {
      montos: { biDg: "770.00", igvDg: "138.60" },
    });
    const s2 = await ec.compra(X, c, {
      serie: "FE01",
      numero: "2",
      propuestaId: propX,
      moneda: "USD",
      tipoCambio: "3.456",
      fecha: "2026-10-09",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
    await ec.version(X, s2.id, 2, {
      excluida: true,
      motivo: "x",
      accion: "excluir",
    });
    const a1 = await ec.compra(X, c, {
      serie: "FE01",
      numero: "3",
      origen: "agregada",
      montos: MONTOS_DG,
    });
    const a2 = await ec.compra(X, c, {
      serie: "FE01",
      numero: "4",
      origen: "agregada",
    });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      a2.id,
    ]);
    await ec.compra(X, c, {
      serie: "FE01",
      numero: "5",
      periodo: "202609",
      propuestaId: propX,
    });

    const r = await comoBackend((tx) =>
      leerExistentesCompras(tx, c.id, PERIODO),
    );
    expect(r.map((x) => [x.clave, x.origen]).sort()).toEqual(
      [
        [s1.clave, "sire"],
        [s2.clave, "sire"],
        [a1.clave, "manual"],
      ].sort(),
    );
    const de = (clave: string) => r.find((x) => x.clave === clave)!.campos;
    expect(de(s1.clave)).toMatchObject({
      fecha: "2026-10-05",
      moneda: "PEN",
      tipoCambio: "",
      biDg: "1000.00",
      igvDg: "180.00",
      total: "1180.00",
    });
    expect(de(s2.clave)).toMatchObject({
      fecha: "2026-10-09",
      moneda: "USD",
      tipoCambio: "3.456",
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
  });

  it("los campos incluyen fecha, moneda, tipoCambio, el documento del proveedor, las 10 columnas de montos y total, todos cadenas, y nunca la razon social", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, {
      serie: "FE02",
      numero: "1",
      propuestaId: propX,
      razonSocial: "CANARIO-RAZON SAC",
      docNumero: "20100070970",
    });
    const [e] = await comoBackend((tx) =>
      leerExistentesCompras(tx, c.id, PERIODO),
    );
    expect(Object.keys(e.campos)).toEqual(
      expect.arrayContaining([
        "fecha",
        "moneda",
        "tipoCambio",
        ...COLUMNAS_MONTO,
        "total",
      ]),
    );
    expect(Object.values(e.campos).every((v) => typeof v === "string")).toBe(
      true,
    );
    expect(
      Object.values(e.campos).some((v) => v.includes("20100070970")),
      "el documento del proveedor entra en la comparacion",
    ).toBe(true);
    expect(JSON.stringify(e)).not.toContain("CANARIO-RAZON");
    expect(Object.keys(e.campos).some((k) => /raz/i.test(k))).toBe(false);
  });

  it("solo el periodo y el cliente consultados, y solo el estudio propio (RLS)", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, { serie: "FE03", numero: "1", propuestaId: propX });
    expect(
      await comoBackend((tx) => leerExistentesCompras(tx, c.id, "202609")),
    ).toEqual([]);
    expect(
      await comoBackend((tx) => leerExistentesCompras(tx, cx.id, PERIODO)).then(
        (r) => r.every((x) => !x.clave.includes("FE03")),
      ),
    ).toBe(true);
    expect(
      await backend.withTenant({ tenantId: Y }, (tx) =>
        leerExistentesCompras(tx, c.id, PERIODO),
      ),
    ).toEqual([]);
  });

  it("el worker (que persiste la descarga) tambien las lee", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, { serie: "FE04", numero: "1", propuestaId: propX });
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      leerExistentesCompras(tx, c.id, PERIODO),
    );
    expect(r).toHaveLength(1);
  });

  it("una agregada a mano que despues se descarta libera su clave: ya no figura entre los existentes", async () => {
    const c = await ec.cliente(X);
    const a = await ec.compra(X, c, {
      serie: "FE05",
      numero: "1",
      origen: "agregada",
    });
    expect(
      await comoBackend((tx) => leerExistentesCompras(tx, c.id, PERIODO)),
    ).toHaveLength(1);
    await admin.query("update compra set descartada_en = now() where id = $1", [
      a.id,
    ]);
    expect(
      await comoBackend((tx) => leerExistentesCompras(tx, c.id, PERIODO)),
    ).toEqual([]);
  });
});

// =================================================================================================
describe("leerProveedoresConocidos · el historial del cliente decide quien es nuevo (D-4, DU-7, CA-10)", () => {
  it("devuelve los documentos de otros periodos del mismo cliente, sin repetir; sin el periodo actual, sin descartadas y sin otros clientes ni estudios", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const ajeno = await ec.cliente(Y);
    const doc = (numero: string, tipo = "6") => ({
      docTipo: tipo,
      docNumero: numero,
    });
    await ec.compra(X, c, {
      periodo: "202609",
      serie: "FP01",
      numero: "1",
      propuestaId: propX,
      ...doc("20100000001"),
    });
    await ec.compra(X, c, {
      periodo: "202608",
      serie: "FP01",
      numero: "2",
      propuestaId: propX,
      ...doc("20100000001"),
    });
    const excl = await ec.compra(X, c, {
      periodo: "202609",
      serie: "FP01",
      numero: "3",
      propuestaId: propX,
      ...doc("20100000002"),
    });
    await ec.version(X, excl.id, 2, {
      excluida: true,
      motivo: "x",
      accion: "excluir",
    });
    await ec.compra(X, c, {
      periodo: "202608",
      serie: "FP01",
      numero: "4",
      propuestaId: propX,
      ...doc("12345678", "1"),
    });
    const descartada = await ec.compra(X, c, {
      periodo: "202609",
      serie: "FP01",
      numero: "5",
      origen: "agregada",
      ...doc("20100000003"),
    });
    await admin.query("update compra set descartada_en = now() where id = $1", [
      descartada.id,
    ]);
    await ec.compra(X, c, {
      periodo: PERIODO,
      serie: "FP01",
      numero: "6",
      propuestaId: propX,
      ...doc("20100000004"),
    });
    await ec.compra(X, otro, {
      periodo: "202609",
      serie: "FP01",
      numero: "7",
      propuestaId: propX,
      ...doc("20100000005"),
    });
    const propY = await ec.propuesta(Y, ajeno, { libro: "compras", nuevas: 1 });
    await ec.compra(Y, ajeno, {
      periodo: "202609",
      serie: "FP01",
      numero: "8",
      propuestaId: propY,
      ...doc("20100000006"),
    });

    const r = await comoBackend((tx) =>
      leerProveedoresConocidos(tx, c.id, PERIODO),
    );
    expect(r).toEqual([
      { tipo: "1", numero: "12345678" },
      { tipo: "6", numero: "20100000001" },
      { tipo: "6", numero: "20100000002" },
    ]);
  });

  it("el primer periodo de un cliente no tiene historial: lista vacia, todos los proveedores son nuevos (DU-7)", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, {
      periodo: PERIODO,
      serie: "FP02",
      numero: "1",
      propuestaId: propX,
    });
    expect(
      await comoBackend((tx) => leerProveedoresConocidos(tx, c.id, PERIODO)),
    ).toEqual([]);
  });

  it("una compra en otro periodo del mismo cliente hace conocido a su proveedor (CA-10)", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, {
      periodo: "202609",
      serie: "FP03",
      numero: "1",
      propuestaId: propX,
      docNumero: "20555555551",
    });
    const r = await comoBackend((tx) =>
      leerProveedoresConocidos(tx, c.id, PERIODO),
    );
    expect(r).toContainEqual({ tipo: "6", numero: "20555555551" });
  });

  it("el estudio ajeno no ve el historial de otro estudio", async () => {
    const c = await ec.cliente(X);
    await ec.compra(X, c, {
      periodo: "202609",
      serie: "FP04",
      numero: "1",
      propuestaId: propX,
    });
    expect(
      await backend.withTenant({ tenantId: Y }, (tx) =>
        leerProveedoresConocidos(tx, c.id, PERIODO),
      ),
    ).toEqual([]);
    expect(await contarFilas(admin, "compra", "cliente_id = $1", [c.id])).toBe(
      1,
    );
  });
});

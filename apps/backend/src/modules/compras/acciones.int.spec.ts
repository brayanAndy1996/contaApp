/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 (T9, rojo): acciones sobre una compra por HTTP: clasificar, editar, calcular, aceptar sugerencia, excluir,
// restaurar, agregar, descartar, deshacer, rehacer y estado del periodo (D-2 a D-9, D-11, D-14, D-16; CA-3 a CA-8, CA-11,
// CA-12, CA-13, CA-19; DU-18; p95 de CA-15). Las acciones masivas están en `masivas.int.spec.ts`.
//
// Contrato (plan 014, «Contratos: HTTP»; formas de `@contapp/shared/compras`; errores `{codigo}`):
//  - Rutas bajo `/clientes/:clienteId/periodos/:periodo/compras`. Cuerpos: clasificar `{versionBase, destino}`, editar
//    `{versionBase, cambios}`, calcular `{cambios}`, aceptar `POST /:id/sugerencias/aceptar {versionBase, regla, confirmar?,
//    dato?}`, excluir `{versionBase, motivo?}`, restaurar y descartar `{versionBase}`, agregar `POST ''` con el cuerpo de
//    `agregarCompraSchema`, deshacer y rehacer `POST /deshacer` y `/rehacer`, `POST /estado/revisar` y `/estado/reabrir`.
//  - Clasificar, editar, aceptar, excluir, restaurar y agregar responden `{ fila: FilaCompraVista, cuadre }` (`AccionCompraRespuesta`);
//    agregar con 201, las demás con 200. Calcular responde `{ total, cuadre }` sin escribir. Deshacer y rehacer `{ operacionId, filas }`.
//  - `versionBase` obsoleta: 409 `{ codigo: "version_obsoleta", versionVigente }` y no se escribe nada. Montos como cadenas.
//  - Permisos: acciones `sire.clasificar` (lectura: 403 `permiso_denegado`); reabrir `sire.aprobar_generar`. Estado del
//    periodo (D-9): `revisado` solo con `sire.aprobar_generar` (el resto 403 `periodo_revisado`); `generado` nadie (409
//    `periodo_generado`). Cliente archivado 409 `cliente_archivado`. Cliente de otro estudio, no asignado o inexistente, y
//    `compraId` de otro cliente, periodo o estudio: el mismo 404 `no_encontrado`. Sin sesión 401.
// SUPUESTOS que fijan estas pruebas y que el implementador (T16) puede rebatir con el arquitecto:
//  (a) el estado del periodo se comprueba ANTES que la versión base y que las precondiciones de la acción;
//  (b) la aceptación de una sugerencia contrasta el hallazgo GUARDADO de la versión base con la fila actual (re-evaluación);
//  (c) la `accion` de la versión es una de `ACCIONES_VERSION` de `@contapp/shared` (original, agregada, clasificar, editar,
//      sugerencia, excluir, restaurar, deshacer, rehacer).
// Rojo: el módulo `compras` aún no existe (T15 y T16): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { accionCompraRespuestaSchema, filaCompraVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  centimos,
  hallazgoIscSinXml,
  montos,
  p95,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
} from "../../../test/soporte-compras.js";
import { forma } from "../../../test/soporte.js";

// Siembras de miles de filas y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente"); // sin ningún cliente asignado
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const titular = (): Actor => E.titular;

/** Cliente de E (responsable: contador; colaboradores: asistente y lectura) con las 5 compras del fixture de 009. */
async function escenario(
  o: Parameters<BancoCompras["cliente"]>[1] = {},
  conocidos = true,
): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await v.cliente(E, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
  const ids = await v.sembrarFixture(E.tenantId, c.id, {
    usuarioId: E.titular.id,
    conocidos,
  });
  return { c, ids };
}

const post = (a: Actor, c: Cliente, ruta: string, cuerpo?: unknown) =>
  v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo ?? {});
const get = (a: Actor, c: Cliente, ruta = "") =>
  v.llamar(a, "GET", `${base(c.id)}${ruta}`);
const vigenteN = async (id: string): Promise<number> =>
  (await v.versiones(id)).at(-1)!.n;
const ultima = async (id: string) => (await v.versiones(id)).at(-1)!;

/** La respuesta cumple `AccionCompraRespuesta` de `@contapp/shared` (montos solo como cadenas). */
function esAccion(r: { status: number; body: any; text: string }) {
  const x = accionCompraRespuestaSchema.safeParse(r.body);
  expect(x.success, `${r.status} ${r.text}`).toBe(true);
  return r.body as {
    fila: z_Fila;
    cuadre: { cuadra: boolean; celdas: any[] };
  };
}
type z_Fila = ReturnType<typeof filaCompraVistaSchema.parse>;

const cuerpoAgregar = (
  serie: string,
  numero: string,
  extra: Record<string, unknown> = {},
) => ({
  tipo: "01",
  serie,
  numero,
  proveedor: {
    tipo: "6",
    numero: "20700000099",
    razonSocial: "PROVEEDOR AGREGADO SAC",
  },
  fecha: "2026-10-15",
  moneda: "PEN",
  montos: { biDg: "100.00", igvDg: "18.00" },
  ...extra,
});

// --- CA-4 · clasificar ----------------------------------------------------------------------------------------------

describe("CA-4 · clasificar (RF-062, D-5)", () => {
  it("F001-3064 de DG a DNG: BI e IGV pasan a las columnas 3, el total no cambia y la versión 1 queda intacta", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const antes = await v.versiones(id);
    const r = await post(titular(), c, `/${id}/clasificar`, {
      versionBase: 1,
      destino: "DNG",
    });
    expect(r.status, r.text).toBe(200);
    const { fila, cuadre } = esAccion(r);
    expect(fila).toMatchObject({
      id,
      version: 2,
      clasificada: true,
      excluida: false,
      origen: "sire",
    });
    expect(fila.montos).toEqual({
      biDg: "0.00",
      igvDg: "0.00",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "100.00",
      igvDng: "18.00",
      noGravado: "0.00",
      isc: "0.00",
      icbper: "1.50",
      otrosTributos: "0.00",
      total: "119.50",
    });
    expect(cuadre.cuadra).toBe(true);

    const vs = await v.versiones(id);
    expect(vs.map((x) => x.n)).toEqual([1, 2]);
    expect(vs[0]).toEqual(antes[0]); // la versión 1 no se toca (RNF-052)
    expect(vs[1]).toMatchObject({
      accion: "clasificar",
      clasificada: true,
      usuario_id: E.titular.id,
      biDng: "100.00",
      total: "119.50",
    });
    const cs = await v.compras(c.id);
    expect(cs.find((x) => x.id === id)!.version_vigente).toBe(2);
    // Una operación vigente del usuario y la versión 2 apunta a ella.
    const ops = await v.operaciones(c.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ usuario_id: E.titular.id, estado: "vigente" });
    expect(vs[1]!.operacion_id).toBe(ops[0]!.id);
  });

  it("no toca ninguna otra compra del periodo", async () => {
    const { c, ids } = await escenario();
    const otras = Object.entries(ids).filter(([k]) => k !== "F001-3064");
    const antes = await Promise.all(otras.map(([, id]) => v.versiones(id)));
    const r = await post(titular(), c, `/${ids["F001-3064"]}/clasificar`, {
      versionBase: 1,
      destino: "DGNG",
    });
    expect(r.status, r.text).toBe(200);
    const despues = await Promise.all(otras.map(([, id]) => v.versiones(id)));
    expect(despues).toEqual(antes);
  });

  it.each([
    ["destino inexistente", { versionBase: 1, destino: "XX" }],
    ["destino en minúsculas", { versionBase: 1, destino: "dng" }],
    ["sin destino", { versionBase: 1 }],
    ["sin versionBase", { destino: "DNG" }],
    ["versionBase cero", { versionBase: 0, destino: "DNG" }],
    ["versionBase como cadena", { versionBase: "1", destino: "DNG" }],
    ["versionBase decimal", { versionBase: 1.5, destino: "DNG" }],
  ])("400 solicitud_invalida y nada se escribe: %s", async (_n, cuerpo) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-3064"]}/clasificar`, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("D-2: versionBase obsoleta da 409 version_obsoleta con la versión vigente y no escribe", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect(
      (await post(titular(), c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" })).status,
    ).toBe(200);
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${id}/clasificar`, { versionBase: 1, destino: "DGNG" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("una versionBase del futuro tampoco vale (la base es siempre la vigente)", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 7, destino: "DNG" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "version_obsoleta", versionVigente: 1 });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("D-6: una compra excluida no se clasifica: 409 fila_excluida", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${id}/clasificar`, { versionBase: 2, destino: "DNG" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "fila_excluida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("la respuesta no trae nada del estudio, la clave interna ni la propuesta", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect(r.status, r.text).toBe(200);
    const texto = JSON.stringify(r.body);
    for (const prohibido of [E.tenantId, c.id, "tenant", "01|F001|3064", "propuesta"]) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });
});

// --- CA-5 · editar y DU-18 --------------------------------------------------------------------------------------------

describe("CA-5 · editar con cuadre por celda (RF-064, D-5)", () => {
  it("editar la BI: el total es Σ de las componentes y, si el IGV deja de cuadrar, la celda se marca con su explicación y aun así se guarda", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const r = await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "200.00" } });
    expect(r.status, r.text).toBe(200);
    const { fila, cuadre } = esAccion(r);
    expect(fila.version).toBe(2);
    expect(fila.montos).toMatchObject({ biDg: "200.00", igvDg: "18.00", icbper: "1.50", total: "219.50" });
    expect(cuadre.cuadra).toBe(false);
    const celda = cuadre.celdas.find((x) => x.columna === "igvDg");
    expect(celda).toBeDefined();
    expect(celda.cuadra).toBe(false);
    expect(typeof celda.explicacion).toBe("string");
    expect(celda.explicacion.length).toBeGreaterThan(0);
    // Se guardó pese al descuadre (HU-16): quien bloquea la generación es la prevalidación de 012.
    const u = await ultima(id);
    expect(u).toMatchObject({ n: 2, accion: "editar", biDg: "200.00", total: "219.50" });
  });

  it("una edición que cuadra no marca ninguna celda y su explicación es null", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { biDg: "200.00", igvDg: "36.00" },
    });
    expect(r.status, r.text).toBe(200);
    const { fila, cuadre } = esAccion(r);
    expect(fila.montos.total).toBe("237.50");
    expect(cuadre.cuadra).toBe(true);
    expect(cuadre.celdas.every((x) => x.cuadra && x.explicacion === null)).toBe(true);
  });

  it("acepta cualquier subconjunto de las 10 columnas y deja intactas las demás", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { otrosTributos: "2.00", isc: "3.00" },
    });
    expect(r.status, r.text).toBe(200);
    expect(esAccion(r).fila.montos).toMatchObject({
      biDg: "100.00",
      igvDg: "18.00",
      icbper: "1.50",
      isc: "3.00",
      otrosTributos: "2.00",
      total: "124.50",
    });
  });

  it("admite montos negativos (nota de crédito)", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { biDg: "-100.00", igvDg: "-18.00" },
    });
    expect(r.status, r.text).toBe(200);
    expect(esAccion(r).fila.montos).toMatchObject({ biDg: "-100.00", igvDg: "-18.00", total: "-116.50" });
  });

  it("el total no se edita: un `total` del cuerpo no llega a la fila (Σ de las columnas)", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { biDg: "150.00", total: "5.00" },
    });
    expect(r.status, r.text).toBe(200);
    expect(esAccion(r).fila.montos.total).toBe("169.50");
  });

  it("los campos de identidad del cuerpo (tenantId, usuarioId, origen) no se aplican", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const r = await post(titular(), c, `/${id}/editar`, {
      versionBase: 1,
      cambios: { biDg: "150.00" },
      tenantId: F.tenantId,
      usuarioId: randomUUID(),
      origen: "agregada",
    });
    expect(r.status, r.text).toBe(200);
    expect((await ultima(id)).usuario_id).toBe(E.titular.id);
    expect((await v.compras(c.id)).find((x) => x.id === id)!.origen).toBe("sire");
  });

  const MALOS: [string, unknown][] = [
    ["tres decimales (0.005)", { biDg: "0.005" }],
    ["tres decimales (0.015)", { igvDg: "0.015" }],
    ["fuera de NUMERIC(14,2)", { biDg: "1000000000000.00" }],
    ["fuera de rango negativo", { biDg: "-1000000000000.00" }],
    ["number en vez de cadena", { biDg: 100 }],
    ["texto", { biDg: "cien" }],
    ["notación científica", { biDg: "1e3" }],
    ["separador de miles", { biDg: "1,000.00" }],
    ["vacío", { biDg: "" }],
    ["null", { biDg: null }],
  ];
  it.each(MALOS)("400 solicitud_invalida y no escribe: %s", async (_n, cambios) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, { versionBase: 1, cambios });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each([
    ["sin cambios", { versionBase: 1 }],
    ["cambios no es objeto", { versionBase: 1, cambios: "biDg" }],
    ["cambios es un arreglo", { versionBase: 1, cambios: [] }],
    ["sin versionBase", { cambios: { biDg: "1.00" } }],
  ])("cuerpo mal formado: %s", async (_n, cuerpo) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("D-6: editar una compra excluida es 409 fila_excluida", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${id}/editar`, { versionBase: 2, cambios: { biDg: "1.00" } });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "fila_excluida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("D-2: editar con una versionBase obsoleta es 409 version_obsoleta", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "110.00" } })).status).toBe(200);
    const r = await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "120.00" } });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
  });

  it("re-evalúa la fila con la versión nueva (nota [014]): corregir el IGV de la mixta apaga su R-MIX", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const antes = await get(titular(), c, `/${id}`);
    expect(antes.status, antes.text).toBe(200);
    expect(antes.body.hallazgos.map((h: any) => h.regla)).toContain("R-MIX");
    const r = await post(titular(), c, `/${id}/editar`, {
      versionBase: 1,
      cambios: { biDg: "8.97", noGravado: "12.51" },
    });
    expect(r.status, r.text).toBe(200);
    expect(esAccion(r).fila.hallazgos.map((h) => h.regla)).not.toContain("R-MIX");
    expect((await v.hallazgosDe(id, 2)).map((h) => h.regla)).not.toContain("R-MIX");
  });
});

describe("DU-18 · editar con `cambios` vacío es 400 y no deja rastro", () => {
  it("400 solicitud_invalida: no crea versión, no crea operación y no altera compra_periodo", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const antes = await v.foto(c.id);
    expect(antes.periodo).toBeNull();
    const r = await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: {} });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    // La vigente no cambia ...
    expect(await vigenteN(id)).toBe(1);
    expect((await v.compras(c.id)).find((x) => x.id === id)!.version_vigente).toBe(1);
    // ... no hay operación (deshacer no tiene nada) ...
    expect(await v.operaciones(c.id)).toHaveLength(0);
    const d = await post(titular(), c, "/deshacer");
    expect(d.status, d.text).toBe(409);
    expect(d.body).toEqual({ codigo: "nada_que_deshacer" });
    // ... y compra_periodo queda como estaba.
    expect(await v.periodoFila(c.id)).toEqual(antes.periodo);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("`cambios` con solo `total` o claves desconocidas queda vacío tras descartarlas: también 400", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    for (const cambios of [{ total: "5.00" }, { desconocida: "1.00" }]) {
      const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, { versionBase: 1, cambios });
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("una edición con al menos una columna sí crea la versión (control)", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/editar`, { versionBase: 1, cambios: { biDg: "0.00" } });
    expect(r.status, r.text).toBe(200);
    expect(await vigenteN(ids["F001-3064"]!)).toBe(2);
  });
});

// --- CA-19 · calcular -------------------------------------------------------------------------------------------------

describe("CA-19 · calcular no escribe (RF-064, D-16)", () => {
  it("devuelve el mismo total y cuadre que daría editar, sin crear versión ni operación ni tocar compra_periodo", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const antes = await v.foto(c.id);
    const cambios = { biDg: "200.00" };
    const k = await post(titular(), c, `/${id}/calcular`, { cambios });
    expect(k.status, k.text).toBe(200);
    expect(k.body.total).toBe("219.50");
    expect(typeof k.body.cuadre.cuadra).toBe("boolean");
    expect(await v.foto(c.id)).toEqual(antes); // ni versión, ni operación, ni compra_periodo
    expect(await v.periodoFila(c.id)).toBeNull();

    const e = await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios });
    expect(e.status, e.text).toBe(200);
    const { fila, cuadre } = esAccion(e);
    expect(fila.montos.total).toBe(k.body.total);
    expect(cuadre).toEqual(k.body.cuadre);
  });

  it("no pide versionBase y la ignora si llega", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/calcular`, { cambios: { biDg: "150.00" }, versionBase: 99 });
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toBe("169.50");
  });

  it("con `cambios` vacío vale: devuelve el total actual (no escribe, a diferencia de editar)", async () => {
    const { c, ids } = await escenario();
    const r = await post(titular(), c, `/${ids["F001-3064"]}/calcular`, { cambios: {} });
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toBe("119.50");
  });

  it("un monto con más de 2 decimales, fuera de rango o number es 400", async () => {
    const { c, ids } = await escenario();
    for (const cambios of [{ biDg: "0.005" }, { biDg: "1000000000000.00" }, { biDg: 1 }]) {
      const r = await post(titular(), c, `/${ids["F001-3064"]}/calcular`, { cambios });
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
  });

  it("respeta el permiso (lectura 403) y el estado (revisado sin aprobar 403; generado 409)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const cuerpo = { cambios: { biDg: "150.00" } };
    const sin = await post(lectura, c, `/${id}/calcular`, cuerpo);
    expect(sin.status).toBe(403);
    expect(sin.body).toEqual({ codigo: "permiso_denegado" });

    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const rev = await post(asistente, c, `/${id}/calcular`, cuerpo);
    expect(rev.status).toBe(403);
    expect(rev.body).toEqual({ codigo: "periodo_revisado" });
    expect((await post(contador, c, `/${id}/calcular`, cuerpo)).status).toBe(200);

    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const gen = await post(contador, c, `/${id}/calcular`, cuerpo);
    expect(gen.status).toBe(409);
    expect(gen.body).toEqual({ codigo: "periodo_generado" });
  });
});

// --- CA-6 · sugerencias -----------------------------------------------------------------------------------------------

describe("CA-6 · aceptar una sugerencia (RF-080, D-4)", () => {
  it("San Juan: R-ISC aceptada con confirmación deja BI DG 0.00 e ISC 770.00 (una versión con accion sugerencia)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-1040"]!;
    const r = await post(titular(), c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(r.status, r.text).toBe(200);
    const { fila } = esAccion(r);
    expect(fila.version).toBe(2);
    expect(fila.montos).toMatchObject({ biDg: "0.00", isc: "770.00", total: "770.00" });
    expect(fila.hallazgos.map((h) => h.regla)).not.toContain("R-ISC");
    const u = await ultima(id);
    expect(u).toMatchObject({ n: 2, accion: "sugerencia", biDg: "0.00", isc: "770.00" });
    expect((await v.versiones(id))[0]).toMatchObject({ n: 1, biDg: "770.00", isc: "0.00", accion: "original" });
  });

  it("R-ISC pide confirmación: sin `confirmar` no se aplica nada (nada se aplica solo)", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-1040"]}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC" });
    expect([400, 409, 422], r.text).toContain(r.status);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("mixta 21.48 / 1.61 sin XML: aceptar R-MIX pide `gravado` (422 requiere_dato) y no escribe", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-2056"]}/sugerencias/aceptar`, { versionBase: 1, regla: "R-MIX", confirmar: true });
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "requiere_dato", dato: "gravado" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("mixta con gravado 8.97: 8.97 en DG y 12.51 en no gravado, IGV 1.61 y total 23.09", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const r = await post(titular(), c, `/${id}/sugerencias/aceptar`, {
      versionBase: 1,
      regla: "R-MIX",
      confirmar: true,
      dato: { gravado: "8.97" },
    });
    expect(r.status, r.text).toBe(200);
    const { fila } = esAccion(r);
    expect(fila.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
    expect(fila.hallazgos.map((h) => h.regla)).not.toContain("R-MIX");
    expect(await ultima(id)).toMatchObject({ accion: "sugerencia", biDg: "8.97", noGravado: "12.51" });
  });

  it("un gravado con más de 2 decimales o que no es monto es 400 y no escribe", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    for (const dato of [{ gravado: "8.971" }, { gravado: 8.97 }, { gravado: "x" }]) {
      const r = await post(titular(), c, `/${ids["F001-2056"]}/sugerencias/aceptar`, {
        versionBase: 1,
        regla: "R-MIX",
        confirmar: true,
        dato,
      });
      expect(r.status, r.text).toBe(400);
    }
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("sugerencia vieja: la fila cambió después de evaluarse y el hallazgo guardado ya no la describe → 409 revisar_de_nuevo y no escribe", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    // BI 800.00, pero el hallazgo R-ISC guardado se evaluó cuando la BI era 770.00.
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: "7001",
      doc: "20700000011",
      usuarioId: E.titular.id,
      montos: { biDg: "800.00" },
      hallazgos: [hallazgoIscSinXml(montos({ biDg: "770.00" }))],
    });
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("tras editar la fila, su sugerencia anterior ya no se acepta con la versión nueva (409 revisar_de_nuevo) ni con la vieja (409 version_obsoleta)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-1040"]!;
    // Se corrige la BI a una gravada común: R-ISC deja de existir.
    expect((await post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "100.00", igvDg: "18.00" } })).status).toBe(200);
    const antes = await v.foto(c.id);
    const nueva = await post(titular(), c, `/${id}/sugerencias/aceptar`, { versionBase: 2, regla: "R-ISC", confirmar: true });
    expect(nueva.status, nueva.text).toBe(409);
    expect(nueva.body).toEqual({ codigo: "revisar_de_nuevo" });
    const vieja = await post(titular(), c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(vieja.status, vieja.text).toBe(409);
    expect(vieja.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("proveedor nuevo (R-NEW): sin destino es 422 requiere_dato destino; con destino clasifica y el hallazgo no reaparece", async () => {
    const { c, ids } = await escenario({}, false); // ningún proveedor tiene historial: todos son nuevos (DU-7)
    const id = ids["F001-3064"]!;
    const sin = await post(titular(), c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-NEW", confirmar: true });
    expect(sin.status, sin.text).toBe(422);
    expect(sin.body).toEqual({ codigo: "requiere_dato", dato: "destino" });
    expect(await vigenteN(id)).toBe(1);

    const r = await post(titular(), c, `/${id}/sugerencias/aceptar`, {
      versionBase: 1,
      regla: "R-NEW",
      confirmar: true,
      dato: { destino: "DNG" },
    });
    expect(r.status, r.text).toBe(200);
    const { fila } = esAccion(r);
    expect(fila.clasificada).toBe(true);
    expect(fila.montos).toMatchObject({ biDng: "100.00", igvDng: "18.00", biDg: "0.00" });
    expect(fila.hallazgos.map((h) => h.regla)).not.toContain("R-NEW");
  });

  it.each([
    ["regla desconocida", { versionBase: 1, regla: "R-XYZ" }],
    ["regla en minúsculas", { versionBase: 1, regla: "r-isc" }],
    ["confirmar como cadena", { versionBase: 1, regla: "R-ISC", confirmar: "true" }],
    ["sin regla", { versionBase: 1 }],
    ["destino inexistente", { versionBase: 1, regla: "R-NEW", dato: { destino: "XX" } }],
  ])("400 solicitud_invalida: %s", async (_n, cuerpo) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-1040"]}/sugerencias/aceptar`, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

// --- CA-7 · excluir y restaurar ---------------------------------------------------------------------------------------

describe("CA-7 · excluir y restaurar (RF-066, HU-17, D-6)", () => {
  it("zapatillas: excluir con motivo la saca de los totales y de la lista principal y la deja en «excluidas»; restaurar la devuelve", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const total0 = (await get(titular(), c, "/resumen")).body.casilleros.vigente.total as string;

    const r = await post(titular(), c, `/${id}/excluir`, { versionBase: 1, motivo: "zapatillas de uso personal" });
    expect(r.status, r.text).toBe(200);
    const { fila } = esAccion(r);
    expect(fila).toMatchObject({ excluida: true, motivo: "zapatillas de uso personal", version: 2 });
    expect(fila.montos.total).toBe("119.50"); // excluir no cambia los montos de la fila
    expect(await ultima(id)).toMatchObject({ accion: "excluir", excluida: true, total: "119.50" });

    const total1 = (await get(titular(), c, "/resumen")).body.casilleros.vigente.total as string;
    expect(centimos(total1) - centimos(total0)).toBe(-11950n); // sale de los totales
    const principal = await get(titular(), c);
    expect(principal.status, principal.text).toBe(200);
    expect(principal.body.filas.map((f: any) => f.id)).not.toContain(id);
    const excluidas = await get(titular(), c, "?vista=excluidas");
    expect(excluidas.body.filas.map((f: any) => f.id)).toEqual([id]);

    const q = await post(titular(), c, `/${id}/restaurar`, { versionBase: 2 });
    expect(q.status, q.text).toBe(200);
    expect(esAccion(q).fila).toMatchObject({ excluida: false, motivo: null, version: 3 });
    expect(await ultima(id)).toMatchObject({ accion: "restaurar", excluida: false });
    const total2 = (await get(titular(), c, "/resumen")).body.casilleros.vigente.total as string;
    expect(total2).toBe(total0);
    expect((await get(titular(), c)).body.filas.map((f: any) => f.id)).toContain(id);
    expect((await get(titular(), c, "?vista=excluidas")).body.filas).toEqual([]);
    // La versión 1 sigue siendo la del SIRE.
    expect((await v.versiones(id))[0]).toMatchObject({ n: 1, excluida: false, accion: "original" });
  });

  it("con el periodo generado, excluir y restaurar son 409 periodo_generado", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    expect((await post(titular(), c, `/${id}/restaurar`, { versionBase: 2 })).status).toBe(200);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const antes = await v.foto(c.id);
    const a = await post(titular(), c, `/${ids["F001-5070"]}/excluir`, { versionBase: 1 });
    const b = await post(titular(), c, `/${id}/excluir`, { versionBase: 3 });
    for (const r of [a, b]) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "periodo_generado" });
    }
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("restaurar una compra excluida con el periodo generado también es 409 periodo_generado", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await post(titular(), c, `/${id}/restaurar`, { versionBase: 2 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "periodo_generado" });
  });

  it("el motivo es opcional y de hasta 200 caracteres; 201 es 400", async () => {
    const { c, ids } = await escenario();
    const largo = await post(titular(), c, `/${ids["F001-3064"]}/excluir`, { versionBase: 1, motivo: "x".repeat(201) });
    expect(largo.status, largo.text).toBe(400);
    expect(largo.body).toEqual({ codigo: "solicitud_invalida" });
    const justo = await post(titular(), c, `/${ids["F001-3064"]}/excluir`, { versionBase: 1, motivo: "x".repeat(200) });
    expect(justo.status, justo.text).toBe(200);
    const sin = await post(titular(), c, `/${ids["F001-5070"]}/excluir`, { versionBase: 1 });
    expect(sin.status, sin.text).toBe(200);
    expect(esAccion(sin).fila.motivo).toBeNull();
  });

  it("excluir una ya excluida es 409 fila_excluida; con versionBase obsoleta, version_obsoleta", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    const dos = await post(titular(), c, `/${id}/excluir`, { versionBase: 2 });
    expect(dos.status, dos.text).toBe(409);
    expect(dos.body).toEqual({ codigo: "fila_excluida" });
    const vieja = await post(titular(), c, `/${id}/excluir`, { versionBase: 1 });
    expect(vieja.status, vieja.text).toBe(409);
    expect(vieja.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
  });

  it("una excluida sigue siendo historial del proveedor: no se vuelve a agregar su clave (CA-8)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    expect((await post(titular(), c, `/${id}/excluir`, { versionBase: 1 })).status).toBe(200);
    const r = await post(
      titular(),
      c,
      "",
      cuerpoAgregar("F001", "3064", {
        proveedor: { tipo: "6", numero: "20700000053", razonSocial: "PRUEBA PROVEEDOR BOLSAS S.A.C." },
      }),
    );
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "duplicado", id });
  });
});

// --- CA-8 · agregar y descartar ---------------------------------------------------------------------------------------

describe("CA-8 · agregar y descartar (RF-067, HU-18, D-7)", () => {
  it("el formulario crea una compra `agregada` con versión 1, total Σ y sin propuesta", async () => {
    const { c } = await escenario();
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "9001", { montos: { biDg: "100.00", igvDg: "18.00", icbper: "0.50" } }));
    expect(r.status, r.text).toBe(201);
    const { fila, cuadre } = esAccion(r);
    expect(fila).toMatchObject({
      origen: "agregada",
      version: 1,
      tipo: "01",
      serie: "F001",
      numero: "9001",
      fecha: "2026-10-15",
      moneda: "PEN",
      tipoCambio: null,
      excluida: false,
      proveedor: { tipo: "6", numero: "20700000099", razonSocial: "PROVEEDOR AGREGADO SAC" },
    });
    expect(fila.montos).toMatchObject({ biDg: "100.00", igvDg: "18.00", icbper: "0.50", total: "118.50" });
    expect(cuadre.cuadra).toBe(true);
    const cs = await v.compras(c.id);
    const nueva = cs.find((x) => x.id === fila.id)!;
    expect(nueva).toMatchObject({ origen: "agregada", propuesta_id: null, version_vigente: 1, descartada: false });
    expect((await v.versiones(fila.id))[0]).toMatchObject({ n: 1, accion: "agregada", usuario_id: E.titular.id, total: "118.50" });
    // El resumen la cuenta como vigente.
    const res = await get(titular(), c, "/resumen");
    expect(res.status, res.text).toBe(200);
    expect(res.body.casilleros.diferencia.total).not.toBe("0.00");
  });

  it("USD con tipo de cambio: se guarda con su tipo de cambio", async () => {
    const { c } = await escenario();
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "9002", { moneda: "USD", tipoCambio: "3.750", montos: { biDg: "10.00", igvDg: "1.80" } }));
    expect(r.status, r.text).toBe(201);
    expect(esAccion(r).fila).toMatchObject({ moneda: "USD", tipoCambio: "3.750" });
  });

  it("la razón social es texto no confiable: se guarda y se devuelve tal cual, sin interpretarla", async () => {
    const { c } = await escenario();
    const razon = `<script>alert(1)</script> & "x"`;
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "9003", { proveedor: { tipo: "6", numero: "20700000099", razonSocial: razon } }));
    expect(r.status, r.text).toBe(201);
    expect(esAccion(r).fila.proveedor.razonSocial).toBe(razon);
    expect(String(r.headers["content-type"])).toMatch(/application\/json/);
  });

  it("clave repetida de una fila del SIRE: 409 duplicado con el id de la existente y no escribe", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(
      titular(),
      c,
      "",
      cuerpoAgregar("F001", "1040", { proveedor: { tipo: "6", numero: "20700000011", razonSocial: "OTRA RAZON SAC" } }),
    );
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "duplicado", id: ids["F001-1040"] });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("la clave es la normalizada: ceros a la izquierda y mayúsculas de la serie no escapan al duplicado", async () => {
    const { c, ids } = await escenario();
    const r = await post(
      titular(),
      c,
      "",
      cuerpoAgregar("F001", "00001040", { proveedor: { tipo: "6", numero: "20700000011", razonSocial: "X" } }),
    );
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "duplicado", id: ids["F001-1040"] });
  });

  it("el mismo número con otro proveedor no es duplicado", async () => {
    const { c } = await escenario();
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "1040"));
    expect(r.status, r.text).toBe(201);
  });

  it("repetir una agregada es 409 duplicado con su id; descartarla la quita sin contarla como excluida y libera la clave", async () => {
    const { c } = await escenario();
    const a = await post(titular(), c, "", cuerpoAgregar("F001", "9100"));
    expect(a.status, a.text).toBe(201);
    const id = esAccion(a).fila.id;
    const dup = await post(titular(), c, "", cuerpoAgregar("F001", "9100"));
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ codigo: "duplicado", id });

    const total0 = (await get(titular(), c, "/resumen")).body.casilleros.vigente.total as string;
    const d = await post(titular(), c, `/${id}/descartar`, { versionBase: 1 });
    expect(d.status, d.text).toBe(200);
    // Sale de la lista, del resumen y de «excluidas»: nunca fue una excluida.
    expect((await get(titular(), c)).body.filas.map((f: any) => f.id)).not.toContain(id);
    expect((await get(titular(), c, "?vista=excluidas")).body.filas).toEqual([]);
    const total1 = (await get(titular(), c, "/resumen")).body.casilleros.vigente.total as string;
    expect(centimos(total1) - centimos(total0)).toBe(-11800n);
    expect((await v.compras(c.id)).find((x) => x.id === id)!.descartada).toBe(true);
    // La clave quedó libre: se puede volver a agregar y es otra compra.
    const otra = await post(titular(), c, "", cuerpoAgregar("F001", "9100"));
    expect(otra.status, otra.text).toBe(201);
    expect(esAccion(otra).fila.id).not.toBe(id);
  });

  it("DU-16: excluir una agregada equivale a descartarla (no queda excluida) y se puede volver a agregar", async () => {
    const { c } = await escenario();
    const a = await post(titular(), c, "", cuerpoAgregar("F001", "9200"));
    const id = esAccion(a).fila.id;
    const r = await post(titular(), c, `/${id}/excluir`, { versionBase: 1 });
    expect(r.status, r.text).toBe(200);
    expect((await get(titular(), c, "?vista=excluidas")).body.filas).toEqual([]);
    expect((await get(titular(), c)).body.filas.map((f: any) => f.id)).not.toContain(id);
    expect((await post(titular(), c, "", cuerpoAgregar("F001", "9200"))).status).toBe(201);
  });

  it("descartar una fila del SIRE es 409 no_descartable (se excluye, no se descarta)", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, `/${ids["F001-3064"]}/descartar`, { versionBase: 1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "no_descartable" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("descartar una agregada ya descartada o con versionBase obsoleta no escribe", async () => {
    const { c } = await escenario();
    const a = await post(titular(), c, "", cuerpoAgregar("F001", "9300"));
    const id = esAccion(a).fila.id;
    const mala = await post(titular(), c, `/${id}/descartar`, { versionBase: 5 });
    expect(mala.status, mala.text).toBe(409);
    expect(mala.body).toEqual({ codigo: "version_obsoleta", versionVigente: 1 });
    expect((await post(titular(), c, `/${id}/descartar`, { versionBase: 1 })).status).toBe(200);
    const otra = await post(titular(), c, `/${id}/descartar`, { versionBase: 1 });
    expect([404, 409]).toContain(otra.status); // una descartada ya no existe para el usuario
  });

  it("agregar y descartar no entran en la pila de deshacer (DU-14)", async () => {
    const { c } = await escenario();
    const a = await post(titular(), c, "", cuerpoAgregar("F001", "9400"));
    const id = esAccion(a).fila.id;
    expect((await post(titular(), c, `/${id}/descartar`, { versionBase: 1 })).status).toBe(200);
    const d = await post(titular(), c, "/deshacer");
    expect(d.status, d.text).toBe(409);
    expect(d.body).toEqual({ codigo: "nada_que_deshacer" });
    expect(await v.operaciones(c.id)).toHaveLength(0);
  });

  const MALOS: [string, Record<string, unknown>][] = [
    ["USD sin tipo de cambio", { moneda: "USD" }],
    ["PEN con tipo de cambio", { tipoCambio: "3.750" }],
    ["tipo de cambio cero", { moneda: "USD", tipoCambio: "0.000" }],
    ["fecha imposible", { fecha: "2026-02-30" }],
    ["fecha con otro formato", { fecha: "15/10/2026" }],
    ["tipo de comprobante de 3 dígitos", { tipo: "001" }],
    ["serie en minúsculas", { serie: "f001" }],
    ["serie de 5 caracteres", { serie: "F0001" }],
    ["número de 9 dígitos", { numero: "123456789" }],
    ["número no numérico", { numero: "12A" }],
    ["monto con 3 decimales", { montos: { biDg: "100.005" } }],
    ["monto number", { montos: { biDg: 100 } }],
    ["monto fuera de rango", { montos: { biDg: "1000000000000.00" } }],
    ["razón social vacía", { proveedor: { tipo: "6", numero: "20700000099", razonSocial: "" } }],
    ["moneda desconocida", { moneda: "EUR" }],
  ];
  it.each(MALOS)("400 solicitud_invalida y no escribe: %s", async (_n, extra) => {
    const { c } = await escenario();
    const antes = await v.foto(c.id);
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "9500", extra));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("un `origen`, `tenantId` o `version` del cuerpo no se aplican", async () => {
    const { c } = await escenario();
    const r = await post(titular(), c, "", cuerpoAgregar("F001", "9600", { origen: "sire", tenantId: F.tenantId, version: 7, propuestaId: randomUUID() }));
    expect(r.status, r.text).toBe(201);
    const nueva = (await v.compras(c.id)).find((x) => x.id === esAccion(r).fila.id)!;
    expect(nueva).toMatchObject({ origen: "agregada", propuesta_id: null, version_vigente: 1 });
  });
});

// --- CA-3 · concurrencia ----------------------------------------------------------------------------------------------

describe("CA-3 · dos acciones simultáneas con el mismo versionBase (D-2)", () => {
  it("una gana (200) y la otra recibe 409 version_obsoleta sin escribir: dos versiones, una operación", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const [a, b] = await Promise.all([
      post(titular(), c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" }),
      post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DGNG" }),
    ]);
    expect([a.status, b.status].sort(), `${a.text} | ${b.text}`).toEqual([200, 409]);
    const perdedora = a.status === 409 ? a : b;
    expect(perdedora.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
    expect(await v.operaciones(c.id)).toHaveLength(1);
  });

  it("editar y excluir a la vez sobre la misma versión: exactamente una se aplica", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-5070"]!;
    const [a, b] = await Promise.all([
      post(titular(), c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "200.00" } }),
      post(contador, c, `/${id}/excluir`, { versionBase: 1 }),
    ]);
    expect([a.status, b.status].sort(), `${a.text} | ${b.text}`).toEqual([200, 409]);
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
  });

  it("ocho carreras seguidas en filas distintas: siempre un solo ganador por fila", async () => {
    const { c } = await escenario();
    const volumen = await v.sembrarVolumen(E.tenantId, c.id, 8, { usuarioId: E.titular.id });
    const rs = await Promise.all(
      volumen.flatMap((id) => [
        post(titular(), c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" }),
        post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DGNG" }),
      ]),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(8);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(8);
    for (const id of volumen) expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
  });
});

// --- CA-11 · deshacer y rehacer -----------------------------------------------------------------------------------------

describe("CA-11 · deshacer y rehacer (RF-065, D-14)", () => {
  it("deshacer revierte la última operación propia creando una versión nueva (nada se borra); rehacer la repone", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    const v1 = (await v.versiones(id))[0]!;
    expect((await post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" })).status).toBe(200);
    const v2 = (await v.versiones(id))[1]!;

    const d = await post(contador, c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect(d.body.operacionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.body.filas).toEqual([id]);
    const vs = await v.versiones(id);
    expect(vs.map((x) => x.n)).toEqual([1, 2, 3]); // nada se borra ni se pisa
    expect(vs[0]).toEqual(v1);
    expect(vs[1]).toEqual(v2);
    expect(vs[2]).toMatchObject({
      accion: "deshacer",
      biDg: v1.biDg,
      igvDg: v1.igvDg,
      biDng: v1.biDng,
      total: v1.total,
      clasificada: v1.clasificada,
      excluida: v1.excluida,
      operacion_id: d.body.operacionId,
    });
    expect((await get(contador, c, `/${id}`)).body.vigente.montos.biDg).toBe("100.00");

    const r = await post(contador, c, "/rehacer");
    expect(r.status, r.text).toBe(200);
    expect(r.body.filas).toEqual([id]);
    const vs2 = await v.versiones(id);
    expect(vs2.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(vs2[3]).toMatchObject({ accion: "rehacer", biDng: "100.00", biDg: "0.00", clasificada: true, total: v2.total });
    expect(vs2[0]).toEqual(v1);
  });

  it("sin operaciones: 409 nada_que_deshacer y 409 nada_que_rehacer", async () => {
    const { c } = await escenario();
    const d = await post(contador, c, "/deshacer");
    expect(d.status, d.text).toBe(409);
    expect(d.body).toEqual({ codigo: "nada_que_deshacer" });
    const r = await post(contador, c, "/rehacer");
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "nada_que_rehacer" });
  });

  it("deshacer recorre la pila en orden inverso (última primero) y después no queda nada", async () => {
    const { c, ids } = await escenario();
    const a = ids["F001-3064"]!;
    const b = ids["F001-5070"]!;
    await post(contador, c, `/${a}/clasificar`, { versionBase: 1, destino: "DNG" });
    await post(contador, c, `/${b}/excluir`, { versionBase: 1 });
    const d1 = await post(contador, c, "/deshacer");
    expect(d1.body.filas).toEqual([b]);
    const d2 = await post(contador, c, "/deshacer");
    expect(d2.body.filas).toEqual([a]);
    const d3 = await post(contador, c, "/deshacer");
    expect(d3.status).toBe(409);
    expect(d3.body).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("entran en la pila: editar, aceptar sugerencia, excluir y restaurar", async () => {
    const { c, ids } = await escenario();
    const e = ids["F001-3064"]!;
    const s = ids["F001-1040"]!;
    const yaExcluida = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F003",
      numero: "1",
      doc: "20700000077",
      usuarioId: E.titular.id,
      versiones: [{ excluida: true, motivo: "no es del giro", accion: "excluir" }],
    });
    // Cada operación toca una fila distinta: deshacer una exige que la fila siga en la versión que esa operación creó.
    await post(contador, c, `/${e}/editar`, { versionBase: 1, cambios: { biDg: "150.00" } });
    await post(contador, c, `/${s}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true });
    await post(contador, c, `/${ids["F001-5070"]}/excluir`, { versionBase: 1 });
    await post(contador, c, `/${yaExcluida}/restaurar`, { versionBase: 2 });
    for (let i = 0; i < 4; i++) expect((await post(contador, c, "/deshacer")).status, `paso ${i}`).toBe(200);
    expect((await post(contador, c, "/deshacer")).status).toBe(409);
    expect((await get(contador, c, `/${e}`)).body.vigente.montos.biDg).toBe("100.00");
    expect((await get(contador, c, `/${s}`)).body.vigente.montos).toMatchObject({ biDg: "770.00", isc: "0.00" });
  });

  it("rehacer vale solo hasta la siguiente acción nueva del usuario", async () => {
    const { c, ids } = await escenario();
    const a = ids["F001-3064"]!;
    await post(contador, c, `/${a}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect((await post(contador, c, "/deshacer")).status).toBe(200);
    // Una acción nueva caduca lo deshecho.
    expect((await post(contador, c, `/${ids["F001-5070"]}/editar`, { versionBase: 1, cambios: { biDg: "160.00" } })).status).toBe(200);
    const r = await post(contador, c, "/rehacer");
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "nada_que_rehacer" });
    expect((await v.versiones(a)).map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it("si otra persona cambió la fila, 409 fila_cambiada con los ids y no se escribe nada", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    await post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });
    // Otra persona edita la misma fila.
    expect((await post(titular(), c, `/${id}/editar`, { versionBase: 2, cambios: { biDng: "120.00" } })).status).toBe(200);
    const antes = await v.foto(c.id);
    const d = await post(contador, c, "/deshacer");
    expect(d.status, d.text).toBe(409);
    expect(d.body).toEqual({ codigo: "fila_cambiada", ids: [id] });
    expect(await v.foto(c.id)).toEqual(antes);
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it("el mismo usuario que cambió la fila desde otra pestaña también recibe fila_cambiada", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    await post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });
    const otraPestana = await v.nuevaSesion(contador);
    expect((await post(otraPestana, c, `/${id}/editar`, { versionBase: 2, cambios: { biDng: "120.00" } })).status).toBe(200);
    // Esa edición es ahora su última operación: deshacerla es lo que corresponde, y vale.
    const d = await post(contador, c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect(d.body.filas).toEqual([id]);
    // Su operación anterior (clasificar) ya no puede deshacerse: la fila volvió a otra versión distinta de la que creó.
    const d2 = await post(contador, c, "/deshacer");
    expect([200, 409]).toContain(d2.status);
    if (d2.status === 409) expect(["fila_cambiada", "nada_que_deshacer"]).toContain(d2.body.codigo);
  });

  it("la pila de un usuario no toca la de otro", async () => {
    const { c, ids } = await escenario();
    const a = ids["F001-3064"]!;
    const b = ids["F001-5070"]!;
    await post(contador, c, `/${a}/clasificar`, { versionBase: 1, destino: "DNG" });
    await post(titular(), c, `/${b}/clasificar`, { versionBase: 1, destino: "DNG" });
    const dt = await post(titular(), c, "/deshacer");
    expect(dt.status, dt.text).toBe(200);
    expect(dt.body.filas).toEqual([b]); // solo lo del titular
    expect(await vigenteN(a)).toBe(2); // lo del contador sigue en pie
    expect((await post(titular(), c, "/deshacer")).status).toBe(409);
    const dc = await post(contador, c, "/deshacer");
    expect(dc.status, dc.text).toBe(200);
    expect(dc.body.filas).toEqual([a]);
  });

  it("la pila es por periodo: lo hecho en otro periodo del cliente no se deshace desde este", async () => {
    const { c, ids } = await escenario();
    await post(contador, c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
    const d = await v.llamar(contador, "POST", `${base(c.id, "202609")}/deshacer`, {});
    expect(d.status, d.text).toBe(409);
    expect(d.body).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("sobrevive a recargar la sesión: la pila vive en la BD, no en la sesión", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-3064"]!;
    await post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });
    const recargada = await v.nuevaSesion(contador);
    const d = await post(recargada, c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect(d.body.filas).toEqual([id]);
  });

  it("el deshacer de una operación ya deshecha no se repite", async () => {
    const { c, ids } = await escenario();
    await post(contador, c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect((await post(contador, c, "/deshacer")).status).toBe(200);
    const otra = await post(contador, c, "/deshacer");
    expect(otra.status, otra.text).toBe(409);
    expect(otra.body).toEqual({ codigo: "nada_que_deshacer" });
  });
});

// --- CA-12 · estado del periodo y permisos ------------------------------------------------------------------------------

type Estado = "abierto" | "revisado" | "generado";
interface Contexto {
  c: Cliente;
  ids: IdsPorNumero;
  excluida: string;
  agregada: string;
}
const ACCIONES: { nombre: string; llamar: (a: Actor, x: Contexto) => ReturnType<typeof post> }[] = [
  { nombre: "clasificar", llamar: (a, x) => post(a, x.c, `/${x.ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" }) },
  { nombre: "editar", llamar: (a, x) => post(a, x.c, `/${x.ids["F001-3064"]}/editar`, { versionBase: 1, cambios: { biDg: "101.00" } }) },
  { nombre: "calcular", llamar: (a, x) => post(a, x.c, `/${x.ids["F001-3064"]}/calcular`, { cambios: { biDg: "101.00" } }) },
  { nombre: "aceptar sugerencia", llamar: (a, x) => post(a, x.c, `/${x.ids["F001-1040"]}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true }) },
  { nombre: "excluir", llamar: (a, x) => post(a, x.c, `/${x.ids["F001-5070"]}/excluir`, { versionBase: 1 }) },
  { nombre: "restaurar", llamar: (a, x) => post(a, x.c, `/${x.excluida}/restaurar`, { versionBase: 2 }) },
  { nombre: "agregar", llamar: (a, x) => post(a, x.c, "", cuerpoAgregar("F001", "9700")) },
  { nombre: "descartar", llamar: (a, x) => post(a, x.c, `/${x.agregada}/descartar`, { versionBase: 1 }) },
  { nombre: "masiva clasificar", llamar: (a, x) => post(a, x.c, "/masivas/clasificar", { items: [{ compraId: x.ids["F001-3064"], versionBase: 1 }], destino: "DNG" }) },
  { nombre: "masiva excluir", llamar: (a, x) => post(a, x.c, "/masivas/excluir", { items: [{ compraId: x.ids["F001-5070"], versionBase: 1 }] }) },
  { nombre: "deshacer", llamar: (a, x) => post(a, x.c, "/deshacer") },
  { nombre: "rehacer", llamar: (a, x) => post(a, x.c, "/rehacer") },
];

/** No lo bloquea el estado: las acciones con precondiciones válidas dan 2xx; deshacer y rehacer, 200 o «nada que …». */
function sinBloqueo(nombre: string, r: { status: number; body: any; text: string }): void {
  if (nombre === "deshacer" || nombre === "rehacer") {
    if (r.status === 200) return;
    expect(r.status, `${nombre}: ${r.text}`).toBe(409);
    expect(["nada_que_deshacer", "nada_que_rehacer"], `${nombre}: ${r.text}`).toContain(r.body?.codigo);
    return;
  }
  expect(r.status, `${nombre}: ${r.text}`).toBeLessThan(300);
}

async function periodoEn(estado: Estado): Promise<Contexto> {
  const { c, ids } = await escenario();
  const excluida = await v.sembrarCompra(E.tenantId, c.id, {
    serie: "F003",
    numero: "1",
    doc: "20700000077",
    usuarioId: E.titular.id,
    versiones: [{ excluida: true, motivo: "no es del giro", accion: "excluir" }],
  });
  const agregada = await v.sembrarCompra(E.tenantId, c.id, {
    serie: "F004",
    numero: "1",
    doc: "20700000078",
    origen: "agregada",
    usuarioId: E.titular.id,
  });
  if (estado !== "abierto") await v.estadoPeriodo(E.tenantId, c.id, PERIODO, estado, contador.id);
  return { c, ids, excluida, agregada };
}

describe("CA-12 · matriz de estado × permiso (RF-071, D-9, DU-4)", () => {
  describe.each(ACCIONES)("$nombre", ({ nombre, llamar }) => {
    it("revisado: quien solo tiene sire.clasificar (asistente) recibe 403 periodo_revisado y nada cambia", async () => {
      const x = await periodoEn("revisado");
      const antes = await v.foto(x.c.id);
      const r = await llamar(asistente, x);
      expect(r.status, `${nombre}: ${r.text}`).toBe(403);
      expect(r.body).toEqual({ codigo: "periodo_revisado" });
      expect(await v.foto(x.c.id)).toEqual(antes);
    });

    it("revisado: quien tiene sire.aprobar_generar (contador) no es bloqueado por el estado", async () => {
      const x = await periodoEn("revisado");
      const r = await llamar(contador, x);
      expect(r.body?.codigo, `${nombre}: ${r.text}`).not.toBe("periodo_revisado");
      expect(r.body?.codigo).not.toBe("periodo_generado");
      expect(r.status, `${nombre}: ${r.text}`).not.toBe(403);
      sinBloqueo(nombre, r);
    });

    it("generado: nadie edita, ni con sire.aprobar_generar (409 periodo_generado) y nada cambia", async () => {
      const x = await periodoEn("generado");
      const antes = await v.foto(x.c.id);
      for (const a of [asistente, contador, titular()]) {
        const r = await llamar(a, x);
        expect(r.status, `${nombre} como ${a.rol}: ${r.text}`).toBe(409);
        expect(r.body).toEqual({ codigo: "periodo_generado" });
      }
      expect(await v.foto(x.c.id)).toEqual(antes);
    });

    it("abierto: basta sire.clasificar (el asistente no es bloqueado)", async () => {
      const x = await periodoEn("abierto");
      const r = await llamar(asistente, x);
      expect(r.status, `${nombre}: ${r.text}`).not.toBe(403);
      expect(r.body?.codigo).not.toBe("periodo_revisado");
      expect(r.body?.codigo).not.toBe("periodo_generado");
      sinBloqueo(nombre, r);
    });
  });
});

describe("CA-12 · marcar revisado y reabrir (D-9)", () => {
  it("revisar desde abierto lo hace sire.clasificar: 200 { estado, por, en } y la fila de compra_periodo", async () => {
    const { c } = await escenario();
    const r = await post(asistente, c, "/estado/revisar");
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toBe("revisado");
    expect(r.body.por).toBe(asistente.id);
    expect(Number.isNaN(Date.parse(r.body.en))).toBe(false);
    const fila = await v.periodoFila(c.id);
    expect(fila).toMatchObject({ estado: "revisado", marcado_por: asistente.id });
  });

  it("revisar de nuevo, o desde generado, es 409 estado_invalido y no cambia nada", async () => {
    const { c } = await escenario();
    expect((await post(contador, c, "/estado/revisar")).status).toBe(200);
    const otra = await post(contador, c, "/estado/revisar");
    expect(otra.status, otra.text).toBe(409);
    expect(otra.body).toEqual({ codigo: "estado_invalido" });
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const gen = await post(contador, c, "/estado/revisar");
    expect(gen.status, gen.text).toBe(409);
    expect(gen.body).toEqual({ codigo: "estado_invalido" });
    expect((await v.periodoFila(c.id)).estado).toBe("generado");
  });

  it("reabrir exige sire.aprobar_generar: el asistente recibe 403 permiso_denegado", async () => {
    const { c } = await escenario();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const r = await post(asistente, c, "/estado/reabrir");
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect((await v.periodoFila(c.id)).estado).toBe("revisado");
  });

  it("reabrir desde revisado y desde generado vuelve a abierto, y entonces se vuelve a editar", async () => {
    for (const desde of ["revisado", "generado"] as const) {
      const { c, ids } = await escenario();
      await v.estadoPeriodo(E.tenantId, c.id, PERIODO, desde, contador.id);
      const bloqueada = await post(asistente, c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
      expect(bloqueada.status).toBe(desde === "revisado" ? 403 : 409);
      const r = await post(contador, c, "/estado/reabrir");
      expect(r.status, `${desde}: ${r.text}`).toBe(200);
      expect(r.body.estado).toBe("abierto");
      expect((await v.periodoFila(c.id)).estado).toBe("abierto");
      const ok = await post(asistente, c, `/${ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
      expect(ok.status, `${desde}: ${ok.text}`).toBe(200);
    }
  });

  it("reabrir un periodo abierto es 409 estado_invalido", async () => {
    const { c } = await escenario();
    const r = await post(contador, c, "/estado/reabrir");
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
  });

  it("revisar y reabrir no crean versiones ni entran en deshacer (DU-14)", async () => {
    const { c } = await escenario();
    const antes = (await v.foto(c.id)).versiones;
    await post(contador, c, "/estado/revisar");
    await post(contador, c, "/estado/reabrir");
    expect((await v.foto(c.id)).versiones).toEqual(antes);
    expect((await post(contador, c, "/deshacer")).body).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("el estado de un periodo no pasa a otro periodo ni a otro cliente", async () => {
    const { c, ids } = await escenario();
    const otro = await escenario();
    await post(contador, c, "/estado/revisar");
    const r = await post(asistente, otro.c, `/${otro.ids["F001-3064"]}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect(r.status, r.text).toBe(200);
    const sembrado = await v.sembrarCompra(E.tenantId, c.id, { serie: "F009", numero: "1", usuarioId: E.titular.id, periodo: "202609" });
    const o = await v.llamar(asistente, "POST", `${base(c.id, "202609")}/${sembrado}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect(o.status, o.text).toBe(200);
    expect(ids["F001-3064"]).toBeDefined();
  });
});

// --- CA-13 · alcance, permisos y cliente archivado ------------------------------------------------------------------------

interface Ruta {
  nombre: string;
  /** Escribe en el cliente (para la tabla del cliente archivado). */
  escribe: boolean;
  metodo: "POST";
  ruta: (ids: IdsPorNumero) => string;
  cuerpo: (ids: IdsPorNumero) => unknown;
  /** Permiso especial: solo `sire.aprobar_generar`. */
  aprobar?: boolean;
}
const RUTAS: Ruta[] = [
  { nombre: "clasificar", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/clasificar`, cuerpo: () => ({ versionBase: 1, destino: "DNG" }) },
  { nombre: "editar", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/editar`, cuerpo: () => ({ versionBase: 1, cambios: { biDg: "110.00" } }) },
  { nombre: "calcular", escribe: false, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/calcular`, cuerpo: () => ({ cambios: { biDg: "110.00" } }) },
  { nombre: "aceptar sugerencia", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-1040"]}/sugerencias/aceptar`, cuerpo: () => ({ versionBase: 1, regla: "R-ISC", confirmar: true }) },
  { nombre: "excluir", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/excluir`, cuerpo: () => ({ versionBase: 1 }) },
  { nombre: "restaurar", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/restaurar`, cuerpo: () => ({ versionBase: 2 }) },
  { nombre: "descartar", escribe: true, metodo: "POST", ruta: (i) => `/${i["F001-3064"]}/descartar`, cuerpo: () => ({ versionBase: 1 }) },
  { nombre: "agregar", escribe: true, metodo: "POST", ruta: () => "", cuerpo: () => cuerpoAgregar("F001", "9800") },
  { nombre: "masiva clasificar", escribe: true, metodo: "POST", ruta: () => "/masivas/clasificar", cuerpo: (i) => ({ items: [{ compraId: i["F001-3064"], versionBase: 1 }], destino: "DNG" }) },
  { nombre: "masiva aceptar", escribe: true, metodo: "POST", ruta: () => "/masivas/aceptar", cuerpo: (i) => ({ items: [{ compraId: i["F001-3064"], versionBase: 1 }], regla: "R-RED" }) },
  { nombre: "masiva excluir", escribe: true, metodo: "POST", ruta: () => "/masivas/excluir", cuerpo: (i) => ({ items: [{ compraId: i["F001-3064"], versionBase: 1 }] }) },
  { nombre: "masiva restaurar", escribe: true, metodo: "POST", ruta: () => "/masivas/restaurar", cuerpo: (i) => ({ items: [{ compraId: i["F001-3064"], versionBase: 2 }] }) },
  { nombre: "deshacer", escribe: true, metodo: "POST", ruta: () => "/deshacer", cuerpo: () => ({}) },
  { nombre: "rehacer", escribe: true, metodo: "POST", ruta: () => "/rehacer", cuerpo: () => ({}) },
  { nombre: "revisar", escribe: true, metodo: "POST", ruta: () => "/estado/revisar", cuerpo: () => ({}) },
  { nombre: "reabrir", escribe: true, metodo: "POST", ruta: () => "/estado/reabrir", cuerpo: () => ({}), aprobar: true },
];
const ES_DE_COMPRA = (r: Ruta) => r.ruta({ "F001-3064": "x", "F001-1040": "x" }).startsWith("/x");

const llamarRuta = (a: Actor, r: Ruta, clienteId: string, ids: IdsPorNumero, periodo = PERIODO) =>
  v.llamar(a, r.metodo, `${base(clienteId, periodo)}${r.ruta(ids)}`, r.cuerpo(ids));

/**
 * La ruta existe para el dueño legítimo: con un periodo mal formado responde 400 (no el 404 de una ruta inexistente). Sin esta
 * guarda, un 404 por «ruta no registrada» pasaría por aislamiento.
 */
async function existe(r: Ruta, clienteId: string, ids: IdsPorNumero): Promise<void> {
  const x = await llamarRuta(titular(), r, clienteId, ids, "2026-10");
  expect(x.status, `${r.nombre}: la ruta existe (${x.text})`).toBe(400);
}

describe("CA-13 · el mismo 404 para cliente ajeno, no asignado e inexistente en todas las rutas de acción", () => {
  it.each(RUTAS)("otro estudio · $nombre", async (r) => {
    const { c, ids } = await escenario();
    await existe(r, c.id, ids);
    const antes = await v.foto(c.id);
    const ajeno = await llamarRuta(F.titular, r, c.id, ids);
    const inexistente = await llamarRuta(F.titular, r, randomUUID(), ids);
    expect(ajeno.status, ajeno.text).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(ajeno)).toEqual(forma(inexistente));
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each(RUTAS)("asistente no asignado · $nombre", async (r) => {
    const { c, ids } = await escenario();
    await existe(r, c.id, ids);
    const antes = await v.foto(c.id);
    const ajeno = await llamarRuta(asistenteAjeno, r, c.id, ids);
    const inexistente = await llamarRuta(asistenteAjeno, r, randomUUID(), ids);
    expect(ajeno.status, ajeno.text).toBe(404);
    expect(ajeno.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(ajeno)).toEqual(forma(inexistente));
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each(RUTAS.filter(ES_DE_COMPRA))(
    "un compraId de otro cliente del mismo estudio es 404 y no se toca · $nombre",
    async (r) => {
      const { c } = await escenario();
      const otro = await escenario();
      await existe(r, c.id, otro.ids);
      const antes = await v.foto(otro.c.id);
      const x = await llamarRuta(titular(), r, c.id, otro.ids); // ids del otro cliente en la URL de este
      expect(x.status, x.text).toBe(404);
      expect(x.body).toEqual({ codigo: "no_encontrado" });
      expect(await v.foto(otro.c.id)).toEqual(antes);
    },
  );

  it.each(RUTAS.filter(ES_DE_COMPRA))(
    "un compraId de otro periodo del mismo cliente es 404 · $nombre",
    async (r) => {
      const { c, ids } = await escenario();
      await existe(r, c.id, ids);
      const antes = await v.foto(c.id);
      const x = await llamarRuta(titular(), r, c.id, ids, "202609");
      expect(x.status, x.text).toBe(404);
      expect(x.body).toEqual({ codigo: "no_encontrado" });
      expect(await v.foto(c.id)).toEqual(antes);
    },
  );

  it.each(RUTAS.filter(ES_DE_COMPRA))(
    "un compraId de un cliente de otro estudio es 404 · $nombre",
    async (r) => {
      const { c } = await escenario();
      const cf = await v.cliente(F);
      const idsF = await v.sembrarFixture(F.tenantId, cf.id, { usuarioId: F.titular.id });
      await existe(r, c.id, idsF);
      const antes = await v.foto(cf.id);
      const x = await llamarRuta(titular(), r, c.id, idsF);
      expect(x.status, x.text).toBe(404);
      expect(x.body).toEqual({ codigo: "no_encontrado" });
      expect(await v.foto(cf.id)).toEqual(antes);
    },
  );
});

describe("CA-13 · sin permiso, sin sesión y cliente archivado", () => {
  it.each(RUTAS)("lectura recibe 403 permiso_denegado y no escribe · $nombre", async (r) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const x = await llamarRuta(lectura, r, c.id, ids);
    expect(x.status, x.text).toBe(403);
    expect(x.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("reabrir exige sire.aprobar_generar: el asistente asignado recibe 403 permiso_denegado", async () => {
    const { c, ids } = await escenario();
    const r = RUTAS.find((x) => x.nombre === "reabrir")!;
    const x = await llamarRuta(asistente, r, c.id, ids);
    expect(x.status, x.text).toBe(403);
    expect(x.body).toEqual({ codigo: "permiso_denegado" });
  });

  it.each(RUTAS)("sin sesión: 401 y no escribe · $nombre", async (r) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const x = await v.sinSesion(r.metodo, `${base(c.id)}${r.ruta(ids)}`, r.cuerpo(ids));
    expect(x.status, x.text).toBe(401);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each(RUTAS.filter((r) => r.escribe))(
    "cliente archivado: 409 cliente_archivado y no escribe · $nombre",
    async (r) => {
      const { c, ids } = await escenario({ archivado: true });
      const antes = await v.foto(c.id);
      const x = await llamarRuta(contador, r, c.id, ids);
      expect(x.status, x.text).toBe(409);
      expect(x.body).toEqual({ codigo: "cliente_archivado" });
      expect(await v.foto(c.id)).toEqual(antes);
    },
  );

  it("control: el dueño legítimo recorre las rutas de acción con éxito (los 404 de arriba no son rutas inexistentes)", async () => {
    const { c, ids } = await escenario();
    const ok = async (nombre: string, esperado: number | number[]) => {
      const r = RUTAS.find((x) => x.nombre === nombre)!;
      const x = await llamarRuta(titular(), r, c.id, ids);
      expect([esperado].flat(), `${nombre}: ${x.text}`).toContain(x.status);
      return x;
    };
    await ok("clasificar", 200); // F001-3064 pasa a versión 2
    await ok("calcular", 200);
    await ok("aceptar sugerencia", 200);
    const e = await post(titular(), c, `/${ids["F001-3064"]}/editar`, { versionBase: 2, cambios: { biDng: "110.00" } });
    expect(e.status, e.text).toBe(200); // versión 3
    await ok("agregar", 201);
    await ok("deshacer", 200);
    await ok("rehacer", 200);
    await ok("revisar", 200);
    await ok("reabrir", 200);
    expect((await post(titular(), c, `/${ids["F001-5070"]}/excluir`, { versionBase: 1 })).status).toBe(200);
    expect((await post(titular(), c, `/${ids["F001-5070"]}/restaurar`, { versionBase: 2 })).status).toBe(200);
    expect(
      (await post(titular(), c, "/masivas/clasificar", { items: [{ compraId: ids["F001-5070"], versionBase: 3 }], destino: "DNG" })).status,
    ).toBe(200);
    expect(
      (await post(titular(), c, "/masivas/excluir", { items: [{ compraId: ids["F001-5070"], versionBase: 4 }] })).status,
    ).toBe(200);
    expect(
      (await post(titular(), c, "/masivas/restaurar", { items: [{ compraId: ids["F001-5070"], versionBase: 5 }] })).status,
    ).toBe(200);
    expect(
      (await post(titular(), c, "/masivas/aceptar", { items: [{ compraId: ids["F001-1040"], versionBase: 2 }], regla: "R-RED" })).status,
    ).toBe(200); // parcial: la rechazada va en el informe
    const agregada = (await v.compras(c.id)).find((x) => x.origen === "agregada")!;
    expect((await post(titular(), c, `/${agregada.id}/descartar`, { versionBase: 1 })).status).toBe(200);
  });
});

// --- CA-15 · p95 de una acción con 5.000 filas ---------------------------------------------------------------------------

describe("CA-15 · una acción sobre una fila con 5.000 filas en el periodo (RNF-033)", () => {
  it("p95 < 300 ms entre clasificar, editar y excluir sobre filas distintas", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const filas = await v.sembrarVolumen(E.tenantId, c.id, 5000, { usuarioId: E.titular.id });
    expect(filas).toHaveLength(5000);
    // Calentamiento: la primera llamada paga el arranque de módulos y del pool.
    for (let i = 0; i < 5; i++) {
      const r = await post(contador, c, `/${filas[i]}/clasificar`, { versionBase: 1, destino: "DNG" });
      expect(r.status, r.text).toBe(200);
    }
    const tiempos: number[] = [];
    for (let i = 5; i < 65; i++) {
      const id = filas[i * 7]!;
      const r =
        i % 3 === 0
          ? await post(contador, c, `/${id}/clasificar`, { versionBase: 1, destino: "DGNG" })
          : i % 3 === 1
            ? await post(contador, c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "101.00" } })
            : await post(contador, c, `/${id}/excluir`, { versionBase: 1 });
      expect(r.status, r.text).toBe(200);
      tiempos.push(r.ms);
    }
    expect(p95(tiempos), `tiempos(ms): ${tiempos.join(",")}`).toBeLessThan(300);
  });
});

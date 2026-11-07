// Spec 014 (T20a): lecturas de compras de `packages/db/src/compras/lectura.ts` contra la BD real, con RLS. Antes solo las
// cubrían las suites del backend y el gate `cobertura:db` las medía en 0 %. Aquí se prueba su comportamiento público:
//   listarCompras(tx, clienteId, periodo, filtros) · leerDetalleCompra(tx, clienteId, periodo, compraId)
//   leerHallazgosVigentes(tx, compraIds) · leerOrigenesCompras(tx, clienteId, periodo, ids) · leerLoteParaResumen(...)
// Datos sintéticos; los montos viajan como cadenas.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioCompras, MONTOS_DG, montos, PERIODO } from "./compras-soporte";

interface Compra {
  id: string;
  serie: string;
  numero: string;
  razonSocial: string | null;
  fecha: string;
  montos: Record<string, string>;
  excluida: boolean;
}
interface Listada {
  compra: Compra;
  proveedorNuevo: boolean;
  hallazgos: { compraId: string; regla: string; requiereConfirmacion: boolean }[];
}
interface Pagina {
  filas: Listada[];
  siguiente: { fecha: string; serie: string; numero: string; id: string } | null;
}
type Filtros = {
  limite: number;
  cursor?: Pagina["siguiente"];
  vista?: "con_igv" | "sin_igv" | "excluidas";
  alertas?: boolean;
  proveedorNuevo?: boolean;
  q?: string;
};

const listarCompras = (tx: Tx, c: string, p: string, f: Filtros) =>
  exportado<(tx: Tx, c: string, p: string, f: Filtros) => Promise<Pagina>>("listarCompras")(tx, c, p, f);
const leerDetalleCompra = (tx: Tx, c: string, p: string, id: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      id: string,
    ) => Promise<null | {
      compra: Compra;
      proveedorNuevo: boolean;
      versiones: { n: number; accion: string; excluida: boolean; motivo: string | null; montos: Record<string, string> }[];
      hallazgos: { regla: string }[];
    }>
  >("leerDetalleCompra")(tx, c, p, id);
const leerHallazgosVigentes = (tx: Tx, ids: string[]) =>
  exportado<(tx: Tx, ids: string[]) => Promise<Map<string, { regla: string; lecturas: Record<string, string> }[]>>>(
    "leerHallazgosVigentes",
  )(tx, ids);
const leerOrigenesCompras = (tx: Tx, c: string, p: string, ids: string[]) =>
  exportado<(tx: Tx, c: string, p: string, ids: string[]) => Promise<Map<string, string>>>("leerOrigenesCompras")(
    tx,
    c,
    p,
    ids,
  );
const leerLoteParaResumen = (tx: Tx, c: string, p: string, despuesDe: string | null, n: number) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string | null,
      n: number,
    ) => Promise<
      {
        id: string;
        origen: string;
        moneda: string;
        tipoCambio: string | null;
        excluida: boolean;
        original: Record<string, string>;
        vigente: Record<string, string>;
      }[]
    >
  >("leerLoteParaResumen")(tx, c, p, despuesDe, n);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  backend = crearDb("contapp_backend", 6);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

const comoX = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: X }, fn);
const comoY = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: Y }, fn);
const hallazgo = (compraId: string, versionN: number, regla: string, confirmar = false) =>
  admin.query(
    `insert into compra_hallazgo (tenant_id, compra_id, version_n, regla, sugerencia, lecturas, requiere_confirmacion)
     values ($1, $2, $3, $4, '{"destino":"DNG"}'::jsonb, '{"biDg":"1000.00"}'::jsonb, $5)`,
    [X, compraId, versionN, regla, confirmar],
  );
const numeros = (p: Pagina) => p.filas.map((f) => `${f.compra.serie}-${f.compra.numero}`);

describe("listarCompras · filtros, orden y paginación con cursor", () => {
  let c: ClientePrueba;
  let ids: Record<string, string>;
  const P_OTRO = "202609";
  beforeAll(async () => {
    c = await ec.cliente(X);
    const s = (serie: string, numero: string, o: Record<string, unknown> = {}) =>
      ec.compra(X, c, { serie, numero, propuestaId: propX, docNumero: "20100070970", ...o });
    // Orden esperado: fecha, serie ('C' ordena antes que minúsculas y por bytes), número como entero (999 < 1000), id.
    const a = await s("F001", "1000", { fecha: "2026-10-05", razonSocial: "ALFA PERU SAC" });
    const b = await s("F001", "999", { fecha: "2026-10-05", razonSocial: "BETA 100% SAC", docNumero: "20100070971" });
    const d = await s("B001", "7", { fecha: "2026-10-10", razonSocial: "GAMMA SAC", docNumero: "20100070972", montos: montos({ biDng: "100.00" }) });
    const e = await s("F002", "1", { fecha: "2026-10-01", razonSocial: "DELTA SAC", docNumero: "20100070973" });
    const f = await s("F003", "2", { fecha: "2026-10-20", razonSocial: "EXCLUIDA SAC", docNumero: "20100070974" });
    const g = await ec.compra(X, c, { serie: "G001", numero: "1", origen: "agregada", docNumero: "20100070975", razonSocial: "DESCARTADA SAC", fecha: "2026-10-02" });
    await ec.version(X, f.id, 2, { excluida: true, motivo: "no es del giro", accion: "excluir" });
    await admin.query("update compra set descartada_en = now() where id = $1", [g.id]);
    await hallazgo(a.id, 1, "R-ISC", true);
    await hallazgo(a.id, 1, "R-MIX");
    // Otro periodo con el mismo documento que «a» (20100070970): «a» deja de ser de proveedor nuevo.
    await ec.compra(X, c, { periodo: P_OTRO, serie: "F009", numero: "1", propuestaId: propX, docNumero: "20100070970" });
    ids = { a: a.id, b: b.id, d: d.id, e: e.id, f: f.id, g: g.id };
  });

  const lista = (f: Partial<Filtros> = {}) => comoX((tx) => listarCompras(tx, c.id, PERIODO, { limite: 50, ...f }));

  it("la lista principal ordena por fecha, serie y número como entero, y no trae excluidas ni descartadas", async () => {
    const p = await lista();
    expect(numeros(p)).toEqual(["F002-1", "F001-999", "F001-1000", "B001-7"]);
    expect(p.siguiente).toBeNull();
    expect(p.filas.every((x) => !x.compra.excluida)).toBe(true);
  });

  it("pagina con cursor sin repetir ni saltar filas, y la última página no tiene siguiente", async () => {
    const vistas: string[] = [];
    let cursor: Pagina["siguiente"] | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await lista({ limite: 3, cursor });
      vistas.push(...numeros(p));
      if (p.siguiente === null) break;
      expect(p.filas).toHaveLength(3);
      cursor = p.siguiente;
    }
    expect(vistas).toEqual(["F002-1", "F001-999", "F001-1000", "B001-7"]);
  });

  it("el cursor desempata por serie y número dentro de la misma fecha", async () => {
    const primera = await lista({ limite: 2 });
    expect(numeros(primera)).toEqual(["F002-1", "F001-999"]);
    expect(primera.siguiente).toMatchObject({ serie: "F001", numero: "999", fecha: "2026-10-05" });
    expect(numeros(await lista({ limite: 2, cursor: primera.siguiente }))).toEqual(["F001-1000", "B001-7"]);
  });

  it("vista: con_igv, sin_igv y excluidas separan la lista", async () => {
    expect(numeros(await lista({ vista: "con_igv" }))).toEqual(["F002-1", "F001-999", "F001-1000"]);
    expect(numeros(await lista({ vista: "sin_igv" }))).toEqual(["B001-7"]);
    const ex = await lista({ vista: "excluidas" });
    expect(numeros(ex)).toEqual(["F003-2"]);
    expect(ex.filas[0]?.compra.excluida).toBe(true);
  });

  it("alertas trae solo las que tienen hallazgos de su versión vigente, con las reglas en el orden de 011", async () => {
    const p = await lista({ alertas: true });
    expect(numeros(p)).toEqual(["F001-1000"]);
    expect(p.filas[0]?.hallazgos.map((h) => h.regla)).toEqual(["R-ISC", "R-MIX"]);
    expect(p.filas[0]?.hallazgos[0]?.requiereConfirmacion).toBe(true);
  });

  it("proveedorNuevo: quien ya compró al proveedor en otro periodo no es nuevo", async () => {
    const nuevos = await lista({ proveedorNuevo: true });
    expect(numeros(nuevos)).toEqual(["F002-1", "F001-999", "B001-7"]);
    expect(nuevos.filas.every((x) => x.proveedorNuevo)).toBe(true);
    const conocidos = await lista({ proveedorNuevo: false });
    expect(numeros(conocidos)).toEqual(["F001-1000"]);
    expect(conocidos.filas[0]?.proveedorNuevo).toBe(false);
  });

  it("q busca por prefijo de RUC, fragmento de razón social o de serie-número, sin distinguir mayúsculas", async () => {
    expect(numeros(await lista({ q: "2010007097" }))).toEqual(["F002-1", "F001-999", "F001-1000", "B001-7"]);
    expect(numeros(await lista({ q: "20100070972" }))).toEqual(["B001-7"]);
    expect(numeros(await lista({ q: "alfa" }))).toEqual(["F001-1000"]);
    expect(numeros(await lista({ q: "f001-99" }))).toEqual(["F001-999"]);
    expect(await lista({ q: "no-existe" })).toMatchObject({ filas: [] });
  });

  it("q trata %, _ y \\ como texto literal, y la cadena vacía no filtra", async () => {
    expect(numeros(await lista({ q: "100%" }))).toEqual(["F001-999"]);
    expect(numeros(await lista({ q: "%" }))).toEqual(["F001-999"]);
    expect(numeros(await lista({ q: "_" }))).toEqual([]);
    expect(numeros(await lista({ q: "\\" }))).toEqual([]);
    expect(await lista({ q: "" })).toMatchObject({ filas: expect.any(Array) });
    expect((await lista({ q: "" })).filas).toHaveLength(4);
  });

  it("otro estudio no ve nada del cliente (RLS) y los montos llegan como cadenas exactas", async () => {
    const ajeno = await comoY((tx) => listarCompras(tx, c.id, PERIODO, { limite: 50 }));
    expect(ajeno.filas).toEqual([]);
    const p = await lista();
    const a = p.filas.find((x) => x.compra.id === ids.a)!;
    expect(a.compra.montos.biDg).toBe("1000.00");
    expect(typeof a.compra.montos.total).toBe("string");
  });
});

describe("leerDetalleCompra · compra con historial y hallazgos", () => {
  it("devuelve la vigente, todas las versiones en orden y los hallazgos de la vigente", async () => {
    const c = await ec.cliente(X);
    const k = await ec.compra(X, c, { serie: "D001", numero: "1", propuestaId: propX, docNumero: "20100070980" });
    await ec.version(X, k.id, 2, { montos: { biDg: "500.00", igvDg: "90.00" }, accion: "editar", motivo: null });
    await hallazgo(k.id, 1, "R-NEW");
    await hallazgo(k.id, 2, "R-RED");
    const d = await comoX((tx) => leerDetalleCompra(tx, c.id, PERIODO, k.id));
    expect(d).not.toBeNull();
    expect(d!.compra.id).toBe(k.id);
    expect(d!.compra.montos.biDg).toBe("500.00");
    expect(d!.versiones.map((v) => [v.n, v.accion])).toEqual([
      [1, "original"],
      [2, "editar"],
    ]);
    expect(d!.versiones[0]?.montos.biDg).toBe(MONTOS_DG.biDg);
    expect(d!.hallazgos.map((h) => h.regla)).toEqual(["R-RED"]);
    expect(d!.proveedorNuevo).toBe(true);
  });

  it("sin hallazgos devuelve una lista vacía", async () => {
    const c = await ec.cliente(X);
    const k = await ec.compra(X, c, { serie: "D002", numero: "1", propuestaId: propX, docNumero: "20100070981" });
    const d = await comoX((tx) => leerDetalleCompra(tx, c.id, PERIODO, k.id));
    expect(d?.hallazgos).toEqual([]);
  });

  it("es null para id mal formado, inexistente, de otro periodo o cliente, descartada o de otro estudio", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const k = await ec.compra(X, c, { serie: "D003", numero: "1", propuestaId: propX, docNumero: "20100070982" });
    const g = await ec.compra(X, c, { serie: "D004", numero: "1", origen: "agregada", docNumero: "20100070983" });
    await admin.query("update compra set descartada_en = now() where id = $1", [g.id]);
    const leer = (cl: string, p: string, id: string) => comoX((tx) => leerDetalleCompra(tx, cl, p, id));
    expect(await leer(c.id, PERIODO, "no-es-un-uuid")).toBeNull();
    expect(await leer(c.id, PERIODO, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await leer(c.id, "202609", k.id)).toBeNull();
    expect(await leer(otro.id, PERIODO, k.id)).toBeNull();
    expect(await leer(c.id, PERIODO, g.id)).toBeNull();
    expect(await comoY((tx) => leerDetalleCompra(tx, c.id, PERIODO, k.id))).toBeNull();
    expect(await leer(c.id, PERIODO, k.id)).not.toBeNull();
  });
});

describe("leerHallazgosVigentes · solo los de la versión vigente", () => {
  it("lista vacía no consulta; las versiones viejas no salen; sin hallazgos la compra no figura", async () => {
    const c = await ec.cliente(X);
    const k = await ec.compra(X, c, { serie: "H001", numero: "1", propuestaId: propX, docNumero: "20100070990" });
    const l = await ec.compra(X, c, { serie: "H001", numero: "2", propuestaId: propX, docNumero: "20100070991" });
    await hallazgo(k.id, 1, "R-ISC");
    await ec.version(X, k.id, 2, { accion: "editar" });
    await hallazgo(k.id, 2, "R-MIX");
    await hallazgo(k.id, 2, "R-GP");
    expect((await comoX((tx) => leerHallazgosVigentes(tx, []))).size).toBe(0);
    const m = await comoX((tx) => leerHallazgosVigentes(tx, [k.id, l.id]));
    expect(m.get(k.id)?.map((h) => h.regla)).toEqual(["R-MIX", "R-GP"]);
    expect(m.get(k.id)?.[0]?.lecturas).toEqual({ biDg: "1000.00" });
    expect(m.has(l.id)).toBe(false);
  });
});

describe("leerOrigenesCompras · origen de las vivas del cliente y periodo", () => {
  it("devuelve sire y agregada; omite inexistentes, de otro periodo o cliente, descartadas y ids mal formados", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const s = await ec.compra(X, c, { serie: "O001", numero: "1", propuestaId: propX, docNumero: "20100071000" });
    const a = await ec.compra(X, c, { serie: "O001", numero: "2", origen: "agregada", docNumero: "20100071001" });
    const g = await ec.compra(X, c, { serie: "O001", numero: "3", origen: "agregada", docNumero: "20100071002" });
    const ajena = await ec.compra(X, otro, { serie: "O001", numero: "4", propuestaId: propX, docNumero: "20100071003" });
    await admin.query("update compra set descartada_en = now() where id = $1", [g.id]);
    const leer = (cl: string, ids: string[]) => comoX((tx) => leerOrigenesCompras(tx, cl, PERIODO, ids));
    expect((await leer(c.id, ["no-uuid", "123"])).size).toBe(0);
    expect((await leer(c.id, [])).size).toBe(0);
    const m = await leer(c.id, [s.id, a.id, g.id, ajena.id, "no-uuid", "00000000-0000-4000-8000-000000000000"]);
    expect([...m.entries()].sort()).toEqual(
      [
        [s.id, "sire"],
        [a.id, "agregada"],
      ].sort(),
    );
    expect((await comoY((tx) => leerOrigenesCompras(tx, c.id, PERIODO, [s.id]))).size).toBe(0);
  });
});

describe("leerLoteParaResumen · lotes por id con la versión 1 y la vigente", () => {
  it("recorre el periodo en lotes por id ascendente hasta vaciarse, con montos originales y vigentes", async () => {
    const c = await ec.cliente(X);
    const hechas: string[] = [];
    for (let i = 1; i <= 5; i++)
      hechas.push(
        (await ec.compra(X, c, { serie: "L001", numero: String(i), propuestaId: propX, docNumero: `2010007110${i}` })).id,
      );
    const usd = await ec.compra(X, c, { serie: "L002", numero: "1", propuestaId: propX, docNumero: "20100071120", moneda: "USD", tipoCambio: "3.300" });
    const g = await ec.compra(X, c, { serie: "L003", numero: "1", origen: "agregada", docNumero: "20100071121" });
    await admin.query("update compra set descartada_en = now() where id = $1", [g.id]);
    await ec.version(X, hechas[0]!, 2, { montos: { biDg: "400.00", igvDg: "72.00" }, excluida: true, motivo: "x" });

    const todos: Awaited<ReturnType<typeof leerLoteParaResumen>> = [];
    let despues: string | null = null;
    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const lote = await comoX((tx) => leerLoteParaResumen(tx, c.id, PERIODO, despues, 4));
      if (lote.length === 0) break;
      expect(lote.length).toBeLessThanOrEqual(4);
      todos.push(...lote);
      despues = lote[lote.length - 1]!.id;
    }
    const ids = todos.map((l) => l.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set([...hechas, usd.id]));
    const primera = todos.find((l) => l.id === hechas[0])!;
    expect(primera.excluida).toBe(true);
    expect(primera.original.biDg).toBe("1000.00");
    expect(primera.vigente.biDg).toBe("400.00");
    expect(primera.origen).toBe("sire");
    const d = todos.find((l) => l.id === usd.id)!;
    expect(d).toMatchObject({ moneda: "USD", tipoCambio: "3.300", excluida: false });
    expect((await comoY((tx) => leerLoteParaResumen(tx, c.id, PERIODO, null, 10))).length).toBe(0);
  });
});

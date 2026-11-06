// Spec 013 (T2, rojo): repositorios de `packages/db/src/ventas/**` contra la BD real (CA-3, CA-5, CA-7, CA-8, CA-11; D3, D8,
// D9, D10, D16, D17). Se importan de `@contapp/db` por nombre (si faltan, la prueba dice cual).
//
// FIRMAS que fija (T8). Todas reciben la `tx` de withTenant como primer argumento y trabajan dentro del estudio del contexto.
// Los montos y el tipo de cambio entran y salen como CADENAS decimales ("118.00", "3.456"), nunca `number`; la fecha, como
// "AAAA-MM-DD"; las marcas de tiempo, como Date. Los errores de pg se reducen a un error con `codigo` = SQLSTATE.
//   type VentaNueva = { clave, tipo, serie, numero, fecha, tipoDocContraparte, docContraparte, moneda: 'PEN'|'USD',
//     tipoCambio: string | null, baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total }
//   type VentaFila = VentaNueva & { id, clienteId, periodo, propuestaId: string | null, origen: 'sire'|'manual',
//     numeroN: number | null, creadaPor: string | null, creadaEn: Date }
//   type Existente = { clave, origen: 'sire'|'manual', campos: Record<string, string> }
//     campos = fecha, moneda, tipoCambio, tipoDocContraparte, docContraparte y los 8 montos (baseGravada, igv, exonerada,
//     inafecta, isc, icbper, otros, total), todos cadenas; sin razon social (spec D16 / plan: planificarComplemento).
//   type Justificado = { id, tipo, serie, desde: number, hasta: number, comentario, usuarioId, creadaEn: Date,
//     revertidoPor: string | null, revertidoEn: Date | null }
//
//   insertarVentas(tx, { clienteId, periodo, propuestaId }, ventas: VentaNueva[]): Promise<void>
//       Origen `sire`; calcula `numeroN` (entero si `numero` tiene 1 a 8 digitos, si no null). Todo o nada; una clave repetida
//       lanza (23505). Parte la insercion en lotes (20.000 filas no caben en un solo INSERT parametrizado). Nunca actualiza.
//   leerExistentes(tx, clienteId, periodo): Promise<Existente[]>            (sire y manual del periodo)
//   listarVentas(tx, clienteId, periodo, f): Promise<{ filas: VentaFila[]; total: number; avisos: string[] }>
//       f = { pagina (desde 1), tamano: 10 | 25 | 50 | 'todas', q?, tipo?, serie?, min?, max? }; orden (tipo, serie, numeroN,
//       numero) con los no evaluables al final; `total` = filas que cumplen los filtros (no las de la pagina); min y max
//       (cadenas) se comparan con el `total` de la venta como NUMERIC, sin redondear el limite; `q` busca una coincidencia
//       parcial, sin distinguir mayusculas, en `serie-numero` y en `docContraparte`, con %, _ y \ literales.
//       'todas' entrega como maximo 5.000 filas y agrega 'todas_limitada' a `avisos` cuando hay mas.
//   leerFilasVentas(tx, clienteId, periodo): Promise<VentaFila[]>           (todas las del periodo, mismo orden; base del
//       resumen y de la correlatividad; sin tope de 5.000)
//   crearVentaManual(tx, { clienteId, periodo, creadaPor, ...VentaNueva }): Promise<VentaFila>   (origen manual; clave repetida
//       en el periodo, tambien contra una fila sire, lanza 23505)
//   quitarVentaManual(tx, ventaId): Promise<boolean>     (true solo si borro una fila manual del estudio; sire o ajena = false)
//   justificar(tx, { clienteId, periodo, tipo, serie, desde, hasta, comentario, usuarioId }): Promise<Justificado>
//       Si ya hay una vigente igual, la devuelve (no lanza y no crea otra).
//   revertirJustificacion(tx, id, usuarioId): Promise<boolean>   (solo escribe revertido_*; true si estaba vigente)
//   listarJustificados(tx, clienteId, periodo, opciones?: { incluirRevertidas?: boolean }): Promise<Justificado[]>
//       (vigentes por defecto; orden tipo, serie, desde, hasta)
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { contar, EscenarioVentas, PERIODO } from "./ventas-soporte";

interface VentaNueva {
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  fecha: string;
  tipoDocContraparte: string;
  docContraparte: string;
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}
type VentaFila = VentaNueva & {
  id: string;
  clienteId: string;
  periodo: string;
  propuestaId: string | null;
  origen: "sire" | "manual";
  numeroN: number | null;
  creadaPor: string | null;
  creadaEn: Date;
};
interface Existente {
  clave: string;
  origen: "sire" | "manual";
  campos: Record<string, string>;
}
interface Justificado {
  id: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
  usuarioId: string;
  creadaEn: Date;
  revertidoPor: string | null;
  revertidoEn: Date | null;
}
interface Filtros {
  pagina: number;
  tamano: 10 | 25 | 50 | "todas";
  q?: string;
  tipo?: string;
  serie?: string;
  min?: string;
  max?: string;
}
interface Pagina {
  filas: VentaFila[];
  total: number;
  avisos: string[];
}
interface Ctx {
  clienteId: string;
  periodo: string;
  propuestaId: string;
}
interface DatosJustificar {
  clienteId: string;
  periodo: string;
  tipo: string;
  serie: string;
  desde: number;
  hasta: number;
  comentario: string;
  usuarioId: string;
}

const insertarVentas = (tx: Tx, c: Ctx, v: VentaNueva[]) =>
  exportado<(tx: Tx, c: Ctx, v: VentaNueva[]) => Promise<void>>("insertarVentas")(tx, c, v);
const leerExistentes = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<Existente[]>>("leerExistentes")(tx, c, p);
const listarVentas = (tx: Tx, c: string, p: string, f: Filtros) =>
  exportado<(tx: Tx, c: string, p: string, f: Filtros) => Promise<Pagina>>("listarVentas")(tx, c, p, f);
const leerFilasVentas = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<VentaFila[]>>("leerFilasVentas")(tx, c, p);
const crearVentaManual = (tx: Tx, n: VentaNueva & { clienteId: string; periodo: string; creadaPor: string }) =>
  exportado<(tx: Tx, n: unknown) => Promise<VentaFila>>("crearVentaManual")(tx, n);
const quitarVentaManual = (tx: Tx, id: string) =>
  exportado<(tx: Tx, id: string) => Promise<boolean>>("quitarVentaManual")(tx, id);
const justificar = (tx: Tx, d: DatosJustificar) =>
  exportado<(tx: Tx, d: DatosJustificar) => Promise<Justificado>>("justificar")(tx, d);
const revertirJustificacion = (tx: Tx, id: string, u: string) =>
  exportado<(tx: Tx, id: string, u: string) => Promise<boolean>>("revertirJustificacion")(tx, id, u);
const listarJustificados = (tx: Tx, c: string, p: string, o?: { incluirRevertidas?: boolean }) =>
  exportado<(tx: Tx, c: string, p: string, o?: { incluirRevertidas?: boolean }) => Promise<Justificado[]>>("listarJustificados")(
    tx,
    c,
    p,
    o,
  );

let admin: Pool;
let ev: EscenarioVentas;
const dbs: ContappDb[] = [];
let X: string;
let Y: string;
let ux: string;
let uy: string;

const db = (rol: "contapp_backend" | "contapp_worker", max = 4): ContappDb => {
  const d = crearDb(rol, max);
  dbs.push(d);
  return d;
};
const backend = () => db("contapp_backend");
const worker = () => db("contapp_worker");

/** Un cliente nuevo en X: cada prueba trabaja en el suyo y no ve las filas de las otras. */
const clienteNuevo = (): Promise<ClientePrueba> => ev.cliente(X);

const venta = (tipo: string, serie: string, numero: string, o: Partial<VentaNueva> = {}): VentaNueva => ({
  clave: `${tipo}|${serie}|${numero.replace(/^0+(?=.)/, "")}`,
  tipo,
  serie,
  numero,
  fecha: "2026-10-05",
  tipoDocContraparte: "0",
  docContraparte: "-",
  moneda: "PEN",
  tipoCambio: null,
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...o,
});
const claves = (r: { clave: string }[]) => r.map((x) => x.clave);
const ids = (r: { numero: string; serie: string; tipo: string }[]) => r.map((x) => `${x.tipo} ${x.serie}-${x.numero}`);

async function sembrar(c: ClientePrueba, filas: VentaNueva[]): Promise<string> {
  const propuestaId = await ev.propuesta(X, c, { nuevas: filas.length });
  await worker().withTenant({ tenantId: X }, (tx) => insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, filas));
  return propuestaId;
}

beforeAll(async () => {
  admin = abrirAdmin(6);
  ev = new EscenarioVentas(admin);
  X = (await ev.estudio()).id;
  Y = (await ev.estudio()).id;
  ux = await ev.usuarioDe(X);
  uy = await ev.usuarioDe(Y);
});
afterAll(async () => {
  await ev?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

// =================================================================================================
describe("insertarVentas (D3, D16)", () => {
  it("el worker inserta filas sire con su propuesta; numeroN se deriva del numero (1 a 8 digitos) y nada mas cambia", async () => {
    const c = await clienteNuevo();
    const propuestaId = await ev.propuesta(X, c, { nuevas: 5 });
    await worker().withTenant({ tenantId: X }, (tx) =>
      insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, [
        venta("03", "B001", "290", { total: "120.50", baseGravada: "102.12", igv: "18.38" }),
        venta("03", "B001", "00291"),
        venta("03", "B001", "ABC12"),
        venta("03", "B001", "123456789"),
        venta("03", "B001", "12345678"),
      ]),
    );
    const r = (await admin.query("select * from venta where cliente_id = $1 order by numero", [c.id])).rows;
    expect(r).toHaveLength(5);
    const por = Object.fromEntries(r.map((x) => [x.numero, x]));
    expect(por["290"]).toMatchObject({
      tenant_id: X,
      origen: "sire",
      propuesta_id: propuestaId,
      periodo: PERIODO,
      clave: "03|B001|290",
      numero_n: 290,
      total: "120.50",
      base_gravada: "102.12",
      igv: "18.38",
      creada_por: null,
    });
    expect(por["00291"]).toMatchObject({ numero_n: 291, clave: "03|B001|291" });
    expect(por["ABC12"].numero_n).toBeNull();
    expect(por["123456789"].numero_n, "9 digitos: no evaluable").toBeNull();
    expect(por["12345678"].numero_n).toBe(12345678);
  });

  it("guarda moneda USD con su tipo de cambio de tres decimales y la fecha tal cual", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("01", "F001", "10", { moneda: "USD", tipoCambio: "3.456", fecha: "2026-10-31", total: "100.00" })]);
    const f = (await admin.query("select moneda, tipo_cambio::text as tc, fecha::text as fecha from venta where cliente_id = $1", [c.id])).rows[0];
    expect(f).toEqual({ moneda: "USD", tc: "3.456", fecha: "2026-10-31" });
  });

  it("una lista vacia no hace nada", async () => {
    const c = await clienteNuevo();
    const propuestaId = await ev.propuesta(X, c);
    await worker().withTenant({ tenantId: X }, (tx) => insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, []));
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(0);
  });

  it("todo o nada: una clave repetida (en el lote o ya guardada) lanza 23505 y no deja ni las otras filas", async () => {
    const c = await clienteNuevo();
    const propuestaId = await ev.propuesta(X, c, { nuevas: 2 });
    await expect(
      worker().withTenant({ tenantId: X }, (tx) =>
        insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, [venta("03", "B001", "1"), venta("03", "B001", "2"), venta("03", "B001", "1")]),
      ),
    ).rejects.toMatchObject({ codigo: "23505" });
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(0);
    await sembrar(c, [venta("03", "B001", "5")]);
    await expect(
      worker().withTenant({ tenantId: X }, (tx) =>
        insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, [venta("03", "B001", "6"), venta("03", "B001", "5")]),
      ),
    ).rejects.toMatchObject({ codigo: "23505" });
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(1);
  });

  it("nunca modifica una fila existente: insertar la misma clave con otro total falla y deja el original", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "290", { total: "118.00" })]);
    const propuestaId = await ev.propuesta(X, c, { nuevas: 1 });
    await expect(
      worker().withTenant({ tenantId: X }, (tx) =>
        insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, [venta("03", "B001", "290", { total: "999.00" })]),
      ),
    ).rejects.toMatchObject({ codigo: "23505" });
    expect((await admin.query("select total from venta where cliente_id = $1", [c.id])).rows[0].total).toBe("118.00");
  });

  it("20.000 filas en una llamada (tope de una propuesta): se parte en lotes y entran todas", async () => {
    const c = await clienteNuevo();
    const filas = Array.from({ length: 20000 }, (_, i) => venta("03", "B001", String(i + 1)));
    const propuestaId = await ev.propuesta(X, c, { nuevas: 20000 });
    await worker().withTenant({ tenantId: X }, (tx) => insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, filas));
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(20000);
  }, 60_000);

  it("un cliente de otro estudio lanza 23503 y una propuesta de otro estudio tambien", async () => {
    const cy = await ev.cliente(Y);
    const propX = await ev.propuesta(X, await clienteNuevo(), { nuevas: 1 });
    await expect(
      worker().withTenant({ tenantId: X }, (tx) => insertarVentas(tx, { clienteId: cy.id, periodo: PERIODO, propuestaId: propX }, [venta("03", "B001", "1")])),
    ).rejects.toMatchObject({ codigo: "23503" });
    const propY = await ev.propuesta(Y, cy, { nuevas: 1 });
    const c = await clienteNuevo();
    await expect(
      worker().withTenant({ tenantId: X }, (tx) => insertarVentas(tx, { clienteId: c.id, periodo: PERIODO, propuestaId: propY }, [venta("03", "B001", "1")])),
    ).rejects.toMatchObject({ codigo: "23503" });
  });
});

// =================================================================================================
describe("leerExistentes (D16): la base de planificarComplemento", () => {
  it("devuelve las filas sire y manual del periodo con su origen y los campos como cadenas", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [
      venta("03", "B001", "290", { total: "120.00" }),
      venta("01", "F001", "7", { moneda: "USD", tipoCambio: "3.456", total: "100.00", docContraparte: "20100000001", tipoDocContraparte: "6" }),
    ]);
    await ev.venta(X, c, { numero: "291", origen: "manual", montos: { total: "118.00" } });
    const r = await backend().withTenant({ tenantId: X }, (tx) => leerExistentes(tx, c.id, PERIODO));
    expect(r.map((x) => [x.clave, x.origen]).sort()).toEqual([
      ["01|F001|7", "sire"],
      ["03|B001|290", "sire"],
      ["03|B001|291", "manual"],
    ]);
    const b290 = r.find((x) => x.clave === "03|B001|290")!;
    expect(b290.campos).toMatchObject({
      fecha: "2026-10-05",
      moneda: "PEN",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "120.00",
    });
    const usd = r.find((x) => x.clave === "01|F001|7")!;
    expect(usd.campos).toMatchObject({ moneda: "USD", tipoCambio: "3.456", tipoDocContraparte: "6", docContraparte: "20100000001" });
    for (const f of r) {
      for (const [k, val] of Object.entries(f.campos)) expect(typeof val, `${f.clave}.${k}`).toBe("string");
      expect(Object.keys(f.campos), "sin razon social ni montos con number").not.toContain("razonSocial");
    }
  });

  it("solo lee el cliente y el periodo pedidos, y el estudio del contexto", async () => {
    const c = await clienteNuevo();
    const otro = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "1")]);
    await ev.venta(X, c, { numero: "2", periodo: "202609" });
    await ev.venta(X, otro, { numero: "3" });
    const r = await backend().withTenant({ tenantId: X }, (tx) => leerExistentes(tx, c.id, PERIODO));
    expect(claves(r)).toEqual(["03|B001|1"]);
    expect(await backend().withTenant({ tenantId: Y }, (tx) => leerExistentes(tx, c.id, PERIODO))).toEqual([]);
    expect(await backend().withTenant({ tenantId: X }, (tx) => leerExistentes(tx, otro.id, "202601"))).toEqual([]);
  });
});

// =================================================================================================
describe("listarVentas: orden, paginacion y total (D10, CA-5)", () => {
  it("ordena por tipo, serie y numero NUMERICO (1000 despues de 290), con los no evaluables al final de su serie", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [
      venta("07", "B001", "3"),
      venta("03", "B001", "1000"),
      venta("03", "B001", "ABC"),
      venta("03", "B001", "292"),
      venta("01", "F001", "12"),
      venta("03", "B001", "9"),
      venta("03", "B001", "290"),
      venta("01", "F001", "5"),
      venta("03", "B002", "1"),
    ]);
    const r = await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 1, tamano: 50 }));
    expect(ids(r.filas)).toEqual([
      "01 F001-5",
      "01 F001-12",
      "03 B001-9",
      "03 B001-290",
      "03 B001-292",
      "03 B001-1000",
      "03 B001-ABC",
      "03 B002-1",
      "07 B001-3",
    ]);
    expect(r.total).toBe(9);
    expect(r.avisos).toEqual([]);
  });

  it("la fila trae los datos tal cual: montos y tipo de cambio como cadenas, fecha AAAA-MM-DD, numeroN y Date", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("01", "F001", "10", { moneda: "USD", tipoCambio: "3.456", total: "1234.56", docContraparte: "20100000001", tipoDocContraparte: "6" })]);
    const f = (await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 1, tamano: 10 }))).filas[0];
    expect(f).toMatchObject({
      clienteId: c.id,
      periodo: PERIODO,
      origen: "sire",
      clave: "01|F001|10",
      tipo: "01",
      serie: "F001",
      numero: "10",
      numeroN: 10,
      fecha: "2026-10-05",
      tipoDocContraparte: "6",
      docContraparte: "20100000001",
      moneda: "USD",
      tipoCambio: "3.456",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "1234.56",
      creadaPor: null,
    });
    expect(f.propuestaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.creadaEn).toBeInstanceOf(Date);
    for (const k of ["baseGravada", "igv", "total", "tipoCambio"] as const) expect(typeof f[k]).toBe("string");
  });

  it("pagina de 10 en 10 (1-based): 25 filas dan 10, 10 y 5, sin repetir ni saltar, y total = 25 en todas", async () => {
    const c = await clienteNuevo();
    await sembrar(c, Array.from({ length: 25 }, (_, i) => venta("03", "B001", String(i + 1))));
    const pag = (pagina: number, tamano: 10 | 25 | 50 | "todas") =>
      backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina, tamano }));
    const [p1, p2, p3, p4] = [await pag(1, 10), await pag(2, 10), await pag(3, 10), await pag(4, 10)];
    expect([p1.filas.length, p2.filas.length, p3.filas.length, p4.filas.length]).toEqual([10, 10, 5, 0]);
    expect([p1.total, p2.total, p3.total, p4.total]).toEqual([25, 25, 25, 25]);
    expect([...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.numeroN)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    for (const t of [25, 50, "todas"] as const) {
      const r = await pag(1, t);
      expect(r.filas, `tamano ${t}`).toHaveLength(25);
      expect(r.avisos).toEqual([]);
    }
    expect((await pag(2, 25)).filas).toEqual([]);
  });

  /** `n` ventas sire de golpe con el superusuario (una sola sentencia). */
  async function masivas(c: ClientePrueba, n: number): Promise<void> {
    const propuestaId = await ev.propuesta(X, c, { nuevas: n });
    await admin.query(
      `insert into venta (tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
         tipo_doc_contraparte, doc_contraparte, moneda, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total)
       select $1, $2, $3, $4, 'sire', '03|B001|' || g, '03', 'B001', g::text, g, '2026-10-05', '0', '-', 'PEN',
              1, 0, 0, 0, 0, 0, 0, 1 from generate_series(1, $5::int) g`,
      [X, c.id, PERIODO, propuestaId, n],
    );
  }

  it("'todas' entrega como maximo 5.000 filas con el aviso todas_limitada y el total real; el resto se pide paginando", async () => {
    const c = await clienteNuevo();
    await masivas(c, 5001);
    const r = await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 1, tamano: "todas" }));
    expect(r.filas).toHaveLength(5000);
    expect(r.total).toBe(5001);
    expect(r.avisos).toEqual(["todas_limitada"]);
    expect(r.filas[0].numeroN).toBe(1);
    expect(r.filas[4999].numeroN).toBe(5000);
    const ultima = await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 101, tamano: 50 }));
    expect(ultima.filas.map((f) => f.numeroN)).toEqual([5001]);
    // leerFilasVentas (base del resumen y de la correlatividad) no tiene el tope de 5.000
    const todas = await backend().withTenant({ tenantId: X }, (tx) => leerFilasVentas(tx, c.id, PERIODO));
    expect(todas).toHaveLength(5001);
  }, 60_000);

  it("con 5.000 filas exactas 'todas' entrega las 5.000 y no avisa", async () => {
    const c = await clienteNuevo();
    await masivas(c, 5000);
    const r = await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 1, tamano: "todas" }));
    expect(r.filas).toHaveLength(5000);
    expect(r.total).toBe(5000);
    expect(r.avisos).toEqual([]);
  }, 60_000);

  it("el estudio ajeno y un periodo sin filas dan una pagina vacia con total 0", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "1")]);
    const f: Filtros = { pagina: 1, tamano: 10 };
    expect(await backend().withTenant({ tenantId: Y }, (tx) => listarVentas(tx, c.id, PERIODO, f))).toEqual({ filas: [], total: 0, avisos: [] });
    expect(await backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, "202601", f))).toEqual({ filas: [], total: 0, avisos: [] });
  });
});

// =================================================================================================
describe("listarVentas: filtros tipo, serie, rango de montos y busqueda (CA-5)", () => {
  let c: ClientePrueba;
  const listar = (f: Partial<Filtros>) =>
    backend().withTenant({ tenantId: X }, (tx) => listarVentas(tx, c.id, PERIODO, { pagina: 1, tamano: 50, ...f }));

  beforeAll(async () => {
    c = await clienteNuevo();
    await sembrar(c, [
      venta("03", "B001", "290", { total: "118.00", docContraparte: "40000011" }),
      venta("03", "B001", "292", { total: "236.00" }),
      venta("03", "B002", "1", { total: "0.00", baseGravada: "0.00", igv: "0.00" }),
      venta("01", "F001", "5", { total: "0.01", baseGravada: "0.01", igv: "0.00", docContraparte: "20100000001", tipoDocContraparte: "6" }),
      venta("01", "F001", "6", { total: "999999999999.99", baseGravada: "999999999999.99", igv: "0.00" }),
      venta("07", "B001", "3", { total: "-118.00", baseGravada: "-100.00", igv: "-18.00" }),
      venta("03", "B003", "100", { docContraparte: "A%B", total: "5.00" }),
      venta("03", "B003", "101", { docContraparte: "AXB", total: "5.00" }),
      venta("03", "B003", "102", { docContraparte: "A_B", total: "5.00" }),
      venta("03", "B003", "103", { docContraparte: "A\\B", total: "5.00" }),
    ]);
  });

  it("tipo y serie filtran por igualdad exacta y se combinan", async () => {
    expect(ids((await listar({ tipo: "01" })).filas)).toEqual(["01 F001-5", "01 F001-6"]);
    expect(ids((await listar({ serie: "B002" })).filas)).toEqual(["03 B002-1"]);
    expect(ids((await listar({ tipo: "03", serie: "B001" })).filas)).toEqual(["03 B001-290", "03 B001-292"]);
    expect((await listar({ tipo: "03", serie: "F001" })).total).toBe(0);
    expect((await listar({ serie: "B00" })).total, "la serie no es una busqueda parcial").toBe(0);
  });

  it("min y max se comparan como NUMERIC contra el total, sin redondear el limite (0.005, 999999999999.99)", async () => {
    expect(ids((await listar({ min: "0.005" })).filas), "0.00 queda fuera y 0.01 dentro").not.toContain("03 B002-1");
    expect(ids((await listar({ min: "0.005" })).filas)).toContain("01 F001-5");
    // si el limite se redondeara a 0.01 el 0.01 seguiria dentro: el discriminante esta en max
    expect(ids((await listar({ max: "0.005" })).filas).sort()).toEqual(["03 B002-1", "07 B001-3"].sort());
    expect(ids((await listar({ min: "0.01", max: "0.01" })).filas)).toEqual(["01 F001-5"]);
    expect(ids((await listar({ min: "999999999999.99" })).filas)).toEqual(["01 F001-6"]);
    expect((await listar({ max: "999999999999.99" })).total, "el maximo representable incluye todo").toBe(10);
    expect(ids((await listar({ min: "100", max: "200" })).filas)).toEqual(["03 B001-290"]);
    expect(ids((await listar({ min: "-200", max: "-100" })).filas), "la nota de credito es negativa").toEqual(["07 B001-3"]);
    expect((await listar({ min: "300", max: "100" })).total, "rango invertido: vacio").toBe(0);
  });

  it("q busca por serie-numero y por documento, sin distinguir mayusculas, y el total cuenta lo filtrado", async () => {
    expect(ids((await listar({ q: "B001-29" })).filas)).toEqual(["03 B001-290", "03 B001-292"]);
    expect(ids((await listar({ q: "b001-290" })).filas)).toEqual(["03 B001-290"]);
    expect(ids((await listar({ q: "40000011" })).filas)).toEqual(["03 B001-290"]);
    expect(ids((await listar({ q: "20100000001" })).filas)).toEqual(["01 F001-5"]);
    const r = await listar({ q: "B001", tamano: 10 });
    expect(r.total).toBe(3);
  });

  it("q con %, _ , \\ o comillas es literal y no altera la consulta", async () => {
    expect(ids((await listar({ q: "A%B" })).filas), "% literal: no coincide con AXB").toEqual(["03 B003-100"]);
    expect(ids((await listar({ q: "A_B" })).filas), "_ literal: no coincide con AXB").toEqual(["03 B003-102"]);
    expect(ids((await listar({ q: "A\\B" })).filas), "\\ literal").toEqual(["03 B003-103"]);
    expect((await listar({ q: "%" })).filas.map((f) => f.docContraparte)).toEqual(["A%B"]);
    expect((await listar({ q: "_" })).filas.map((f) => f.docContraparte)).toEqual(["A_B"]);
    for (const q of ["'", "' OR '1'='1", "'; drop table venta; --", '"', "%' OR 1=1 --"]) {
      expect((await listar({ q })).total, q).toBe(0);
    }
    expect((await listar({})).total, "la tabla sigue entera tras las inyecciones").toBe(10);
  });

  it("los filtros se combinan con la paginacion: el total es el de lo filtrado", async () => {
    const r = await listar({ tipo: "03", tamano: 10, pagina: 1 });
    expect(r.total).toBe(7);
    const p2 = await listar({ tipo: "03", tamano: 10, pagina: 2 });
    expect(p2.filas).toEqual([]);
    expect(p2.total).toBe(7);
  });
});

// =================================================================================================
describe("leerFilasVentas", () => {
  it("devuelve todas las del periodo (sire y manual) en el orden de la grilla, solo del cliente y estudio", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "292"), venta("03", "B001", "290")]);
    await ev.venta(X, c, { numero: "291", origen: "manual" });
    await ev.venta(X, c, { numero: "5", periodo: "202609" });
    const r = await backend().withTenant({ tenantId: X }, (tx) => leerFilasVentas(tx, c.id, PERIODO));
    expect(ids(r)).toEqual(["03 B001-290", "03 B001-291", "03 B001-292"]);
    expect(r.map((f) => f.origen)).toEqual(["sire", "manual", "sire"]);
    expect(await backend().withTenant({ tenantId: Y }, (tx) => leerFilasVentas(tx, c.id, PERIODO))).toEqual([]);
  });
});

// =================================================================================================
describe("crearVentaManual y quitarVentaManual (D9, CA-8)", () => {
  const nueva = (c: ClientePrueba, o: Partial<VentaNueva> = {}) => ({
    ...venta("03", "B001", "291", o),
    clienteId: c.id,
    periodo: PERIODO,
    creadaPor: ux,
  });

  it("crea la fila manual: sin propuesta, con el usuario y la clave dada; aparece en la lectura", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "290"), venta("03", "B001", "292")]);
    const f = await backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, nueva(c)));
    expect(f).toMatchObject({
      origen: "manual",
      propuestaId: null,
      creadaPor: ux,
      clienteId: c.id,
      periodo: PERIODO,
      clave: "03|B001|291",
      numeroN: 291,
      total: "118.00",
    });
    const todas = await backend().withTenant({ tenantId: X }, (tx) => leerFilasVentas(tx, c.id, PERIODO));
    expect(ids(todas)).toEqual(["03 B001-290", "03 B001-291", "03 B001-292"]);
    // la propuesta original queda intacta
    expect(todas.filter((x) => x.origen === "sire")).toHaveLength(2);
  });

  it("una clave repetida lanza 23505, contra otra manual y contra una fila del SIRE, y no deja nada", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "290")]);
    await expect(backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, nueva(c, { clave: "03|B001|290", numero: "290" })))).rejects.toMatchObject({
      codigo: "23505",
    });
    await backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, nueva(c)));
    await expect(backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, nueva(c)))).rejects.toMatchObject({ codigo: "23505" });
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(2);
  });

  it("un cliente de otro estudio lanza 23503", async () => {
    const cy = await ev.cliente(Y);
    await expect(
      backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, { ...venta("03", "B001", "1"), clienteId: cy.id, periodo: PERIODO, creadaPor: ux })),
    ).rejects.toMatchObject({ codigo: "23503" });
  });

  it("quitarVentaManual: borra la manual (true); la del SIRE, una inexistente o una de otro estudio devuelven false y no cambian nada", async () => {
    const c = await clienteNuevo();
    await sembrar(c, [venta("03", "B001", "290")]);
    const sire = (await admin.query("select id from venta where cliente_id = $1", [c.id])).rows[0].id as string;
    const manual = (await backend().withTenant({ tenantId: X }, (tx) => crearVentaManual(tx, nueva(c)))).id;
    expect(await backend().withTenant({ tenantId: X }, (tx) => quitarVentaManual(tx, sire)), "fila sire").toBe(false);
    expect(await backend().withTenant({ tenantId: X }, (tx) => quitarVentaManual(tx, "00000000-0000-4000-8000-000000000001"))).toBe(false);
    expect(await backend().withTenant({ tenantId: Y }, (tx) => quitarVentaManual(tx, manual)), "otro estudio").toBe(false);
    expect(await contar(admin, "venta", "cliente_id = $1", [c.id])).toBe(2);
    expect(await backend().withTenant({ tenantId: X }, (tx) => quitarVentaManual(tx, manual))).toBe(true);
    expect(await contar(admin, "venta", "id = $1", [manual])).toBe(0);
    expect(await contar(admin, "venta", "id = $1", [sire])).toBe(1);
    expect(await backend().withTenant({ tenantId: X }, (tx) => quitarVentaManual(tx, manual)), "ya quitada").toBe(false);
  });
});

// =================================================================================================
describe("justificar, revertirJustificacion y listarJustificados (D8, CA-7)", () => {
  const datos = (c: ClientePrueba, o: Partial<DatosJustificar> = {}): DatosJustificar => ({
    clienteId: c.id,
    periodo: PERIODO,
    tipo: "03",
    serie: "B001",
    desde: 291,
    hasta: 291,
    comentario: "Boleta anulada en caja",
    usuarioId: ux,
    ...o,
  });

  it("justifica el salto de la 291: devuelve la fila con numeros (no cadenas), autor y fecha, y queda vigente", async () => {
    const c = await clienteNuevo();
    const j = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c)));
    expect(j).toMatchObject({ tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada en caja", usuarioId: ux, revertidoPor: null, revertidoEn: null });
    expect(typeof j.desde).toBe("number");
    expect(j.creadaEn).toBeInstanceOf(Date);
    const lista = await backend().withTenant({ tenantId: X }, (tx) => listarJustificados(tx, c.id, PERIODO));
    expect(lista.map((x) => x.id)).toEqual([j.id]);
  });

  it("dos justificaciones iguales dejan una sola vigente: la segunda devuelve la misma fila sin error", async () => {
    const c = await clienteNuevo();
    const a = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c)));
    const b = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { comentario: "otro comentario" })));
    expect(b.id).toBe(a.id);
    expect(b.comentario, "se conserva la primera").toBe("Boleta anulada en caja");
    expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1", [c.id])).toBe(1);
  });

  it("30 rondas: dos justificaciones simultaneas iguales no fallan, devuelven la misma fila y dejan una vigente", async () => {
    const c = await clienteNuevo();
    const dos = [backend(), backend()];
    for (let ronda = 0; ronda < 30; ronda++) {
      const n = 100 + ronda;
      const r = await Promise.allSettled(dos.map((d) => d.withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { desde: n, hasta: n })))));
      expect(r.map((x) => x.status), `ronda ${ronda}: ${JSON.stringify(r)}`).toEqual(["fulfilled", "fulfilled"]);
      const [a, b] = r.map((x) => (x as PromiseFulfilledResult<Justificado>).value.id);
      expect(a, `ronda ${ronda}`).toBe(b);
      expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1 and desde = $2 and revertido_en is null", [c.id, n])).toBe(1);
    }
  });

  it("revertir deja el registro (quien y cuando), la saca de los vigentes y permite justificar de nuevo", async () => {
    const c = await clienteNuevo();
    const a = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c)));
    expect(await backend().withTenant({ tenantId: X }, (tx) => revertirJustificacion(tx, a.id, ux))).toBe(true);
    expect(await backend().withTenant({ tenantId: X }, (tx) => listarJustificados(tx, c.id, PERIODO))).toEqual([]);
    const todas = await backend().withTenant({ tenantId: X }, (tx) => listarJustificados(tx, c.id, PERIODO, { incluirRevertidas: true }));
    expect(todas).toHaveLength(1);
    expect(todas[0]).toMatchObject({ id: a.id, comentario: "Boleta anulada en caja", revertidoPor: ux });
    expect(todas[0].revertidoEn).toBeInstanceOf(Date);
    const b = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { comentario: "De nuevo" })));
    expect(b.id).not.toBe(a.id);
    expect(b.comentario).toBe("De nuevo");
    const vigentes = await backend().withTenant({ tenantId: X }, (tx) => listarJustificados(tx, c.id, PERIODO));
    expect(vigentes.map((x) => x.id)).toEqual([b.id]);
    expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1", [c.id])).toBe(2);
  });

  it("revertir solo escribe revertido_*: el resto de la fila queda igual", async () => {
    const c = await clienteNuevo();
    const a = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c)));
    const antes = (await admin.query("select * from venta_salto_justificado where id = $1", [a.id])).rows[0];
    await backend().withTenant({ tenantId: X }, (tx) => revertirJustificacion(tx, a.id, ux));
    const despues = (await admin.query("select * from venta_salto_justificado where id = $1", [a.id])).rows[0];
    const { revertido_por: _a, revertido_en: _b, ...r1 } = antes;
    const { revertido_por: _c, revertido_en: _d, ...r2 } = despues;
    expect(r2).toEqual(r1);
  });

  it("revertir dos veces, una inexistente o la de otro estudio devuelve false y no cambia nada", async () => {
    const c = await clienteNuevo();
    const a = await backend().withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c)));
    expect(await backend().withTenant({ tenantId: Y }, (tx) => revertirJustificacion(tx, a.id, uy)), "otro estudio").toBe(false);
    expect(await backend().withTenant({ tenantId: X }, (tx) => revertirJustificacion(tx, "00000000-0000-4000-8000-000000000001", ux))).toBe(false);
    expect(await contar(admin, "venta_salto_justificado", "id = $1 and revertido_en is null", [a.id])).toBe(1);
    expect(await backend().withTenant({ tenantId: X }, (tx) => revertirJustificacion(tx, a.id, ux))).toBe(true);
    expect(await backend().withTenant({ tenantId: X }, (tx) => revertirJustificacion(tx, a.id, ux)), "ya revertida").toBe(false);
  });

  it("listarJustificados: solo el cliente y periodo pedidos, ordenadas por tipo, serie y desde; aislado por estudio", async () => {
    const c = await clienteNuevo();
    const otro = await clienteNuevo();
    const b = backend();
    await b.withTenant({ tenantId: X }, async (tx) => {
      await justificar(tx, datos(c, { serie: "B002", desde: 5, hasta: 5 }));
      await justificar(tx, datos(c, { desde: 400, hasta: 405 }));
      await justificar(tx, datos(c, { desde: 291, hasta: 291 }));
      await justificar(tx, datos(c, { tipo: "01", serie: "F001", desde: 9, hasta: 9 }));
      await justificar(tx, datos(c, { periodo: "202609" }));
      await justificar(tx, datos(otro));
    });
    const r = await b.withTenant({ tenantId: X }, (tx) => listarJustificados(tx, c.id, PERIODO));
    expect(r.map((x) => `${x.tipo} ${x.serie} ${x.desde}-${x.hasta}`)).toEqual(["01 F001 9-9", "03 B001 291-291", "03 B001 400-405", "03 B002 5-5"]);
    expect(await b.withTenant({ tenantId: Y }, (tx) => listarJustificados(tx, c.id, PERIODO))).toEqual([]);
  });

  it("un comentario vacio o de mas de 500, un rango invertido o un cliente ajeno lanzan SQLSTATE (23514 / 23503)", async () => {
    const c = await clienteNuevo();
    const cy = await ev.cliente(Y);
    const b = backend();
    await expect(b.withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { comentario: "" })))).rejects.toMatchObject({ codigo: "23514" });
    await expect(b.withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { comentario: "x".repeat(501) })))).rejects.toMatchObject({ codigo: "23514" });
    await expect(b.withTenant({ tenantId: X }, (tx) => justificar(tx, datos(c, { desde: 5, hasta: 4 })))).rejects.toMatchObject({ codigo: "23514" });
    await expect(b.withTenant({ tenantId: X }, (tx) => justificar(tx, datos(cy)))).rejects.toMatchObject({ codigo: "23503" });
    expect(await contar(admin, "venta_salto_justificado", "cliente_id = $1", [c.id])).toBe(0);
  });
});

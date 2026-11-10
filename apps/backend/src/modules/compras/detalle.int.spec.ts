/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 016 (T7, rojo): detalle de la lupa por HTTP (D-6, D-8, D-9, D-11; CA-9 comparación, CA-14, CA-16 distintivo, CA-17
// lectura y glosa como texto, CA-18).
// Contrato (plan 016, «Contratos: HTTP» y «DetalleCompraDto»; formas de `detalleLupaSchema` de `@contapp/shared`):
//  - `GET …/compras/:compraId/detalle` -> 200 `{cabecera, items[], comparacion[], hallazgos[], historialProveedor[], xml}`.
//    Solo lectura: no encola, no escribe y no re-parsea (lee el `detalle` jsonb guardado). Permiso `clientes.ver`;
//    compra de otro cliente, periodo o estudio, inexistente o mal formada: el mismo 404 `{codigo:"no_encontrado"}`.
//  - `comparacion` trae siempre las 7 columnas de D-9, en este orden: bi, igv, noGravado, isc, icbper, otrosTributos, total.
//    `bi` es Σ BI (DG + DGNG + DNG) de la fila contra el gravado del XML. Sin XML, `xml = null` y `difiere = false`.
//    Una diferencia cubierta por un hallazgo lleva su `regla` y su `explicacion` (la del hallazgo).
//  - `xml`: `disponible {origen, subidoPor?, subidoEn?, avisoMoneda?}` | `pendiente` | `no_disponible {codigo}` |
//    `sin_solicitar`. `pendiente` y `no_disponible` salen de `documento_xml_obtencion`; `no_aplica` (tipo fuera de
//    01/03/07/08 o proveedor sin RUC) se decide por la compra y no necesita fila de obtención.
//  - `historialProveedor`: compras del MISMO cliente y proveedor en los 6 periodos anteriores, a lo sumo 50.
//  - `cabecera.proveedorNuevo` y `origenSerie` ("E" si la serie empieza por E, "F" si por F, `null` en otro caso).
// Rojo: la ruta `detalle` aún no existe (T13): responde 404 de ruta inexistente. Las pruebas con XML lo suben por
// `POST …/xml` (T14), que tampoco existe.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  p95,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
} from "../../../test/soporte-compras.js";
import {
  archivosBajo,
  bytes,
  cambiar,
  detalleLupaSchema,
  documentosXml,
  pedirXml,
  prepararStorage,
  sembrarObtencion,
  trabajosDeTipo,
  xmlConItems,
  xmlDe,
  type EstadoObtencion,
  type StoragePrueba,
} from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente"); // sin ningún cliente asignado
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };

/** Cliente de E con las 5 compras del fixture de 009 (San Juan, mixta, bolsas, USD, zapatilla). */
async function escenario(o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id], ...o });
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  return { c, ids };
}
const detalle = (a: Actor, c: Cliente, id: string, periodo = PERIODO) =>
  v.llamar(a, "GET", `${base(c.id, periodo)}/${id}/detalle`);
const subir = (a: Actor, c: Cliente, id: string, xml: string | Uint8Array) =>
  pedirXml(v, a, "POST", `${base(c.id)}/${id}/xml`, typeof xml === "string" ? bytes(xml) : xml);
/** Sube el XML y exige 200 (la subida es el preparativo, no lo que se prueba aquí). */
async function conXml(c: Cliente, id: string, xml: string): Promise<void> {
  const r = await subir(contador, c, id, xml);
  expect(r.status, r.texto).toBe(200);
}
const columna = (d: any, nombre: string) => (d.comparacion as any[]).find((x) => x.columna === nombre);
const COLUMNAS = ["bi", "igv", "noGravado", "isc", "icbper", "otrosTributos", "total"];

// --- Sin XML --------------------------------------------------------------------------------------------------------

describe("D-8 · detalle de una compra sin XML", () => {
  it("200 con la forma de detalleLupaSchema, sin XML solicitado, sin ítems y con las 7 columnas sin diferencia", async () => {
    const { c, ids } = await escenario();
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(detalleLupaSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["cabecera", "comparacion", "hallazgos", "historialProveedor", "items", "xml"]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.xml).toEqual({ estado: "sin_solicitar" });
    expect(r.body.items).toEqual([]);
    expect((r.body.comparacion as any[]).map((x) => x.columna)).toEqual(COLUMNAS);
    for (const fila of r.body.comparacion as any[]) {
      expect(fila.xml, fila.columna).toBeNull();
      expect(fila.difiere, fila.columna).toBe(false);
    }
    expect(columna(r.body, "bi")).toMatchObject({ sire: "21.48" });
    expect(columna(r.body, "igv")).toMatchObject({ sire: "1.61" });
    expect(columna(r.body, "total")).toMatchObject({ sire: "23.09" });
  });

  it("los hallazgos son los vigentes de 014: la mixta trae R-MIX que pide el gravado", async () => {
    const { c, ids } = await escenario();
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect((r.body.hallazgos as any[]).map((h) => h.regla)).toEqual(["R-MIX"]);
    expect(r.body.hallazgos[0]).toMatchObject({ dato: "gravado", requiereConfirmacion: true, masiva: false });
    expect(r.body.hallazgos[0].explicacion.length).toBeGreaterThan(0);
  });

  it("GET es solo lectura: no encola ningún trabajo ni escribe documento_xml ni storage", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    for (const id of Object.values(ids)) expect((await detalle(contador, c, id)).status).toBe(200);
    expect(await trabajosDeTipo(v, c.id, "xml.obtener")).toEqual([]);
    expect(await documentosXml(v, c.id)).toEqual([]);
    expect(archivosBajo(st.dir, `xml/${E.tenantId}/${c.id}/`)).toEqual([]);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("la cabecera: RUC, razón social, tipo, serie-número, fecha, moneda y tipo de cambio de la fila", async () => {
    const { c, ids } = await escenario();
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.body.cabecera).toMatchObject({
      ruc: "20700000045",
      razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C.",
      proveedorNuevo: true,
      tipo: "01",
      serie: "F001",
      numero: "2056",
      fecha: "2026-10-05",
      moneda: "PEN",
      tipoCambio: null,
      origenSerie: "F",
    });
    const usd = await detalle(contador, c, ids["F001-4062"]!);
    expect(usd.body.cabecera).toMatchObject({ moneda: "USD", tipoCambio: "3.300" });
  });

  it.each([
    ["E001", "E"],
    ["F001", "F"],
    ["B001", null],
  ])("origenSerie de la serie %s es %s", async (serie, esperado) => {
    const c = await v.cliente(E, { responsable: contador.id });
    const id = await v.sembrarCompra(E.tenantId, c.id, { serie, numero: "10", doc: "20700000011", usuarioId: E.titular.id });
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.cabecera.origenSerie).toBe(esperado);
  });
});

// --- Proveedor nuevo e historial ------------------------------------------------------------------------------------

describe("RF-094 · proveedor nuevo e historial del proveedor", () => {
  it("con compras del mismo proveedor en otro periodo del cliente: no es nuevo y el historial las trae, sin las de otro cliente", async () => {
    const { c, ids } = await escenario();
    await v.sembrarCompra(E.tenantId, c.id, {
      periodo: "202609",
      origen: "agregada",
      serie: "F000",
      numero: "1",
      doc: "20700000045",
      usuarioId: E.titular.id,
      montos: { biDg: "50.00", igvDg: "9.00" },
    });
    const otro = await v.cliente(E, { responsable: contador.id });
    await v.sembrarCompra(E.tenantId, otro.id, {
      periodo: "202609",
      origen: "agregada",
      serie: "F999",
      numero: "9",
      doc: "20700000045",
      usuarioId: E.titular.id,
    });
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.cabecera.proveedorNuevo).toBe(false);
    expect(r.body.historialProveedor).toEqual([
      { periodo: "202609", serie: "F000", numero: "1", biDg: "50.00", biDgng: "0.00", biDng: "0.00", excluida: false },
    ]);
    expect(r.text).not.toContain("F999");
  });

  it("el historial es de los últimos 6 periodos: uno más viejo no cuenta", async () => {
    const { c, ids } = await escenario();
    await v.sembrarCompra(E.tenantId, c.id, {
      periodo: "202501",
      origen: "agregada",
      serie: "F000",
      numero: "2",
      doc: "20700000045",
      usuarioId: E.titular.id,
    });
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.historialProveedor).toEqual([]);
  });

  it("el historial trae a lo sumo 50 compras", async () => {
    const { c, ids } = await escenario();
    for (let i = 1; i <= 52; i++) {
      await v.sembrarCompra(E.tenantId, c.id, {
        periodo: "202609",
        origen: "agregada",
        serie: "F000",
        numero: String(i),
        doc: "20700000045",
        usuarioId: E.titular.id,
      });
    }
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.historialProveedor).toHaveLength(50);
  });
});

// --- Estados del XML ------------------------------------------------------------------------------------------------

describe("D-8 · xml en sus cuatro estados (CA-11, CA-16)", () => {
  it("sin_solicitar mientras nadie lo pidió", async () => {
    const { c, ids } = await escenario();
    expect((await detalle(contador, c, ids["F001-2056"]!)).body.xml).toEqual({ estado: "sin_solicitar" });
  });

  it("pendiente cuando hay un trabajo en curso para el comprobante", async () => {
    const { c, ids } = await escenario();
    await sembrarObtencion(v, {
      tenantId: E.tenantId,
      clienteId: c.id,
      rucEmisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      estado: "pendiente",
    });
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toEqual({ estado: "pendiente" });
    // El de otra compra del mismo cliente sigue sin solicitar.
    expect((await detalle(contador, c, ids["F001-1040"]!)).body.xml).toEqual({ estado: "sin_solicitar" });
  });

  it.each(["no_encontrado", "credencial", "transitorio"] satisfies EstadoObtencion[])(
    "no_disponible con el código %s, sin filtrar la causa interna",
    async (estado) => {
      const { c, ids } = await escenario();
      await sembrarObtencion(v, {
        tenantId: E.tenantId,
        clienteId: c.id,
        rucEmisor: "20700000045",
        tipo: "01",
        serie: "F001",
        numero: "2056",
        estado,
        intentos: 3,
      });
      const r = await detalle(contador, c, ids["F001-2056"]!);
      expect(r.status, r.text).toBe(200);
      expect(r.body.xml).toEqual({ estado: "no_disponible", codigo: estado });
      expect(detalleLupaSchema.safeParse(r.body).success).toBe(true);
    },
  );

  it.each([
    ["tipo 14 (fuera de 01/03/07/08)", { tipoDoc: "14", docTipo: "6" }],
    ["proveedor sin RUC (DNI)", { tipoDoc: "01", docTipo: "1", doc: "12345678" }],
  ])("no_disponible no_aplica: %s", async (_n, o) => {
    const c = await v.cliente(E, { responsable: contador.id });
    const id = await v.sembrarCompra(E.tenantId, c.id, { serie: "F010", numero: "1", usuarioId: E.titular.id, ...o });
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toEqual({ estado: "no_disponible", codigo: "no_aplica" });
  });

  it("disponible tras subir: origen subido con quién y cuándo (CA-16)", async () => {
    const { c, ids } = await escenario();
    const antes = Date.now();
    await conXml(c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({ estado: "disponible", origen: "subido", subidoPor: contador.id });
    const cuando = Date.parse(r.body.xml.subidoEn);
    expect(cuando).toBeGreaterThanOrEqual(antes - 5_000);
    expect(cuando).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(r.body.xml).not.toHaveProperty("avisoMoneda");
  });
});

// --- Con XML: cabecera, ítems y comparación (CA-14) -----------------------------------------------------------------

describe("CA-14 · la lupa de F001-2056 con XML (caso mixta 21.48 / 1.61 → 8.97 + 12.51)", () => {
  it("los ítems salen con descripción, cantidad, unidad, precio exacto, valor, afectación e IGV", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(detalleLupaSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(r.body.items).toEqual([
      {
        descripcion: "Producto gravado de prueba (PRUEBA)",
        cantidad: "1",
        unidad: "NIU",
        precioUnitario: "8.97",
        valor: "8.97",
        afectacion: "10",
        igv: "1.61",
        isc: "0.00",
        icbper: "0.00",
      },
      {
        descripcion: "Producto exonerado de prueba (PRUEBA)",
        cantidad: "1",
        unidad: "NIU",
        precioUnitario: "12.51",
        valor: "12.51",
        afectacion: "20",
        igv: "0.00",
        isc: "0.00",
        icbper: "0.00",
      },
    ]);
  });

  it("la comparación resalta Σ BI y no gravado, y no el IGV ni el total; la BI lleva la regla R-MIX y su explicación", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect((r.body.comparacion as any[]).map((x) => x.columna)).toEqual(COLUMNAS);
    expect(columna(r.body, "bi")).toMatchObject({ sire: "21.48", xml: "8.97", difiere: true, regla: "R-MIX" });
    expect(columna(r.body, "noGravado")).toMatchObject({ sire: "0.00", xml: "12.51", difiere: true });
    expect(columna(r.body, "igv")).toMatchObject({ sire: "1.61", xml: "1.61", difiere: false });
    expect(columna(r.body, "total")).toMatchObject({ sire: "23.09", xml: "23.09", difiere: false });
    expect(columna(r.body, "isc")).toMatchObject({ sire: "0.00", xml: "0.00", difiere: false });
    const mix = (r.body.hallazgos as any[]).find((h) => h.regla === "R-MIX")!;
    expect(mix).toBeDefined();
    expect(columna(r.body, "bi").explicacion).toBe(mix.explicacion);
    expect(mix.explicacion.length).toBeGreaterThan(0);
  });

  it("el hallazgo vigente es el de la evaluación con XML: R-MIX exacto 8.97, sin pedir confirmación y apto para la masiva (CA-6)", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    const r = await detalle(contador, c, ids["F001-2056"]!);
    const mix = (r.body.hallazgos as any[]).filter((h) => h.regla === "R-MIX");
    expect(mix).toHaveLength(1);
    expect(mix[0]).toMatchObject({
      destino: "DG",
      dato: null,
      requiereConfirmacion: false,
      masiva: true,
      sugerencia: { tipo: "separar", columnaBi: "biDg", exacto: "8.97" },
    });
    expect(r.body.cabecera).toMatchObject({ razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." });
  });

  it("caso San Juan (F001-1040): el XML trae ISC 770.00 y valor 0.00; la BI y el ISC difieren por R-ISC", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-1040"]!, xmlDe("1040", c.ruc));
    const r = await detalle(contador, c, ids["F001-1040"]!);
    expect(r.status, r.text).toBe(200);
    expect(columna(r.body, "bi")).toMatchObject({ sire: "770.00", xml: "0.00", difiere: true, regla: "R-ISC" });
    expect(columna(r.body, "isc")).toMatchObject({ sire: "0.00", xml: "770.00", difiere: true, regla: "R-ISC" });
    expect(columna(r.body, "total")).toMatchObject({ sire: "770.00", xml: "770.00", difiere: false });
    expect(r.body.hallazgos[0]).toMatchObject({
      regla: "R-ISC",
      requiereConfirmacion: false,
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
    });
  });

  it("zapatilla (F001-5070): la glosa del ítem viene del XML", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-5070"]!, xmlDe("5070", c.ruc));
    const r = await detalle(contador, c, ids["F001-5070"]!);
    expect(r.status, r.text).toBe(200);
    const glosas = (r.body.items as any[]).map((i) => i.descripcion as string);
    expect(glosas.some((g) => g.includes("Par de zapatillas deportivas de prueba"))).toBe(true);
  });

  it("ICBPER (F001-3064): la columna ICBPER del XML es 1.50 y coincide con la fila", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-3064"]!, xmlDe("3064", c.ruc));
    const r = await detalle(contador, c, ids["F001-3064"]!);
    expect(columna(r.body, "icbper")).toMatchObject({ sire: "1.50", xml: "1.50", difiere: false });
    expect(columna(r.body, "igv")).toMatchObject({ sire: "18.00", xml: "18.00", difiere: false });
  });
});

describe("CA-9 · monedas (D-6)", () => {
  it("compra USD con XML USD (F001-4062): se compara sin convertir y no hay aviso de moneda", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-4062"]!, xmlDe("4062", c.ruc));
    const r = await detalle(contador, c, ids["F001-4062"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.cabecera).toMatchObject({ moneda: "USD", tipoCambio: "3.300" });
    expect(columna(r.body, "bi")).toMatchObject({ sire: "0.15", xml: "0.15", difiere: false });
    expect(columna(r.body, "igv")).toMatchObject({ sire: "0.03", xml: "0.03", difiere: false });
    expect(columna(r.body, "total")).toMatchObject({ sire: "0.18", xml: "0.18", difiere: false });
    expect(r.body.xml).toMatchObject({ estado: "disponible", origen: "subido" });
    expect(r.body.xml).not.toHaveProperty("avisoMoneda");
  });

  it("compra PEN con un XML en USD: aviso de moneda, las dos columnas sin convertir y ninguna sugerencia respaldada por el XML", async () => {
    const { c, ids } = await escenario();
    const enUsd = cambiar(cambiar(xmlDe("2056", c.ruc), 'currencyID="PEN"', 'currencyID="USD"'), ">PEN</cbc:DocumentCurrencyCode>", ">USD</cbc:DocumentCurrencyCode>");
    await conXml(c, ids["F001-2056"]!, enUsd);
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({
      estado: "disponible",
      origen: "subido",
      avisoMoneda: { monedaXml: "USD", monedaFila: "PEN" },
    });
    expect(columna(r.body, "bi")).toMatchObject({ sire: "21.48", xml: "8.97" });
    expect(columna(r.body, "total")).toMatchObject({ sire: "23.09", xml: "23.09" });
    for (const h of r.body.hallazgos as any[]) {
      expect(h.requiereConfirmacion, h.regla).toBe(true);
      expect(h.masiva, h.regla).toBe(false);
    }
  });
});

// --- Texto no confiable ---------------------------------------------------------------------------------------------

describe("CA-17 · glosa y razón social son texto", () => {
  it("un <script> en la glosa se devuelve como texto de un JSON, sin interpretarse ni alterar las cabeceras", async () => {
    const { c, ids } = await escenario();
    const hostil = cambiar(
      xmlDe("2056", c.ruc),
      "Producto gravado de prueba (PRUEBA)",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    await conXml(c, ids["F001-2056"]!, hostil);
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const glosa = r.body.items[0].descripcion as string;
    expect(typeof glosa).toBe("string");
    expect(glosa).toContain("script");
    expect(glosa).toContain("alert(1)");
  });

  it("la glosa se recorta a 500 caracteres", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "G".repeat(900)));
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.items[0].descripcion).toHaveLength(500);
  });
});

// --- Rendimiento y "sin re-parsear" ---------------------------------------------------------------------------------

describe("CA-18 · RNF-032: el detalle sale del jsonb guardado, no del XML crudo", () => {
  it("con el archivo borrado del storage el detalle sigue respondiendo (solo la descarga lo necesita)", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    const docs = await documentosXml(v, c.id);
    expect(docs).toHaveLength(1);
    rmSync(join(st.dir, docs[0]!.ruta), { force: true });
    const r = await detalle(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.xml).toMatchObject({ estado: "disponible" });
  });

  it("factura de 500 ítems: p95 < 500 ms en 30 lecturas", async () => {
    const { c, ids } = await escenario();
    await conXml(c, ids["F001-2056"]!, xmlConItems(500, c.ruc));
    const primera = await detalle(contador, c, ids["F001-2056"]!);
    expect(primera.status, primera.text.slice(0, 200)).toBe(200);
    expect(primera.body.items).toHaveLength(500);
    expect(detalleLupaSchema.safeParse(primera.body).success).toBe(true);
    const ms: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await detalle(contador, c, ids["F001-2056"]!);
      expect(r.status).toBe(200);
      ms.push(r.ms);
    }
    expect(p95(ms), `p95 ${p95(ms)} ms`).toBeLessThan(500);
  });
});

// --- Permisos y aislamiento de la lectura ----------------------------------------------------------------------------

describe("D-8 · permisos de la lectura", () => {
  it("quien solo lee (clientes.ver) puede abrir la lupa", async () => {
    const { c, ids } = await escenario();
    const r = await detalle(lectura, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(200);
  });

  it("sin sesión: 401", async () => {
    const { c, ids } = await escenario();
    const r = await v.sinSesion("GET", `${base(c.id)}/${ids["F001-2056"]}/detalle`);
    expect(r.status).toBe(401);
  });

  it("un miembro sin el cliente asignado, el cliente de otro estudio y una compra de otro cliente: el mismo 404 de una inexistente", async () => {
    const { c, ids } = await escenario();
    const otro = await v.cliente(E, { responsable: contador.id });
    const idOtro = await v.sembrarCompra(E.tenantId, otro.id, { serie: "F777", numero: "1", usuarioId: E.titular.id });
    const inexistente = await detalle(contador, c, "00000000-0000-4000-8000-000000000000");
    expect(inexistente.status).toBe(404);
    const casos = [
      await detalle(asistenteAjeno, c, ids["F001-2056"]!),
      await detalle(contador, c, idOtro),
      await detalle(contador, c, ids["F001-2056"]!, "202609"),
      await detalle(contador, c, "no-es-uuid"),
    ];
    for (const r of casos) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual(inexistente.body);
    }
    const contadorF = await v.b.c.p.b.miembro(F.tenantId, "contador");
    const deF = await detalle(contadorF, c, ids["F001-2056"]!);
    expect(deF.status, deF.text).toBe(404);
    expect(deF.body).toEqual(inexistente.body);
  });
});

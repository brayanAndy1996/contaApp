/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 016 (T7, rojo): «agregar desde XML» por HTTP (HU-18, RF-067, D-3, D-8, P-9; CA-2, CA-13).
// Contrato (plan 016, «Contratos: HTTP» y «Decisión P-9»; formas de `vistaPreviaDesdeXmlSchema` y `destinoDesdeXmlSchema`):
//  - `POST …/compras/desde-xml/vista-previa` (cuerpo crudo: el XML; permiso `sire.clasificar`) -> 200 `VistaPreviaDesdeXml`
//    `{tipo, serie, numero, proveedor:{tipo,numero,razonSocial}, fecha, moneda, montos, items[], existente:{id}|null,
//    requiereTipoCambio}`. No escribe nada ni toca el storage. `montos` son los campos de `agregarCompraSchema` con la BI y el
//    IGV en la columna DG (el destino aún no se eligió), el no gravado, el ISC y el ICBPER del XML; sin total.
//    `requiereTipoCambio` es true si la moneda del XML es USD (P-9).
//  - `POST …/compras/desde-xml?destino=DG|DGNG|DNG[&tipoCambio=3.752]` (cuerpo: el XML) -> 201 `FilaCompraVista` de una compra
//    `agregada` en versión 1, y guarda el XML (`documento_xml` con `origen = subido`, y su archivo en storage) en la misma
//    operación. El destino decide en qué par de columnas van la BI y el IGV (DG, DGNG o DNG). El tipo de cambio es obligatorio
//    en USD y está prohibido en PEN; su falta o sobra, un destino ausente o inválido y una gramática mala son 400
//    `solicitud_invalida` y no guardan nada (ni en storage ni en BD). El tipo de cambio no se toma del XML (P-9).
//    Comprobante que ya existe (014 D-7): 409 `{codigo:"duplicado", id}`. Los mismos 403 y 409 de estado que agregar a mano
//    (014 D-9): lectura 403 `permiso_denegado`; `revisado` sin aprobar 403 `periodo_revisado`; `generado` 409
//    `periodo_generado`; archivado 409 `cliente_archivado`.
//  - Un XML cuyo receptor no es el RUC del cliente es 422 `xml_ajeno {campos:["receptor"]}` (D-3); inválido o incompleto, 422;
//    más de 1 MiB, 413. Las rutas estáticas `desde-xml*` van antes de `:compraId`.
// Rojo: las rutas aún no existen (T14): responden 404 de ruta inexistente.
import { filaCompraVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
} from "../../../test/soporte-compras.js";
import {
  archivosDe,
  bytes,
  cambiar,
  conTamano,
  documentosXml,
  pedirXml,
  prepararStorage,
  sha256Hex,
  vistaPreviaDesdeXmlSchema,
  xmlDe,
  type NombreXml,
  type StoragePrueba,
} from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const MIB = 1024 * 1024;

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };

/** Cliente de E SIN compras (los XML de las pruebas son comprobantes nuevos para él). */
const nuevo = (o: Parameters<BancoCompras["cliente"]>[1] = {}) =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
/** Cliente con las 5 compras del fixture de 009 (todas ya existen). */
async function conFixture(): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await nuevo();
  return { c, ids: await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id }) };
}
const previa = (a: Actor, c: Cliente, cuerpo: string | Uint8Array, tipo?: string) =>
  pedirXml(v, a, "POST", `${base(c.id)}/desde-xml/vista-previa`, typeof cuerpo === "string" ? bytes(cuerpo) : cuerpo, tipo);
const alta = (a: Actor, c: Cliente, query: string, cuerpo: string | Uint8Array) =>
  pedirXml(v, a, "POST", `${base(c.id)}/desde-xml${query}`, typeof cuerpo === "string" ? bytes(cuerpo) : cuerpo);
/** Nada guardado para el cliente: ni compras, ni documento_xml, ni archivo en storage. */
async function nadaGuardado(c: Cliente): Promise<void> {
  expect(await documentosXml(v, c.id)).toEqual([]);
  expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual([]);
}

// --- Vista previa ---------------------------------------------------------------------------------------------------

describe("CA-13 · vista previa: parsea y devuelve los campos, no guarda nada", () => {
  it("F001-2056 (PEN): identidad, proveedor, fecha, moneda, montos e ítems prellenados, sin existente y sin pedir tipo de cambio", async () => {
    const c = await nuevo();
    const antes = await v.foto(c.id);
    const r = await previa(contador, c, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(200);
    expect(vistaPreviaDesdeXmlSchema.safeParse(r.json).success, r.texto).toBe(true);
    expect(r.json).toMatchObject({
      tipo: "01",
      serie: "F001",
      numero: "2056",
      proveedor: { tipo: "6", numero: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
      fecha: "2026-10-05",
      moneda: "PEN",
      existente: null,
      requiereTipoCambio: false,
    });
    expect(r.json.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51" });
    expect(r.json.montos).not.toHaveProperty("total");
    expect(r.json).not.toHaveProperty("tipoCambio");
    expect(r.json).not.toHaveProperty("destino");
    expect((r.json.items as any[]).map((i) => i.afectacion)).toEqual(["10", "20"]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    // No escribe nada: ni compras, ni XML, ni archivos, ni trabajos.
    await nadaGuardado(c);
    expect(await v.foto(c.id)).toEqual(antes);
    expect(await v.trabajos(c.id)).toEqual([]);
  });

  it("San Juan (F001-1040): valor 0.00 e ISC 770.00 sin error", async () => {
    const c = await nuevo();
    const r = await previa(contador, c, xmlDe("1040", c.ruc));
    expect(r.status, r.texto).toBe(200);
    expect(r.json.montos).toMatchObject({ isc: "770.00" });
    expect(r.json.requiereTipoCambio).toBe(false);
  });

  it("USD (F001-4062): moneda USD, 0.15 + 0.03 y requiereTipoCambio = true (P-9)", async () => {
    const c = await nuevo();
    const r = await previa(contador, c, xmlDe("4062", c.ruc));
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ moneda: "USD", requiereTipoCambio: true, serie: "F001", numero: "4062" });
    expect(r.json.montos).toMatchObject({ biDg: "0.15", igvDg: "0.03" });
    expect(r.json).not.toHaveProperty("tipoCambio");
  });

  it("si el comprobante ya está en el periodo, dice cuál: existente { id }", async () => {
    const { c, ids } = await conFixture();
    const r = await previa(contador, c, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(200);
    expect(r.json.existente).toEqual({ id: ids["F001-2056"] });
  });

  it("una glosa con <script> viaja como texto de un JSON", async () => {
    const c = await nuevo();
    const hostil = cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "&lt;script&gt;alert(1)&lt;/script&gt;");
    const r = await previa(contador, c, hostil);
    expect(r.status, r.texto).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.json.items[0].descripcion).toContain("script");
  });

  it("un XML de otro receptor es 422 xml_ajeno { campos: [receptor] } y no revela datos del XML", async () => {
    const c = await nuevo();
    const r = await previa(contador, c, xmlDe("2056", "20700000099"));
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_ajeno", campos: ["receptor"] });
    for (const dato of ["MIXTO", "8.97"]) expect(r.texto).not.toContain(dato);
  });

  it.each([
    ["no es XML", "esto no es un xml", "xml_invalido"],
    ["tiene DOCTYPE", '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>', "xml_invalido"],
  ])("%s: 422 %s y nada guardado", async (_n, cuerpo, codigo) => {
    const c = await nuevo();
    const r = await previa(contador, c, cuerpo);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo });
    await nadaGuardado(c);
  });

  it("sin total: 422 xml_incompleto", async () => {
    const c = await nuevo();
    const sinTotal = xmlDe("2056", c.ruc).replace(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, "");
    const r = await previa(contador, c, sinTotal);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_incompleto" });
  });

  it("1 MiB + 1 byte: 413 antes de parsear", async () => {
    const c = await nuevo();
    const r = await previa(contador, c, conTamano(xmlDe("2056", c.ruc), MIB + 1));
    expect(r.status).toBe(413);
    await nadaGuardado(c);
  });

  it("quien solo lee: 403 permiso_denegado; sin sesión: 401; con el periodo revisado la vista previa sigue disponible (no escribe)", async () => {
    const c = await nuevo();
    const sin = await previa(lectura, c, xmlDe("2056", c.ruc));
    expect(sin.status, sin.texto).toBe(403);
    expect(sin.json).toEqual({ codigo: "permiso_denegado" });
    expect((await v.sinSesion("POST", `${base(c.id)}/desde-xml/vista-previa`, {})).status).toBe(401);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    expect((await previa(asistente, c, xmlDe("2056", c.ruc))).status).toBe(200);
  });
});

// --- Alta -----------------------------------------------------------------------------------------------------------

describe("CA-13 · alta desde XML con destino (PEN)", () => {
  it("F001-2056 con destino DG: 201, compra agregada en versión 1 con los montos del XML, y el XML guardado en la misma operación", async () => {
    const c = await nuevo();
    const cuerpo = bytes(xmlDe("2056", c.ruc));
    const r = await alta(contador, c, "?destino=DG", cuerpo);
    expect(r.status, r.texto).toBe(201);
    expect(filaCompraVistaSchema.safeParse(r.json).success, r.texto).toBe(true);
    expect(r.json).toMatchObject({
      origen: "agregada",
      version: 1,
      tipo: "01",
      serie: "F001",
      numero: "2056",
      fecha: "2026-10-05",
      moneda: "PEN",
      tipoCambio: null,
      excluida: false,
      proveedor: { tipo: "6", numero: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
    });
    expect(r.json.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
    expect(r.json.montos).toMatchObject({ biDgng: "0.00", biDng: "0.00" });

    const cs = await v.compras(c.id);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ id: r.json.id, origen: "agregada", propuesta_id: null, version_vigente: 1, descartada: false });
    expect((await v.versiones(r.json.id))[0]).toMatchObject({ n: 1, accion: "agregada", usuario_id: contador.id, total: "23.09" });

    const docs = await documentosXml(v, c.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      n: 1,
      origen: "subido",
      ruc_emisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      tamano: cuerpo.length,
      sha256: sha256Hex(cuerpo),
      subido_por: contador.id,
    });
    expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual([docs[0]!.ruta]);

    // La lupa de la compra nueva ya tiene su XML.
    const g = await v.llamar(contador, "GET", `${base(c.id)}/${r.json.id}/detalle`);
    expect(g.status, g.text).toBe(200);
    expect(g.body.xml).toMatchObject({ estado: "disponible", origen: "subido", subidoPor: contador.id });
    expect(g.body.items).toHaveLength(2);
    expect(g.body.cabecera.proveedorNuevo).toBe(true);
  });

  it.each([
    ["DGNG", { biDgng: "8.97", igvDgng: "1.61", biDg: "0.00", igvDg: "0.00" }],
    ["DNG", { biDng: "8.97", igvDng: "1.61", biDg: "0.00", igvDg: "0.00" }],
  ])("el destino %s lleva la BI y el IGV a su par de columnas", async (destino, esperado) => {
    const c = await nuevo();
    const r = await alta(contador, c, `?destino=${destino}`, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect(r.json.montos).toMatchObject({ ...esperado, noGravado: "12.51", total: "23.09" });
  });

  it("San Juan (F001-1040) con destino DG: BI 0.00, ISC 770.00 y total 770.00", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", xmlDe("1040", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect(r.json.montos).toMatchObject({ biDg: "0.00", igvDg: "0.00", isc: "770.00", total: "770.00" });
  });

  it("ICBPER (F001-3064): BI 100.00, IGV 18.00, ICBPER 1.50 y total 119.50", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", xmlDe("3064", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect(r.json.montos).toMatchObject({ biDg: "100.00", igvDg: "18.00", icbper: "1.50", total: "119.50" });
  });

  it("la compra nueva aparece en el listado del periodo y en el resumen", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(201);
    const lista = await v.llamar(contador, "GET", base(c.id));
    expect((lista.body.filas as any[]).map((f) => f.id)).toEqual([r.json.id]);
  });
});

describe("CA-13 · USD con tipo de cambio (P-9, F001-4062)", () => {
  it("destino DG y tipoCambio 3.752: 201 con el tipo de cambio guardado y los montos USD sin convertir", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG&tipoCambio=3.752", xmlDe("4062", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect(filaCompraVistaSchema.safeParse(r.json).success, r.texto).toBe(true);
    expect(r.json).toMatchObject({ origen: "agregada", moneda: "USD", tipoCambio: "3.752", serie: "F001", numero: "4062" });
    expect(r.json.montos).toMatchObject({ biDg: "0.15", igvDg: "0.03", total: "0.18" });
    expect((await v.compras(c.id))[0]).toMatchObject({ moneda: "USD", tipo_cambio: "3.752" });
    expect(await documentosXml(v, c.id)).toHaveLength(1);
    expect(archivosDe(st.dir, E.tenantId, c.id)).toHaveLength(1);
  });

  it("aunque el XML traiga PaymentExchangeRate, el tipo de cambio es el que pone el usuario", async () => {
    const c = await nuevo();
    const conTc = cambiar(
      xmlDe("4062", c.ruc),
      "</cac:LegalMonetaryTotal>",
      '</cac:LegalMonetaryTotal><cac:PaymentExchangeRate><cbc:SourceCurrencyCode>USD</cbc:SourceCurrencyCode><cbc:TargetCurrencyCode>PEN</cbc:TargetCurrencyCode><cbc:CalculationRate>9.999</cbc:CalculationRate></cac:PaymentExchangeRate>',
    );
    const sin = await alta(contador, c, "?destino=DG", conTc);
    expect(sin.status, sin.texto).toBe(400);
    expect(sin.json).toEqual({ codigo: "solicitud_invalida" });
    const ok = await alta(contador, c, "?destino=DG&tipoCambio=3.752", conTc);
    expect(ok.status, ok.texto).toBe(201);
    expect(ok.json.tipoCambio).toBe("3.752");
  });
});

describe("CA-13 · 400 solicitud_invalida: no guarda nada, ni en BD ni en storage", () => {
  const casos: [string, NombreXml, string][] = [
    ["USD sin tipo de cambio", "4062", "?destino=DG"],
    ["USD con tipo de cambio cero", "4062", "?destino=DG&tipoCambio=0"],
    ["USD con tipo de cambio 0.000", "4062", "?destino=DG&tipoCambio=0.000"],
    ["USD con más de 3 decimales", "4062", "?destino=DG&tipoCambio=3.7521"],
    ["USD con tipo de cambio que no es número", "4062", "?destino=DG&tipoCambio=abc"],
    ["USD con tipo de cambio negativo", "4062", "?destino=DG&tipoCambio=-3.7"],
    ["USD con coma decimal", "4062", "?destino=DG&tipoCambio=3,75"],
    ["PEN con tipo de cambio", "2056", "?destino=DG&tipoCambio=3.752"],
    ["destino ausente", "2056", ""],
    ["destino vacío", "2056", "?destino="],
    ["destino inexistente", "2056", "?destino=XX"],
    ["destino en minúsculas", "2056", "?destino=dg"],
  ];
  it.each(casos)("%s", async (_n, nombre, query) => {
    const c = await nuevo();
    const antes = await v.foto(c.id);
    const r = await alta(contador, c, query, xmlDe(nombre, c.ruc));
    expect(r.status, r.texto).toBe(400);
    expect(r.json).toEqual({ codigo: "solicitud_invalida" });
    await nadaGuardado(c);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("parámetros de más en la query (tenantId, clienteId) no se aceptan como datos: la compra queda en el cliente de la ruta", async () => {
    const c = await nuevo();
    const otro = await nuevo();
    const r = await alta(contador, c, `?destino=DG&clienteId=${otro.id}&tenantId=${E.tenantId}`, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect(await v.compras(c.id)).toHaveLength(1);
    expect(await v.compras(otro.id)).toHaveLength(0);
  });
});

describe("CA-13 · el comprobante ya existe: 409 duplicado con el id", () => {
  it("una fila del SIRE del mismo periodo: 409 { duplicado, id } y no se guarda el XML", async () => {
    const { c, ids } = await conFixture();
    const antes = await v.foto(c.id);
    const r = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "duplicado", id: ids["F001-2056"] });
    expect(await documentosXml(v, c.id)).toEqual([]);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("agregarlo dos veces: la segunda es 409 duplicado con el id de la primera y queda un solo XML", async () => {
    const c = await nuevo();
    const primera = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(primera.status, primera.texto).toBe(201);
    const segunda = await alta(contador, c, "?destino=DNG", xmlDe("2056", c.ruc));
    expect(segunda.status, segunda.texto).toBe(409);
    expect(segunda.json).toEqual({ codigo: "duplicado", id: primera.json.id });
    expect(await documentosXml(v, c.id)).toHaveLength(1);
    expect(await v.compras(c.id)).toHaveLength(1);
  });

  it("dos altas simultáneas del mismo XML: una gana (201) y la otra es 409 duplicado; un solo XML guardado", async () => {
    const c = await nuevo();
    const rs = await Promise.all([alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc)), alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await v.compras(c.id)).toHaveLength(1);
    expect(await documentosXml(v, c.id)).toHaveLength(1);
  });

  it("vista previa después del alta: existente apunta a la compra nueva", async () => {
    const c = await nuevo();
    const a = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    const p = await previa(contador, c, xmlDe("2056", c.ruc));
    expect(p.json.existente).toEqual({ id: a.json.id });
  });
});

describe("CA-12 · CA-2 · el alta rechaza lo que la subida rechaza", () => {
  it("receptor de otro RUC: 422 xml_ajeno { receptor } y nada guardado", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", xmlDe("2056", "20700000099"));
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_ajeno", campos: ["receptor"] });
    await nadaGuardado(c);
    expect(await v.compras(c.id)).toEqual([]);
  });

  it.each([
    ["que no es XML", "esto no es un xml"],
    ["con DOCTYPE", '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><Invoice>&x;</Invoice>'],
  ])("un archivo %s: 422 xml_invalido y nada guardado", async (_n, cuerpo) => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", cuerpo);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_invalido" });
    await nadaGuardado(c);
    expect(await v.compras(c.id)).toEqual([]);
  });

  it("1 MiB + 1 byte: 413 y nada en storage ni en BD", async () => {
    const c = await nuevo();
    const r = await alta(contador, c, "?destino=DG", conTamano(xmlDe("2056", c.ruc), MIB + 1));
    expect(r.status).toBe(413);
    await nadaGuardado(c);
    expect(await v.compras(c.id)).toEqual([]);
  });
});

describe("D-8 · permisos y estado del periodo (los mismos que agregar a mano, 014 D-9)", () => {
  it("quien solo lee: 403 permiso_denegado; sin sesión: 401", async () => {
    const c = await nuevo();
    const r = await alta(lectura, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(403);
    expect(r.json).toEqual({ codigo: "permiso_denegado" });
    expect((await v.sinSesion("POST", `${base(c.id)}/desde-xml?destino=DG`, {})).status).toBe(401);
    await nadaGuardado(c);
  });

  it("periodo revisado: quien solo clasifica recibe 403 periodo_revisado y nada se guarda", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const r = await alta(asistente, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(403);
    expect(r.json).toEqual({ codigo: "periodo_revisado" });
    await nadaGuardado(c);
  });

  it("periodo generado: 409 periodo_generado y nada se guarda", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "periodo_generado" });
    await nadaGuardado(c);
  });

  it("cliente archivado: 409 cliente_archivado y nada se guarda", async () => {
    const c = await nuevo({ archivado: true });
    const r = await alta(contador, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "cliente_archivado" });
    await nadaGuardado(c);
  });

  it("un cliente de otro estudio o sin asignar es el mismo 404 de siempre", async () => {
    const c = await nuevo();
    const ajeno = await v.b.c.p.b.miembro(E.tenantId, "asistente"); // sin ningún cliente asignado
    const r = await alta(ajeno, c, "?destino=DG", xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(404);
    const p = await previa(ajeno, c, xmlDe("2056", c.ruc));
    expect(p.status, p.texto).toBe(404);
    await nadaGuardado(c);
  });
});

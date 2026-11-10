/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 016 (T7, rojo): subir, descargar y obtener el XML de una compra por HTTP, y la re-evaluación con el XML
// (D-1 a D-9, D-11; CA-1 vía HTTP, CA-2, CA-6 a CA-9, CA-11, CA-12, CA-15, CA-16, CA-17).
// Contrato (plan 016, «Contratos: HTTP»; errores `{codigo}`; formas de `errorXmlSchema` y `detalleLupaSchema` de `@contapp/shared`):
//  - `POST …/compras/:compraId/xml` (cuerpo crudo `application/xml`, `text/xml` u `application/octet-stream`, ≤ 1 MiB; permiso
//    `sire.clasificar`) -> 200 `DetalleCompraDto` | 413 (más de 1 MiB: antes del controlador) | 422 `xml_invalido` \|
//    `xml_incompleto` \| `xml_ajeno {campos[]}` (campos ⊆ ruc, tipo, serie, numero, receptor) | 409 `xml_existente`
//    (P-6) \| `cliente_archivado` | 404. Un cuerpo vacío es `xml_invalido`. Se permite en cualquier estado del periodo (D-7).
//    Guarda los bytes tal cual llegaron en `xml/{tenant}/{cliente}/{uuid}.xml`, una fila `documento_xml` (`origen = subido`,
//    `subido_por`, `tamano`, `sha256`) y re-evalúa sin crear versión de la fila (D-5).
//  - `GET …/:compraId/xml` (permiso `clientes.ver`) -> 200 con los bytes guardados, `Content-Type: application/xml`,
//    `Content-Disposition: attachment; filename="{ruc}-{tipo}-{serie}-{numero}.xml"` y `X-Content-Type-Options: nosniff`;
//    404 también si no hay XML.
//  - `POST …/:compraId/xml/obtener` (permiso `sire.clasificar`) -> 202 `{trabajoId}` (`xml.obtener`, cola `xml`, canal
//    `ninguno`, prioridad `interactivo`, parámetros `{periodo, compraIds:[id]}`), idempotente por dedupe de 008; 409
//    `xml_existente` si ya hay un XML que no es simulado; 409 `cliente_archivado`. No usa credencial del cliente (P-7).
//  - Toda ruta con `compraId` de otro cliente, periodo o estudio, inexistente o mal formado: el mismo 404 `no_encontrado`.
//  - Ni el XML, ni montos, glosas o razones sociales, ni rutas de storage aparecen en logs, errores ni parámetros del trabajo (D-11).
// Rojo: las rutas aún no existen (T13 y T14): responden 404 de ruta inexistente.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { informeMasivaSchema } from "@contapp/shared";
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
import { capturarLogs } from "../../../test/soporte.js";
import {
  archivosBajo,
  archivosDe,
  bytes,
  bytesLatin1,
  cambiar,
  conTamano,
  detalleLupaSchema,
  documentosXml,
  forzarOrigen,
  pedirXml,
  prepararStorage,
  sembrarObtencion,
  sha256Hex,
  trabajosDeTipo,
  xmlConLineasMinimas,
  xmlDe,
  type EstadoObtencion,
  type StoragePrueba,
} from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const MIB = 1024 * 1024;

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  st = prepararStorage();
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
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };

async function escenario(o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  return { c, ids };
}
const ruta = (c: Cliente, id: string, resto = "") => `${base(c.id)}/${id}${resto}`;
const subir = (a: Actor, c: Cliente, id: string, xml: string | Uint8Array, tipo = "application/xml") =>
  pedirXml(v, a, "POST", ruta(c, id, "/xml"), typeof xml === "string" ? bytes(xml) : xml, tipo);
const bajar = (a: Actor, c: Cliente, id: string) => pedirXml(v, a, "GET", ruta(c, id, "/xml"));
const obtener = (a: Actor, c: Cliente, id: string) => v.llamar(a, "POST", ruta(c, id, "/xml/obtener"), {});
const detalle = (a: Actor, c: Cliente, id: string) => v.llamar(a, "GET", ruta(c, id, "/detalle"));
const post = (a: Actor, c: Cliente, id: string, resto: string, cuerpo: unknown) => v.llamar(a, "POST", ruta(c, id, resto), cuerpo);
const masivaAceptar = (a: Actor, c: Cliente, items: string[], regla: string, versionBase = 1) =>
  v.llamar(a, "POST", `${base(c.id)}/masivas/aceptar`, { items: items.map((compraId) => ({ compraId, versionBase })), regla });
const trabajosXml = (c: Cliente) => trabajosDeTipo(v, c.id, "xml.obtener");
/** Nada guardado para el cliente: ni documento_xml ni archivo en storage. */
async function nadaGuardado(c: Cliente): Promise<void> {
  expect(await documentosXml(v, c.id)).toEqual([]);
  expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual([]);
}

// --- Subir ----------------------------------------------------------------------------------------------------------

describe("CA-12 · subir el XML del mismo comprobante (HU-22, D-3, D-4)", () => {
  it("200 con el detalle completo, bytes en storage con ruta de uuid, fila documento_xml y la versión de la fila intacta", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const cuerpo = bytes(xmlDe("2056", c.ruc));
    const r = await subir(contador, c, id, cuerpo);
    expect(r.status, r.texto).toBe(200);
    expect(detalleLupaSchema.safeParse(r.json).success, r.texto).toBe(true);
    expect(r.json.xml).toMatchObject({ estado: "disponible", origen: "subido", subidoPor: contador.id });
    expect(r.json.items).toHaveLength(2);
    expect(r.headers["cache-control"]).toMatch(/no-store/);

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
    expect(docs[0]!.ruta).toMatch(new RegExp(`^xml/${E.tenantId}/${c.id}/[0-9a-f-]{36}\\.xml$`));
    expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual([docs[0]!.ruta]);
    expect(new Uint8Array(readFileSync(join(st.dir, docs[0]!.ruta)))).toEqual(cuerpo);

    // Subir y re-evaluar no crea versión de la fila (D-5).
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1]);
    expect((await v.compras(c.id)).find((x) => x.id === id)!.version_vigente).toBe(1);
  });

  it("la lupa se completa sin recargar: el GET de después ve lo mismo que devolvió la subida", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const r = await subir(contador, c, id, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(200);
    const g = await detalle(contador, c, id);
    expect(g.status, g.text).toBe(200);
    expect(g.body).toEqual(r.json);
  });

  it("el mismo XML otra vez (ya subido): 409 xml_existente y no se guarda nada más (P-6)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const antes = { docs: await documentosXml(v, c.id), archivos: archivosDe(st.dir, E.tenantId, c.id) };
    const r = await subir(contador, c, id, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "xml_existente" });
    expect(await documentosXml(v, c.id)).toEqual(antes.docs);
    expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual(antes.archivos);
  });

  it("ISO-8859-1 con ñ: se guardan los bytes originales y la glosa se lee bien", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const original = bytesLatin1(cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "Pañal ñandú (PRUEBA)"));
    const r = await subir(contador, c, id, original);
    expect(r.status, r.texto).toBe(200);
    expect(r.json.items[0].descripcion).toBe("Pañal ñandú (PRUEBA)");
    const bajado = await bajar(contador, c, id);
    expect(bajado.status).toBe(200);
    expect(new Uint8Array(bajado.bytes)).toEqual(original);
  });

  it.each(["application/xml", "text/xml", "application/octet-stream"])("acepta el cuerpo crudo como %s", async (tipo) => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, xmlDe("2056", c.ruc), tipo);
    expect(r.status, r.texto).toBe(200);
  });

  it("un cuerpo JSON no es un XML: 4xx y no se guarda nada", async () => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, xmlDe("2056", c.ruc), "application/json");
    expect([400, 415, 422], r.texto).toContain(r.status);
    await nadaGuardado(c);
  });
});

describe("CA-12 · identidad: un XML de otro comprobante da 422 xml_ajeno con el campo que difiere (D-3)", () => {
  const variantes: [string, (xml: string, c: Cliente) => string, string[]][] = [
    ["RUC del emisor", (x) => cambiar(x, "20700000045", "20700000046"), ["ruc"]],
    ["tipo", (x) => cambiar(x, ">01</cbc:InvoiceTypeCode>", ">03</cbc:InvoiceTypeCode>"), ["tipo"]],
    ["serie", (x) => cambiar(x, "<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F009-2056</cbc:ID>"), ["serie"]],
    ["número", (x) => cambiar(x, "<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F001-2057</cbc:ID>"), ["numero"]],
    ["receptor (otro cliente)", (x, c) => cambiar(x, c.ruc, "20700000099"), ["receptor"]],
    [
      "RUC y serie a la vez",
      (x) => cambiar(cambiar(x, "20700000045", "20700000046"), "<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F009-2056</cbc:ID>"),
      ["ruc", "serie"],
    ],
  ];
  it.each(variantes)("%s", async (_nombre, variar, campos) => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, variar(xmlDe("2056", c.ruc), c));
    expect(r.status, r.texto).toBe(422);
    expect(r.json.codigo).toBe("xml_ajeno");
    expect([...r.json.campos].sort()).toEqual([...campos].sort());
    expect(Object.keys(r.json).sort()).toEqual(["campos", "codigo"]);
    // El error no devuelve nada más del XML.
    for (const dato of ["MIXTO", "8.97", "12.51", "PRUEBA"]) expect(r.texto).not.toContain(dato);
    await nadaGuardado(c);
  });

  it("el XML de otra compra del mismo cliente (F001-1040 sobre la fila F001-2056) también es ajeno", async () => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, xmlDe("1040", c.ruc));
    expect(r.status, r.texto).toBe(422);
    expect(r.json.codigo).toBe("xml_ajeno");
    expect([...r.json.campos].sort()).toEqual(["numero", "ruc"]);
    await nadaGuardado(c);
  });
});

describe("CA-1 · CA-2 · archivos que no son un XML aceptable (D-1, P-5)", () => {
  const XXE = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Invoice>&xxe;</Invoice>';
  const LAUGHS =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">]><Invoice>&lol3;</Invoice>';
  const EXTERNA = '<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://127.0.0.1:1/x.dtd"><Invoice/>';
  it.each([
    ["texto que no es XML", "esto no es un xml"],
    ["HTML", "<html><body>hola</body></html>"],
    ["un XML que no es UBL", '<?xml version="1.0"?><Order><ID>1</ID></Order>'],
    ["XXE con entidad de archivo", XXE],
    ["entidades anidadas (billion laughs)", LAUGHS],
    ["DTD externa por HTTP", EXTERNA],
    ["byte NUL", new Uint8Array([0x3c, 0x49, 0x00, 0x3e])],
    ["cuerpo vacío", new Uint8Array(0)],
  ] as [string, string | Uint8Array][])("%s: 422 xml_invalido sin repetir el contenido y sin guardar nada", async (_n, cuerpo) => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await subir(contador, c, ids["F001-2056"]!, cuerpo);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_invalido" });
    for (const eco of ["passwd", "lolz", "127.0.0.1", "esto no es", "hola"]) expect(r.texto).not.toContain(eco);
    await nadaGuardado(c);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("un UBL sin total (ni PayableAmount ni TaxInclusiveAmount): 422 xml_incompleto", async () => {
    const { c, ids } = await escenario();
    const sinTotal = xmlDe("2056", c.ruc).replace(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, "");
    expect(sinTotal).not.toContain("PayableAmount");
    const r = await subir(contador, c, ids["F001-2056"]!, sinTotal);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_incompleto" });
    await nadaGuardado(c);
  });

  it("1 MiB + 1 byte: 413 antes de llegar al controlador y nada en storage ni en BD", async () => {
    const { c, ids } = await escenario();
    const antes = await v.foto(c.id);
    const r = await subir(contador, c, ids["F001-2056"]!, conTamano(xmlDe("2056", c.ruc), MIB + 1));
    expect(r.status).toBe(413);
    await nadaGuardado(c);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("exactamente 1 MiB se acepta", async () => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, conTamano(xmlDe("2056", c.ruc), MIB));
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect((await documentosXml(v, c.id))[0]).toMatchObject({ tamano: MIB });
  });

  it("2.001 ítems: 422 xml_invalido antes de guardar nada (el tope es 2.000)", async () => {
    const { c, ids } = await escenario();
    const r = await subir(contador, c, ids["F001-2056"]!, xmlConLineasMinimas(2001, c.ruc));
    expect(r.status, r.texto.slice(0, 200)).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_invalido" });
    await nadaGuardado(c);
  });

  it("más de 32 niveles de profundidad: 422 xml_invalido y nada guardado", async () => {
    const { c, ids } = await escenario();
    const hondo = cambiar(xmlDe("2056", c.ruc), "<cbc:UBLVersionID>", `${"<a>".repeat(40)}${"</a>".repeat(40)}<cbc:UBLVersionID>`);
    const r = await subir(contador, c, ids["F001-2056"]!, hondo);
    expect(r.status, r.texto).toBe(422);
    expect(r.json).toEqual({ codigo: "xml_invalido" });
    await nadaGuardado(c);
  });
});

describe("P-6 · reemplazo del XML (D-4)", () => {
  it("con uno simulado, subir otro se acepta: queda vigente el subido y el anterior se conserva", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const [primero] = await documentosXml(v, c.id);
    await forzarOrigen(v, primero!.id, "simulado");
    expect((await detalle(contador, c, id)).body.xml).toMatchObject({ estado: "disponible", origen: "simulado" });
    expect((await detalle(contador, c, id)).body.xml).not.toHaveProperty("subidoPor");

    const nuevo = cambiar(xmlDe("2056", c.ruc), "<!-- Datos", "<!-- Segunda versión. Datos");
    const r = await subir(contador, c, id, nuevo);
    expect(r.status, r.texto).toBe(200);
    expect(r.json.xml).toMatchObject({ estado: "disponible", origen: "subido", subidoPor: contador.id });
    const docs = await documentosXml(v, c.id);
    expect(docs.map((d) => [d.n, d.origen])).toEqual([
      [1, "simulado"],
      [2, "subido"],
    ]);
    expect(archivosDe(st.dir, E.tenantId, c.id)).toHaveLength(2);
    const bajado = await bajar(contador, c, id);
    expect(new Uint8Array(bajado.bytes)).toEqual(bytes(nuevo));
  });

  it("con uno real, subir otro es 409 xml_existente y nada cambia", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const [primero] = await documentosXml(v, c.id);
    await forzarOrigen(v, primero!.id, "real");
    const antes = { docs: await documentosXml(v, c.id), archivos: archivosDe(st.dir, E.tenantId, c.id) };
    const r = await subir(contador, c, id, cambiar(xmlDe("2056", c.ruc), "<!-- Datos", "<!-- Otra. Datos"));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "xml_existente" });
    expect(await documentosXml(v, c.id)).toEqual(antes.docs);
    expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual(antes.archivos);
  });
});

describe("D-7 · permisos y estado del periodo al subir", () => {
  it("quien solo lee: 403 permiso_denegado; sin sesión: 401", async () => {
    const { c, ids } = await escenario();
    const r = await subir(lectura, c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(403);
    expect(r.json).toEqual({ codigo: "permiso_denegado" });
    const sin = await v.sinSesion("POST", ruta(c, ids["F001-2056"]!, "/xml"));
    expect(sin.status).toBe(401);
    await nadaGuardado(c);
  });

  it.each(["revisado", "generado"] as const)("con el periodo %s también se puede subir (no cambia montos ni versiones), aun sin aprobar", async (estado) => {
    const { c, ids } = await escenario();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, estado, contador.id);
    const r = await subir(asistente, c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(200);
    expect((await v.versiones(ids["F001-2056"]!)).map((x) => x.n)).toEqual([1]);
  });

  it("cliente archivado: 409 cliente_archivado y nada guardado", async () => {
    const { c, ids } = await escenario({ archivado: true });
    const r = await subir(contador, c, ids["F001-2056"]!, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "cliente_archivado" });
    await nadaGuardado(c);
  });
});

// --- Descargar ------------------------------------------------------------------------------------------------------

describe("CA-17 · descargar el XML (D-8)", () => {
  it("200 con los bytes guardados, como adjunto con nosniff y nombre armado con la identidad, sin caché", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const original = bytes(xmlDe("2056", c.ruc));
    expect((await subir(contador, c, id, original)).status).toBe(200);
    const r = await bajar(lectura, c, id); // clientes.ver basta
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(new Uint8Array(r.bytes)).toEqual(original);
    expect(r.headers["content-type"]).toMatch(/^application\/xml/);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="20700000045-01-F001-2056.xml"');
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("un XML con <script> en la glosa se descarga como application/xml adjunto, nunca como HTML", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const hostil = cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "&lt;script&gt;alert(1)&lt;/script&gt;");
    expect((await subir(contador, c, id, hostil)).status).toBe(200);
    const r = await bajar(contador, c, id);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).not.toMatch(/html/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sin XML guardado: 404 no_encontrado, igual que una compra inexistente", async () => {
    const { c, ids } = await escenario();
    const r = await bajar(contador, c, ids["F001-2056"]!);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
  });
});

// --- Obtener --------------------------------------------------------------------------------------------------------

describe("D-8 · POST xml/obtener (HU-21)", () => {
  it("202 { trabajoId } y una fila xml.obtener interactiva, sin credencial, con { periodo, compraIds }", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const r = await obtener(contador, c, id);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajoId"]);
    expect(r.body.trabajoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const filas = await trabajosXml(c);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: "xml.obtener",
      cola: "xml",
      canal: "ninguno",
      prioridad: "interactivo",
      estado: "en_cola",
      creado_por: contador.id,
    });
    expect(filas[0].parametros).toEqual({ periodo: PERIODO, compraIds: [id] });
    expect(await documentosXml(v, c.id)).toEqual([]); // guardar el XML es del worker
    expect((await detalle(contador, c, id)).body.xml).toEqual({ estado: "pendiente" });
  });

  it("pulsar dos veces, o a la vez, devuelve el mismo trabajoId y deja una sola fila (dedupe de 008)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const a = await obtener(contador, c, id);
    const b = await obtener(contador, c, id);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.trabajoId).toBe(a.body.trabajoId);
    const otra = await escenario();
    const [x, y] = await Promise.all([obtener(contador, otra.c, otra.ids["F001-2056"]!), obtener(contador, otra.c, otra.ids["F001-2056"]!)]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(y.body.trabajoId).toBe(x.body.trabajoId);
    expect(await trabajosXml(c)).toHaveLength(1);
    expect(await trabajosXml(otra.c)).toHaveLength(1);
  });

  it("con un XML subido o real ya guardado: 409 xml_existente y no se encola nada", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const r = await obtener(contador, c, id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "xml_existente" });
    expect(await trabajosXml(c)).toEqual([]);
  });

  it("con uno simulado ya guardado sí se encola (el real puede reemplazarlo)", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    await forzarOrigen(v, (await documentosXml(v, c.id))[0]!.id, "simulado");
    const r = await obtener(contador, c, id);
    expect(r.status, r.text).toBe(202);
  });

  it.each(["no_encontrado", "credencial", "transitorio"] satisfies EstadoObtencion[])(
    "«Reintentar» tras no disponible (%s): 202 y la lupa vuelve a pendiente",
    async (estado) => {
      const { c, ids } = await escenario();
      const id = ids["F001-2056"]!;
      await sembrarObtencion(v, {
        tenantId: E.tenantId,
        clienteId: c.id,
        rucEmisor: "20700000045",
        tipo: "01",
        serie: "F001",
        numero: "2056",
        estado,
      });
      expect((await detalle(contador, c, id)).body.xml).toEqual({ estado: "no_disponible", codigo: estado });
      const r = await obtener(contador, c, id);
      expect(r.status, r.text).toBe(202);
      expect((await detalle(contador, c, id)).body.xml).toEqual({ estado: "pendiente" });
    },
  );

  it("no usa credenciales del cliente (P-7): un cliente sin SOL ni SIRE configuradas también encola", async () => {
    const { c, ids } = await escenario({ sol: "no_configurada", sireApi: "no_configurada" });
    const r = await obtener(contador, c, ids["F001-2056"]!);
    expect(r.status, r.text).toBe(202);
    expect(await v.b.credenciales(c.id)).toEqual([]);
  });

  it("se permite con el periodo revisado o generado, incluso a quien solo clasifica", async () => {
    const { c, ids } = await escenario();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    expect((await obtener(asistente, c, ids["F001-2056"]!)).status).toBe(202);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    expect((await obtener(asistente, c, ids["F001-1040"]!)).status).toBe(202);
  });

  it("quien solo lee: 403; cliente archivado: 409 cliente_archivado; sin sesión: 401", async () => {
    const { c, ids } = await escenario();
    const sinPermiso = await obtener(lectura, c, ids["F001-2056"]!);
    expect(sinPermiso.status).toBe(403);
    expect(sinPermiso.body).toEqual({ codigo: "permiso_denegado" });
    expect((await v.sinSesion("POST", ruta(c, ids["F001-2056"]!, "/xml/obtener"), {})).status).toBe(401);
    const archivado = await escenario({ archivado: true });
    const r = await obtener(contador, archivado.c, archivado.ids["F001-2056"]!);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await trabajosXml(c)).toEqual([]);
    expect(await trabajosXml(archivado.c)).toEqual([]);
  });
});

// --- Aislamiento y secretos -----------------------------------------------------------------------------------------

describe("CA-17 · aislamiento: las cuatro rutas dan el mismo 404 que una compra inexistente", () => {
  it("compra de otro cliente, de otro periodo o de otro estudio, inexistente o mal formada", async () => {
    const { c, ids } = await escenario();
    const otro = await escenario();
    // La otra compra SÍ tiene XML: no debe filtrarse por la ruta de este cliente.
    expect((await subir(contador, otro.c, otro.ids["F001-2056"]!, xmlDe("2056", otro.c.ruc))).status).toBe(200);
    const cF = await v.cliente(F, {});
    const idF = await v.sembrarCompra(F.tenantId, cF.id, { serie: "F001", numero: "2056", doc: "20700000045", usuarioId: F.titular.id });
    const contadorF = await v.b.c.p.b.miembro(F.tenantId, "contador");

    const xmlPropio = xmlDe("2056", c.ruc);
    const rutas = {
      detalle: (id: string, a: Actor = contador, cl: Cliente = c, per = PERIODO) => v.llamar(a, "GET", `${base(cl.id, per)}/${id}/detalle`),
      descargar: (id: string, a: Actor = contador, cl: Cliente = c, per = PERIODO) => pedirXml(v, a, "GET", `${base(cl.id, per)}/${id}/xml`),
      subir: (id: string, a: Actor = contador, cl: Cliente = c, per = PERIODO) =>
        pedirXml(v, a, "POST", `${base(cl.id, per)}/${id}/xml`, bytes(xmlPropio)),
      obtener: (id: string, a: Actor = contador, cl: Cliente = c, per = PERIODO) => v.llamar(a, "POST", `${base(cl.id, per)}/${id}/xml/obtener`, {}),
    };
    const respuesta = (r: any) => ({ status: r.status, cuerpo: r.body ?? r.json });
    for (const [nombre, llamar] of Object.entries(rutas)) {
      const inexistente = respuesta(await llamar("00000000-0000-4000-8000-000000000000"));
      expect(inexistente.status, nombre).toBe(404);
      expect(inexistente.cuerpo, nombre).toEqual({ codigo: "no_encontrado" });
      const casos = {
        "de otro cliente": await llamar(otro.ids["F001-2056"]!),
        "de otro periodo": await llamar(ids["F001-2056"]!, contador, c, "202609"),
        "de otro estudio (cliente ajeno)": await llamar(idF, contador, cF as Cliente),
        "de este cliente pero con la sesión de otro estudio": await llamar(ids["F001-2056"]!, contadorF),
        "sin el cliente asignado": await llamar(ids["F001-2056"]!, asistenteAjeno),
        "mal formada": await llamar("no-es-uuid"),
      };
      for (const [caso, r] of Object.entries(casos)) {
        expect(respuesta(r), `${nombre} ${caso}`).toEqual(inexistente);
      }
    }
    // Nada se guardó por esas rutas: el cliente propio y el ajeno siguen sin XML.
    await nadaGuardado(c);
    expect(await documentosXml(v, cF.id)).toEqual([]);
    expect(archivosBajo(st.dir, `xml/${F.tenantId}/`)).toEqual([]);
    expect(await trabajosXml(c)).toEqual([]);
    // El XML de la otra compra sigue siendo solo suyo.
    expect((await documentosXml(v, otro.c.id)).length).toBe(1);
  });
});

describe("CA-17 · D-11: ni el XML ni sus datos aparecen en logs, errores o parámetros del trabajo", () => {
  it("con canarios en la glosa y la razón social, subir, leer, descargar y obtener no los dejan en los logs", async () => {
    const { c, ids } = await escenario();
    const otra = ids["F001-1040"]!;
    const marcado = cambiar(
      cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "CANARIO-GLOSA-016"),
      "PRUEBA PROVEEDOR MIXTO S.A.C.",
      "CANARIO-RAZON-016 SAC",
    );
    const { resultado, logs } = await capturarLogs(async () => {
      const s = await subir(contador, c, ids["F001-2056"]!, marcado);
      const d = await detalle(contador, c, ids["F001-2056"]!);
      const b = await bajar(contador, c, ids["F001-2056"]!);
      const o = await obtener(contador, c, otra);
      const malo = await subir(contador, c, otra, cambiar(marcado, "20700000045", "20700000046"));
      return { s, d, b, o, malo };
    });
    expect(resultado.s.status, resultado.s.texto).toBe(200);
    expect(resultado.b.status).toBe(200);
    expect(resultado.o.status, resultado.o.text).toBe(202);
    expect(resultado.malo.status).toBe(422);
    for (const secreto of ["CANARIO-GLOSA-016", "CANARIO-RAZON-016", "<cbc:", "PayableAmount", "8.97", "12.51"]) {
      expect(logs, secreto).not.toContain(secreto);
      expect(resultado.malo.texto, secreto).not.toContain(secreto);
    }
    expect(logs).not.toMatch(/xml\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//);
    const [t] = await trabajosXml(c);
    expect(JSON.stringify([t.parametros, t.resultado, t.motivo])).not.toContain("CANARIO");
    expect(t.parametros).toEqual({ periodo: PERIODO, compraIds: [otra] });
  });
});

// --- Re-evaluación con el XML (D-5, D-7) ----------------------------------------------------------------------------

describe("CA-6 · el XML que llega completa R-MIX sin tocar la versión y la masiva lo acepta (caso mixta)", () => {
  it("sin XML la masiva no la ofrece; con XML subido R-MIX es exacto 8.97 / 12.51 y la masiva la aplica", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const antes = await masivaAceptar(contador, c, [id], "R-MIX");
    expect(antes.status, antes.text).toBe(200);
    expect(antes.body).toEqual({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: id, codigo: "no_masiva" }] });

    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1]); // la versión no cambia
    const g = await detalle(contador, c, id);
    expect(g.body.hallazgos).toHaveLength(1);
    expect(g.body.hallazgos[0]).toMatchObject({
      regla: "R-MIX",
      requiereConfirmacion: false,
      sugerencia: { tipo: "separar", columnaBi: "biDg", exacto: "8.97" },
    });

    const r = await masivaAceptar(contador, c, [id], "R-MIX");
    expect(r.status, r.text).toBe(200);
    expect(informeMasivaSchema.safeParse(r.body).success, r.text).toBe(true);
    expect(r.body).toMatchObject({ aplicadas: 1, rechazadas: [] });
    expect(r.body.operacionId).toMatch(/^[0-9a-f-]{36}$/);
    const v2 = (await v.versiones(id)).at(-1)!;
    expect(v2).toMatchObject({ n: 2, accion: "sugerencia", biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
  });

  it("aceptarla de una en una con el XML no pide el gravado: se acepta sin `dato`", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const r = await post(contador, c, id, "/sugerencias/aceptar", { versionBase: 1, regla: "R-MIX", confirmar: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body.fila.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", noGravado: "12.51", total: "23.09" });
    expect(r.body.fila.hallazgos.map((h: any) => h.regla)).not.toContain("R-MIX");
  });
});

describe("CA-7 · San Juan: R-ISC respaldado por el XML (valor 0.00, ISC 770.00)", () => {
  it("aceptar la sugerencia deja BI DG 0.00 e ISC 770.00", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-1040"]!;
    expect((await subir(contador, c, id, xmlDe("1040", c.ruc))).status).toBe(200);
    const g = await detalle(contador, c, id);
    expect(g.body.hallazgos[0]).toMatchObject({
      regla: "R-ISC",
      requiereConfirmacion: false,
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
    });
    const r = await post(contador, c, id, "/sugerencias/aceptar", { versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body.fila.montos).toMatchObject({ biDg: "0.00", isc: "770.00", total: "770.00" });
    expect((await v.versiones(id)).at(-1)!).toMatchObject({ n: 2, accion: "sugerencia", biDg: "0.00", isc: "770.00" });
  });
});

describe("CA-8 · edición y llegada del XML: la versión final queda evaluada con el XML, en cualquier orden", () => {
  const exacto = async (c: Cliente, id: string) => {
    const g = await detalle(contador, c, id);
    expect(g.status, g.text).toBe(200);
    const mix = (g.body.hallazgos as any[]).filter((h) => h.regla === "R-MIX");
    expect(mix).toHaveLength(1);
    expect(mix[0]).toMatchObject({ requiereConfirmacion: false, sugerencia: { exacto: "8.97" } });
    expect(g.body.xml).toMatchObject({ estado: "disponible" });
  };

  it("primero el XML y luego la edición: la versión 2 sale con el XML", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const e = await post(contador, c, id, "/editar", { versionBase: 1, cambios: { biDg: "21.50" } });
    expect(e.status, e.text).toBe(200);
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
    await exacto(c, id);
  });

  it("primero la edición y luego el XML: la versión 2 ya vigente se evalúa con el XML sin crear otra", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const e = await post(contador, c, id, "/editar", { versionBase: 1, cambios: { biDg: "21.50" } });
    expect(e.status, e.text).toBe(200);
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
    await exacto(c, id);
  });

  it("a la vez, en 5 rondas: ambas responden 200 y la versión final queda evaluada con el XML", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const { c, ids } = await escenario();
      const id = ids["F001-2056"]!;
      const [e, s] = await Promise.all([
        post(contador, c, id, "/editar", { versionBase: 1, cambios: { biDg: "21.50" } }),
        subir(contador, c, id, xmlDe("2056", c.ruc)),
      ]);
      expect(e.status, `ronda ${ronda}: ${e.text}`).toBe(200);
      expect(s.status, `ronda ${ronda}: ${s.texto}`).toBe(200);
      expect((await v.versiones(id)).map((x) => x.n), `ronda ${ronda}`).toEqual([1, 2]);
      await exacto(c, id);
    }
  });

  it("una sugerencia evaluada antes del XML que ya no sale: 409 revisar_de_nuevo y no escribe", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-1040"]!;
    expect((await subir(contador, c, id, xmlDe("1040", c.ruc))).status).toBe(200);
    // El contador pasa el ISC a su columna a mano: con la versión 2 y el XML, R-ISC deja de existir.
    const e = await post(contador, c, id, "/editar", { versionBase: 1, cambios: { biDg: "0.00", isc: "770.00" } });
    expect(e.status, e.text).toBe(200);
    const g = await detalle(contador, c, id);
    expect((g.body.hallazgos as any[]).map((h) => h.regla)).not.toContain("R-ISC");
    const antes = await v.foto(c.id);
    const r = await post(contador, c, id, "/sugerencias/aceptar", { versionBase: 2, regla: "R-ISC", confirmar: true });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

describe("CA-9 · compra PEN con un XML en USD: la masiva no ofrece las del XML (D-6)", () => {
  async function conXmlUsd() {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const enUsd = cambiar(cambiar(xmlDe("2056", c.ruc), 'currencyID="PEN"', 'currencyID="USD"'), ">PEN</cbc:DocumentCurrencyCode>", ">USD</cbc:DocumentCurrencyCode>");
    const r = await subir(contador, c, id, enUsd);
    expect(r.status, r.texto).toBe(200); // la moneda no es parte de la identidad (D-3)
    return { c, id };
  }

  it("la masiva de R-MIX la rechaza como no_masiva y no cambia la fila", async () => {
    const { c, id } = await conXmlUsd();
    const antes = await v.foto(c.id);
    const r = await masivaAceptar(contador, c, [id], "R-MIX");
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: id, codigo: "no_masiva" }] });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("aceptarla una a una sigue pidiendo el gravado: el XML en otra moneda no da el exacto", async () => {
    const { c, id } = await conXmlUsd();
    const r = await post(contador, c, id, "/sugerencias/aceptar", { versionBase: 1, regla: "R-MIX", confirmar: true });
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "requiere_dato", dato: "gravado" });
  });
});

describe("CA-15 · las acciones de 014 desde la lupa dan los mismos 409 y 422 con el XML presente", () => {
  it("versión obsoleta, periodo generado y permiso de lectura", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    expect((await subir(contador, c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    expect((await post(contador, c, id, "/editar", { versionBase: 1, cambios: { biDg: "21.50" } })).status).toBe(200);
    const vieja = await post(contador, c, id, "/clasificar", { versionBase: 1, destino: "DNG" });
    expect(vieja.status, vieja.text).toBe(409);
    expect(vieja.body).toEqual({ codigo: "version_obsoleta", versionVigente: 2 });
    const sin = await post(lectura, c, id, "/excluir", { versionBase: 2 });
    expect(sin.status).toBe(403);
    expect(sin.body).toEqual({ codigo: "permiso_denegado" });
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const gen = await post(contador, c, id, "/excluir", { versionBase: 2 });
    expect(gen.status, gen.text).toBe(409);
    expect(gen.body).toEqual({ codigo: "periodo_generado" });
  });
});

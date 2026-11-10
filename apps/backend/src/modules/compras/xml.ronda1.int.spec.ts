// Spec 016 · T19 · corrección de H-016-7 (ronda adversarial 1): `GET …/xml` no sirve una `ruta` que no pertenezca al estudio de la
// sesión y al cliente de la URL (D-8, D-11; CA-17).
// Contrato: la `ruta` de la fila debe empezar por `xml/{tenant de la sesión}/{cliente}/`. Si no, responde como XML no disponible
// (404 `no_encontrado`, igual que una compra sin XML), sin servir bytes y sin llevar la ruta al cuerpo ni a los logs.
// Nace en rojo (T20 corrige `xml.service.ts`). Complementa a `xml.adv.int.spec.ts` (B4), que no se toca.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, base, type Actor, type BancoCompras, type Estudio, type IdsPorNumero } from "../../../test/soporte-compras.js";
import { capturarLogs } from "../../../test/soporte.js";
import { bytes, cambiar, documentosXml, pedirXml, prepararStorage, xmlDe, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const CANARIO = "CANARIO-RONDA1-H7";

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
async function escenario(): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await v.cliente(E, { responsable: contador.id });
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  return { c, ids };
}
const rutaXml = (c: Cliente, id: string) => `${base(c.id)}/${id}/xml`;
const subir = (c: Cliente, id: string, xml: string) => pedirXml(v, contador, "POST", rutaXml(c, id), bytes(xml));
const bajar = (c: Cliente, id: string) => pedirXml(v, contador, "GET", rutaXml(c, id));

/** Sube el XML de F001-2056 del cliente y devuelve la fila `documento_xml` resultante. */
async function conXmlSubido(glosa: string): Promise<{ c: Cliente; id: string; docId: string; ruta: string }> {
  const { c, ids } = await escenario();
  const id = ids["F001-2056"]!;
  const xml = cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", glosa);
  expect((await subir(c, id, xml)).status).toBe(200);
  const [doc] = await documentosXml(v, c.id);
  return { c, id, docId: doc!.id, ruta: doc!.ruta };
}

/** Apunta la fila a `ruta` (conexión de migraciones: el CHECK de 0035 solo valida la gramática). */
const apuntarA = (docId: string, ruta: string) => v.b.sql("update documento_xml set ruta = $2 where id = $1", [docId, ruta]);

/** Un archivo con bytes reconocibles en `ruta` del storage de prueba (como el de otro estudio, que esta app no escribió). */
function escribirArchivo(ruta: string, contenido: string): void {
  const destino = join(st.dir, ruta);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
}

async function exigirNoDisponible(c: Cliente, id: string, rutaMala: string, canarios: readonly string[]): Promise<void> {
  const { resultado: r, logs } = await capturarLogs(() => bajar(c, id));
  expect(r.status, r.texto.slice(0, 120)).toBe(404);
  expect(r.json).toEqual({ codigo: "no_encontrado" });
  expect(r.headers["content-disposition"]).toBeUndefined();
  for (const canario of canarios) expect(r.texto).not.toContain(canario);
  expect(r.texto).not.toContain(rutaMala);
  expect(logs).not.toContain(rutaMala);
  expect(logs).not.toMatch(/xml\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//);
  for (const canario of canarios) expect(logs).not.toContain(canario);
}

describe("H-016-7 · GET xml solo sirve rutas del estudio de la sesión y del cliente de la URL", () => {
  it("guardia: con la ruta propia (xml/{tenant}/{cliente}/…) la descarga sigue dando 200 con los bytes subidos", async () => {
    const propio = await conXmlSubido(`${CANARIO}-PROPIO`);
    expect(propio.ruta.startsWith(`xml/${E.tenantId}/${propio.c.id}/`)).toBe(true);
    const r = await bajar(propio.c, propio.id);
    expect(r.status).toBe(200);
    expect(r.texto).toContain(`${CANARIO}-PROPIO`);
  });

  it("la ruta apunta al archivo de OTRO CLIENTE del mismo estudio: 404 no_encontrado, sin bytes ni ruta", async () => {
    const propio = await conXmlSubido(`${CANARIO}-PROPIO-A`);
    const ajeno = await conXmlSubido(`${CANARIO}-AJENO-CLIENTE`);
    await apuntarA(propio.docId, ajeno.ruta);
    await exigirNoDisponible(propio.c, propio.id, ajeno.ruta, [`${CANARIO}-AJENO-CLIENTE`]);
  });

  it("la ruta apunta a un archivo de OTRO ESTUDIO (existe en el storage): 404 no_encontrado, sin bytes ni ruta", async () => {
    const propio = await conXmlSubido(`${CANARIO}-PROPIO-B`);
    const otro = await v.estudio();
    const rutaOtroEstudio = `xml/${otro.tenantId}/${randomUUID()}/${randomUUID()}.xml`;
    escribirArchivo(rutaOtroEstudio, `<Invoice>${CANARIO}-OTRO-ESTUDIO</Invoice>`);
    await apuntarA(propio.docId, rutaOtroEstudio);
    await exigirNoDisponible(propio.c, propio.id, rutaOtroEstudio, [`${CANARIO}-OTRO-ESTUDIO`]);
  });

  it("el estudio de la ruta es el de la sesión pero el cliente es otro (existente o no): 404 también", async () => {
    const propio = await conXmlSubido(`${CANARIO}-PROPIO-C`);
    const rutaInventada = `xml/${E.tenantId}/${randomUUID()}/${randomUUID()}.xml`;
    escribirArchivo(rutaInventada, `<Invoice>${CANARIO}-CLIENTE-INVENTADO</Invoice>`);
    await apuntarA(propio.docId, rutaInventada);
    await exigirNoDisponible(propio.c, propio.id, rutaInventada, [`${CANARIO}-CLIENTE-INVENTADO`]);
  });

  it("el cliente de la ruta es el correcto pero el estudio es otro: 404 también", async () => {
    const propio = await conXmlSubido(`${CANARIO}-PROPIO-D`);
    const otro = await v.estudio();
    const rutaMezclada = `xml/${otro.tenantId}/${propio.c.id}/${randomUUID()}.xml`;
    escribirArchivo(rutaMezclada, `<Invoice>${CANARIO}-ESTUDIO-MEZCLADO</Invoice>`);
    await apuntarA(propio.docId, rutaMezclada);
    await exigirNoDisponible(propio.c, propio.id, rutaMezclada, [`${CANARIO}-ESTUDIO-MEZCLADO`]);
  });
});

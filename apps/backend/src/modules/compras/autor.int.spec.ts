/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 017 (T5, rojo): autor con nombre en las pantallas de compras (D-12, CA-13): el Historial de la compra (015), «revisado por» del
// periodo (014 D-13) y «XML subido por» de la lupa (016). PG real.
// Contrato (plan 017, «Contratos: shared»; lo implementa T11 con `resolverAutores`; las formas las fija T1/T6 en `autorSchema`):
//  - Junto a cada id de autor se AGREGA `autor` y el id se conserva (aditivo): `versiones[].usuarioId` -> `versiones[].autor`,
//    `estado.por` -> `estado.autor`, `xml.subidoPor` -> `xml.autor`. `autor` es exactamente `{ id, nombre, activo }`:
//      miembro activo del estudio    -> `{ id, nombre: "<su nombre>", activo: true }`
//      miembro desactivado           -> `{ id, nombre: "<su nombre>", activo: false }`  (la pantalla muestra «Nombre (inactivo)»)
//      id que NO es miembro del estudio -> `{ id, nombre: null, activo: false }`      (la pantalla muestra «Usuario desconocido»)
//    y nunca el correo, el rol ni, para un desconocido, el nombre real del usuario.
//  - Lo ve quien ya ve la fila (`clientes.ver` con el cliente en su alcance): no hay permiso nuevo.
//  - Un estado de periodo que nadie marcó sigue siendo `{ estado: "abierto", por: null, autor: null, en: null }`; un XML que no subió
//    una persona (origen simulado o real) sigue sin `subidoPor` y sin `autor`.
// Los ids se conservan: las pruebas de 014 a 016 que leen `usuarioId`, `por` y `subidoPor` siguen válidas.
// Rojo: las respuestas aún no traen `autor`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, base, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { quitarMembresiaSinRestricciones } from "../../../test/soporte-notificaciones.js";
import { bytes, documentosXml, forzarOrigen, pedirXml, prepararStorage, xmlDe, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let lectura: Actor;
const CLAVES_AUTOR = ["activo", "id", "nombre"];

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  await v.b.sql("update usuario set nombre = 'Carlos Contador' where id = $1", [contador.id]);
  await v.b.sql("update usuario set nombre = 'Dueña Principal' where id = $1", [E.titular.id]);
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
/** Miembro que no llama a la API (sin sesión): solo figura como autor en las filas. */
async function miembroAutor(nombre: string): Promise<{ id: string; correo: string }> {
  const a = await v.b.c.p.b.miembro(E.tenantId, "contador", { sesion: false });
  await v.b.sql("update usuario set nombre = $2 where id = $1", [a.id, nombre]);
  return { id: a.id, correo: a.correo };
}
const desactivar = (id: string) => v.b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, id]);
const cliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id] });
let serie = 900;
const compraDe = (c: Cliente, usuarioId: string, extra: Partial<Parameters<BancoCompras["sembrarCompra"]>[2]> = {}): Promise<string> => {
  serie += 1;
  return v.sembrarCompra(E.tenantId, c.id, { serie: `F${serie}`, numero: "1", doc: `207${String(serie).padStart(8, "0")}`, usuarioId, ...extra });
};
const historial = (a: Actor, c: Cliente, id: string) => v.llamar(a, "GET", `${base(c.id)}/${id}`);
const detalle = (a: Actor, c: Cliente, id: string) => v.llamar(a, "GET", `${base(c.id)}/${id}/detalle`);
const post = (a: Actor, c: Cliente, ruta: string, cuerpo?: unknown) => v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo ?? {});

describe("CA-13 · Historial de la compra (015): cada versión trae su autor", () => {
  it("activo: el autor trae el nombre; el usuarioId se conserva y el original es la versión 1 con su autor", async () => {
    const c = await cliente();
    const id = await compraDe(c, contador.id, { versiones: [{ accion: "editar", montos: { biDg: "90.00" } }, { accion: "excluir", excluida: true }] });
    const r = await historial(lectura, c, id); // lo ve quien ya ve la fila (clientes.ver)
    expect(r.status, r.text).toBe(200);
    expect(r.body.versiones).toHaveLength(3);
    for (const x of r.body.versiones) {
      expect(x.usuarioId).toBe(contador.id);
      expect(x.autor, `v${x.n}`).toEqual({ id: contador.id, nombre: "Carlos Contador", activo: true });
      expect(Object.keys(x.autor).sort()).toEqual(CLAVES_AUTOR);
    }
    expect(r.body.original.autor).toEqual(r.body.versiones[0].autor);
    expect(r.text).not.toContain(contador.correo); // el autor nunca trae el correo
  });

  it("una acción real deja su autor: el contador que excluye figura en la versión nueva", async () => {
    const c = await cliente();
    const id = await compraDe(c, E.titular.id);
    const ex = await post(contador, c, `/${id}/excluir`, { versionBase: 1 });
    expect(ex.status, ex.text).toBe(200);
    const r = await historial(E.titular, c, id);
    expect(r.status, r.text).toBe(200);
    const v2 = r.body.versiones.find((x: any) => x.n === 2);
    expect(v2).toMatchObject({ accion: "excluir", usuarioId: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
    expect(r.body.versiones[0].autor).toEqual({ id: E.titular.id, nombre: "Dueña Principal", activo: true });
  });

  it("miembro desactivado: conserva su nombre con activo=false (la pantalla muestra «(inactivo)»)", async () => {
    const c = await cliente();
    const inactivo = await miembroAutor("Luis Inactivo");
    const id = await compraDe(c, inactivo.id);
    await desactivar(inactivo.id);
    const r = await historial(contador, c, id);
    expect(r.status, r.text).toBe(200);
    for (const x of r.body.versiones) expect(x.autor).toEqual({ id: inactivo.id, nombre: "Luis Inactivo", activo: false });
  });

  it("id que ya no es miembro del estudio: nombre null y activo=false, sin filtrar el nombre real (la pantalla muestra «Usuario desconocido»)", async () => {
    const c = await cliente();
    const ajeno = await miembroAutor("Zoe Foranea Secreta");
    const id = await compraDe(c, ajeno.id);
    await quitarMembresiaSinRestricciones(E.tenantId, ajeno.id);
    const r = await historial(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.versiones[0].usuarioId).toBe(ajeno.id);
    expect(r.body.versiones[0].autor).toEqual({ id: ajeno.id, nombre: null, activo: false });
    expect(r.text).not.toContain("Zoe Foranea Secreta");
    expect(r.text).not.toContain(ajeno.correo);
  });
});

describe("CA-13 · «revisado por» del periodo de compras (014 D-13)", () => {
  it("revisar y reabrir devuelven { estado, por, autor, en } con el nombre de quien lo hizo", async () => {
    const c = await cliente();
    await compraDe(c, E.titular.id);
    const rev = await post(contador, c, "/estado/revisar");
    expect(rev.status, rev.text).toBe(200);
    expect(rev.body).toMatchObject({ estado: "revisado", por: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
    expect(Object.keys(rev.body.autor).sort()).toEqual(CLAVES_AUTOR);
    const reab = await post(E.titular, c, "/estado/reabrir", { estadoVisto: "revisado" });
    expect(reab.status, reab.text).toBe(200);
    expect(reab.body).toMatchObject({ estado: "abierto", por: E.titular.id, autor: { id: E.titular.id, nombre: "Dueña Principal", activo: true } });
  });
});

describe("CA-13 · «XML subido por» de la lupa (016)", () => {
  /** Cliente con el fixture de 009 y el XML de F001-2056 subido por el contador (el documento queda con su `subido_por`). */
  async function conXmlSubido(): Promise<{ c: Cliente; id: string; docId: string }> {
    const c = await cliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const id = ids["F001-2056"]!;
    const sub = await pedirXml(v, contador, "POST", `${base(c.id)}/${id}/xml`, bytes(xmlDe("2056", c.ruc)));
    expect(sub.status, sub.texto).toBe(200);
    const docs = await documentosXml(v, c.id);
    expect(docs).toHaveLength(1);
    return { c, id, docId: docs[0]!.id };
  }

  it("subido por un miembro activo: subidoPor se conserva y autor trae su nombre", async () => {
    const { c, id } = await conXmlSubido();
    const r = await detalle(lectura, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({
      estado: "disponible",
      origen: "subido",
      subidoPor: contador.id,
      autor: { id: contador.id, nombre: "Carlos Contador", activo: true },
    });
    expect(Object.keys(r.body.xml.autor).sort()).toEqual(CLAVES_AUTOR);
    expect(r.text).not.toContain(contador.correo);
  });

  it("subido por un miembro luego desactivado: nombre con activo=false", async () => {
    const { c, id, docId } = await conXmlSubido();
    const inactivo = await miembroAutor("Luis Inactivo");
    await v.b.sql("update documento_xml set subido_por = $2 where id = $1", [docId, inactivo.id]);
    await desactivar(inactivo.id);
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({ subidoPor: inactivo.id, autor: { id: inactivo.id, nombre: "Luis Inactivo", activo: false } });
  });

  it("subido por quien ya no es miembro: nombre null y el nombre real no sale", async () => {
    const { c, id, docId } = await conXmlSubido();
    const ajeno = await miembroAutor("Zoe Foranea Secreta");
    await v.b.sql("update documento_xml set subido_por = $2 where id = $1", [docId, ajeno.id]);
    await quitarMembresiaSinRestricciones(E.tenantId, ajeno.id);
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({ subidoPor: ajeno.id, autor: { id: ajeno.id, nombre: null, activo: false } });
    expect(r.text).not.toContain("Zoe Foranea Secreta");
  });

  it("un XML que no subió una persona (real) no trae subidoPor ni autor", async () => {
    const { c, id, docId } = await conXmlSubido();
    await forzarOrigen(v, docId, "real");
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({ estado: "disponible", origen: "real" });
    expect(r.body.xml).not.toHaveProperty("subidoPor");
    expect(r.body.xml).not.toHaveProperty("autor");
  });
});

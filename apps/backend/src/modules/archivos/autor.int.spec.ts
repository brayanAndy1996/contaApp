// Spec 017 (T5, rojo): autor con nombre en las pantallas de archivos y ventas (D-12, CA-13): «revisado por» del previo de
// ambos libros (012b), las versiones de archivo («generado por») y el estado del periodo de ventas. PG real.
// Contrato (plan 017, «Contratos: shared»; lo implementa T11 con `resolverAutores`; las formas las fija T1/T6 en `autorSchema`):
//  - Aditivo: el id se conserva y se agrega `autor` = exactamente `{ id, nombre, activo }`:
//      miembro activo -> su nombre y `activo: true`; miembro desactivado -> su nombre y `activo: false` («Nombre (inactivo)»);
//      id que NO es miembro del estudio -> `nombre: null` y `activo: false` («Usuario desconocido») sin filtrar el nombre real.
//    * `GET …/{compras|ventas}/archivos/previo` -> `estado.autor` (junto a `estado.por`); `null` si nadie marcó el periodo.
//    * `POST …/ventas/estado/revisar|reabrir` -> `{ estado, por, autor, en }` (igual que compras, 014 D-13).
//    * `GET …/{compras|ventas}/archivos` -> cada versión trae `autor` junto a `generadoPor` (siempre presente: quien genera es un usuario).
//  - Lo ve quien ya ve la fila (`clientes.ver`); nunca el correo ni el rol.
// Rojo: las respuestas aún no traen `autor`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, prepararStorage, rutaArchivos, rutaVentas, type Libro, type SoporteArchivos, type StoragePrueba } from "../../../test/soporte-archivos.js";
import { quitarMembresiaSinRestricciones } from "../../../test/soporte-notificaciones.js";
import { boletas290y292 } from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let contador: Actor;
let lectura: Actor;
const CLAVES_AUTOR = ["activo", "id", "nombre"];

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  await v.b.sql("update usuario set nombre = 'Carlos Contador' where id = $1", [contador.id]);
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
async function miembroAutor(nombre: string): Promise<{ id: string; correo: string }> {
  const a = await v.b.c.p.b.miembro(E.tenantId, "contador", { sesion: false });
  await v.b.sql("update usuario set nombre = $2 where id = $1", [a.id, nombre]);
  return { id: a.id, correo: a.correo };
}
const desactivar = (id: string) => v.b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, id]);
const cliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id] });
/** Cliente con compras (fixture de 009) y ventas (boletas 290 y 292), para pedir el previo de cualquier libro. */
async function conLibros(): Promise<Cliente> {
  const c = await cliente();
  await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: E.titular.id });
  return c;
}
const previo = (a: Actor, c: Cliente, libro: Libro) => v.llamar(a, "GET", `${rutaArchivos(c.id, PERIODO, libro)}/previo`);
const versiones = (a: Actor, c: Cliente, libro: Libro) => v.llamar(a, "GET", rutaArchivos(c.id, PERIODO, libro));
const marcar = (libro: Libro, c: Cliente, usuarioId: string | null) =>
  libro === "compras" ? v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", usuarioId) : A.estadoVentas(E.tenantId, c.id, PERIODO, "revisado", usuarioId);

describe.each(["compras", "ventas"] as const)("CA-13 · «revisado por» del previo de %s (012b)", (libro) => {
  it("sin marca: estado abierto con por, autor y en en null", async () => {
    const c = await conLibros();
    const r = await previo(contador, c, libro);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toEqual({ estado: "abierto", por: null, autor: null, en: null });
  });

  it("revisado por un miembro activo: por se conserva y autor trae su nombre (lo ve quien ya ve la fila)", async () => {
    const c = await conLibros();
    await marcar(libro, c, contador.id);
    const r = await previo(lectura, c, libro);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toMatchObject({ estado: "revisado", por: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
    expect(Object.keys(r.body.estado.autor).sort()).toEqual(CLAVES_AUTOR);
    expect(r.text).not.toContain(contador.correo);
  });

  it("revisado por un miembro luego desactivado: su nombre con activo=false", async () => {
    const c = await conLibros();
    const inactivo = await miembroAutor("Luis Inactivo");
    await marcar(libro, c, inactivo.id);
    await desactivar(inactivo.id);
    const r = await previo(contador, c, libro);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toMatchObject({ por: inactivo.id, autor: { id: inactivo.id, nombre: "Luis Inactivo", activo: false } });
  });

  it("revisado por quien ya no es miembro: nombre null y el nombre real no sale", async () => {
    const c = await conLibros();
    const ajeno = await miembroAutor("Zoe Foranea Secreta");
    await marcar(libro, c, ajeno.id);
    await quitarMembresiaSinRestricciones(E.tenantId, ajeno.id);
    const r = await previo(contador, c, libro);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado).toMatchObject({ por: ajeno.id, autor: { id: ajeno.id, nombre: null, activo: false } });
    expect(r.text).not.toContain("Zoe Foranea Secreta");
    expect(r.text).not.toContain(ajeno.correo);
  });
});

describe("CA-13 · estado del periodo de ventas (revisar y reabrir)", () => {
  it("devuelve { estado, por, autor, en } con el nombre de quien lo hizo, igual que compras", async () => {
    const c = await conLibros();
    const rev = await v.llamar(contador, "POST", `${rutaVentas(c.id)}/estado/revisar`, {});
    expect(rev.status, rev.text).toBe(200);
    expect(rev.body).toMatchObject({ estado: "revisado", por: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
    expect(Object.keys(rev.body.autor).sort()).toEqual(CLAVES_AUTOR);
    const reab = await v.llamar(contador, "POST", `${rutaVentas(c.id)}/estado/reabrir`, { estadoVisto: "revisado" });
    expect(reab.status, reab.text).toBe(200);
    expect(reab.body).toMatchObject({ estado: "abierto", por: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
  });
});

describe.each(["compras", "ventas"] as const)("CA-13 · versiones de archivo de %s: «generado por»", (libro) => {
  it("cada versión conserva generadoPor y trae autor: activo, desactivado y quien ya no es miembro (nombre null)", async () => {
    const c = await cliente();
    const inactivo = await miembroAutor("Luis Inactivo");
    const ajeno = await miembroAutor("Zoe Foranea Secreta");
    const base = { tenantId: E.tenantId, clienteId: c.id, libro };
    await A.sembrarVersion({ ...base, usuarioId: contador.id }, st);
    await A.sembrarVersion({ ...base, usuarioId: inactivo.id }, st);
    await A.sembrarVersion({ ...base, usuarioId: ajeno.id }, st);
    await desactivar(inactivo.id);
    await quitarMembresiaSinRestricciones(E.tenantId, ajeno.id);
    const r = await versiones(lectura, c, libro);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toHaveLength(3);
    const [v3, v2, v1] = r.body; // la mayor versión primero
    expect(v1).toMatchObject({ version: 1, generadoPor: contador.id, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } });
    expect(v2).toMatchObject({ version: 2, generadoPor: inactivo.id, autor: { id: inactivo.id, nombre: "Luis Inactivo", activo: false } });
    expect(v3).toMatchObject({ version: 3, generadoPor: ajeno.id, autor: { id: ajeno.id, nombre: null, activo: false } });
    for (const x of r.body) expect(Object.keys(x.autor).sort()).toEqual(CLAVES_AUTOR);
    expect(r.text).not.toContain("Zoe Foranea Secreta");
    for (const correo of [contador.correo, inactivo.correo, ajeno.correo]) expect(r.text).not.toContain(correo);
  });
});

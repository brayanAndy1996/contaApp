/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b (T6, rojo): GET /clientes/:clienteId/periodos/:periodo/{compras|ventas}/archivos (versiones; D3, D5, D9, P-4;
// CA-2, CA-5, CA-6, CA-9). Contrato (plan 012b, «Contratos: HTTP»; `versionArchivoSchema` de shared):
//  - 200 `VersionArchivoDto[]` de ESE cliente, periodo y libro, con la mayor versión primero. Cada elemento lleva exactamente
//    { id, version, generadoEn, generadoPor, formato{id,version}, provisional, nombreZip, sha256Txt, sha256Zip, bytesZip, lineas,
//    resumen, avisos } y NUNCA la ruta del storage, la huella, el trabajo ni el estudio.
//  - `resumen` sale de las columnas de la versión: { modificadas, excluidas, agregadas, impactoIgv{DG,DGNG,DNG,total}, filasSinConvertir }.
//    Ventas guarda DG/DGNG/DNG en null. `filasSinConvertir` no se guarda por versión: viaja como lista vacía. Montos solo cadenas.
//  - `avisos` = conteos por código ({ "R-ISC": 1 }), tal como se guardan.
//  - Permiso `clientes.ver` con el cliente asignado (P-4: asistente y lectura asignados la ven); también con el cliente archivado.
//    No asignado, inexistente u otro estudio: el mismo 404 `{ codigo: "no_encontrado" }`. Sin sesión 401. `Cache-Control: no-store`.
//  - Solo lectura. La numeración de versiones es independiente por cliente, periodo y libro.
// Rojo: el módulo `archivos` aún no existe (T12): toda ruta responde 404 de ruta inexistente (y la siembra de `archivo_generado`
// falla mientras la tabla no exista, T10).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import {
  abrirArchivos,
  cumple,
  HEX64,
  prepararStorage,
  rutaArchivos,
  type Libro,
  type SoporteArchivos,
  type StoragePrueba,
  type VersionSembrada,
} from "../../../test/soporte-archivos.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
const sembrar = (c: Cliente, libro: Libro, o: Partial<Parameters<SoporteArchivos["sembrarVersion"]>[0]> = {}): Promise<VersionSembrada> =>
  A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro, ...o }, st);
const listar = (a: Actor, c: { id: string }, libro: Libro = "compras", periodo = PERIODO) =>
  v.llamar(a, "GET", rutaArchivos(c.id, periodo, libro));

const listarOk = async (...args: Parameters<typeof listar>) => {
  const r = await listar(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};

const CLAVES_DTO = [
  "avisos",
  "bytesZip",
  "formato",
  "generadoEn",
  "generadoPor",
  "id",
  "lineas",
  "nombreZip",
  "provisional",
  "resumen",
  "sha256Txt",
  "sha256Zip",
  "version",
];

describe("CA-2 / CA-5 / CA-6 · la lista de versiones de compras", () => {
  it("200, mayor versión primero, con la forma de versionArchivoSchema y exactamente las claves del DTO", async () => {
    const c = await nuevoCliente();
    const v1 = await sembrar(c, "compras", { lineas: 4, modificadas: 2, impactoTotal: "0.00" });
    const v2 = await sembrar(c, "compras", { lineas: 3, modificadas: 2, excluidas: 1, impactoTotal: "-18.00" });
    const r = await listarOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((x: any) => x.version)).toEqual([2, 1]);
    expect(r.body.map((x: any) => x.id)).toEqual([v2.id, v1.id]);
    for (const x of r.body) {
      expect(Object.keys(x).sort()).toEqual(CLAVES_DTO);
      expect(cumple("versionArchivoSchema", x), JSON.stringify(x)).toBe(true);
    }
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("cada versión guarda lo mismo que se sembró: usuario, fecha, formato, provisional, nombre, hashes, bytes y líneas", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras", { lineas: 4 });
    const [x] = (await listarOk(contador, c)).body;
    expect(x).toMatchObject({
      id: s.id,
      version: 1,
      generadoPor: contador.id,
      provisional: true,
      nombreZip: s.nombreZip,
      sha256Txt: s.sha256Txt,
      sha256Zip: s.sha256Zip,
      bytesZip: s.zip.length,
      lineas: 4,
    });
    expect(x.sha256Zip).toMatch(HEX64);
    expect(x.sha256Txt).toMatch(HEX64);
    expect(Number.isNaN(Date.parse(x.generadoEn))).toBe(false);
    expect(typeof x.formato.id).toBe("string");
    expect(typeof x.formato.version).toBe("string");
    expect(Object.keys(x.formato).sort()).toEqual(["id", "version"]);
  });

  it("el resumen y los avisos de la versión son los guardados (CA-5): conteos, impacto en IGV por destino y total", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras", { modificadas: 2, excluidas: 1, agregadas: 3, impactoTotal: "-18.00", avisos: { "R-ISC": 1, RAZON_SOCIAL_RECORTADA: 2 } });
    const [x] = (await listarOk(contador, c)).body;
    expect(x.resumen).toEqual({
      modificadas: 2,
      excluidas: 1,
      agregadas: 3,
      impactoIgv: { DG: "-18.00", DGNG: "0.00", DNG: "0.00", total: "-18.00" },
      filasSinConvertir: [],
    });
    expect(x.avisos).toEqual({ "R-ISC": 1, RAZON_SOCIAL_RECORTADA: 2 });
  });

  it("los montos viajan como cadenas, nunca como número", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras", { impactoTotal: "1234567.89" });
    const r = await listarOk(contador, c);
    expect(r.text).toContain('"total":"1234567.89"');
    expect(r.text).not.toMatch(/"(DG|DGNG|DNG|total)":-?\d/);
  });

  it("no lleva la ruta del storage, la huella, el trabajo ni el estudio", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const texto = (await listarOk(contador, c)).text;
    for (const prohibido of [s.ruta, "archivos/", E.tenantId, c.id, s.huella, s.trabajoId, "ruta", "huella", "trabajoId", "tenantId"]) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
  });

  it("un cliente sin versiones: lista vacía", async () => {
    const c = await nuevoCliente();
    const r = await listarOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("listar no escribe nada", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras");
    const antes = await A.versionesBd(c.id);
    for (let i = 0; i < 3; i++) await listarOk(contador, c);
    expect(await A.versionesBd(c.id)).toEqual(antes);
    expect(await A.trabajosArchivo(c.id)).toHaveLength(1); // solo el de la siembra
  });
});

describe("CA-7 / CA-10 · libros, periodos y clientes no se mezclan; la numeración es independiente", () => {
  it("compras y ventas del mismo cliente y periodo tienen su propia lista, cada una desde la versión 1", async () => {
    const c = await nuevoCliente();
    const compra = await sembrar(c, "compras");
    const venta = await sembrar(c, "ventas", { modificadas: 0, impactoTotal: "-18.00" });
    expect([compra.version, venta.version]).toEqual([1, 1]);
    const lc = (await listarOk(contador, c, "compras")).body;
    const lv = (await listarOk(contador, c, "ventas")).body;
    expect(lc.map((x: any) => x.id)).toEqual([compra.id]);
    expect(lv.map((x: any) => x.id)).toEqual([venta.id]);
  });

  it("ventas guarda el impacto por destino en null y solo el total", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "ventas", { modificadas: 0, excluidas: 2, impactoTotal: "-18.00", avisos: { SALTO_CORRELATIVIDAD: 1 } });
    const [x] = (await listarOk(contador, c, "ventas")).body;
    expect(cumple("versionArchivoSchema", x), JSON.stringify(x)).toBe(true);
    expect(x.resumen).toMatchObject({ modificadas: 0, excluidas: 2, agregadas: 0 });
    expect(x.resumen.impactoIgv).toEqual({ DG: null, DGNG: null, DNG: null, total: "-18.00" });
    expect(x.avisos).toEqual({ SALTO_CORRELATIVIDAD: 1 });
  });

  it("otro periodo del mismo cliente tiene su propia numeración y su propia lista", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras", { periodo: "202610" });
    const otro = await sembrar(c, "compras", { periodo: "202609" });
    expect(otro.version).toBe(1);
    expect((await listarOk(contador, c, "compras", "202609")).body.map((x: any) => x.id)).toEqual([otro.id]);
    expect((await listarOk(contador, c, "compras", "202610")).body).toHaveLength(1);
    expect((await listarOk(contador, c, "compras", "202608")).body).toEqual([]);
  });

  it("otro cliente del mismo estudio tiene su propia lista", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    const va = await sembrar(a, "compras");
    const vb = await sembrar(b, "compras");
    expect([va.version, vb.version]).toEqual([1, 1]);
    expect((await listarOk(contador, a)).body.map((x: any) => x.id)).toEqual([va.id]);
    expect((await listarOk(contador, b)).body.map((x: any) => x.id)).toEqual([vb.id]);
  });
});

describe("CA-9 / P-4 · permisos y alcance de la lista", () => {
  it.each(["compras", "ventas"] as const)("%s: Dueño, contador, asistente y lectura asignados ven la misma lista (P-4)", async (libro) => {
    const c = await nuevoCliente();
    const s = await sembrar(c, libro);
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await listar(a, c, libro);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(200);
      expect(r.body.map((x: any) => x.id)).toEqual([s.id]);
    }
  });

  it("el cliente archivado se puede consultar", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras");
    await v.b.sql("update cliente set archivado_at = now() where id = $1", [c.id]);
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it("el asistente no asignado recibe el mismo 404 que un cliente inexistente, sin datos de las versiones", async () => {
    const c = await nuevoCliente({ colaboradores: [] });
    await sembrar(c, "compras");
    expect((await listar(contador, c)).status).toBe(200); // control
    const r = await listar(asistenteAjeno, c);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await listar(asistenteAjeno, { id: randomUUID() })));
  });

  it("otro estudio: las versiones de E son un 404 para el Dueño de F", async () => {
    const c = await nuevoCliente();
    await sembrar(c, "compras");
    const r = await listar(F.titular, c);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });

  it("sin sesión: 401", async () => {
    const c = await nuevoCliente();
    expect((await listar(contador, c)).status).toBe(200); // control: la ruta existe
    const r = await v.sinSesion("GET", rutaArchivos(c.id, PERIODO, "compras"));
    expect(r.status, r.text).toBe(401);
  });

  it.each(["2026-10", "202613", "abcdef", "209912"])("periodo «%s»: 400 solicitud_invalida", async (periodo) => {
    const c = await nuevoCliente();
    expect((await listar(contador, c)).status).toBe(200); // control: la ruta existe con un periodo válido
    const r = await listar(contador, c, "compras", periodo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("cliente inexistente: 404 no_encontrado", async () => {
    expect((await listar(contador, await nuevoCliente())).status).toBe(200); // control: la ruta existe
    const r = await listar(contador, { id: randomUUID() });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });
});

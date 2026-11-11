// Spec 012b (T6, rojo): GET /clientes/:clienteId/periodos/:periodo/{compras|ventas}/archivos/:archivoId/zip (D8, D9, P-4;
// CA-6, CA-9, CA-12). Contrato (plan 012b, «Contratos: HTTP»):
//  - 200 con los bytes del ZIP guardado (SHA-256 = `sha256_zip`), `Content-Type: application/zip`,
//    `Content-Disposition: attachment; filename="{nombreZip}"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
//    La ruta del storage sale de la FILA, nunca de la petición. Permiso `clientes.ver` con el cliente asignado (P-4); un cliente
//    archivado también se descarga. Cada versión se descarga con su propio hash (CA-6).
//  - Antes de servir, el backend recalcula el SHA-256: si el ZIP en storage fue alterado, truncado o ampliado, responde 500
//    `{ codigo: "archivo_alterado" }` SIN bytes, ruta ni hashes (en la respuesta ni en los logs).
//  - Un `archivoId` de otro estudio, cliente, periodo o libro, inexistente o mal formado: el mismo 404 `no_encontrado` sin bytes.
//  - Solo lectura: no escribe filas ni toca el storage. Sin sesión 401.
// Rojo: el módulo `archivos` aún no existe (T12): toda ruta responde 404 de ruta inexistente (y la siembra de `archivo_generado`
// falla mientras la tabla no exista, T10).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import {
  abrirArchivos,
  archivosBajo,
  prepararStorage,
  rutaArchivos,
  sha256,
  type Libro,
  type SoporteArchivos,
  type StoragePrueba,
  type VersionSembrada,
} from "../../../test/soporte-archivos.js";
import { capturarLogs } from "../../../test/soporte.js";

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
const descargar = (a: Actor, c: { id: string }, libro: Libro, id: string, periodo = PERIODO, consulta = "") =>
  v.bin(a, "GET", `${rutaArchivos(c.id, periodo, libro)}/${id}/zip${consulta}`);
const enDisco = (s: VersionSembrada): string => join(st.dir, s.ruta);
const ZIP_PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe("D8 · la descarga entrega el ZIP guardado con sus cabeceras", () => {
  it.each(["compras", "ventas"] as const)("%s: 200 con los bytes exactos, SHA-256 = sha256_zip y las cabeceras de D8", async (libro) => {
    const c = await nuevoCliente();
    const s = await sembrar(c, libro);
    const r = await descargar(contador, c, libro, s.id);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(Buffer.compare(r.bytes, s.zip)).toBe(0);
    expect(sha256(r.bytes)).toBe(s.sha256Zip);
    expect(String(r.headers["content-type"])).toMatch(/^application\/zip/);
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="${s.nombreZip}"`);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect((await A.versionesBd(c.id, libro))[0].sha256_zip).toBe(sha256(r.bytes));
  });

  it("CA-6: la versión 1 y la 2 se descargan cada una con sus bytes y su hash", async () => {
    const c = await nuevoCliente();
    const v1 = await sembrar(c, "compras");
    const v2 = await sembrar(c, "compras");
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const r1 = await descargar(contador, c, "compras", v1.id);
    const r2 = await descargar(contador, c, "compras", v2.id);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(sha256(r1.bytes)).toBe(v1.sha256Zip);
    expect(sha256(r2.bytes)).toBe(v2.sha256Zip);
    expect(v1.sha256Zip).not.toBe(v2.sha256Zip);
    expect(r1.headers["content-disposition"]).toContain(v1.nombreZip);
  });

  it("el nombre del ZIP en Content-Disposition sale de la fila y es de la gramática de generarTxt", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "ventas");
    const r = await descargar(contador, c, "ventas", s.id);
    const cd = String(r.headers["content-disposition"]);
    expect(cd).toMatch(/^attachment; filename="CONTAPP-PROVISIONAL-[0-9]{11}-[0-9]{6}-[A-Z]+\.zip"$/);
    expect(cd).not.toMatch(/[/\\]|\.\./);
  });

  it("descargar es de solo lectura: no escribe filas ni toca el storage", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const antes = { filas: await A.versionesBd(c.id), archivos: archivosBajo(st.dir, `archivos/${E.tenantId}/${c.id}/`), disco: readFileSync(enDisco(s)) };
    for (let i = 0; i < 3; i++) expect((await descargar(contador, c, "compras", s.id)).status).toBe(200);
    expect(await A.versionesBd(c.id)).toEqual(antes.filas);
    expect(archivosBajo(st.dir, `archivos/${E.tenantId}/${c.id}/`)).toEqual(antes.archivos);
    expect(Buffer.compare(readFileSync(enDisco(s)), antes.disco)).toBe(0);
  });

  it("la ruta sale de la fila, nunca de la petición: una consulta ?ruta=… se ignora", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const r = await descargar(contador, c, "compras", s.id, PERIODO, "?ruta=../../../etc/passwd&archivo=../x.zip");
    expect(r.status, r.texto.slice(0, 100)).toBe(200);
    expect(sha256(r.bytes)).toBe(s.sha256Zip);
  });
});

describe("CA-12 · un ZIP alterado en storage es 500 archivo_alterado sin bytes", () => {
  const alteraciones: [string, (original: Buffer) => Buffer][] = [
    ["un byte cambiado", (b) => Buffer.concat([b.subarray(0, 100), Buffer.from([b[100]! ^ 0xff]), b.subarray(101)])],
    ["truncado", (b) => b.subarray(0, b.length - 10)],
    ["con bytes añadidos", (b) => Buffer.concat([b, Buffer.from("extra")])],
    ["vacío", () => Buffer.alloc(0)],
    ["reemplazado por otro ZIP", () => Buffer.concat([ZIP_PK, Buffer.from("otro contenido")])],
  ];

  it.each(alteraciones)("%s: 500 { codigo: archivo_alterado }, sin los bytes ni la ruta ni los hashes", async (_nombre, alterar) => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    writeFileSync(enDisco(s), alterar(s.zip));
    const { resultado: r, logs } = await capturarLogs(() => descargar(contador, c, "compras", s.id));
    expect(r.status, r.texto.slice(0, 200)).toBe(500);
    expect(r.json).toEqual({ codigo: "archivo_alterado" });
    expect(r.bytes.length).toBeLessThan(200);
    expect(r.bytes.includes(ZIP_PK)).toBe(false);
    expect(String(r.headers["content-type"])).not.toMatch(/zip/);
    expect(r.headers["content-disposition"]).toBeUndefined();
    for (const prohibido of [s.ruta, s.sha256Zip, s.sha256Txt, `archivos/${E.tenantId}`, E.tenantId]) {
      expect(r.texto, prohibido).not.toContain(prohibido);
      expect(logs, prohibido).not.toContain(prohibido);
    }
  });

  it("alterar una versión no afecta a las demás, y restaurar los bytes originales la vuelve a servir", async () => {
    const c = await nuevoCliente();
    const v1 = await sembrar(c, "compras");
    const v2 = await sembrar(c, "compras");
    writeFileSync(enDisco(v1), Buffer.concat([v1.zip, Buffer.from("x")]));
    expect((await descargar(contador, c, "compras", v1.id)).status).toBe(500);
    expect((await descargar(contador, c, "compras", v2.id)).status).toBe(200);
    writeFileSync(enDisco(v1), v1.zip);
    const otra = await descargar(contador, c, "compras", v1.id);
    expect(otra.status).toBe(200);
    expect(sha256(otra.bytes)).toBe(v1.sha256Zip);
  });

  it("un ZIP alterado también falla para quien solo puede ver (lectura asignada): nadie recibe bytes sin verificar", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "ventas");
    writeFileSync(enDisco(s), Buffer.concat([s.zip, Buffer.from("x")]));
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await descargar(a, c, "ventas", s.id);
      expect(r.status, a.rol).toBe(500);
      expect(r.json).toEqual({ codigo: "archivo_alterado" });
    }
  });
});

describe("CA-9 / P-4 · permisos y aislamiento de la descarga", () => {
  it("Dueño, contador, asistente y lectura asignados descargan (P-4); un cliente archivado también", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    await v.b.sql("update cliente set archivado_at = now() where id = $1", [c.id]);
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await descargar(a, c, "compras", s.id);
      expect(r.status, `${a.rol}: ${r.texto.slice(0, 100)}`).toBe(200);
      expect(sha256(r.bytes)).toBe(s.sha256Zip);
    }
  });

  it("el asistente no asignado recibe el mismo 404 que un id inexistente, sin bytes", async () => {
    const c = await nuevoCliente({ colaboradores: [] });
    const s = await sembrar(c, "compras");
    expect((await descargar(contador, c, "compras", s.id)).status).toBe(200); // control
    const r = await descargar(asistenteAjeno, c, "compras", s.id);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect(r.bytes.includes(ZIP_PK)).toBe(false);
    const inexistente = await descargar(asistenteAjeno, { id: randomUUID() }, "compras", randomUUID());
    expect({ status: r.status, json: r.json }).toEqual({ status: inexistente.status, json: inexistente.json });
  });

  it("otro estudio: el archivoId de E es un 404 para el Dueño de F y no entrega bytes", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const r = await descargar(F.titular, c, "compras", s.id);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect(r.bytes.includes(ZIP_PK)).toBe(false);
  });

  it("otro estudio con un cliente propio: el archivoId de E bajo un cliente de F es 404", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const propio = await v.cliente(F);
    const r = await descargar(F.titular, propio, "compras", s.id);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect(r.bytes.includes(ZIP_PK)).toBe(false);
  });

  it("otro cliente del mismo estudio: el archivoId de A bajo la ruta de B es 404 (también para el Dueño)", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    const s = await sembrar(a, "compras");
    expect((await descargar(E.titular, a, "compras", s.id)).status).toBe(200); // control
    for (const actor of [E.titular, contador]) {
      const r = await descargar(actor, b, "compras", s.id);
      expect(r.status, actor.rol).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.bytes.includes(ZIP_PK)).toBe(false);
    }
  });

  it("otro periodo: el archivoId de 202610 bajo 202609 es 404", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras", { periodo: "202610" });
    const r = await descargar(contador, c, "compras", s.id, "202609");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
  });

  it("otro libro: el archivoId de compras bajo ventas (y al revés) es 404", async () => {
    const c = await nuevoCliente();
    const compra = await sembrar(c, "compras");
    const venta = await sembrar(c, "ventas");
    for (const [libro, id] of [
      ["ventas", compra.id],
      ["compras", venta.id],
    ] as const) {
      const r = await descargar(contador, c, libro, id);
      expect(r.status, `${libro}/${id}`).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.bytes.includes(ZIP_PK)).toBe(false);
    }
    expect((await descargar(contador, c, "compras", compra.id)).status).toBe(200); // control
    expect((await descargar(contador, c, "ventas", venta.id)).status).toBe(200);
  });

  it.each([randomUUID(), "abc", "..", "%2e%2e", "..%2f..%2fxml", "00000000-0000-0000-0000-000000000000", "' or 1=1 --"])(
    "archivoId «%s»: 404 no_encontrado, sin bytes",
    async (id) => {
      const c = await nuevoCliente();
      await sembrar(c, "compras");
      const r = await descargar(contador, c, "compras", id);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.bytes.includes(ZIP_PK)).toBe(false);
    },
  );

  it("sin sesión: 401 y sin bytes", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const r = await v.sinSesion("GET", `${rutaArchivos(c.id, PERIODO, "compras")}/${s.id}/zip`);
    expect(r.status, r.text).toBe(401);
    expect(String(r.text)).not.toContain("PK");
  });

  it("periodo mal formado: 400 solicitud_invalida", async () => {
    const c = await nuevoCliente();
    const s = await sembrar(c, "compras");
    const r = await descargar(contador, c, "compras", s.id, "202613");
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ codigo: "solicitud_invalida" });
  });
});

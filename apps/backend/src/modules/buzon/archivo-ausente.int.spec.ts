// Spec 023 · T15 (cobertura): qué pasa con el detalle y la descarga cuando el archivo de storage falta,
// fue alterado o no se puede leer. Falta -> 404 como si no existiera; alterado o ilegible -> 500 sin bytes.
import { randomBytes } from "node:crypto";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let b: BancoBuzon;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  contador = await b.v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await b?.cerrar();
});

const conMensaje = async (texto?: string) => {
  const c = await b.cliente(E, { responsable: contador.id });
  const m = await b.sembrarMensaje(E.tenantId, c.id, {
    contenido: texto,
    declarados: 1,
  });
  return { c, m };
};
const detalle = (c: string, m: string) =>
  b.llamar(contador, "GET", `/clientes/${c}/buzon/mensajes/${m}`);
const bajar = (c: string, m: string, a: string) =>
  b.bin(contador, "GET", `/clientes/${c}/buzon/mensajes/${m}/adjuntos/${a}`);
const enDisco = (ruta: string): string => join(b.storage.dir, ruta);
const auditorias = async (accion: string): Promise<number> =>
  (await b.auditoria(E.tenantId, accion)).length;

describe("descarga con el archivo en mal estado", () => {
  it("archivo borrado de storage: 404 no_encontrado y sin auditoría de descarga", async () => {
    const { c, m } = await conMensaje("Ver adjunto.");
    const adj = await b.sembrarAdjunto(E.tenantId, c.id, m.id);
    const antes = await auditorias("buzon.adjunto_descargado");
    rmSync(enDisco(adj.ruta as string));
    const r = await bajar(c.id, m.id, adj.id);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect(await auditorias("buzon.adjunto_descargado")).toBe(antes);
  });

  it("archivo alterado (otro SHA-256): 500, no entrega ni un byte y no audita la descarga", async () => {
    const { c, m } = await conMensaje("Ver adjunto.");
    const adj = await b.sembrarAdjunto(E.tenantId, c.id, m.id);
    const antes = await auditorias("buzon.adjunto_descargado");
    const intruso = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      randomBytes(128),
    ]);
    writeFileSync(enDisco(adj.ruta as string), intruso);
    const r = await bajar(c.id, m.id, adj.id);
    expect(r.status).toBe(500);
    expect(Buffer.compare(r.bytes, intruso)).not.toBe(0);
    expect(r.texto).not.toContain(adj.ruta as string);
    expect(await auditorias("buzon.adjunto_descargado")).toBe(antes);
  });

  it("archivo sustituido por un enlace simbólico que sale de la raíz: 500 sin contenido ajeno", async () => {
    const { c, m } = await conMensaje("Ver adjunto.");
    const adj = await b.sembrarAdjunto(E.tenantId, c.id, m.id);
    const destino = enDisco(adj.ruta as string);
    rmSync(destino);
    symlinkSync("/etc/hostname", destino);
    const r = await bajar(c.id, m.id, adj.id);
    expect(r.status).toBe(500);
    expect(r.texto).not.toContain(adj.ruta as string);
  });
});

describe("detalle con el texto plano en mal estado", () => {
  it("texto borrado de storage: 404 no_encontrado y sin auditoría de contenido_visto", async () => {
    const { c, m } = await conMensaje("Texto que se perdió.");
    const antes = await auditorias("buzon.contenido_visto");
    rmSync(enDisco(m.contenidoRuta as string));
    const r = await detalle(c.id, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await auditorias("buzon.contenido_visto")).toBe(antes);
  });

  it("texto sustituido por un enlace simbólico que sale de la raíz: 500 sin filtrar el archivo ajeno", async () => {
    const { c, m } = await conMensaje("Texto original.");
    const destino = enDisco(m.contenidoRuta as string);
    rmSync(destino);
    symlinkSync("/etc/hostname", destino);
    const antes = await auditorias("buzon.contenido_visto");
    const r = await detalle(c.id, m.id);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain(m.contenidoRuta as string);
    expect(await auditorias("buzon.contenido_visto")).toBe(antes);
  });
});

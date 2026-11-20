import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredencialSol } from "../puertos.js";
import { MockSolPortal, type FixtureBuzonSol } from "./sol-portal.mock.js";

// Spec 023 (D-2, CA-3, CA-8; fixtures/LEEME.md). El fixture del repo `fixtures/sol/buzon/{ruc}.json` del contribuyente
// de prueba (rucs-prueba.json) tiene la forma `FixtureBuzonSol` y cubre: una coactiva, una RD, una RM, un
// requerimiento y comunes, con variantes de asunto (tildes, mayúsculas, abreviaturas) y adjuntos PDF, XML y uno hostil.
const RAIZ = resolve(__dirname, "../../../..");
const RUC = "20700000002";
const RUTA = resolve(RAIZ, "fixtures/sol/buzon", `${RUC}.json`);
const cred: CredencialSol = {
  ruc: RUC,
  usuarioSol: "CANARIO-USUARIO-sol",
  claveSol: "CANARIO-SOL-clave",
};
const TOPES = { maxBytesAdjunto: 20 * 1024 * 1024, maxBytesMensaje: 50 * 1024 * 1024 };
const sinTildes = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function fixture(): FixtureBuzonSol {
  return JSON.parse(readFileSync(RUTA, "utf8")) as FixtureBuzonSol;
}

describe("fixtures/sol/buzon del contribuyente de prueba", () => {
  it("existe, es JSON y pesa menos de 1 MiB", () => {
    expect(existsSync(RUTA)).toBe(true);
    expect(readFileSync(RUTA).byteLength).toBeLessThan(1_048_576);
    expect(Array.isArray(fixture().mensajes)).toBe(true);
  });

  it("cada mensaje tiene los campos del contrato y los ids no se repiten", () => {
    const { mensajes } = fixture();
    expect(mensajes.length).toBeGreaterThanOrEqual(8);
    const ids = mensajes.map((m) => m.idSunat);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of mensajes) {
      expect(typeof m.idSunat).toBe("string");
      expect(m.idSunat.length).toBeGreaterThan(0);
      expect(m.idSunat.length).toBeLessThanOrEqual(64);
      expect(typeof m.asunto).toBe("string");
      expect(typeof m.remitente).toBe("string");
      expect(Number.isNaN(Date.parse(m.fecha))).toBe(false);
      expect(m.fecha).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
      expect(m.codigoTipo === null || typeof m.codigoTipo === "string").toBe(true);
      expect(typeof m.leidoEnSunat).toBe("boolean");
      expect(["texto", "html"]).toContain(m.contenido.formato);
      for (const a of m.adjuntos) {
        expect(typeof a.idSunat).toBe("string");
        expect(typeof a.nombre).toBe("string");
        expect(typeof a.base64 === "string" || typeof a.tamano === "number").toBe(true);
      }
    }
  });

  it("trae una coactiva, una RD, una RM, un requerimiento y comunes", () => {
    const asuntos = fixture().mensajes.map((m) => sinTildes(m.asunto));
    expect(asuntos.filter((a) => /coactiv/.test(a)).length).toBeGreaterThanOrEqual(1);
    expect(asuntos.filter((a) => /determinacion/.test(a)).length).toBeGreaterThanOrEqual(1);
    expect(asuntos.filter((a) => /multa/.test(a)).length).toBeGreaterThanOrEqual(1);
    expect(asuntos.filter((a) => /requerimiento/.test(a)).length).toBeGreaterThanOrEqual(1);
    const comunes = asuntos.filter((a) => !/coactiv|determinacion|multa|requerimiento/.test(a));
    expect(comunes.length).toBeGreaterThanOrEqual(3);
  });

  it("incluye variantes de asunto: con tilde, en mayúsculas y con abreviatura", () => {
    const asuntos = fixture().mensajes.map((m) => m.asunto);
    const criticos = asuntos.filter((a) =>
      /coactiv|determinaci|multa|requerimiento|\bR\.?\s?[DM]\.?\b|\bREQ\b/i.test(a),
    );
    expect(criticos.some((a) => /[áéíóúÁÉÍÓÚñÑ]/.test(a))).toBe(true);
    expect(criticos.some((a) => a === a.toUpperCase() && /[A-Z]{4}/.test(a))).toBe(true);
    expect(criticos.some((a) => /\b(R\.D\.|R\.M\.|Res\.|REQ\.)/.test(a))).toBe(true);
  });

  it("alguno trae código de tipo y alguno no (el portal no siempre lo da)", () => {
    const codigos = fixture().mensajes.map((m) => m.codigoTipo);
    expect(codigos.some((c) => c !== null)).toBe(true);
    expect(codigos.some((c) => c === null)).toBe(true);
  });

  it("trae contenido en texto y en HTML, con un HTML hostil (script)", () => {
    const { mensajes } = fixture();
    expect(mensajes.some((m) => m.contenido.formato === "texto")).toBe(true);
    const html = mensajes.filter((m) => m.contenido.formato === "html");
    expect(html.length).toBeGreaterThanOrEqual(1);
    expect(html.some((m) => /<script/i.test(m.contenido.cuerpo))).toBe(true);
  });

  it("adjuntos: un PDF real, un XML, uno hostil y uno que supera el tope", () => {
    const adj = fixture().mensajes.flatMap((m) => m.adjuntos);
    const pdf = adj.find((a) => /\.pdf$/i.test(a.nombre) && a.base64);
    expect(pdf).toBeDefined();
    expect(Buffer.from(pdf!.base64!, "base64").subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const xml = adj.find((a) => /\.xml$/i.test(a.nombre) && a.base64);
    expect(xml).toBeDefined();
    expect(Buffer.from(xml!.base64!, "base64").toString("utf8").trimStart().startsWith("<")).toBe(
      true,
    );
    expect(
      adj.some((a) =>
        /\.\.[\\/]|[\\/]|\u0000|[\u0001-\u001f‪-‮⁦-⁩]/u.test(a.nombre),
      ),
    ).toBe(true);
    expect(adj.some((a) => typeof a.tamano === "number" && a.tamano > 20 * 1024 * 1024)).toBe(
      true,
    );
  });

  it("es sintético: no contiene RUC de 11 dígitos fuera de rucs-prueba.json", () => {
    const permitidos = new Set(
      (
        JSON.parse(readFileSync(resolve(RAIZ, "fixtures/rucs-prueba.json"), "utf8")) as {
          ruc: string;
        }[]
      ).map((r) => r.ruc),
    );
    const encontrados = readFileSync(RUTA, "utf8").match(/(?<!\d)\d{11}(?!\d)/g) ?? [];
    for (const r of encontrados) expect(permitidos.has(r)).toBe(true);
  });

  it("fixtures/LEEME.md documenta la carpeta sol/buzon", () => {
    expect(readFileSync(resolve(RAIZ, "fixtures/LEEME.md"), "utf8")).toContain("sol/buzon");
  });
});

describe("MockSolPortal con el fixture del repo (carpeta por defecto)", () => {
  it("lista el fixture del RUC, de lo reciente a lo antiguo, con los mismos ids del archivo", async () => {
    const puerto = new MockSolPortal();
    const r = await puerto.listarMensajes(cred, { cursor: null, limite: 200 });
    const esperados = fixture().mensajes.map((m) => m.idSunat).sort();
    expect(r.mensajes.map((m) => m.idSunat).sort()).toEqual(esperados);
    const fechas = r.mensajes.map((m) => Date.parse(m.fecha));
    expect([...fechas].sort((a, b) => b - a)).toEqual(fechas);
    expect(puerto.leidosMarcados()).toEqual([]);
    expect(puerto.llamadasObtener()).toBe(0);
  });

  it("abre cada mensaje con sus adjuntos: PDF y XML con bytes, el enorme omitido por tamaño", async () => {
    const puerto = new MockSolPortal();
    const { mensajes } = await puerto.listarMensajes(cred, { cursor: null, limite: 200 });
    const adjuntos: { nombre: string; bytes?: Uint8Array; omitido?: string }[] = [];
    for (const m of mensajes) {
      const r = await puerto.obtenerMensaje(cred, m.idSunat, TOPES);
      expect(r.marcaLeido).toBe(true);
      adjuntos.push(...(r.adjuntos as never[]));
    }
    expect(puerto.llamadasObtener()).toBe(mensajes.length);
    expect(adjuntos.some((a) => /\.pdf$/i.test(a.nombre) && a.bytes !== undefined)).toBe(true);
    expect(adjuntos.some((a) => /\.xml$/i.test(a.nombre) && a.bytes !== undefined)).toBe(true);
    expect(adjuntos.some((a) => a.omitido === "tamano" && a.bytes === undefined)).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorDatos } from "../errores.js";
import type { CredencialSol } from "../puertos.js";
import { MockSolPortal } from "./sol-portal.mock.js";

// Spec 023, T10: defensas del mock que las pruebas de T3 no ejercen (forma del fixture, ruta, topes y entradas).
const RUC = "20100000001";
const cred = (ruc = RUC): CredencialSol => ({ ruc, usuarioSol: "CANARIO-USUARIO-sol", claveSol: "CANARIO-SOL-clave" });
const TOPES = { maxBytesAdjunto: 1000, maxBytesMensaje: 5000 };
const buena = () => ({
  idSunat: "M-1",
  asunto: "Aviso",
  remitente: "SUNAT",
  fecha: "2026-10-01T10:00:00-05:00",
  codigoTipo: null,
  leidoEnSunat: false,
  contenido: { formato: "texto", cuerpo: "x" },
  adjuntos: [],
});
const rechaza = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorDatos);
    return;
  }
  throw new Error("se esperaba ErrorDatos");
};

describe("MockSolPortal · defensas de forma y de ruta (T10)", () => {
  let dir: string;
  let fuera: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sol-def-"));
    fuera = mkdtempSync(join(tmpdir(), "sol-fuera-"));
    writeFileSync(join(fuera, "secreto.json"), JSON.stringify({ mensajes: [buena()] }));
    symlinkSync(join(fuera, "secreto.json"), join(dir, "20100000002.json"));
    writeFileSync(join(dir, "20100000003.json"), "x".repeat(1_048_577));
    mkdirSync(join(dir, "20100000004.json"));
    writeFileSync(join(dir, "20100000005.json"), JSON.stringify({ mensajes: "no" }));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fuera, { recursive: true, force: true });
  });

  it.each(["20100000002", "20100000003", "20100000004", "20100000005"])(
    "fixture %s (enlace que sale, enorme, no regular, forma errónea) -> ErrorDatos",
    async (ruc) => {
      const p = new MockSolPortal({ dirFixtures: dir });
      await rechaza(p.listarMensajes(cred(ruc), { cursor: null, limite: 5 }));
    },
  );

  it("carpeta de fixtures inexistente -> buzón generado", async () => {
    const p = new MockSolPortal({ dirFixtures: join(dir, "no-existe") });
    const r = await p.listarMensajes(cred(), { cursor: null, limite: 5 });
    expect(r.mensajes).toHaveLength(5);
  });

  it("una carpeta de fixtures que cuelga de un archivo -> buzón generado", async () => {
    const p = new MockSolPortal({ dirFixtures: join(dir, "20100000005.json", "x") });
    await expect(p.listarMensajes(cred(), { cursor: null, limite: 5 })).resolves.toBeDefined();
  });

  it.each([
    ["sin mensajes", {}],
    ["mensaje que no es objeto", { mensajes: [1] }],
    ["id vacío", { mensajes: [{ ...buena(), idSunat: "" }] }],
    ["id repetido", { mensajes: [buena(), buena()] }],
    ["fecha ilegible", { mensajes: [{ ...buena(), fecha: "ayer" }] }],
    ["código de tipo numérico", { mensajes: [{ ...buena(), codigoTipo: 3 }] }],
    ["formato desconocido", { mensajes: [{ ...buena(), contenido: { formato: "pdf", cuerpo: "x" } }] }],
    ["adjuntos que no son lista", { mensajes: [{ ...buena(), adjuntos: {} }] }],
    ["adjunto sin bytes ni tamaño", { mensajes: [{ ...buena(), adjuntos: [{ idSunat: "A", nombre: "a" }] }] }],
    [
      "adjunto con bytes y tamaño",
      { mensajes: [{ ...buena(), adjuntos: [{ idSunat: "A", nombre: "a", base64: "AAAA", tamano: 3 }] }] },
    ],
    ["base64 inválido", { mensajes: [{ ...buena(), adjuntos: [{ idSunat: "A", nombre: "a", base64: "***" }] }] }],
    ["tamaño negativo", { mensajes: [{ ...buena(), adjuntos: [{ idSunat: "A", nombre: "a", tamano: -1 }] }] }],
    [
      "adjunto repetido",
      {
        mensajes: [
          {
            ...buena(),
            adjuntos: [
              { idSunat: "A", nombre: "a", tamano: 1 },
              { idSunat: "A", nombre: "b", tamano: 1 },
            ],
          },
        ],
      },
    ],
  ])("inyectar con forma errónea (%s) -> ErrorDatos", (_nombre, caso) => {
    expect(() => new MockSolPortal().inyectar(RUC, caso as never)).toThrow(ErrorDatos);
  });

  it("inyectar con un RUC fuera de la gramática -> ErrorDatos", () => {
    expect(() => new MockSolPortal().inyectar("../x", { mensajes: [] })).toThrow(ErrorDatos);
  });

  it("topes inválidos o id que no es texto -> ErrorDatos", async () => {
    const p = new MockSolPortal();
    await rechaza(p.obtenerMensaje(cred(), "M-1", { maxBytesAdjunto: -1, maxBytesMensaje: 10 }));
    await rechaza(p.obtenerMensaje(cred(), 5 as never, TOPES));
  });

  it("cursor fuera del buzón o en cero -> ErrorDatos", async () => {
    const p = new MockSolPortal();
    await rechaza(p.listarMensajes(cred(), { cursor: "s1_zz", limite: 5 }));
    await rechaza(p.listarMensajes(cred(), { cursor: "s1_0", limite: 5 }));
    await rechaza(p.listarMensajes(cred(), { cursor: 7 as never, limite: 5 }));
  });

  it("mensajesGenerados: sube a 8 como mínimo y un valor no finito usa el valor por defecto", async () => {
    const lista = async (n: number | undefined) =>
      (await new MockSolPortal({ mensajesGenerados: n }).listarMensajes(cred(), { cursor: null, limite: 200 }))
        .mensajes.length;
    expect(await lista(2)).toBe(8);
    expect(await lista(Number.NaN)).toBe(12);
    expect(await lista(undefined)).toBe(12);
  });

  it("latencia inválida (negativa o no finita) equivale a cero", async () => {
    for (const latenciaMs of [-5, Number.NaN]) {
      const t0 = Date.now();
      await new MockSolPortal({ latenciaMs }).listarMensajes(cred(), { cursor: null, limite: 1 });
      expect(Date.now() - t0).toBeLessThan(100);
    }
  });

  it("un adjunto sintético que cabe se entrega con sus bytes", async () => {
    const p = new MockSolPortal();
    p.inyectar(RUC, { mensajes: [{ ...buena(), adjuntos: [{ idSunat: "A", nombre: "a.bin", tamano: 10 }] }] as never });
    const r = await p.obtenerMensaje(cred(), "M-1", TOPES);
    expect((r.adjuntos[0] as { bytes: Uint8Array }).bytes).toHaveLength(10);
  });

  it("volver a inyectar un RUC reinicia sus marcas de lectura", async () => {
    const p = new MockSolPortal();
    p.inyectar(RUC, { mensajes: [buena()] as never });
    await p.obtenerMensaje(cred(), "M-1", TOPES);
    p.inyectar(RUC, { mensajes: [buena()] as never });
    const r = await p.listarMensajes(cred(), { cursor: null, limite: 5 });
    expect(r.mensajes[0]!.leidoEnSunat).toBe(false);
  });
});

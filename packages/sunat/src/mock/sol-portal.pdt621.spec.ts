import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorCredencial, ErrorDatos, ErrorTransitorio } from "../errores.js";
import type { CredencialSol } from "../puertos.js";
import { MockSolPortal } from "./sol-portal.mock.js";

// Spec 026 · T2 (rojo). PDT 621 del mock SOL (spec 026 D-1, D-2, D-7; plan 026, Contratos: sunat; CA-1, CA-7, CA-10).
// Contrato fijado por estas pruebas (packages/sunat/src/puertos.ts y mock/sol-portal.mock.ts, `SOL_PORTAL=mock`):
//  - `SolPortal.obtenerDeclaraciones621(credencial, {periodo}) → Declaracion621[]`: TODAS las presentaciones de ese periodo
//    (lista vacía = sin declaración). Declaracion621 = {periodo, numeroOrden: 1..15 dígitos, fechaPresentacion: AAAA-MM-DD,
//    tipo: original|rectificatoria, ventasGravadasBase, ventasGravadasIgv, exportaciones, noGravadas, igvAdquisicionesDg,
//    igvAdquisicionesDgng, prorrataUsada: «NN.NN» | null}. Montos como cadenas decimales (nunca number).
//  - Origen en este orden: `inyectar` -> `{dirFixtures}/pdt621/{ruc}.json` (`{periodos: {AAAAMM: Declaracion621[] | "error_datos"}}`;
//    un periodo ausente = sin declaración; "error_datos" = ErrorDatos) -> generado determinista por RUC (sin reloj ni azar) con: un mes
//    sin declaración, una rectificatoria, un mes que da ErrorDatos, exportaciones en un mes y prorrata usada en el último (2026-10),
//    dentro de la ventana 202511..202610.
//  - Cualquier defecto del fixture o del periodo pedido = ErrorDatos de mensaje fijo, sin RUC ni ruta. `clave-errada` = ErrorCredencial;
//    `fallar("credencial" | "transitorio", {veces?})` como el buzón; `inyectar(ruc, {error})` hace fallar toda llamada de ese RUC.
//  - El mock no conserva la credencial (ni usuario, ni clave) y devuelve copias: mutar el resultado no cambia la siguiente llamada.
// Si el método no existe, la prueba falla con «no implementado», no al compilar ni al cargar el archivo.
const CANARIO_USUARIO = "CANARIO-USUARIO-sol";
const CANARIO_CLAVE = "CANARIO-SOL-clave";
const RUC_A = "20100000001";
const RUC_B = "20100000002";
const RUC_C = "20100000003";
const RUC_MALO = "20100000004";
const RUC_ERRORES = "20100000005";
const cred = (ruc: string, extra: Partial<CredencialSol> = {}): CredencialSol => ({
  ruc,
  usuarioSol: CANARIO_USUARIO,
  claveSol: CANARIO_CLAVE,
  ...extra,
});

interface Decl {
  periodo: string;
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}
type Con621 = { obtenerDeclaraciones621?: (c: CredencialSol, o: { periodo: string }) => Promise<Decl[]> };

/** Llama al método nuevo del puerto; si no existe, falla con «no implementado». */
async function obtener(puerto: MockSolPortal, c: CredencialSol, periodo: string): Promise<Decl[]> {
  const f = (puerto as unknown as Con621).obtenerDeclaraciones621;
  if (typeof f !== "function") throw new Error("no implementado: MockSolPortal.obtenerDeclaraciones621");
  return f.call(puerto, c, { periodo });
}
const esNoImplementado = (e: unknown) => e instanceof Error && e.message.startsWith("no implementado");
async function atrapar(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    if (esNoImplementado(e)) throw e;
    return e;
  }
  throw new Error("se esperaba un error");
}
const textoDe = (e: unknown) => `${(e as Error).message} ${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`;

/** Los 12 periodos de la ventana de 2026-10, del más antiguo al más reciente. */
const VENTANA = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];

type Resultado = { periodo: string; declaraciones: Decl[] } | { periodo: string; error: unknown };
async function ventana(puerto: MockSolPortal, c: CredencialSol): Promise<Resultado[]> {
  const salida: Resultado[] = [];
  for (const periodo of VENTANA) {
    try {
      salida.push({ periodo, declaraciones: await obtener(puerto, c, periodo) });
    } catch (error) {
      if (esNoImplementado(error)) throw error;
      salida.push({ periodo, error });
    }
  }
  return salida;
}
const conDatos = (r: Resultado[]) => r.flatMap((x) => ("declaraciones" in x ? x.declaraciones : []));

const decl = (periodo: string, o: Partial<Decl> = {}): Decl => ({
  periodo,
  numeroOrden: "7654321",
  fechaPresentacion: "2026-11-10",
  tipo: "original",
  ventasGravadasBase: "100000.00",
  ventasGravadasIgv: "18000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  igvAdquisicionesDg: "9000.00",
  igvAdquisicionesDgng: "3600.00",
  prorrataUsada: null,
  ...o,
});

const RE_MONTO = /^-?\d{1,12}(\.\d{1,2})?$/;

describe("MockSolPortal · PDT 621 generado y determinista (D-2, CA-1)", () => {
  it("el método existe en el puerto y devuelve una lista", async () => {
    const r = await obtener(new MockSolPortal(), cred(RUC_A), "202610");
    expect(Array.isArray(r)).toBe(true);
  });

  it("es determinista por RUC: dos instancias dan lo mismo en los 12 periodos y otro RUC da otros datos", async () => {
    const uno = await ventana(new MockSolPortal(), cred(RUC_A));
    const dos = await ventana(new MockSolPortal(), cred(RUC_A));
    const otro = await ventana(new MockSolPortal(), cred(RUC_B));
    expect(JSON.stringify(dos)).toBe(JSON.stringify(uno));
    expect(JSON.stringify(otro)).not.toBe(JSON.stringify(uno));
  });

  it("dos llamadas iguales en la misma instancia dan lo mismo (sin estado ni azar)", async () => {
    const puerto = new MockSolPortal();
    for (const periodo of VENTANA) {
      const a = await obtener(puerto, cred(RUC_A), periodo).catch((e: unknown) => {
        if (esNoImplementado(e)) throw e;
        return (e as Error).name;
      });
      const b = await obtener(puerto, cred(RUC_A), periodo).catch((e: unknown) => {
        if (esNoImplementado(e)) throw e;
        return (e as Error).name;
      });
      expect(b).toEqual(a);
    }
  });

  it("no depende del reloj: es lo mismo con otra fecha del sistema", async () => {
    const antes = await ventana(new MockSolPortal(), cred(RUC_A));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      const despues = await ventana(new MockSolPortal(), cred(RUC_A));
      expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
    } finally {
      vi.useRealTimers();
    }
  });

  it("devuelve copias: mutar el resultado no cambia la siguiente llamada", async () => {
    const puerto = new MockSolPortal();
    const antes = await ventana(puerto, cred(RUC_A));
    for (const x of antes) if ("declaraciones" in x) for (const d of x.declaraciones) d.ventasGravadasBase = "CORROMPIDO";
    expect(JSON.stringify(await ventana(puerto, cred(RUC_A)))).not.toContain("CORROMPIDO");
  });

  it("todas las declaraciones son del periodo pedido y cumplen el layout (D-1)", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const todas = conDatos(r);
    expect(todas.length).toBeGreaterThan(0);
    for (const x of r) {
      if (!("declaraciones" in x)) continue;
      for (const d of x.declaraciones) {
        expect(d.periodo).toBe(x.periodo);
        expect(d.numeroOrden).toMatch(/^[0-9]{1,15}$/);
        expect(d.fechaPresentacion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(d.fechaPresentacion))).toBe(false);
        expect(["original", "rectificatoria"]).toContain(d.tipo);
        for (const campo of ["ventasGravadasBase", "ventasGravadasIgv", "exportaciones", "noGravadas", "igvAdquisicionesDg", "igvAdquisicionesDgng"] as const) {
          expect(typeof d[campo], campo).toBe("string");
          expect(d[campo], campo).toMatch(RE_MONTO);
        }
        expect(d.prorrataUsada === null || /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/.test(d.prorrataUsada)).toBe(true);
      }
    }
  });

  it("los números de orden de un mismo periodo no se repiten", async () => {
    for (const x of await ventana(new MockSolPortal(), cred(RUC_A))) {
      if (!("declaraciones" in x)) continue;
      const ordenes = x.declaraciones.map((d) => d.numeroOrden);
      expect(new Set(ordenes).size).toBe(ordenes.length);
    }
  });

  it("deja un mes sin declaración (lista vacía)", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    expect(r.some((x) => "declaraciones" in x && x.declaraciones.length === 0)).toBe(true);
  });

  it("trae una rectificatoria: un periodo con dos presentaciones, la de mayor orden rectificatoria", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const conRectificatoria = r.flatMap((x) => ("declaraciones" in x && x.declaraciones.some((d) => d.tipo === "rectificatoria") ? [x.declaraciones] : []));
    expect(conRectificatoria.length).toBeGreaterThanOrEqual(1);
    for (const lista of conRectificatoria) {
      expect(lista.length).toBeGreaterThanOrEqual(2);
      expect(lista.some((d) => d.tipo === "original")).toBe(true);
      const mayor = [...lista].sort((a, b) => Number(BigInt(b.numeroOrden) - BigInt(a.numeroOrden)))[0]!;
      expect(mayor.tipo).toBe("rectificatoria");
    }
  });

  it("trae un mes que da ErrorDatos con mensaje fijo, y el resto sigue respondiendo", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const errores = r.filter((x) => "error" in x) as { periodo: string; error: unknown }[];
    expect(errores.length).toBeGreaterThanOrEqual(1);
    for (const x of errores) {
      expect(x.error).toBeInstanceOf(ErrorDatos);
      const texto = textoDe(x.error);
      expect(texto).not.toContain(RUC_A);
      expect(texto).not.toContain("CANARIO");
    }
    expect(r.filter((x) => "declaraciones" in x).length).toBeGreaterThanOrEqual(8);
  });

  it("el mes con ErrorDatos, el mes vacío y la rectificatoria son meses distintos", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const error = r.filter((x) => "error" in x).map((x) => x.periodo);
    const vacio = r.filter((x) => "declaraciones" in x && x.declaraciones.length === 0).map((x) => x.periodo);
    const rect = r.filter((x) => "declaraciones" in x && x.declaraciones.some((d) => d.tipo === "rectificatoria")).map((x) => x.periodo);
    expect(error.filter((p) => vacio.includes(p) || rect.includes(p))).toEqual([]);
    expect(vacio.filter((p) => rect.includes(p))).toEqual([]);
  });

  it("trae exportaciones distintas de cero en algún mes", async () => {
    const todas = conDatos(await ventana(new MockSolPortal(), cred(RUC_A)));
    expect(todas.some((d) => Number(d.exportaciones) !== 0)).toBe(true);
  });

  it("trae prorrata usada en el último mes (2026-10) y en ningún mes anterior sin que sea decisión del fixture", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const ultimo = r.find((x) => x.periodo === "202610");
    expect(ultimo).toBeDefined();
    expect("declaraciones" in ultimo!).toBe(true);
    const vigentes = (ultimo as { declaraciones: Decl[] }).declaraciones;
    expect(vigentes.length).toBeGreaterThanOrEqual(1);
    expect(vigentes.some((d) => d.prorrataUsada !== null)).toBe(true);
  });

  it("los 12 periodos de la ventana responden (CA-11: la obtención completa no necesita esperas ni reloj)", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    expect(r).toHaveLength(12);
  });
});

describe("MockSolPortal · fixture en disco e `inyectar` del PDT 621 (D-2)", () => {
  let dir: string;
  const escribir = (ruc: string, contenido: unknown) =>
    writeFileSync(join(dir, "pdt621", `${ruc}.json`), typeof contenido === "string" ? contenido : JSON.stringify(contenido));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sol-pdt621-"));
    mkdirSync(join(dir, "pdt621"));
    escribir(RUC_A, {
      periodos: {
        "202610": [decl("202610", { numeroOrden: "100", prorrataUsada: "83.34" }), decl("202610", { numeroOrden: "250", tipo: "rectificatoria", ventasGravadasBase: "110000.00" })],
        "202609": [],
        "202608": "error_datos",
        "202607": [decl("202607", { exportaciones: "5000.50", noGravadas: "0.00" })],
      },
    });
    escribir(RUC_B, "{ esto no es json");
    escribir(RUC_ERRORES, { periodos: { "202610": "error_datos" } });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("usa pdt621/{ruc}.json en lugar de lo generado y devuelve todas las presentaciones del periodo", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const r = await obtener(puerto, cred(RUC_A), "202610");
    expect(r).toHaveLength(2);
    expect(r.map((d) => d.numeroOrden).sort()).toEqual(["100", "250"]);
    expect(r.find((d) => d.numeroOrden === "250")).toMatchObject({ tipo: "rectificatoria", ventasGravadasBase: "110000.00", periodo: "202610" });
    expect(r.find((d) => d.numeroOrden === "100")?.prorrataUsada).toBe("83.34");
  });
  it("un periodo con lista vacía es «sin declaración»", async () => {
    expect(await obtener(new MockSolPortal({ dirFixtures: dir }), cred(RUC_A), "202609")).toEqual([]);
  });
  it("un periodo ausente del fixture también es «sin declaración»", async () => {
    expect(await obtener(new MockSolPortal({ dirFixtures: dir }), cred(RUC_A), "202601")).toEqual([]);
  });
  it("un periodo marcado «error_datos» da ErrorDatos con mensaje fijo, sin RUC ni ruta", async () => {
    const e = await atrapar(obtener(new MockSolPortal({ dirFixtures: dir }), cred(RUC_A), "202608"));
    expect(e).toBeInstanceOf(ErrorDatos);
    const texto = textoDe(e);
    expect(texto).not.toContain(RUC_A);
    expect(texto).not.toContain(dir);
    expect(texto).not.toContain("202608");
  });
  it("los demás periodos del fixture siguen respondiendo aunque uno sea error_datos", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    await atrapar(obtener(puerto, cred(RUC_A), "202608"));
    const r = await obtener(puerto, cred(RUC_A), "202607");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ exportaciones: "5000.50", noGravadas: "0.00" });
  });
  it("el mensaje de ErrorDatos es el mismo que el de cualquier otro defecto", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const a = await atrapar(obtener(puerto, cred(RUC_A), "202608"));
    const b = await atrapar(obtener(puerto, cred(RUC_B), "202610"));
    expect((b as Error).message).toBe((a as Error).message);
  });

  it("fixture ilegible -> ErrorDatos con mensaje fijo, sin RUC ni ruta", async () => {
    const e = await atrapar(obtener(new MockSolPortal({ dirFixtures: dir }), cred(RUC_B), "202610"));
    expect(e).toBeInstanceOf(ErrorDatos);
    const texto = textoDe(e);
    expect(texto).not.toContain(RUC_B);
    expect(texto).not.toContain(dir);
  });

  describe("fixtures malformados -> ErrorDatos fijo", () => {
    const casos: [string, unknown][] = [
      ["raíz que no es objeto", []],
      ["sin periodos", { otra: 1 }],
      ["periodos como lista", { periodos: [] }],
      ["periodo con clave inválida", { periodos: { "2026-10": [decl("202610")] } }],
      ["valor que no es lista ni error_datos", { periodos: { "202610": "otro_texto" } }],
      ["declaración que no es objeto", { periodos: { "202610": ["x"] } }],
      ["periodo de la declaración distinto del pedido", { periodos: { "202610": [decl("202609")] } }],
      ["tipo inválido", { periodos: { "202610": [decl("202610", { tipo: "sustitutoria" as never })] } }],
      ["numeroOrden de 16 dígitos", { periodos: { "202610": [decl("202610", { numeroOrden: "1234567890123456" })] } }],
      ["numeroOrden vacío", { periodos: { "202610": [decl("202610", { numeroOrden: "" })] } }],
      ["numeroOrden con letras", { periodos: { "202610": [decl("202610", { numeroOrden: "12a" })] } }],
      ["numeroOrden numérico", { periodos: { "202610": [decl("202610", { numeroOrden: 123 as never })] } }],
      ["numeroOrden repetido en el periodo", { periodos: { "202610": [decl("202610"), decl("202610", { tipo: "rectificatoria" })] } }],
      ["fecha inválida", { periodos: { "202610": [decl("202610", { fechaPresentacion: "10/11/2026" })] } }],
      ["monto como number", { periodos: { "202610": [decl("202610", { ventasGravadasBase: 100000 as never })] } }],
      ["monto con 3 decimales", { periodos: { "202610": [decl("202610", { exportaciones: "1.234" })] } }],
      ["monto en notación científica", { periodos: { "202610": [decl("202610", { noGravadas: "1e3" })] } }],
      ["monto vacío", { periodos: { "202610": [decl("202610", { igvAdquisicionesDg: "" })] } }],
      ["monto null", { periodos: { "202610": [decl("202610", { igvAdquisicionesDgng: null as never })] } }],
      ["prorrataUsada mayor que 100", { periodos: { "202610": [decl("202610", { prorrataUsada: "100.01" })] } }],
      ["prorrataUsada numérica", { periodos: { "202610": [decl("202610", { prorrataUsada: 83.34 as never })] } }],
      ["prorrataUsada con 3 decimales", { periodos: { "202610": [decl("202610", { prorrataUsada: "83.345" })] } }],
    ];
    it.each(casos)("%s", async (_c, contenido) => {
      escribir(RUC_MALO, contenido as object);
      const e = await atrapar(obtener(new MockSolPortal({ dirFixtures: dir }), cred(RUC_MALO), "202610"));
      expect(e).toBeInstanceOf(ErrorDatos);
      const texto = textoDe(e);
      expect(texto).not.toContain(RUC_MALO);
      expect(texto).not.toContain(dir);
    });
  });

  it("el fixture gana sobre lo generado: otro RUC sin fixture sigue usando lo generado", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const generado = await ventana(new MockSolPortal(), cred(RUC_C));
    expect(JSON.stringify(await ventana(puerto, cred(RUC_C)))).toBe(JSON.stringify(generado));
  });

  it("`inyectar` con periodos sustituye lo del fixture y lo generado de ese RUC, y deja intacto el de otro", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    (puerto.inyectar as (ruc: string, caso: unknown) => void)(RUC_A, { periodos: { "202610": [decl("202610", { numeroOrden: "999" })] } });
    const r = await obtener(puerto, cred(RUC_A), "202610");
    expect(r.map((d) => d.numeroOrden)).toEqual(["999"]);
    expect(await obtener(puerto, cred(RUC_A), "202607")).toEqual([]);
    const otro = await ventana(new MockSolPortal({ dirFixtures: dir }), cred(RUC_C));
    expect(conDatos(otro).length).toBeGreaterThan(0);
  });

  it("`inyectar` con error lo lanza tal cual, solo para ese RUC", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const mio = new ErrorTransitorio();
    puerto.inyectar(RUC_A, { error: mio });
    expect(await atrapar(obtener(puerto, cred(RUC_A), "202610"))).toBe(mio);
    await expect(obtener(puerto, cred(RUC_C), "202610")).resolves.toBeDefined();
  });
});

describe("MockSolPortal · periodo y RUC inválidos -> ErrorDatos", () => {
  it.each([
    ["mes 13", "202613"],
    ["mes 00", "202600"],
    ["con guion", "2026-10"],
    ["corto", "20261"],
    ["vacío", ""],
    ["con espacio", "202610 "],
    ["con ruta", "../202610"],
    ["número", 202610 as never],
    ["null", null as never],
    ["undefined", undefined as never],
  ])("periodo %s", async (_c, periodo) => {
    const e = await atrapar(obtener(new MockSolPortal(), cred(RUC_A), periodo));
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(textoDe(e)).not.toContain(RUC_A);
  });
  it.each(["", "2010000000", "201000000011", "../x", "2010000000a", "20100000001\n"])("RUC %j", async (ruc) => {
    const e = await atrapar(obtener(new MockSolPortal(), cred(ruc), "202610"));
    expect(e).toBeInstanceOf(ErrorDatos);
  });
});

describe("MockSolPortal · fallas de la credencial y del portal (D-3, CA-7)", () => {
  it("clave centinela «clave-errada» -> ErrorCredencial, antes de cualquier dato", async () => {
    const puerto = new MockSolPortal();
    expect(await atrapar(obtener(puerto, cred(RUC_A, { claveSol: "clave-errada" }), "202610"))).toBeInstanceOf(ErrorCredencial);
    await expect(obtener(puerto, cred(RUC_A), "202610")).resolves.toBeDefined();
  });
  it("`fallar(\"credencial\")` -> ErrorCredencial en todos los periodos hasta `fallar(null)`", async () => {
    const puerto = new MockSolPortal();
    puerto.fallar("credencial");
    for (const periodo of VENTANA.slice(0, 3)) expect(await atrapar(obtener(puerto, cred(RUC_A), periodo))).toBeInstanceOf(ErrorCredencial);
    puerto.fallar(null);
    await expect(obtener(puerto, cred(RUC_A), "202610")).resolves.toBeDefined();
  });
  it("`fallar(\"transitorio\", {veces: 1})` falla una vez y luego responde (008 reintenta)", async () => {
    const puerto = new MockSolPortal();
    puerto.fallar("transitorio", { veces: 1 });
    expect(await atrapar(obtener(puerto, cred(RUC_A), "202610"))).toBeInstanceOf(ErrorTransitorio);
    const r = await obtener(puerto, cred(RUC_A), "202610");
    expect(Array.isArray(r)).toBe(true);
  });
  it("los errores no llevan usuario, clave ni RUC (canario en message, String, JSON y stack)", async () => {
    const puerto = new MockSolPortal();
    const errores: unknown[] = [];
    errores.push(await atrapar(obtener(puerto, cred(RUC_A, { claveSol: "clave-errada" }), "202610")));
    errores.push(await atrapar(obtener(puerto, cred(RUC_A), "no-es-periodo")));
    errores.push(await atrapar(obtener(puerto, cred("../x"), "202610")));
    for (const modo of ["credencial", "transitorio"] as const) {
      puerto.fallar(modo);
      errores.push(await atrapar(obtener(puerto, cred(RUC_A), "202610")));
    }
    puerto.fallar(null);
    for (const e of errores) {
      expect(e).toBeInstanceOf(Error);
      const texto = textoDe(e);
      expect(texto).not.toContain("CANARIO");
      expect(texto).not.toContain("clave-errada");
      expect(texto).not.toContain(RUC_A);
    }
  });
});

describe("MockSolPortal · no retiene credenciales ni datos de las llamadas (D-7, CA-10)", () => {
  /** Recorre las propiedades propias (también Map, Set y arreglos) y devuelve todo texto que las llame. */
  function textos(valor: unknown, visto = new Set<unknown>(), salida: string[] = []): string[] {
    if (typeof valor === "string") salida.push(valor);
    else if (typeof valor === "object" && valor !== null && !visto.has(valor)) {
      visto.add(valor);
      if (valor instanceof Map) {
        for (const [k, v] of valor) {
          textos(k, visto, salida);
          textos(v, visto, salida);
        }
      }
      else if (valor instanceof Set) for (const v of valor) textos(v, visto, salida);
      else {
        for (const k of Reflect.ownKeys(valor)) {
          salida.push(String(k));
          textos((valor as Record<PropertyKey, unknown>)[k], visto, salida);
        }
      }
    }
    return salida;
  }

  it("tras llamadas correctas y fallidas, ninguna propiedad de la instancia contiene el usuario ni la clave", async () => {
    const puerto = new MockSolPortal();
    await ventana(puerto, cred(RUC_A));
    await atrapar(obtener(puerto, cred(RUC_A, { claveSol: "clave-errada" }), "202610"));
    puerto.fallar("transitorio", { veces: 1 });
    await atrapar(obtener(puerto, cred(RUC_A), "202610"));
    const todo = textos(puerto).join("\n");
    expect(todo).not.toContain(CANARIO_USUARIO);
    expect(todo).not.toContain(CANARIO_CLAVE);
    expect(todo).not.toContain("clave-errada");
  });
  it("el historial de lecturas del buzón (`leidosMarcados`) no cambia ni lleva la clave", async () => {
    const puerto = new MockSolPortal();
    await ventana(puerto, cred(RUC_A));
    expect(puerto.leidosMarcados()).toEqual([]);
    expect(JSON.stringify(puerto.leidosMarcados())).not.toContain("CANARIO");
  });
  it("las respuestas no hacen eco de la credencial ni del RUC", async () => {
    const r = await ventana(new MockSolPortal(), cred(RUC_A));
    const volcado = JSON.stringify(conDatos(r));
    expect(volcado).not.toContain("CANARIO");
    expect(volcado).not.toContain(RUC_A);
  });
  it("no conserva la credencial: mutar el objeto después no cambia la siguiente llamada", async () => {
    const puerto = new MockSolPortal();
    const c = cred(RUC_A);
    const antes = await ventana(puerto, c);
    c.ruc = RUC_B;
    const otra = await ventana(puerto, cred(RUC_A));
    expect(JSON.stringify(otra)).toBe(JSON.stringify(antes));
  });
});

// Spec 026, T5 (rojo): `sol.declaraciones.descargar` sin BD ni Redis. BD y portal son dobles. Fija el contrato fino del procesador
// (test/prorrata.ts, cabecera): parámetros, orden y forma de las llamadas al puerto, `ErrorDatos` y lista vacía como «sin declaración»,
// errores del puerto que salen tal cual y sin escribir, una sola llamada a `registrarDeclaraciones`, `55000`, `resultado` de solo
// conteos y secreto descifrado una vez. El procesador se carga en cada prueba: mientras no exista falla con «no implementado».
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortal,
  ErrorTransitorio,
} from "@contapp/sunat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class ProrrataRepoError extends Error {
    readonly codigo: string;
    constructor(codigo: string) {
      super(`Error de base de datos en prorrata (SQLSTATE ${codigo})`);
      this.name = "ProrrataRepoError";
      this.codigo = codigo;
    }
  }
  return {
    ProrrataRepoError,
    registrar: vi.fn<(tx: unknown, e: unknown) => Promise<number>>(
      async () => 0,
    ),
    credenciales: vi.fn(async (): Promise<{ id: string; tipo: string }[]> => [
      { id: "cred-1", tipo: "sol" },
    ]),
    abiertas: 0,
  };
});
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  estadoCredenciales: h.credenciales,
  registrarDeclaraciones: h.registrar,
  ProrrataRepoError: h.ProrrataRepoError,
}));

const RUC = "20700000002";
const PERIODO = "202610";
const VENTANA = [
  "202610",
  "202609",
  "202608",
  "202607",
  "202606",
  "202605",
  "202604",
  "202603",
  "202602",
  "202601",
  "202512",
  "202511",
];

const trabajo = (parametros: unknown, extra: Record<string, unknown> = {}) => ({
  id: "0190a000-0000-7000-8000-0000000000a1",
  tenantId: "0190a000-0000-7000-8000-0000000000e1",
  clienteId: "0190a000-0000-7000-8000-0000000000c1",
  ruc: RUC,
  tipo: "sol.declaraciones.descargar",
  parametros,
  intentos: 0,
  creadoPor: null,
  ...extra,
});
const ctx = (parametros: unknown) => ({
  trabajo: trabajo(parametros),
  conToken: async <T>(f: (t: string) => Promise<T>) => f("tok"),
});

const decl = (periodo: string, orden = "1") => ({
  periodo,
  numeroOrden: orden,
  fechaPresentacion: "2026-11-10",
  tipo: "original" as const,
  ventasGravadasBase: "100000.00",
  ventasGravadasIgv: "18000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  igvAdquisicionesDg: "9000.00",
  igvAdquisicionesDgng: "3600.00",
  prorrataUsada: null,
});

type Respuesta = unknown[] | Error;

async function cargar(): Promise<
  (d: unknown) => (c: unknown) => Promise<Record<string, unknown>>
> {
  const ruta = "./obtener-declaraciones.js";
  let m: Record<string, unknown>;
  try {
    m = (await import(/* @vite-ignore */ ruta)) as Record<string, unknown>;
  } catch {
    throw new Error(
      "no implementado: procesadores/obtener-declaraciones.ts (spec 026, T11)",
    );
  }
  if (typeof m.obtenerDeclaraciones !== "function")
    throw new Error(
      "no implementado: obtenerDeclaraciones en obtener-declaraciones.ts (spec 026, T11)",
    );
  return m.obtenerDeclaraciones as never;
}

/** `respuestas`: por periodo; lo que falte = lista vacía. */
async function armar(respuestas: Record<string, Respuesta> = {}) {
  const secreto = {
    usar: <T>(f: (v: unknown) => T): T => f({ usuario: "usu", clave: "cla" }),
    destruir: vi.fn(),
  };
  const descifrar = vi.fn(async () => secreto);
  const llamadas: { cred: unknown; periodo: string; abiertas: number }[] = [];
  const solPortal = {
    obtenerDeclaraciones621: vi.fn(
      async (cred: unknown, o: { periodo: string }) => {
        llamadas.push({ cred, periodo: o.periodo, abiertas: h.abiertas });
        const r = respuestas[o.periodo] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
    ),
    listarMensajes: vi.fn(),
    obtenerMensaje: vi.fn(),
  };
  const escrituras = { n: 0 };
  const db = {
    withTenant: async (_c: unknown, f: (tx: unknown) => Promise<unknown>) => {
      h.abiertas += 1;
      try {
        return await f({});
      } finally {
        h.abiertas -= 1;
      }
    },
  };
  h.registrar.mockImplementation(async () => {
    escrituras.n += 1;
    return 0;
  });
  const obtenerDeclaraciones = await cargar();
  const proc = obtenerDeclaraciones({
    db: db as never,
    servicio: { descifrarCredencial: descifrar } as never,
    solPortal: solPortal as never,
  });
  return { proc, solPortal, descifrar, secreto, llamadas, escrituras };
}

beforeEach(() => {
  h.registrar.mockReset();
  h.registrar.mockResolvedValue(0);
  h.credenciales.mockReset();
  h.credenciales.mockResolvedValue([{ id: "cred-1", tipo: "sol" }]);
  h.abiertas = 0;
});

describe("parámetros", () => {
  it.each([
    undefined,
    null,
    {},
    "202610",
    { periodo: "202613" },
    { periodo: "202600" },
    { periodo: "2026-10" },
    { periodo: 202610 },
    { periodo: "202610", extra: 1 },
  ])(
    "parámetros inválidos (%j): ErrorDatos sin descifrar ni llamar al portal",
    async (parametros) => {
      const { proc, solPortal, descifrar } = await armar();
      await expect(proc(ctx(parametros) as never)).rejects.toBeInstanceOf(
        ErrorDatos,
      );
      expect(solPortal.obtenerDeclaraciones621).not.toHaveBeenCalled();
      expect(descifrar).not.toHaveBeenCalled();
      expect(h.registrar).not.toHaveBeenCalled();
    },
  );
});

describe("credencial", () => {
  it("el cliente sin credencial SOL: ErrorCredencial sin descifrar, sin portal y sin escribir", async () => {
    h.credenciales.mockResolvedValue([{ id: "x", tipo: "sire_api" }]);
    const { proc, solPortal, descifrar } = await armar();
    await expect(
      proc(ctx({ periodo: PERIODO }) as never),
    ).rejects.toBeInstanceOf(ErrorCredencial);
    expect(descifrar).not.toHaveBeenCalled();
    expect(solPortal.obtenerDeclaraciones621).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("descifra UNA vez (motivo = tipo del trabajo), destruye el secreto y pasa {ruc, usuarioSol, claveSol} a cada llamada", async () => {
    const { proc, descifrar, secreto, llamadas } = await armar();
    await proc(ctx({ periodo: PERIODO }) as never);
    expect(descifrar).toHaveBeenCalledTimes(1);
    expect(descifrar.mock.calls[0]).toEqual([
      { tenantId: trabajo({}).tenantId },
      "cred-1",
      "sol.declaraciones.descargar",
    ]);
    expect(secreto.destruir).toHaveBeenCalled();
    expect(llamadas).toHaveLength(12);
    for (const l of llamadas)
      expect(l.cred).toEqual({ ruc: RUC, usuarioSol: "usu", claveSol: "cla" });
  });
});

describe("llamadas al puerto", () => {
  it("una por periodo de la ventana, del más reciente al más antiguo, con el periodo pedido y sin transacción abierta", async () => {
    const { proc, solPortal, llamadas } = await armar();
    await proc(ctx({ periodo: PERIODO }) as never);
    expect(solPortal.obtenerDeclaraciones621).toHaveBeenCalledTimes(12);
    expect(llamadas.map((l) => l.periodo)).toEqual(VENTANA);
    expect(llamadas.map((l) => l.abiertas)).toEqual(Array(12).fill(0));
    for (const c of solPortal.obtenerDeclaraciones621.mock.calls)
      expect(Object.keys(c[1] as object)).toEqual(["periodo"]);
    expect(solPortal.listarMensajes).not.toHaveBeenCalled();
  });

  it("la ventana cruza el año (202601 -> 202502) y llega al mismo mes del año anterior sin repetir", async () => {
    const { proc, llamadas } = await armar();
    await proc(ctx({ periodo: "202601" }) as never);
    expect(llamadas.map((l) => l.periodo)).toEqual([
      "202601",
      "202512",
      "202511",
      "202510",
      "202509",
      "202508",
      "202507",
      "202506",
      "202505",
      "202504",
      "202503",
      "202502",
    ]);
  });
});

describe("escritura única y resultado", () => {
  it("UNA llamada a registrarDeclaraciones con los 12 leídos, los «sin declaración» (vacío o ErrorDatos) y todas las presentaciones", async () => {
    const rectificatoria = {
      ...decl("202607", "2"),
      tipo: "rectificatoria" as const,
    };
    const { proc, escrituras } = await armar({
      "202610": [decl("202610", "10")],
      "202607": [decl("202607", "1"), rectificatoria],
      "202605": new ErrorDatos(),
      "202602": [],
    });
    h.registrar.mockImplementation(async () => {
      escrituras.n += 1;
      return 3;
    });
    const r = await proc(ctx({ periodo: PERIODO }) as never);

    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(escrituras.n).toBe(1);
    const e = h.registrar.mock.calls[0]![1] as {
      clienteId: string;
      trabajoId: string;
      periodoHasta: string;
      leidos: string[];
      sinDeclaracion: string[];
      declaraciones: { periodo: string; numeroOrden: string }[];
    };
    expect(e.clienteId).toBe(trabajo({}).clienteId);
    expect(e.trabajoId).toBe(trabajo({}).id);
    expect(e.periodoHasta).toBe(PERIODO);
    expect([...e.leidos].sort()).toEqual([...VENTANA].sort());
    // Con datos solo 202610 y 202607: los otros 10 (lista vacía, ErrorDatos incluido) quedan «sin declaración».
    expect([...e.sinDeclaracion].sort()).toEqual(
      VENTANA.filter((p) => p !== "202610" && p !== "202607").sort(),
    );
    expect(
      e.declaraciones.map((d) => `${d.periodo}/${d.numeroOrden}`).sort(),
    ).toEqual(["202607/1", "202607/2", "202610/10"]);
    // Solo conteos enteros, nunca el RUC ni datos del PDT (D-7).
    expect(r).toEqual({ periodosLeidos: 12, sinDeclaracion: 10, nuevas: 3 });
    expect(JSON.stringify(r)).not.toContain(RUC);
    expect(Object.values(r).every((v) => Number.isInteger(v))).toBe(true);
  });

  it("la escritura ocurre dentro de UNA transacción de withTenant y después de todas las llamadas al puerto", async () => {
    const { proc, solPortal } = await armar({ "202610": [decl("202610")] });
    const ordenes: string[] = [];
    solPortal.obtenerDeclaraciones621.mockImplementation(async (_c, o) => {
      ordenes.push(`puerto:${o.periodo}`);
      return o.periodo === "202610" ? [decl("202610")] : [];
    });
    h.registrar.mockImplementation(async () => {
      ordenes.push(`registrar:abiertas=${h.abiertas}`);
      return 1;
    });
    await proc(ctx({ periodo: PERIODO }) as never);
    expect(ordenes.at(-1)).toBe("registrar:abiertas=1");
    expect(ordenes.filter((o) => o.startsWith("registrar"))).toHaveLength(1);
    expect(ordenes.slice(0, 12).every((o) => o.startsWith("puerto:"))).toBe(
      true,
    );
  });

  it("todo «sin declaración»: igual registra la obtención (12 leídos, 12 sin declaración, 0 presentaciones)", async () => {
    const { proc } = await armar();
    const r = await proc(ctx({ periodo: PERIODO }) as never);
    const e = h.registrar.mock.calls[0]![1] as {
      sinDeclaracion: string[];
      declaraciones: unknown[];
    };
    expect(e.sinDeclaracion).toHaveLength(12);
    expect(e.declaraciones).toEqual([]);
    expect(r).toEqual({ periodosLeidos: 12, sinDeclaracion: 12, nuevas: 0 });
  });
});

describe("errores del puerto: salen tal cual y sin escribir", () => {
  it.each([
    ["ErrorCredencial", () => new ErrorCredencial()],
    ["ErrorTransitorio", () => new ErrorTransitorio()],
    ["ErrorPortal", () => new ErrorPortal()],
    ["Error genérico con datos", () => new Error(`portal: ${RUC} 31415926.53`)],
  ])(
    "%s a mitad de la ventana se propaga idéntico; no se escribe ni se sigue leyendo",
    async (_n, fabrica) => {
      const falla = fabrica();
      const { proc, llamadas } = await armar({ "202606": falla });
      await expect(proc(ctx({ periodo: PERIODO }) as never)).rejects.toBe(
        falla,
      );
      expect(llamadas.map((l) => l.periodo)).toEqual(VENTANA.slice(0, 5));
      expect(h.registrar).not.toHaveBeenCalled();
    },
  );

  it("ErrorDatos de un periodo NO corta: sigue con los demás", async () => {
    const { proc, llamadas } = await armar({ "202609": new ErrorDatos() });
    await proc(ctx({ periodo: PERIODO }) as never);
    expect(llamadas).toHaveLength(12);
    expect(h.registrar).toHaveBeenCalledTimes(1);
  });
});

describe("la escritura la rechaza la BD", () => {
  it("55000 (cliente archivado entre medio): el trabajo termina sin lanzar y no cuenta nuevas", async () => {
    const { proc } = await armar({ "202610": [decl("202610")] });
    h.registrar.mockRejectedValue(new h.ProrrataRepoError("55000"));
    const r = await proc(ctx({ periodo: PERIODO }) as never);
    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r ?? {})).not.toContain(RUC);
    expect((r as { nuevas?: unknown } | undefined)?.nuevas ?? 0).toBe(0);
  });

  it.each(["P0002", "42501", "40001", "desconocido"])(
    "%s no se traga: el trabajo falla para que 008 lo clasifique",
    async (codigo) => {
      const { proc } = await armar({ "202610": [decl("202610")] });
      h.registrar.mockRejectedValue(new h.ProrrataRepoError(codigo));
      await expect(
        proc(ctx({ periodo: PERIODO }) as never),
      ).rejects.toBeInstanceOf(Error);
    },
  );
});

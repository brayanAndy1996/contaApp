// Spec 023, T15 (cobertura): ramas del programador del buzón que la integración no recorre. BD y portal son dobles:
// cola sin configurar, fallo general del ciclo, fallo de liberar el candado, trabajo que desaparece y pérdida del candado.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ciclo: {
    ahora: new Date("2026-11-17T15:00:00Z"),
    reservaInteractiva: 0,
    loteEstudio: 10,
  } as unknown,
  estudios: [] as { tenantId: string; frecuenciaMin: number }[],
  config: new Map<string, { maxPendientesTenant: number }>(),
  renovar: vi.fn(async (): Promise<boolean> => true),
  soltar: vi.fn(async (): Promise<void> => undefined),
  estudiosFalla: null as { valor: unknown } | null,
  encolados: vi.fn(async (): Promise<string[]> => []),
  trabajo: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  tomarCiclo: vi.fn(async () => h.ciclo),
  estudiosBuzon: vi.fn(async () => {
    if (h.estudiosFalla !== null) throw h.estudiosFalla.valor;
    return h.estudios;
  }),
  leerConfig: vi.fn(async () => h.config),
  renovarCiclo: h.renovar,
  soltarCiclo: h.soltar,
  contarPendientes: vi.fn(async () => 0),
  candidatosBuzon: vi.fn(async () => [
    {
      clienteId: "0190a000-0000-7000-8000-0000000000c1",
      ultimaProgramadaEn: null,
    },
  ]),
  encolarBuzonProgramados: h.encolados,
  leerTrabajo: h.trabajo,
}));

import { programarBuzon } from "./programar-buzon.js";

const T1 = "0190a000-0000-7000-8000-0000000000e1";
const T2 = "0190a000-0000-7000-8000-0000000000e2";

function logger() {
  const eventos: { nivel: string; e: Record<string, unknown> }[] = [];
  const reg = (nivel: string) => (e: Record<string, unknown>) => {
    eventos.push({ nivel, e });
  };
  return {
    eventos,
    log: {
      debug: reg("debug"),
      info: reg("info"),
      warn: reg("warn"),
      error: reg("error"),
    } as never,
  };
}
const db = {
  withSistema: async (f: (tx: unknown) => unknown) => f({}),
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f({}),
} as never;

beforeEach(() => {
  h.estudios = [{ tenantId: T1, frecuenciaMin: 720 }];
  h.config = new Map([["sol", { maxPendientesTenant: 50 }]]);
  h.estudiosFalla = null;
  h.renovar.mockReset();
  h.renovar.mockResolvedValue(true);
  h.soltar.mockReset();
  h.soltar.mockResolvedValue(undefined);
  h.encolados.mockReset();
  h.encolados.mockResolvedValue([]);
  h.trabajo.mockReset();
  h.trabajo.mockResolvedValue(null);
});

describe("programarBuzon: ramas de error", () => {
  it("sin configuración de la cola `sol`: registra el error, no atiende estudios y suelta el candado", async () => {
    h.config = new Map();
    const { eventos, log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r).toEqual({
      tomado: true,
      estudios: 0,
      encolados: 0,
      perdioCandado: false,
    });
    expect(eventos).toContainEqual({
      nivel: "error",
      e: { evento: "buzon_ciclo_sin_cola", codigo: "cola_sin_configurar" },
    });
    expect(h.encolados).not.toHaveBeenCalled();
    expect(h.soltar).toHaveBeenCalledTimes(1);
  });

  it("un fallo general del ciclo se registra solo con su código y el ciclo termina sin lanzar", async () => {
    h.estudiosFalla = {
      valor: Object.assign(new Error("detalle con CLAVE-SOL"), {
        codigo: "storage_io",
      }),
    };
    const { eventos, log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r.tomado).toBe(true);
    expect(eventos).toContainEqual({
      nivel: "error",
      e: { evento: "buzon_ciclo_fallo", codigo: "storage_io" },
    });
    expect(JSON.stringify(eventos)).not.toContain("CLAVE-SOL");
    expect(h.soltar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["una cadena", "boom"],
    ["null", null],
    ["código no textual", { codigo: 5 }],
  ])(
    "un fallo general sin código (%s) se registra como «desconocido»",
    async (_n, falla) => {
      h.estudiosFalla = { valor: falla };
      const { eventos, log } = logger();
      await programarBuzon({ db, logger: log })();
      expect(eventos).toContainEqual({
        nivel: "error",
        e: { evento: "buzon_ciclo_fallo", codigo: "desconocido" },
      });
    },
  );

  it("si soltar el candado falla, el ciclo igual termina y devuelve su resultado", async () => {
    h.soltar.mockRejectedValue(new Error("BD caída"));
    const { eventos, log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r).toEqual({
      tomado: true,
      estudios: 1,
      encolados: 0,
      perdioCandado: false,
    });
    expect(eventos.at(-1)?.e).toMatchObject({
      evento: "buzon_ciclo_terminado",
      estudios: 1,
    });
  });

  it("un trabajo encolado que ya no se puede leer no cuenta como encolado", async () => {
    h.encolados.mockResolvedValue(["j-1", "j-2"]);
    h.trabajo.mockResolvedValue(null);
    const { log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r.encolados).toBe(0);
    expect(h.trabajo).toHaveBeenCalledTimes(2);
  });

  it("si renovar el candado da `false`, se detiene tras ese estudio y no atiende el siguiente", async () => {
    h.estudios = [
      { tenantId: T1, frecuenciaMin: 720 },
      { tenantId: T2, frecuenciaMin: 720 },
    ];
    h.renovar.mockResolvedValue(false);
    const { eventos, log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r).toEqual({
      tomado: true,
      estudios: 1,
      encolados: 0,
      perdioCandado: true,
    });
    expect(h.encolados).toHaveBeenCalledTimes(1);
    expect(eventos).toContainEqual({
      nivel: "warn",
      e: { evento: "buzon_ciclo_candado_perdido", codigo: "candado_perdido" },
    });
  });

  it("el fallo de un estudio no tumba a los demás y solo se registra con su código", async () => {
    h.estudios = [
      { tenantId: T1, frecuenciaMin: 720 },
      { tenantId: T2, frecuenciaMin: 720 },
    ];
    h.encolados.mockRejectedValueOnce(
      Object.assign(new Error("x"), { codigo: "42501" }),
    );
    const { eventos, log } = logger();
    const r = await programarBuzon({ db, logger: log })();
    expect(r.estudios).toBe(1);
    expect(eventos).toContainEqual({
      nivel: "warn",
      e: { evento: "buzon_estudio_fallo", tenant_id: T1, codigo: "42501" },
    });
  });
});

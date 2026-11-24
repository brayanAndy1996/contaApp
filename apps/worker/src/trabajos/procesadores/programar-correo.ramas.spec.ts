// Spec 028, T5 (rojo): ramas del ciclo `correo.programar` sin BD (BD y repositorio son dobles): candado ocupado, avisos y resumen apagados
// por el plan, día sin resumen, fallo de un estudio, pérdida del candado, fallo general y fallo de soltar. Contrato de los nombres del
// repositorio: T4 (`tomarCicloCorreo`, `estudiosCorreo`, `renovarCicloCorreo`, `soltarCicloCorreo`, `cerrarResumenCorreo`,
// `encolarAvisosCorreo`, `crearResumenesCorreo`). Eventos de log que fija (solo estudio, conteos y códigos): `correo_estudio_fallo`
// (warn), `correo_ciclo_candado_perdido` (warn), `correo_ciclo_fallo` (error) y `correo_ciclo_terminado` (info).
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ciclo: { resumenDia: null } as { resumenDia: string | null } | null,
  estudios: [] as { tenantId: string; avisos: boolean; resumen: boolean }[],
  estudiosFalla: null as { valor: unknown } | null,
  renovar: vi.fn(async (): Promise<boolean> => true),
  soltar: vi.fn(async (): Promise<void> => undefined),
  cerrar: vi.fn(async (): Promise<void> => undefined),
  encolar: vi.fn(async (): Promise<number> => 0),
  crear: vi.fn(async (): Promise<number> => 0),
  tomar: vi.fn(),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  tomarCicloCorreo: h.tomar,
  estudiosCorreo: vi.fn(async () => {
    if (h.estudiosFalla !== null) throw h.estudiosFalla.valor;
    return h.estudios;
  }),
  renovarCicloCorreo: h.renovar,
  soltarCicloCorreo: h.soltar,
  cerrarResumenCorreo: h.cerrar,
  encolarAvisosCorreo: h.encolar,
  crearResumenesCorreo: h.crear,
}));

import { programarCorreo } from "./programar-correo.js";

const T1 = "0190a000-0000-7000-8000-0000000000e1";
const T2 = "0190a000-0000-7000-8000-0000000000e2";
const DIA = "2026-11-24";
const TX = { query: vi.fn(async () => ({ rows: [] })) };

function logger() {
  const eventos: { nivel: string; e: Record<string, unknown> }[] = [];
  const reg = (nivel: string) => (e: Record<string, unknown>) => {
    eventos.push({ nivel, e });
  };
  return {
    eventos,
    log: { debug: reg("debug"), info: reg("info"), warn: reg("warn"), error: reg("error") } as never,
  };
}
const db = {
  withSistema: async (f: (tx: unknown) => unknown) => f(TX),
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(TX),
} as never;

beforeEach(() => {
  h.ciclo = { resumenDia: null };
  h.estudios = [{ tenantId: T1, avisos: true, resumen: true }];
  h.estudiosFalla = null;
  for (const m of [h.renovar, h.soltar, h.cerrar, h.encolar, h.crear, h.tomar]) m.mockReset();
  h.tomar.mockImplementation(async () => h.ciclo);
  h.renovar.mockResolvedValue(true);
  h.soltar.mockResolvedValue(undefined);
  h.cerrar.mockResolvedValue(undefined);
  h.encolar.mockResolvedValue(0);
  h.crear.mockResolvedValue(0);
});

describe("programarCorreo: ramas", () => {
  it("con el candado de otro no hace nada: ni estudios, ni encolado, ni soltar", async () => {
    h.ciclo = null;
    const r = await programarCorreo({ db })();
    expect(r).toEqual({
      tomado: false,
      estudios: 0,
      avisosEncolados: 0,
      resumenesCreados: 0,
      resumenDia: null,
      diaCerrado: false,
      perdioCandado: false,
    });
    expect(h.encolar).not.toHaveBeenCalled();
    expect(h.soltar).not.toHaveBeenCalled();
  });

  it("encola los avisos de cada estudio con el lote, crea los resúmenes del día, renueva tras cada estudio, cierra el día y suelta el candado", async () => {
    h.ciclo = { resumenDia: DIA };
    h.estudios = [
      { tenantId: T1, avisos: true, resumen: true },
      { tenantId: T2, avisos: true, resumen: true },
    ];
    h.encolar.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    h.crear.mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const r = await programarCorreo({ db, dueno: "dueno-1", lote: 250 })();
    expect(r).toEqual({
      tomado: true,
      estudios: 2,
      avisosEncolados: 5,
      resumenesCreados: 5,
      resumenDia: DIA,
      diaCerrado: true,
      perdioCandado: false,
    });
    expect(h.tomar).toHaveBeenCalledWith(expect.anything(), "dueno-1");
    expect(h.encolar).toHaveBeenCalledTimes(2);
    expect(h.encolar).toHaveBeenCalledWith(expect.anything(), 250);
    expect(h.crear).toHaveBeenCalledWith(expect.anything(), DIA);
    expect(h.renovar).toHaveBeenCalledTimes(2);
    expect(h.cerrar).toHaveBeenCalledOnce();
    expect(h.cerrar).toHaveBeenCalledWith(expect.anything(), "dueno-1", DIA);
    expect(h.soltar).toHaveBeenCalledWith(expect.anything(), "dueno-1");
  });

  it("el lote por omisión es 1000", async () => {
    await programarCorreo({ db })();
    expect(h.encolar).toHaveBeenCalledWith(expect.anything(), 1000);
  });

  it("un estudio con avisos apagados no encola; con el resumen apagado no crea, y ambos cuentan como atendidos (el día se cierra)", async () => {
    h.ciclo = { resumenDia: DIA };
    h.estudios = [
      { tenantId: T1, avisos: false, resumen: true },
      { tenantId: T2, avisos: true, resumen: false },
    ];
    h.encolar.mockResolvedValue(1);
    h.crear.mockResolvedValue(1);
    const r = await programarCorreo({ db })();
    expect(h.encolar).toHaveBeenCalledTimes(1);
    expect(h.crear).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ estudios: 2, avisosEncolados: 1, resumenesCreados: 1, diaCerrado: true });
  });

  it("sin `resumenDia` no crea resúmenes ni cierra el día", async () => {
    await programarCorreo({ db })();
    expect(h.crear).not.toHaveBeenCalled();
    expect(h.cerrar).not.toHaveBeenCalled();
  });

  it("el fallo de un estudio no tumba el ciclo, no cierra el día y el log lleva solo el estudio y un código", async () => {
    h.ciclo = { resumenDia: DIA };
    h.estudios = [
      { tenantId: T1, avisos: true, resumen: true },
      { tenantId: T2, avisos: true, resumen: true },
    ];
    h.encolar.mockRejectedValueOnce(Object.assign(new Error("CANARIO-correo@secreto.test"), { codigo: "40001" }));
    h.encolar.mockResolvedValueOnce(2);
    const { eventos, log } = logger();
    const r = await programarCorreo({ db, logger: log })();
    expect(r).toMatchObject({ tomado: true, estudios: 1, avisosEncolados: 2, diaCerrado: false });
    expect(h.cerrar).not.toHaveBeenCalled();
    expect(h.soltar).toHaveBeenCalledOnce();
    expect(eventos).toContainEqual({
      nivel: "warn",
      e: { evento: "correo_estudio_fallo", tenant_id: T1, codigo: "40001" },
    });
    expect(JSON.stringify(eventos)).not.toContain("CANARIO");
  });

  it("si pierde el candado se detiene sin atender más estudios ni cerrar el día", async () => {
    h.ciclo = { resumenDia: DIA };
    h.estudios = [
      { tenantId: T1, avisos: true, resumen: true },
      { tenantId: T2, avisos: true, resumen: true },
    ];
    h.encolar.mockResolvedValue(1);
    h.renovar.mockResolvedValueOnce(false);
    const { eventos, log } = logger();
    const r = await programarCorreo({ db, logger: log })();
    expect(r).toMatchObject({ tomado: true, estudios: 1, perdioCandado: true, diaCerrado: false });
    expect(h.encolar).toHaveBeenCalledTimes(1);
    expect(h.cerrar).not.toHaveBeenCalled();
    expect(eventos).toContainEqual({
      nivel: "warn",
      e: { evento: "correo_ciclo_candado_perdido", codigo: "candado_perdido" },
    });
  });

  it("un fallo al leer los estudios se registra con su código, no lanza y suelta el candado", async () => {
    h.estudiosFalla = { valor: Object.assign(new Error("CANARIO"), { codigo: "57P01" }) };
    const { eventos, log } = logger();
    const r = await programarCorreo({ db, logger: log })();
    expect(r).toMatchObject({ tomado: true, estudios: 0, diaCerrado: false });
    expect(eventos).toContainEqual({ nivel: "error", e: { evento: "correo_ciclo_fallo", codigo: "57P01" } });
    expect(JSON.stringify(eventos)).not.toContain("CANARIO");
    expect(h.soltar).toHaveBeenCalledOnce();
  });

  it("un error sin código sale como «desconocido»; un fallo al soltar el candado no tumba el ciclo", async () => {
    h.estudiosFalla = { valor: "texto suelto" };
    h.soltar.mockRejectedValueOnce(new Error("no se pudo soltar"));
    const { eventos, log } = logger();
    await expect(programarCorreo({ db, logger: log })()).resolves.toMatchObject({ tomado: true });
    expect(eventos).toContainEqual({ nivel: "error", e: { evento: "correo_ciclo_fallo", codigo: "desconocido" } });
  });

  it("el log final lleva solo conteos y banderas", async () => {
    h.estudios = [{ tenantId: T1, avisos: true, resumen: true }];
    h.encolar.mockResolvedValue(2);
    const { eventos, log } = logger();
    await programarCorreo({ db, logger: log })();
    const fin = eventos.find((x) => x.e.evento === "correo_ciclo_terminado")!;
    expect(fin.nivel).toBe("info");
    for (const v of Object.values(fin.e)) expect(["string", "number", "boolean"].includes(typeof v)).toBe(true);
    expect(fin.e).toMatchObject({ estudios: 1, avisos_encolados: 2, perdio_candado: false });
  });
});

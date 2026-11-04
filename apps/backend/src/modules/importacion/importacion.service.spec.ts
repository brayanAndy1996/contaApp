// Spec 007b (T12) · `ImportacionService` sin BD: proyección HTTP de la vista previa, errores del archivo y permisos.
// El orden de bloqueo, el cupo, el cifrado con AAD final y la cola los cubren las pruebas de integración de T4.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/shared", async (original) => ({
  ...(await original<typeof import("@contapp/shared")>()),
  tienePermiso: vi.fn(),
}));
vi.mock("./lector-csv.js", async (original) => ({
  ...(await original<typeof import("./lector-csv.js")>()),
  leerCsv: vi.fn(),
}));
vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  listarMiembros: vi.fn(),
  rucsExistentes: vi.fn(),
  bloquearMiembros: vi.fn(),
  crearCliente: vi.fn(),
  guardarSobre: vi.fn(),
  asignar: vi.fn(),
}));

import { bloquearMiembros, crearCliente, listarMiembros, rucsExistentes } from "@contapp/db";
import { tienePermiso } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { csv, CABECERA, filaDatos, rucConPrefijo } from "../../../test/soporte-importacion.js";
import { ImportacionService } from "./importacion.service.js";
import { leerCsv } from "./lector-csv.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const ACTOR = "0190a000-0000-7000-8000-0000000000b1";
const sesion = { tenantActivo: TENANT, usuarioId: ACTOR } as SesionResuelta;
const TX = { tx: true };
const cupo = { libres: vi.fn(), reservar: vi.fn() };
const encolador = { encolarLote: vi.fn() };
const wrapper = vi.fn();

function armar() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn(TX)));
  return { withTenant, servicio: new ImportacionService({ withTenant } as never, cupo as never, wrapper as never, encolador as never) };
}
const archivo = (...filas: Array<Parameters<typeof filaDatos>[0]>) => Buffer.from(csv([[...CABECERA], ...filas.map(filaDatos)]));
const miembro = (rol: string) => ({ usuarioId: ACTOR, nombre: "A", correo: "a@x.test", rol, activo: true });
const RUC_A = rucConPrefijo("20", 123);
const RUC_B = rucConPrefijo("20", 124);

beforeEach(async () => {
  vi.resetAllMocks();
  const { tienePermiso: real } = await vi.importActual<typeof import("@contapp/shared")>("@contapp/shared");
  const { leerCsv: csvReal } = await vi.importActual<typeof import("./lector-csv.js")>("./lector-csv.js");
  vi.mocked(tienePermiso).mockImplementation(real);
  vi.mocked(leerCsv).mockImplementation(csvReal);
  vi.mocked(listarMiembros).mockResolvedValue([miembro("dueno")] as never);
  vi.mocked(rucsExistentes).mockResolvedValue([{ ruc: RUC_B, archivado: true }]);
  cupo.libres.mockResolvedValue(5);
});

describe("vistaPrevia", () => {
  it("proyecta los motivos a string[] y marca `archivado` en la fila; no escribe ni cifra nada", async () => {
    const r = await armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A, usuarioSol: "U", claveSol: "K" }, { ruc: RUC_B }));
    expect(r.filas).toEqual([
      { n: 2, ruc: RUC_A, estado: "valida", motivos: [], tieneSol: true, tieneSire: false },
      { n: 3, ruc: RUC_B, estado: "error", motivos: ["duplicado"], tieneSol: false, tieneSire: false, archivado: true },
    ]);
    expect(r).toMatchObject({ validas: 1, conError: 1, cupoLibre: 5, excedentes: 0 });
    expect(JSON.stringify(r)).not.toContain('"K"');
    expect(crearCliente).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
  });

  it("un cuerpo que no es un archivo (sin Buffer, vacío o que supera 2 MB) es 400/413 sin abrir transacción", async () => {
    const { servicio, withTenant } = armar();
    await expect(servicio.vistaPrevia(sesion, {})).rejects.toMatchObject({ response: { codigo: "archivo_invalido" }, status: 400 });
    await expect(servicio.vistaPrevia(sesion, Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toMatchObject({
      response: { codigo: "archivo_demasiado_grande" },
      status: 413,
    });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("sin estudio activo: estudio_requerido; un actor sin clientes.crear (asistente): permiso_denegado", async () => {
    await expect(
      armar().servicio.vistaPrevia({ tenantActivo: null, usuarioId: ACTOR } as SesionResuelta, archivo({ ruc: RUC_A })),
    ).rejects.toMatchObject({ codigo: "estudio_requerido" });
    vi.mocked(listarMiembros).mockResolvedValue([miembro("asistente")] as never);
    await expect(armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A }))).rejects.toMatchObject({ codigo: "permiso_denegado" });
  });
});

describe("confirmar", () => {
  it("un actor sin clientes.crear recibe permiso_denegado antes de cifrar o crear nada", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([miembro("lectura")] as never);
    await expect(armar().servicio.confirmar(sesion, archivo({ ruc: RUC_A, usuarioSol: "U", claveSol: "K" }))).rejects.toMatchObject({
      codigo: "permiso_denegado",
    });
    expect(wrapper).not.toHaveBeenCalled();
    expect(crearCliente).not.toHaveBeenCalled();
  });
});

describe("permisos y errores internos", () => {
  it("un actor que ya no es miembro del estudio recibe estudio_requerido; sin credenciales.editar y con claves, permiso_denegado", async () => {
    vi.mocked(listarMiembros).mockResolvedValue([] as never);
    await expect(armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A }))).rejects.toMatchObject({ codigo: "estudio_requerido" });

    vi.mocked(listarMiembros).mockResolvedValue([miembro("dueno")] as never);
    vi.mocked(tienePermiso).mockImplementation((_rol, permiso) => permiso === "clientes.crear");
    await expect(armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A, usuarioSol: "U", claveSol: "K" }))).rejects.toMatchObject({
      codigo: "permiso_denegado",
    });
    // Sin claves en el archivo, clientes.crear basta.
    await expect(armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A }))).resolves.toMatchObject({ validas: 1 });
  });

  it("si en la transacción el actor ya no está (bloqueo vacío), confirmar responde estudio_requerido y no crea nada", async () => {
    const { bloquearMiembros: bloquear } = await import("@contapp/db");
    vi.mocked(bloquear).mockResolvedValue(new Map());
    await expect(armar().servicio.confirmar(sesion, archivo({ ruc: RUC_A }))).rejects.toMatchObject({ codigo: "estudio_requerido" });
    expect(crearCliente).not.toHaveBeenCalled();
    expect(cupo.reservar).not.toHaveBeenCalled();
  });

  it("un fallo de cifrado se reduce a 500 {codigo: error_interno} sin el secreto, antes de abrir la transacción de escritura", async () => {
    const { servicio, withTenant } = armar();
    wrapper.mockImplementation(() => {
      throw new Error("falla con CANARIO-secreto");
    });
    const e = await servicio.confirmar(sesion, archivo({ ruc: RUC_A, usuarioSol: "U", claveSol: "CANARIO-secreto" })).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 500, response: { codigo: "error_interno" } });
    expect(JSON.stringify(e)).not.toContain("CANARIO-secreto");
    expect(withTenant).toHaveBeenCalledTimes(1); // solo la lectura previa
    expect(vi.mocked(bloquearMiembros)).not.toHaveBeenCalled();
  });

  it("un lector que falla con un error sin tipo se responde como archivo_invalido (400), nunca 500", async () => {
    vi.mocked(leerCsv).mockImplementation(() => {
      throw new TypeError("bug del lector con CANARIO-celda");
    });
    const e = await armar().servicio.vistaPrevia(sesion, archivo({ ruc: RUC_A })).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 400, response: { codigo: "archivo_invalido" } });
    expect(JSON.stringify(e)).not.toContain("CANARIO-celda");
  });
});

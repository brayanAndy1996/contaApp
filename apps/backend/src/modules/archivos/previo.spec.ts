// Spec 012b (T16a) · `calcularPrevio` sin BD: un `DineroError` que escape de `prepararArchivo` (un monto o una suma que no cabe en
// NUMERIC(14,2)) sale como 422 `resumen_fuera_de_rango` en ambos libros, nunca como 500; cualquier otro error se propaga tal cual.
// El dominio ya contiene casi todos los desbordes (CUADRE, `filasSinConvertir`, `EntradaPrevalidacionInvalidaError`), así que la
// integración no puede provocar este camino con filas reales: aquí se fuerza en la frontera. El resto lo cubren los `*.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerClienteDto: vi.fn(),
  leerEstadoPeriodo: vi.fn(),
  leerEstadoPeriodoVentas: vi.fn(),
  leerFilasReemplazo: vi.fn(),
  leerFilasReemplazoVentas: vi.fn(),
  leerProveedoresConocidos: vi.fn(),
  listarJustificados: vi.fn(),
}));
vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  prepararArchivo: vi.fn(),
}));
vi.mock("../compras/apoyo.js", async (original) => ({
  ...(await original<typeof import("../compras/apoyo.js")>()),
  exigirCliente: vi.fn().mockResolvedValue(undefined),
}));

import {
  leerClienteDto,
  leerEstadoPeriodo,
  leerEstadoPeriodoVentas,
  leerFilasReemplazo,
  leerFilasReemplazoVentas,
  leerProveedoresConocidos,
  listarJustificados,
  type Alcance,
} from "@contapp/db";
import { EntradaPrevalidacionInvalidaError, MontoFueraDeRangoError, prepararArchivo } from "@contapp/domain";
import { calcularPrevio } from "./previo.js";

const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const alcance: Alcance = { tipo: "global" };
const tx = { tx: true } as never;
const entrada = (libro: "compras" | "ventas") => ({ alcance, clienteId: CLIENTE, periodo: "202610", libro, nodeEnv: "test" });
const estadoAbierto = { estado: "abierto", marcadoPor: null, marcadoEn: null };

beforeEach(() => {
  vi.mocked(leerClienteDto).mockResolvedValue({ ruc: "20100000001", archivado: false } as never);
  vi.mocked(leerEstadoPeriodo).mockResolvedValue(estadoAbierto as never);
  vi.mocked(leerEstadoPeriodoVentas).mockResolvedValue(estadoAbierto as never);
  vi.mocked(leerFilasReemplazo).mockResolvedValue({ original: [], vigente: [] } as never);
  vi.mocked(leerFilasReemplazoVentas).mockResolvedValue({ original: [], vigente: [] } as never);
  vi.mocked(leerProveedoresConocidos).mockResolvedValue([] as never);
  vi.mocked(listarJustificados).mockResolvedValue([] as never);
  vi.mocked(prepararArchivo).mockReset();
});

describe.each(["compras", "ventas"] as const)("calcularPrevio de %s · montos fuera de NUMERIC(14,2)", (libro) => {
  it("un DineroError del dominio es 422 resumen_fuera_de_rango", async () => {
    vi.mocked(prepararArchivo).mockImplementation(() => {
      throw new MontoFueraDeRangoError();
    });
    await expect(calcularPrevio(tx, entrada(libro))).rejects.toMatchObject({ codigo: "resumen_fuera_de_rango" });
    await expect(calcularPrevio(tx, entrada(libro))).rejects.toMatchObject({ status: 422 });
  });

  it("otro error del dominio no se disfraza de resumen_fuera_de_rango: se propaga", async () => {
    const falla = new EntradaPrevalidacionInvalidaError();
    vi.mocked(prepararArchivo).mockImplementation(() => {
      throw falla;
    });
    await expect(calcularPrevio(tx, entrada(libro))).rejects.toBe(falla);
  });
});

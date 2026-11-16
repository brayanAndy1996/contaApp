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
  ultimaVersion: vi.fn(),
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
  ultimaVersion,
  type Alcance,
} from "@contapp/db";
import {
  EntradaPrevalidacionInvalidaError,
  Money,
  MontoFueraDeRangoError,
  prepararArchivo,
  type ArchivoPreparado,
  type AvisoArchivo,
} from "@contapp/domain";
import { MAX_ITEMS_PREVIO, previoArchivoSchema } from "@contapp/shared";
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
  vi.mocked(ultimaVersion).mockResolvedValue(null as never);
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

// Spec 022 (T7, RP-4, CA-10, D-5): el previo lleva como mucho 1.000 avisos (los primeros, en el orden de `prepararArchivo`) y cuenta
// el resto en `avisosOmitidos`, como `errores` y `excluidas`. Solo se corta el DTO: el `ArchivoPreparado` (lo que usa `generar`) y
// la huella (`sha256Hex(canon)`) no cambian.
const avisosFalsos = (n: number): AvisoArchivo[] =>
  Array.from({ length: n }, (_, i) => ({ filaId: null, codigo: "SALTO_CORRELATIVIDAD", explicacion: `aviso ${i}` }) as AvisoArchivo);

const preparadoConAvisos = (avisos: AvisoArchivo[]): ArchivoPreparado =>
  ({
    resultado: { apto: true, errores: [], formato: { id: "provisional-rce", version: "1", oficial: false } },
    resumen: { modificadas: 0, excluidas: 0, agregadas: 0, impactoIgv: { total: Money.cero("PEN") }, filasSinConvertir: [] },
    avisos,
    generable: true,
    motivo: null,
    canon: "canon-fijo",
  }) as unknown as ArchivoPreparado;

describe("calcularPrevio · CA-10 tope de avisos (022 T7)", () => {
  it("5.000 avisos: viajan los primeros 1.000 en su orden y 4.000 cuentan en avisosOmitidos", async () => {
    const avisos = avisosFalsos(5000);
    vi.mocked(prepararArchivo).mockReturnValue(preparadoConAvisos(avisos));
    const { dto } = await calcularPrevio(tx, entrada("compras"));
    expect(dto.avisos).toHaveLength(MAX_ITEMS_PREVIO);
    expect(dto.avisos.map((a) => a.explicacion)).toEqual(avisos.slice(0, MAX_ITEMS_PREVIO).map((a) => a.explicacion));
    expect(dto.avisosOmitidos).toBe(4000);
    expect(previoArchivoSchema.safeParse(dto).success).toBe(true);
  });

  it("con 1.000 avisos o menos, avisosOmitidos es 0 y no se pierde ninguno", async () => {
    for (const n of [0, 1, 1000]) {
      vi.mocked(prepararArchivo).mockReturnValue(preparadoConAvisos(avisosFalsos(n)));
      const { dto } = await calcularPrevio(tx, entrada("compras"));
      expect(dto.avisos).toHaveLength(n);
      expect(dto.avisosOmitidos).toBe(0);
    }
  });

  it("con 1.001 avisos, 1.000 viajan y 1 se omite", async () => {
    vi.mocked(prepararArchivo).mockReturnValue(preparadoConAvisos(avisosFalsos(1001)));
    const { dto } = await calcularPrevio(tx, entrada("compras"));
    expect(dto.avisos).toHaveLength(1000);
    expect(dto.avisosOmitidos).toBe(1);
  });

  it("la huella no depende del corte: es la de `canon` con 5.000 avisos o con 0", async () => {
    vi.mocked(prepararArchivo).mockReturnValue(preparadoConAvisos(avisosFalsos(5000)));
    const con = await calcularPrevio(tx, entrada("compras"));
    vi.mocked(prepararArchivo).mockReturnValue(preparadoConAvisos([]));
    const sin = await calcularPrevio(tx, entrada("compras"));
    expect(con.dto.huella).toBe(sin.dto.huella);
  });
});

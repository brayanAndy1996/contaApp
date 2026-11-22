// Spec 027 (T14a): ramas del módulo de gastos del backend que las rutas HTTP no alcanzan con datos reales (traducción de SQLSTATE a
// HTTP, normalización de lo que escribe el usuario, proveedores del periodo y la lectura de categorías si el cliente desaparece entre
// la comprobación de acceso y la lectura). Sin BD: el repositorio se reemplaza por dobles.
import { AuthRepoError, GastosRepoError } from "@contapp/db";
import { describe, expect, it, vi } from "vitest";
import { AccesoError } from "../acceso/errores.js";
import { proveedoresValidos } from "./contexto.js";
import { aErrorHttp, esSqlstate, GastosError } from "./errores.js";
import { normalizarExcepciones, normalizarPalabraGnd } from "./normalizar.js";

const leerCategoriasCliente = vi.hoisted(() => vi.fn());
vi.mock("@contapp/db", async (importar) => ({
  ...(await importar<typeof import("@contapp/db")>()),
  leerCategoriasCliente,
}));
vi.mock("../compras/apoyo.js", () => ({
  exigirCliente: vi.fn(async () => undefined),
}));

describe("aErrorHttp: SQLSTATE de 0070 a HTTP (plan 027, «Mapeo»)", () => {
  it.each([
    ["P0002", AccesoError, "no_encontrado", 404],
    ["55000", AccesoError, "cliente_archivado", 409],
    ["CA409", GastosError, "version_cambiada", 409],
    ["CA420", GastosError, "palabra_existente", 409],
    ["CA421", GastosError, "limite_palabras", 409],
    ["CA422", GastosError, "compra_no_excluida", 409],
    ["CA423", GastosError, "compra_sin_xml", 409],
    ["22023", AccesoError, "solicitud_invalida", 400],
    ["42501", AccesoError, "permiso_denegado", 403],
  ] as const)("%s -> %s", (sqlstate, clase, codigo, estado) => {
    for (const origen of [
      new GastosRepoError(sqlstate),
      new AuthRepoError(sqlstate),
    ]) {
      const e = aErrorHttp(origen);
      expect(e).toBeInstanceOf(clase);
      expect((e as { codigo: string }).codigo).toBe(codigo);
      expect((e as { getStatus(): number }).getStatus()).toBe(estado);
      // El cuerpo es solo { codigo }: sin mensaje de BD, SQLSTATE ni detalle.
      expect((e as { getResponse(): unknown }).getResponse()).toEqual({
        codigo,
      });
    }
  });

  it("un SQLSTATE desconocido y un error de otra clase pasan tal cual", () => {
    const desconocido = new GastosRepoError("desconocido");
    const otro = new Error("boom");
    expect(aErrorHttp(desconocido)).toBe(desconocido);
    expect(aErrorHttp(new GastosRepoError("40P01"))).toBeInstanceOf(
      GastosRepoError,
    );
    expect(aErrorHttp(otro)).toBe(otro);
    expect(aErrorHttp(null)).toBeNull();
    expect(aErrorHttp("42501")).toBe("42501");
  });

  it("esSqlstate compara el SQLSTATE de los dos repositorios y es falso para otros errores", () => {
    expect(esSqlstate(new GastosRepoError("22023"), "22023")).toBe(true);
    expect(esSqlstate(new AuthRepoError("22023"), "22023")).toBe(true);
    expect(esSqlstate(new GastosRepoError("22023"), "42501")).toBe(false);
    expect(
      esSqlstate(Object.assign(new Error("x"), { codigo: "22023" }), "22023"),
    ).toBe(false);
    expect(esSqlstate(undefined, "22023")).toBe(false);
  });
});

describe("proveedoresValidos", () => {
  it("descarta tipos y números fuera de la gramática del dominio y los repetidos, en su orden", () => {
    expect(
      proveedoresValidos([
        { tipo: "6", numero: "20100070970" },
        { tipo: "6", numero: "20100070970" },
        { tipo: "", numero: "20100070971" },
        { tipo: "66", numero: "20100070972" },
        { tipo: "a", numero: "20100070973" },
        { tipo: "A", numero: "ABC-123" },
        { tipo: "6", numero: "" },
        { tipo: "6", numero: "1234567890123456" },
        { tipo: "6", numero: "con espacio" },
        { tipo: "1", numero: "12345678" },
      ]),
    ).toEqual([
      { tipo: "6", numero: "20100070970" },
      { tipo: "A", numero: "ABC-123" },
      { tipo: "1", numero: "12345678" },
    ]);
  });

  it("sin proveedores devuelve lista vacía", () => {
    expect(proveedoresValidos([])).toEqual([]);
  });

  it("no comparte objetos con la entrada (copia solo tipo y número)", () => {
    const entrada = { tipo: "6", numero: "20100070970", extra: "no" };
    const [salida] = proveedoresValidos([entrada]);
    expect(salida).toEqual({ tipo: "6", numero: "20100070970" });
    expect(salida).not.toBe(entrada);
  });
});

describe("normalizarPalabraGnd (R-4)", () => {
  it("normaliza a un solo token [a-z0-9] de 3 a 40 caracteres", () => {
    expect(normalizarPalabraGnd("  Zapatilla ")).toBe("zapatilla");
    expect(normalizarPalabraGnd("ÑANDÚ")).toBe("nandu");
    expect(normalizarPalabraGnd("abc")).toBe("abc");
    expect(normalizarPalabraGnd("a".repeat(40))).toBe("a".repeat(40));
  });

  it.each([
    ["vacía", ""],
    ["solo símbolos", "$$$"],
    ["dos palabras", "dos palabras"],
    ["2 letras", "ab"],
    ["41 letras", "a".repeat(41)],
    ["con punto final (abreviatura)", "zapat."],
    ["decimal", "1.50"],
  ])("rechaza %s con 400 solicitud_invalida", (_n, texto) => {
    expect(() => normalizarPalabraGnd(texto)).toThrow(AccesoError);
    try {
      normalizarPalabraGnd(texto);
    } catch (e) {
      expect((e as AccesoError).codigo).toBe("solicitud_invalida");
      expect((e as AccesoError).getResponse()).toEqual({
        codigo: "solicitud_invalida",
      });
    }
  });
});

describe("normalizarExcepciones (R-4)", () => {
  it("sin frases devuelve lista vacía", () => {
    expect(normalizarExcepciones(undefined)).toEqual([]);
    expect(normalizarExcepciones([])).toEqual([]);
  });

  it("normaliza cada frase de 1 a 3 palabras, quita el punto final y no repite", () => {
    expect(
      normalizarExcepciones(["Para  Niños", "para ninos", "zapat.", "A B C"]),
    ).toEqual(["para ninos", "zapat", "a b c"]);
  });

  it.each([
    ["frase vacía", [""]],
    ["solo símbolos", ["***"]],
    ["más de 3 palabras", ["uno dos tres cuatro"]],
    ["número decimal", ["talla 1.50"]],
    ["una buena y una mala", ["valida", "uno dos tres cuatro"]],
  ])("rechaza %s con 400 solicitud_invalida", (_n, frases) => {
    try {
      normalizarExcepciones(frases);
      throw new Error("no lanzó");
    } catch (e) {
      expect(e).toBeInstanceOf(AccesoError);
      expect((e as AccesoError).codigo).toBe("solicitud_invalida");
    }
  });
});

describe("ClienteGastosService.leer: el cliente desaparece tras la comprobación de acceso", () => {
  it("si la lectura de categorías devuelve null responde 404 no_encontrado, el mismo de un cliente ajeno", async () => {
    const { ClienteGastosService } = await import("./cliente.service.js");
    leerCategoriasCliente.mockResolvedValueOnce(null);
    const servicio = new ClienteGastosService({
      withTenant: (_ctx: unknown, fn: (tx: never) => Promise<unknown>) =>
        fn({} as never),
    } as never);
    const sesion = {
      tenantActivo: "11111111-1111-4111-8111-111111111111",
      usuarioId: "22222222-2222-4222-8222-222222222222",
    };
    const e = await servicio
      .leer(
        sesion as never,
        { tipo: "global" } as never,
        "33333333-3333-4333-8333-333333333333",
      )
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(AccesoError);
    expect((e as AccesoError).codigo).toBe("no_encontrado");
    expect(leerCategoriasCliente).toHaveBeenCalledTimes(1);
  });
});

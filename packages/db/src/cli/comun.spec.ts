import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ejecutar, ErrorCli, mensajeSeguro, urlMigraciones } from "./comun";

// Valores de prueba generados para esta suite; no son credenciales reales.
const PASSWORD_FALSA = "hunter2-prueba";
const URL_CON_PASSWORD = `postgresql://postgres:${PASSWORD_FALSA}@localhost:5432/contapp`;

describe("urlMigraciones", () => {
  const original = process.env.MIGRATIONS_DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.MIGRATIONS_DATABASE_URL;
    else process.env.MIGRATIONS_DATABASE_URL = original;
  });

  it("devuelve el valor de MIGRATIONS_DATABASE_URL", () => {
    process.env.MIGRATIONS_DATABASE_URL = URL_CON_PASSWORD;
    expect(urlMigraciones()).toBe(URL_CON_PASSWORD);
  });

  it("falla con mensaje fijo si la variable falta o está vacía", () => {
    delete process.env.MIGRATIONS_DATABASE_URL;
    expect(() => urlMigraciones()).toThrow(ErrorCli);
    expect(() => urlMigraciones()).toThrow("falta MIGRATIONS_DATABASE_URL");
    process.env.MIGRATIONS_DATABASE_URL = "";
    expect(() => urlMigraciones()).toThrow("falta MIGRATIONS_DATABASE_URL");
  });
});

describe("mensajeSeguro", () => {
  it("un ErrorCli se muestra con su mensaje fijo", () => {
    expect(mensajeSeguro(new ErrorCli("falta DATABASE_URL"))).toBe(
      "falta DATABASE_URL",
    );
  });

  it("un error del servidor (severity + code) muestra SQLSTATE y mensaje", () => {
    const e = Object.assign(new Error('relation "x" does not exist'), {
      severity: "ERROR",
      code: "42P01",
    });
    expect(mensajeSeguro(e)).toBe(
      'PostgreSQL 42P01: relation "x" does not exist',
    );
  });

  it("usa la causa anidada de Drizzle y no filtra los parámetros de su mensaje", () => {
    const causa = Object.assign(
      new Error("permission denied for table cliente"),
      {
        severity: "ERROR",
        code: "42501",
      },
    );
    const drizzle = new Error(
      `Failed query: alter role contapp_app password '${PASSWORD_FALSA}'\nparams: ${PASSWORD_FALSA}`,
      { cause: causa },
    );
    const salida = mensajeSeguro(drizzle);
    expect(salida).toBe(
      "PostgreSQL 42501: permission denied for table cliente",
    );
    expect(salida).not.toContain(PASSWORD_FALSA);
  });

  it("sigue varias causas anidadas hasta la última", () => {
    const interna = Object.assign(new Error("fallo interno"), {
      severity: "FATAL",
      code: "28P01",
    });
    const e = new Error("externo", {
      cause: new Error("medio", { cause: interna }),
    });
    expect(mensajeSeguro(e)).toBe("PostgreSQL 28P01: fallo interno");
  });

  it("un error de red con la URL en el mensaje solo muestra el código, sin URL ni contraseña", () => {
    const e = Object.assign(
      new Error(`connect ECONNREFUSED ${URL_CON_PASSWORD}`),
      { code: "ECONNREFUSED" },
    );
    const salida = mensajeSeguro(e);
    expect(salida).toBe("error de conexion o de ejecucion (ECONNREFUSED)");
    expect(salida).not.toContain(PASSWORD_FALSA);
    expect(salida).not.toContain("postgresql://");
  });

  it("sin código ni severity usa 'desconocido' y nunca el mensaje original", () => {
    const e = new Error(`Invalid URL: ${URL_CON_PASSWORD}`);
    const salida = mensajeSeguro(e);
    expect(salida).toBe("error de conexion o de ejecucion (desconocido)");
    expect(salida).not.toContain(PASSWORD_FALSA);
  });

  it("severity sin code (o code que no es texto) no se trata como error del servidor", () => {
    expect(
      mensajeSeguro(
        Object.assign(new Error(URL_CON_PASSWORD), { severity: "ERROR" }),
      ),
    ).toBe("error de conexion o de ejecucion (desconocido)");
    expect(
      mensajeSeguro(
        Object.assign(new Error(URL_CON_PASSWORD), {
          severity: "ERROR",
          code: 42501,
        }),
      ),
    ).toBe("error de conexion o de ejecucion (desconocido)");
  });

  it("una causa que apunta al propio error no provoca recursión infinita", () => {
    const e = new Error(URL_CON_PASSWORD) as Error & { cause?: unknown };
    e.cause = e;
    expect(mensajeSeguro(e)).toBe(
      "error de conexion o de ejecucion (desconocido)",
    );
  });

  it("valores que no son Error (texto, null, undefined) dan 'desconocido'", () => {
    for (const valor of [URL_CON_PASSWORD, null, undefined, 42]) {
      const salida = mensajeSeguro(valor);
      expect(salida).toBe("error de conexion o de ejecucion (desconocido)");
      expect(salida).not.toContain(PASSWORD_FALSA);
    }
  });
});

describe("ejecutar", () => {
  const exitCodeOriginal = process.exitCode;
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = exitCodeOriginal;
    vi.restoreAllMocks();
  });

  const tarde = (fn: () => void) => async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 5));
    fn();
  };

  it("devuelve una promesa que se resuelve cuando termina fn, y registra 'nombre: OK'", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fn = vi.fn(tarde(() => undefined));
    const p = ejecutar("prueba", fn);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith("prueba: OK");
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("si fn rechaza: registra el mensaje seguro, fija exitCode = 1 y la promesa no rechaza", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const p = ejecutar(
      "prueba",
      tarde(() => {
        throw Object.assign(
          new Error(`connect ECONNREFUSED ${URL_CON_PASSWORD}`),
          {
            code: "ECONNREFUSED",
          },
        );
      }),
    );
    await expect(p).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "prueba: error de conexion o de ejecucion (ECONNREFUSED)",
    );
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls)).not.toContain(PASSWORD_FALSA);
  });

  it("un ErrorCli se informa con su mensaje fijo", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await ejecutar(
      "seed",
      tarde(() => {
        throw new ErrorCli("falta MIGRATIONS_DATABASE_URL");
      }),
    );
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "seed: falta MIGRATIONS_DATABASE_URL",
    );
    expect(process.exitCode).toBe(1);
  });
});

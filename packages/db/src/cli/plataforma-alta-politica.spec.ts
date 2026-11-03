// T15b (006) · piezas del CLI `db:plataforma-alta` que no cubren las pruebas de T15a: lista de comunes, política y stdin.
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ErrorCli } from "./comun";
import {
  RUTA_COMUNES,
  cargarComunes,
  leerStdinProceso,
  validarContrasenaNueva,
} from "./plataforma-alta";

describe("cargarComunes", () => {
  it("lee la lista del backend (minúsculas, sin vacías)", () => {
    const comunes = cargarComunes(RUTA_COMUNES);
    expect(comunes.has("password1234")).toBe(true);
    expect(comunes.has("")).toBe(false);
  });

  it("si la lista no existe falla cerrado con ErrorCli de mensaje fijo", () => {
    const e = (() => {
      try {
        cargarComunes("/no/existe/comunes.txt");
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(ErrorCli);
    expect((e as Error).message).not.toContain("/no/existe");
  });
});

describe("validarContrasenaNueva", () => {
  const comunes = new Set(["password1234"]);

  it("acepta una contraseña de 12 puntos de código fuera de la lista", () => {
    expect(() => validarContrasenaNueva("Clave-larga-91", comunes)).not.toThrow();
  });

  it("rechaza una corta, una de más de 128 y una común (sin importar mayúsculas)", () => {
    for (const mala of ["corta", "x".repeat(129), "PassWord1234"]) {
      const e = (() => {
        try {
          validarContrasenaNueva(mala, comunes);
        } catch (x) {
          return x as Error;
        }
      })();
      expect(e).toBeInstanceOf(ErrorCli);
      expect(e!.message).toMatch(/contraseña/);
      expect(e!.message).not.toContain(mala);
    }
  });
});

describe("leerStdinProceso", () => {
  it("lee toda la entrada", async () => {
    expect(await leerStdinProceso(Readable.from(["abc", "def\n"]))).toBe("abcdef\n");
  });

  it("con una terminal interactiva no la pide: ErrorCli que indica la alternativa", async () => {
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await expect(leerStdinProceso(tty)).rejects.toBeInstanceOf(ErrorCli);
  });
});

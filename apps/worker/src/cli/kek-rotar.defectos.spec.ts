import { afterEach, describe, expect, it, vi } from "vitest";
import { uuid } from "../../test/soporte.js";
import { main } from "./kek-rotar.js";

// Dependencias por defecto de `main` (T12, backend): pool propio, salida por consola y mensaje
// genérico para errores no tipados. Sin BD: el pool se crea pero nunca se conecta.

const ARGS = ["--", "--desde", "k1", "--privada-anterior", "/no/existe/k1.pem", "--tenant", uuid()];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kek:rotar: dependencias por defecto", () => {
  it("sin deps crea su propio pool sin conectarse, informa por console.error y devuelve 1", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const codigo = await main(ARGS, { DATABASE_URL: "postgres://nadie@127.0.0.1:1/nada" });
    expect(codigo).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[configuracion]"));
  });

  it("URL de BD vacía: no arranca y lo dice con el mensaje fijo de @contapp/db, sin valores", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const codigo = await main(ARGS, { DATABASE_URL: "" });
    expect(codigo).toBe(1);
    expect(error).toHaveBeenCalledWith("kek:rotar: Falta DATABASE_URL para createDb");
  });
});

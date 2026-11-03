// T15a (006) · CLI `db:plataforma-alta`, parte sin BD. Contrato (lo implementa T15b):
//  - `parsearArgumentos(argv)`: `--correo <c>` obligatorio y `--nombre <n>` opcional, cada uno una sola vez; devuelve el
//    correo normalizado (trim, minúsculas, NFC; solo ASCII, con arroba y dominio). Cualquier otra cosa lanza `ErrorCli`
//    con un mensaje fijo que menciona "correo" o el argumento, sin repetir el valor recibido.
//  - `main(argv, env, leerStdin)`: valida los argumentos ANTES de abrir la conexión; falla con `ErrorCli`.
//  - `ejecutar("plataforma-alta", ...)` (comun.ts) ya da código de salida 1 y el mensaje por stderr.
//  - `packages/db/package.json` trae el script `db:plataforma-alta` sobre `dist/cli/plataforma-alta.js`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCli, ejecutar } from "./comun";
import { main, parsearArgumentos } from "./plataforma-alta";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

const rechazo = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("se esperaba un error");
};

describe("parsearArgumentos", () => {
  it("devuelve el correo normalizado (trim, minúsculas)", () => {
    expect(parsearArgumentos(["--correo", "  Admin@Estudio.PE "])).toEqual({
      correo: "admin@estudio.pe",
    });
  });

  it("acepta --nombre y respeta el orden libre", () => {
    expect(
      parsearArgumentos(["--nombre", "Ana Pérez", "--correo", "ana@estudio.pe"]),
    ).toEqual({ correo: "ana@estudio.pe", nombre: "Ana Pérez" });
  });

  it.each([
    ["sin argumentos", []],
    ["falta el valor de --correo", ["--correo"]],
    ["correo vacío", ["--correo", "   "]],
    ["sin arroba", ["--correo", "sin-arroba"]],
    ["sin dominio", ["--correo", "ana@"]],
    ["sin parte local", ["--correo", "@estudio.pe"]],
    ["no ASCII", ["--correo", "añá@estudio.pe"]],
    ["con espacios dentro", ["--correo", "a b@estudio.pe"]],
    ["demasiado largo", ["--correo", `${"a".repeat(250)}@estudio.pe`]],
    ["correo repetido", ["--correo", "a@x.pe", "--correo", "b@x.pe"]],
    ["argumento desconocido", ["--correo", "a@x.pe", "--rol", "admin"]],
    ["argumento suelto", ["a@x.pe"]],
    ["--nombre sin valor", ["--correo", "a@x.pe", "--nombre"]],
  ] as const)("%s: lanza ErrorCli", (_n, argv) => {
    const e = rechazo(() => parsearArgumentos(argv));
    expect(e).toBeInstanceOf(ErrorCli);
  });

  it("el mensaje de un correo inválido lo nombra pero no repite el valor recibido", () => {
    const e = rechazo(() => parsearArgumentos(["--correo", "valor-canario-91"])) as Error;
    expect(e).toBeInstanceOf(ErrorCli);
    expect(e.message).toMatch(/correo/i);
    expect(e.message).not.toContain("valor-canario-91");
  });
});

describe("main · validación previa a la conexión", () => {
  // Puerto 1 cerrado: si main intentara conectar antes de validar, el error sería ECONNREFUSED y no el del correo.
  const URL_CERRADA = "postgresql://postgres:clave-falsa-t15a@127.0.0.1:1/contapp";

  it("un correo inválido rechaza con ErrorCli sobre el correo, sin tocar la red", async () => {
    vi.stubEnv("MIGRATIONS_DATABASE_URL", URL_CERRADA);
    const leerStdin = vi.fn(async () => "Canario-contrasena-t15a");
    const e = await main(["--correo", "sin-arroba"], process.env, leerStdin).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ErrorCli);
    expect((e as Error).message).toMatch(/correo/i);
    expect(leerStdin).not.toHaveBeenCalled();
  });

  it("sin --correo rechaza con ErrorCli (código de salida 1 y mensaje claro vía ejecutar)", async () => {
    vi.stubEnv("MIGRATIONS_DATABASE_URL", URL_CERRADA);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await ejecutar("plataforma-alta", () => main([], process.env, async () => ""));
    expect(process.exitCode).toBe(1);
    const salida = error.mock.calls.map((a) => a.join(" ")).join("\n");
    expect(salida).toMatch(/^plataforma-alta: .*correo/i);
    expect(salida).not.toContain("clave-falsa-t15a");
    expect(salida).not.toContain("postgresql://");
  });
});

describe("script db:plataforma-alta", () => {
  it("package.json lo define sobre dist/cli/plataforma-alta.js, cargando el .env del repo como db:seed", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["db:plataforma-alta"]).toBe(
      "node --env-file-if-exists=../../.env dist/cli/plataforma-alta.js",
    );
  });
});

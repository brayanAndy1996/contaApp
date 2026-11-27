// Spec 029 (T10a, U5): punto de entrada de `db:totp-restablecer`. Al ejecutarse como proceso, el modulo registra con `ejecutarSiDirecta` una
// tarea llamada «totp-restablecer» que corre `main()` con los argumentos reales del proceso. Se intercepta `ejecutarSiDirecta` (solo el
// arranque; el resto de comun.ts es el real) para correr esa tarea sin lanzar otro proceso.
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorCli } from "./comun";

type Tarea = { nombre: string; fn: () => Promise<void> };
const registradas = vi.hoisted(() => [] as Array<{ nombre: string; fn: () => Promise<void> }>);

vi.mock("./comun", async (importOriginal) => {
  const real = await importOriginal<typeof import("./comun")>();
  return {
    ...real,
    ejecutarSiDirecta: (_principal: unknown, _modulo: unknown, nombre: string, fn: () => Promise<void>) => {
      registradas.push({ nombre, fn });
    },
  };
});

const CORREO = "t10a-entrada-nadie@totp-entrada.test";
let cliente: Client;
const argvOriginal = process.argv;

beforeAll(async () => {
  if (!process.env.MIGRATIONS_DATABASE_URL) throw new Error("Falta MIGRATIONS_DATABASE_URL para la integración");
  cliente = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await cliente.connect();
});
afterEach(() => {
  process.argv = argvOriginal;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await cliente?.end();
});

async function tarea(): Promise<Tarea> {
  await import("./totp-restablecer.js");
  const t = registradas.find((r) => r.nombre === "totp-restablecer");
  expect(t, "el modulo registra la tarea totp-restablecer").toBeDefined();
  return t!;
}

describe("db:totp-restablecer · punto de entrada", () => {
  it("la tarea registrada lee --correo de process.argv y termina con la linea fija", async () => {
    const t = await tarea();
    process.argv = ["node", "totp-restablecer.js", "--correo", CORREO];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await t.fn();
    expect(log.mock.calls.map((a) => a.join(" "))).toEqual(["solicitud procesada"]);
  });

  it("sin --correo falla con ErrorCli y no abre la BD", async () => {
    const t = await tarea();
    process.argv = ["node", "totp-restablecer.js"];
    await expect(t.fn()).rejects.toBeInstanceOf(ErrorCli);
  });
});

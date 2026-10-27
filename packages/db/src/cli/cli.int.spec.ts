// Integración de los CLI de migrar y seed contra la base real (proyecto "integracion" de
// vitest.cobertura.config.mts). Si faltan las variables la suite FALLA: no se salta.
import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SEED } from "../seed/datos";
import { mensajeSeguro } from "./comun";
import { main as migrarMain } from "./migrar";
import { main as seedMain } from "./seed";

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Contraseña de una URL de conexión (decodificada); "" si no tiene. */
function passwordDe(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

/** Valores que nunca deben aparecer en la salida: las URLs completas y sus contraseñas. */
function secretos(): string[] {
  const urls = VARIABLES.map((v) => String(process.env[v]));
  return [...urls, ...urls.map(passwordDe)].filter((s) => s.length > 0);
}

/** Captura console.log/console.error y devuelve las líneas. */
function capturarSalida() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    lineas: () =>
      [...log.mock.calls, ...error.mock.calls].map((a) => a.join(" ")),
  };
}

function sinSecretos(lineas: string[]) {
  const texto = lineas.join("\n");
  for (const s of secretos()) expect(texto.includes(s)).toBe(false);
}

beforeAll(() => {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para la integración: ${faltan.join(", ")}`,
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI migrar (main)", () => {
  it("dos ejecuciones seguidas: la 2.ª informa ajustes, atributos y contraseña 'sin cambios'", async () => {
    const salida1 = capturarSalida();
    await migrarMain();
    sinSecretos(salida1.lineas());
    vi.restoreAllMocks();

    const salida2 = capturarSalida();
    await migrarMain();
    expect(salida2.lineas()).toEqual([
      "migrar: ajustes de contapp_app sin cambios",
      "migrar: atributos de contapp_app sin cambios",
      "migrar: contrasena de contapp_app sin cambios",
    ]);
    sinSecretos(salida2.lineas());
  }, 60_000);

  it("con MIGRATIONS_DATABASE_URL a un puerto cerrado rechaza con un mensaje sin la URL ni la contraseña", async () => {
    // Valores de prueba generados aquí; el puerto 1 de localhost no tiene servidor.
    const passwordFalsa = "clave-falsa-de-prueba-91";
    const urlCerrada = `postgresql://postgres:${passwordFalsa}@127.0.0.1:1/contapp`;
    const original = process.env.MIGRATIONS_DATABASE_URL;
    process.env.MIGRATIONS_DATABASE_URL = urlCerrada;
    const salida = capturarSalida();
    let error: unknown;
    try {
      await migrarMain();
    } catch (e) {
      error = e;
    } finally {
      process.env.MIGRATIONS_DATABASE_URL = original;
    }
    expect(error).toBeInstanceOf(Error);
    // Fallo real de conexión (no un error de programación): solo el código de red.
    expect(mensajeSeguro(error)).toBe(
      "error de conexion o de ejecucion (ECONNREFUSED)",
    );
    for (const texto of [
      (error as Error).message,
      mensajeSeguro(error),
      ...salida.lineas(),
    ]) {
      expect(texto).not.toContain(urlCerrada);
      expect(texto).not.toContain(passwordFalsa);
      expect(texto).not.toContain("postgresql://");
    }
  }, 30_000);
});

describe("CLI seed (main)", () => {
  async function contar(): Promise<{
    clientes: number;
    membresias: number;
    tenants: number;
  }> {
    // Conexión de migraciones (superusuario): no depende de RLS. Se cuentan solo las filas del seed por id.
    const c = new Client({
      connectionString: process.env.MIGRATIONS_DATABASE_URL,
    });
    await c.connect();
    try {
      const r = await c.query<{ n: number }>(
        "select count(*)::int as n from cliente where id = any($1::uuid[])",
        [[...SEED.clientesA, ...SEED.clientesB].map((x) => x.id)],
      );
      const m = await c.query<{ n: number }>(
        "select count(*)::int as n from membresia where id = any($1::uuid[])",
        [SEED.membresias.map((x) => x.id)],
      );
      const t = await c.query<{ n: number }>(
        "select count(*)::int as n from tenant where id = any($1::uuid[])",
        [SEED.tenants.map((x) => x.id)],
      );
      return {
        clientes: r.rows[0]!.n,
        membresias: m.rows[0]!.n,
        tenants: t.rows[0]!.n,
      };
    } finally {
      await c.end();
    }
  }

  it("dos ejecuciones seguidas son idempotentes y no imprimen contraseñas ni URLs", async () => {
    const salida = capturarSalida();
    await seedMain();
    const primera = await contar();
    await seedMain();
    const segunda = await contar();

    expect(primera).toEqual({
      tenants: SEED.tenants.length,
      membresias: SEED.membresias.length,
      clientes: SEED.clientesA.length + SEED.clientesB.length,
    });
    expect(segunda).toEqual(primera);
    sinSecretos(salida.lineas());
  }, 60_000);
});

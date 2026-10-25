import { describe, expect, it } from "vitest";
import { dbProhibido, uuid } from "../../test/soporte.js";
import { main } from "./kek-rotar.js";

// Comando `pnpm kek:rotar -- --desde <kekId> --privada-anterior <ruta> --tenant <uuid>…` sin BD (spec 003, CA-6).
// Contrato para T12 (`apps/worker/src/cli/kek-rotar.ts`):
//   main(argv: string[], env: Record<string, string | undefined>, deps?: {
//     db?: ContappDb;                       // por defecto createDb({ rolApp: "contapp_worker" }) desde env.DATABASE_URL
//     escribir?: (linea: string) => void;   // salida normal (por defecto console.log)
//     escribirError?: (linea: string) => void; // errores (por defecto console.error)
//   }): Promise<number>                      // codigo de salida: 0 ok, distinto de 0 error; nunca lanza
// - `--tenant` se repite una vez por estudio; la salida solo trae conteos (sin llaves, rutas de llaves ni URLs);
// - los argumentos se validan ANTES de tocar la BD o leer llaves; un error imprime un mensaje fijo, sin stack.

const ENV = { KEY_PROVIDER: "local", KEK_ID: "k2", KEK_PRIVATE_KEY_PATH: "/no/existe/k2-private.pem", NODE_ENV: "test" };
const PRIVADA = "/no/existe/k1-private.pem";
const base = (t = uuid()) => ["--desde", "k1", "--privada-anterior", PRIVADA, "--tenant", t];

async function correr(argv: string[], env: Record<string, string | undefined> = ENV) {
  const prohibido = dbProhibido();
  const salida: string[] = [];
  const codigo = await main(argv, env, {
    db: prohibido.db as never,
    escribir: (l) => salida.push(l),
    escribirError: (l) => salida.push(l),
  });
  return { codigo, salida: salida.join("\n"), usos: prohibido.usos() };
}

describe("kek:rotar: argumentos invalidos (no toca BD ni llaves)", () => {
  const casos: Array<[string, string[]]> = [
    ["sin argumentos", []],
    ["sin --desde", ["--privada-anterior", PRIVADA, "--tenant", uuid()]],
    ["sin --privada-anterior", ["--desde", "k1", "--tenant", uuid()]],
    ["sin --tenant", ["--desde", "k1", "--privada-anterior", PRIVADA]],
    ["--tenant no UUID", base("no-es-uuid")],
    ["--tenant con inyeccion", base(`${uuid()}' or '1'='1`)],
    ["un --tenant invalido entre validos", [...base(), "--tenant", "roto"]],
    ["--desde mal formado", ["--desde", "K1 MAL", "--privada-anterior", PRIVADA, "--tenant", uuid()]],
    ["--desde con ruta", ["--desde", "../k1", "--privada-anterior", PRIVADA, "--tenant", uuid()]],
    ["--desde igual a la KEK activa", ["--desde", "k2", "--privada-anterior", PRIVADA, "--tenant", uuid()]],
    ["opcion desconocida", [...base(), "--foo", "bar"]],
    ["opcion sin valor", ["--desde", "k1", "--privada-anterior", PRIVADA, "--tenant"]],
    ["argumento suelto", [...base(), "sobrante"]],
  ];

  it.each(casos)("%s: codigo distinto de 0, mensaje sin stack y sin usar la BD", async (_n, argv) => {
    const r = await correr(argv);
    expect(r.codigo).not.toBe(0);
    expect(r.usos).toBe(0);
    expect(r.salida.length).toBeGreaterThan(0); // dice por que
    expect(r.salida).not.toMatch(/\n\s+at\s/); // sin stack
    expect(r.salida).not.toContain("-----BEGIN");
  });

  it("falta la KEK activa en el entorno (KEK_ID/KEK_PRIVATE_KEY_PATH): no arranca", async () => {
    for (const falta of ["KEK_ID", "KEK_PRIVATE_KEY_PATH", "KEY_PROVIDER"]) {
      const env: Record<string, string | undefined> = { ...ENV };
      delete env[falta];
      const r = await correr(base(), env);
      expect(r.codigo, falta).not.toBe(0);
      expect(r.usos, falta).toBe(0);
    }
  });
});

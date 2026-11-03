// T15a (006) · CLI `db:plataforma-alta` contra la base real (proyecto "integracion" de vitest.cobertura.config.mts).
// Contrato (lo implementa T15b), `main(argv, env, leerStdin)` con MIGRATIONS_DATABASE_URL:
//  - Usuario EXISTENTE (correo normalizado): lo agrega a `admin_plataforma`; NO crea membresía, NO toca su contraseña
//    ni pide una. Salida: una línea con "agregado".
//  - Usuario NUEVO: lo crea (nombre = --nombre o la parte local del correo), con `auth.usuario_contrasena` en
//    argon2id y alta en `admin_plataforma`, sin membresía, en una sola transacción. La contraseña sale de
//    `env.CONTAPP_PLATAFORMA_CONTRASENA` y, si falta, de `leerStdin()` (se descarta el salto de línea final); se valida
//    con la política (12..128 puntos de código y fuera de la lista de comunes). Sin contraseña o inválida: `ErrorCli`
//    que menciona "contrasena" (o "contraseña"), sin repetirla, y no queda NADA creado. Salida: una línea con "creado".
//  - Idempotente: repetirlo no duplica nada, no cambia el hash y dice "sin cambios".
//  - Funciona con NODE_ENV=production (a diferencia de db:seed).
//  - Nunca imprime la contraseña, el hash ni la URL de conexión.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SEED } from "../seed/datos";
import { ErrorCli } from "./comun";
import { main } from "./plataforma-alta";

// db no depende de argon2: se verifica el hash con la copia del backend (solo en pruebas).
const argon2 = createRequire(
  resolve(__dirname, "../../../../apps/backend/package.json"),
)("@node-rs/argon2") as { verify(phc: string, plano: string): Promise<boolean> };

const SUFIJO = "@plataforma-alta.test";
const PWD = "Canario-T15a-ñ-91827"; // canario: 20 puntos de código, fuera de la lista de comunes
const PWD_OTRA = "Otro-canario-T15a-55"; // para detectar si se sobrescribe
let cliente: Client;
let n = 0;
const correoNuevo = () => `t15a-${process.pid}-${Date.now()}-${n++}${SUFIJO}`;

async function limpiar(): Promise<void> {
  const patron = `t15a-%${SUFIJO}`;
  await cliente.query(
    "delete from admin_plataforma where usuario_id in (select id from usuario where email like $1)",
    [patron],
  );
  await cliente.query(
    "delete from auth.usuario_contrasena where usuario_id in (select id from usuario where email like $1)",
    [patron],
  );
  await cliente.query("delete from usuario where email like $1", [patron]);
}

beforeAll(async () => {
  if (!process.env.MIGRATIONS_DATABASE_URL)
    throw new Error("Falta MIGRATIONS_DATABASE_URL para la integración");
  cliente = new Client({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  await cliente.connect();
  await limpiar();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await limpiar();
});
afterAll(async () => {
  await cliente?.end();
});

/** Captura todo lo que el CLI escriba por console y por stdout/stderr. */
function capturar() {
  const l = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
  ];
  const w = [
    vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
  return {
    texto: () =>
      [...l, ...w].flatMap((s) => s.mock.calls.map((a) => a.map(String).join(" "))).join("\n"),
  };
}
function sinSecretos(texto: string, ...extra: string[]) {
  for (const s of [PWD, PWD_OTRA, "$argon2", "postgresql://", process.env.MIGRATIONS_DATABASE_URL ?? "", ...extra])
    if (s !== "") expect(texto).not.toContain(s);
}

const usuarios = async (correo: string) =>
  (await cliente.query("select id, email, nombre from usuario where email = $1", [correo])).rows as Array<{
    id: string;
    email: string;
    nombre: string;
  }>;
const admins = async (usuarioId: string) =>
  (await cliente.query("select 1 from admin_plataforma where usuario_id = $1", [usuarioId])).rowCount;
const membresias = async (usuarioId: string) =>
  (await cliente.query("select 1 from membresia where usuario_id = $1", [usuarioId])).rowCount;
const hashDe = async (usuarioId: string) =>
  (await cliente.query("select hash from auth.usuario_contrasena where usuario_id = $1", [usuarioId])).rows[0]
    ?.hash as string | undefined;
/** Usuario existente creado como lo haría una invitación aceptada: con su contraseña y sin admin. */
async function usuarioExistente(correo: string): Promise<string> {
  const u = await cliente.query<{ id: string }>(
    "insert into usuario (email, nombre) values ($1, 'Existente T15a') returning id",
    [correo],
  );
  await cliente.query("insert into auth.usuario_contrasena (usuario_id, hash) values ($1, $2)", [
    u.rows[0]!.id,
    SEED.credenciales[0]!.hash,
  ]);
  return u.rows[0]!.id;
}
const sinStdin = vi.fn(async () => "");

describe("db:plataforma-alta · usuario existente", () => {
  it("lo agrega a admin_plataforma sin membresía, sin pedir ni tocar su contraseña; el correo se normaliza", async () => {
    const correo = correoNuevo();
    const id = await usuarioExistente(correo);
    const hashAntes = await hashDe(id);
    const salida = capturar();
    const stdin = vi.fn(async () => PWD_OTRA);

    await main(["--correo", `  ${correo.toUpperCase()} `], { CONTAPP_PLATAFORMA_CONTRASENA: PWD_OTRA }, stdin);

    expect(await admins(id)).toBe(1);
    expect(await membresias(id)).toBe(0);
    expect(await usuarios(correo)).toHaveLength(1);
    expect(await hashDe(id)).toBe(hashAntes);
    expect(stdin).not.toHaveBeenCalled();
    expect(salida.texto()).toMatch(/agregado/i);
    sinSecretos(salida.texto());
  });

  it("es idempotente: repetirlo no duplica la fila y dice 'sin cambios'", async () => {
    const correo = correoNuevo();
    const id = await usuarioExistente(correo);
    await main(["--correo", correo], {}, sinStdin);
    const salida = capturar();
    await main(["--correo", correo], {}, sinStdin);
    expect(await admins(id)).toBe(1);
    expect(salida.texto()).toMatch(/sin cambios/i);
    expect(sinStdin).not.toHaveBeenCalled();
  });
});

describe("db:plataforma-alta · usuario nuevo", () => {
  it("lo crea con la contraseña de CONTAPP_PLATAFORMA_CONTRASENA en argon2id, como super-admin y sin membresía", async () => {
    const correo = correoNuevo();
    const salida = capturar();
    const stdin = vi.fn(async () => PWD_OTRA);

    await main(["--correo", correo.toUpperCase()], { CONTAPP_PLATAFORMA_CONTRASENA: PWD }, stdin);

    const [u] = await usuarios(correo);
    expect(u).toBeDefined();
    expect(u!.nombre).toBe(correo.split("@")[0]); // sin --nombre: la parte local del correo
    expect(await admins(u!.id)).toBe(1);
    expect(await membresias(u!.id)).toBe(0);
    const hash = await hashDe(u!.id);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(hash!, PWD)).toBe(true);
    expect(await argon2.verify(hash!, PWD_OTRA)).toBe(false);
    expect(stdin).not.toHaveBeenCalled(); // la variable de entorno tiene prioridad
    expect(salida.texto()).toMatch(/creado/i);
    sinSecretos(salida.texto(), hash!);
  });

  it("sin variable de entorno lee la contraseña de stdin (sin el salto de línea final) y usa --nombre", async () => {
    const correo = correoNuevo();
    await main(["--correo", correo, "--nombre", "Super Admin T15a"], {}, async () => `${PWD}\n`);
    const [u] = await usuarios(correo);
    expect(u!.nombre).toBe("Super Admin T15a");
    expect(await argon2.verify((await hashDe(u!.id))!, PWD)).toBe(true);
    expect(await admins(u!.id)).toBe(1);
  });

  it("es idempotente: la 2.ª vez no duplica, no cambia el hash aunque llegue otra contraseña y dice 'sin cambios'", async () => {
    const correo = correoNuevo();
    await main(["--correo", correo], { CONTAPP_PLATAFORMA_CONTRASENA: PWD }, sinStdin);
    const [u] = await usuarios(correo);
    const hashAntes = await hashDe(u!.id);
    const salida = capturar();

    await main(["--correo", correo], { CONTAPP_PLATAFORMA_CONTRASENA: PWD_OTRA }, sinStdin);

    expect(await usuarios(correo)).toHaveLength(1);
    expect(await admins(u!.id)).toBe(1);
    expect(await hashDe(u!.id)).toBe(hashAntes);
    expect(salida.texto()).toMatch(/sin cambios/i);
    sinSecretos(salida.texto());
  });

  it.each([
    ["falta (sin variable y stdin vacío)", {}, ""],
    ["solo espacios y salto de línea", {}, "  \n"],
    ["demasiado corta", { CONTAPP_PLATAFORMA_CONTRASENA: "Corta-1" }, ""],
    ["común (lista de contraseñas comunes)", { CONTAPP_PLATAFORMA_CONTRASENA: "Password1234" }, ""],
    ["de más de 128 puntos de código", { CONTAPP_PLATAFORMA_CONTRASENA: "x".repeat(129) }, ""],
  ] as const)("contraseña %s: ErrorCli sobre la contraseña, sin repetirla y sin crear nada", async (_n, env, stdin) => {
    const correo = correoNuevo();
    const salida = capturar();
    const e = await main(["--correo", correo], { ...env }, async () => stdin).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ErrorCli);
    expect((e as Error).message).toMatch(/contrase(n|ñ)a/i);
    for (const s of ["Corta-1", "Password1234", "x".repeat(129)]) expect((e as Error).message).not.toContain(s);
    expect(await usuarios(correo)).toHaveLength(0); // nada a medias: ni usuario ni admin ni hash
    sinSecretos(`${salida.texto()}\n${(e as Error).message}`);
  });

  it("funciona con NODE_ENV=production (a diferencia del seed de desarrollo)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const correo = correoNuevo();
    await main(["--correo", correo], { NODE_ENV: "production", CONTAPP_PLATAFORMA_CONTRASENA: PWD }, sinStdin);
    const [u] = await usuarios(correo);
    expect(await admins(u!.id)).toBe(1);
  });
});

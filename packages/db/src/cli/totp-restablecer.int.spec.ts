// Spec 029 (T1, rojo) · U5, CA-9, CA-6: CLI `db:totp-restablecer` contra la base real (proyecto "integracion" de vitest.cobertura.config.mts).
// Contrato (lo implementa T8), `main(argv, env, deps?)` con MIGRATIONS_DATABASE_URL, `deps = { correo?: Correo }` (por omision, la fabrica de
// `@contapp/correo` segun `env`; las pruebas inyectan CorreoMemoria):
//  - Usuario CON TOTP activo: llama a `auth.totp_restablecer` (borra TOTP y codigos, revoca TODAS las sesiones, deja el evento
//    `totp_restablecido`) y envia UN aviso a su correo (U8) sin codigos, secretos ni enlaces.
//  - Correo inexistente o usuario SIN TOTP: no cambia nada, no envia correo y la salida es IDENTICA (indistinguible) a la del caso con TOTP.
//  - La salida es una sola linea fija; nunca imprime el correo, la URL de conexion, secretos ni hashes. Idempotente.
//  - Funciona con NODE_ENV=production.
// Rojo por: `./totp-restablecer` no existe (y las tablas de 0078).
import { CorreoMemoria } from "@contapp/correo";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorCli } from "./comun";
import { main } from "./totp-restablecer";

const SUFIJO = "@totp-restablecer.test";
let cliente: Client;
let n = 0;
const correoNuevo = () => `t1-${process.pid}-${Date.now()}-${n++}${SUFIJO}`;
const sinCorreo = { correo: new CorreoMemoria() };

async function limpiar(): Promise<void> {
  const patron = `t1-%${SUFIJO}`;
  const pasos = [
    "delete from auth.cuenta_evento where usuario_id in (select id from usuario where email like $1)",
    "delete from auth.totp_recuperacion where usuario_id in (select id from usuario where email like $1)",
    "delete from auth.totp where usuario_id in (select id from usuario where email like $1)",
    "delete from auth.sesion where usuario_id in (select id from usuario where email like $1)",
    "delete from auth.usuario_contrasena where usuario_id in (select id from usuario where email like $1)",
  ];
  for (const sql of pasos) await cliente.query(sql, [patron]).catch(() => undefined);
  await cliente.query("delete from usuario where email like $1", [patron]);
}

beforeAll(async () => {
  if (!process.env.MIGRATIONS_DATABASE_URL) throw new Error("Falta MIGRATIONS_DATABASE_URL para la integración");
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

function capturar() {
  const l = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
  ];
  const w = [vi.spyOn(process.stdout, "write").mockImplementation(() => true), vi.spyOn(process.stderr, "write").mockImplementation(() => true)];
  return { texto: () => [...l, ...w].flatMap((s) => s.mock.calls.map((a) => a.map(String).join(" "))).join("\n") };
}

/** Usuario con credencial; con `totp` tambien TOTP activo, 10 codigos, una sesion verificada y otra pendiente. */
async function usuario(totp: boolean) {
  const correo = correoNuevo();
  const u = await cliente.query<{ id: string }>("insert into usuario (email, nombre) values ($1, 'Titular T1') returning id", [correo]);
  const id = u.rows[0]!.id;
  const hash = `$argon2id$v=19$m=19456,t=2,p=1$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;
  await cliente.query("insert into auth.usuario_contrasena (usuario_id, hash) values ($1, $2)", [id, hash]);
  const tokens: Buffer[] = [];
  if (totp) {
    await cliente.query("insert into auth.totp (usuario_id, activo_cifrado, activo_version, ultimo_paso, activado_en) values ($1, $2, 1, 5, now())", [id, randomBytes(48)]);
    for (let i = 0; i < 10; i++) await cliente.query("insert into auth.totp_recuperacion (usuario_id, hash) values ($1, $2)", [id, randomBytes(32)]);
    for (const factor of ["verificado", "pendiente"]) {
      const t = randomBytes(32);
      tokens.push(t);
      await cliente.query(
        "insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, factor) values ($1, $2, now(), now(), now() + interval '1 hour', $3)",
        [t, id, factor],
      );
    }
  }
  return { id, correo, hash, tokens };
}
const conteo = async (tabla: "totp" | "totp_recuperacion", id: string) =>
  (
    await cliente.query(
      tabla === "totp"
        ? "select count(*)::int as n from auth.totp where usuario_id = $1"
        : "select count(*)::int as n from auth.totp_recuperacion where usuario_id = $1",
      [id],
    )
  ).rows[0].n as number;
const eventos = async (id: string) => (await cliente.query("select tipo from auth.cuenta_evento where usuario_id = $1", [id])).rows.map((r) => r.tipo as string);

describe("db:totp-restablecer · usuario con TOTP", () => {
  it("borra TOTP y codigos, revoca todas las sesiones (motivo totp), deja el evento y NO toca la contrasena", async () => {
    const u = await usuario(true);
    const correo = new CorreoMemoria();
    await main(["--correo", u.correo.toUpperCase()], {}, { correo });
    expect(await conteo("totp", u.id)).toBe(0);
    expect(await conteo("totp_recuperacion", u.id)).toBe(0);
    expect(await eventos(u.id)).toEqual(["totp_restablecido"]);
    const ses = (await cliente.query("select revocada_en, motivo from auth.sesion where usuario_id = $1", [u.id])).rows;
    expect(ses).toHaveLength(2);
    for (const s of ses) expect(s).toMatchObject({ motivo: "totp", revocada_en: expect.any(Date) });
    const hash = (await cliente.query("select hash from auth.usuario_contrasena where usuario_id = $1", [u.id])).rows[0].hash;
    expect(hash).toBe(u.hash);
  });

  it("U8: envia UN aviso al correo del usuario, sin codigos, secretos ni enlaces de accion", async () => {
    const u = await usuario(true);
    const correo = new CorreoMemoria();
    await main(["--correo", u.correo], {}, { correo });
    expect(correo.enviados).toHaveLength(1);
    const m = correo.enviados[0]!;
    expect(m.para).toBe(u.correo);
    expect(m.asunto.length).toBeGreaterThan(0);
    const todo = `${m.asunto}\n${m.texto}\n${m.html ?? ""}`;
    expect(todo).not.toMatch(/https?:\/\//i);
    expect(todo).not.toMatch(/otpauth:/i);
    expect(todo).not.toMatch(/\b\d{6}\b/);
    expect(m.baja).toBeUndefined();
  });

  it("salida: una linea fija sin el correo, la URL de conexion, hashes ni secretos", async () => {
    const u = await usuario(true);
    const salida = capturar();
    await main(["--correo", u.correo], {}, { correo: new CorreoMemoria() });
    const t = salida.texto();
    expect(t.trim().split("\n")).toHaveLength(1);
    for (const s of [u.correo, u.hash, "$argon2", "postgresql://", process.env.MIGRATIONS_DATABASE_URL ?? ""]) if (s !== "") expect(t).not.toContain(s);
  });

  it("es idempotente: repetirlo no duplica el evento ni el aviso", async () => {
    const u = await usuario(true);
    const correo = new CorreoMemoria();
    await main(["--correo", u.correo], {}, { correo });
    await main(["--correo", u.correo], {}, { correo });
    expect(await eventos(u.id)).toEqual(["totp_restablecido"]);
    expect(correo.enviados).toHaveLength(1);
  });

  it("funciona con NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const u = await usuario(true);
    await main(["--correo", u.correo], { NODE_ENV: "production" }, { correo: new CorreoMemoria() });
    expect(await conteo("totp", u.id)).toBe(0);
  });

  it("un fallo del correo no deja el restablecimiento a medias ni filtra el detalle: el TOTP ya esta borrado y el error es un ErrorCli fijo", async () => {
    const u = await usuario(true);
    const CANARIO = "smtp://usuario:CANARIO-CLAVE@host";
    const correo = { enviar: async () => Promise.reject(new Error(CANARIO)) };
    const e = await main(["--correo", u.correo], {}, { correo }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e === null || e instanceof ErrorCli, "debe terminar bien o con ErrorCli, no con el error crudo del transporte").toBe(true);
    if (e !== null) expect((e as Error).message).not.toContain("CANARIO");
    expect(await conteo("totp", u.id)).toBe(0);
  });
});

describe("db:totp-restablecer · salida indistinguible (CA-9)", () => {
  it("correo inexistente, usuario sin TOTP y usuario con TOTP imprimen exactamente lo mismo; solo el ultimo cambia algo y manda correo", async () => {
    const con = await usuario(true);
    const sin = await usuario(false);
    const salidas: string[] = [];
    const correos: CorreoMemoria[] = [];
    for (const correo of [correoNuevo(), sin.correo, con.correo]) {
      const c = new CorreoMemoria();
      correos.push(c);
      const s = capturar();
      await main(["--correo", correo], {}, { correo: c });
      salidas.push(s.texto());
      vi.restoreAllMocks();
    }
    expect(salidas[0]).not.toBe("");
    expect(salidas[1]).toBe(salidas[0]);
    expect(salidas[2]).toBe(salidas[0]);
    expect(correos.map((c) => c.enviados.length)).toEqual([0, 0, 1]);
    expect(await eventos(sin.id)).toEqual([]);
  });

  it("el usuario sin TOTP conserva sus sesiones", async () => {
    const sin = await usuario(false);
    const t = randomBytes(32);
    await cliente.query("insert into auth.sesion (token_hash, usuario_id, expira_absoluta) values ($1, $2, now() + interval '1 hour')", [t, sin.id]);
    await main(["--correo", sin.correo], {}, sinCorreo);
    expect((await cliente.query("select revocada_en from auth.sesion where token_hash = $1", [t])).rows[0].revocada_en).toBeNull();
  });

  it("argumentos invalidos: ErrorCli antes de tocar la BD", async () => {
    await expect(main([], {}, sinCorreo)).rejects.toBeInstanceOf(ErrorCli);
  });
});

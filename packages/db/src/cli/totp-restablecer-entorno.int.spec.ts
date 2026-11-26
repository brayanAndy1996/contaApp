// Spec 029 (T10a, U5, U8, CA-9): `db:totp-restablecer` elige el correo del entorno (sin `deps.correo`) y llega hasta la BD real.
//  - consola (por omision) y smtp (con SMTP_URL y CORREO_REMITENTE) resuelven; con un correo inexistente no se envia nada y la salida es la fija.
//  - Si el aviso no se puede entregar por SMTP, el restablecimiento ya esta hecho y el error es fijo: no filtra SMTP_URL ni su clave.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorCli } from "./comun";
import { main } from "./totp-restablecer";

const SUFIJO = "@totp-entorno.test";
const SMTP_URL = "smtp://usuario:CLAVE-SECRETA-029@127.0.0.1:1";
let cliente: Client;
let n = 0;
const correoNuevo = () => `t10a-${process.pid}-${Date.now()}-${n++}${SUFIJO}`;

async function limpiar(): Promise<void> {
  const patron = `t10a-%${SUFIJO}`;
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

async function usuarioConTotp() {
  const correo = correoNuevo();
  const u = await cliente.query<{ id: string }>("insert into usuario (email, nombre) values ($1, 'Titular T10a') returning id", [correo]);
  const id = u.rows[0]!.id;
  await cliente.query("insert into auth.totp (usuario_id, activo_cifrado, activo_version, ultimo_paso, activado_en) values ($1, $2, 1, 5, now())", [id, randomBytes(48)]);
  return { id, correo };
}

describe("db:totp-restablecer · correo elegido por el entorno", () => {
  it.each([
    ["por omision (consola)", {}],
    ["consola explicito, fuera de produccion", { CORREO_PROVIDER: "consola", NODE_ENV: "development" }],
    ["smtp con remitente y SMTP_URL", { CORREO_PROVIDER: "smtp", CORREO_REMITENTE: "avisos@contapp.test", SMTP_URL }],
    ["smtp con valores rodeados de espacios", { CORREO_PROVIDER: " smtp ", CORREO_REMITENTE: " avisos@contapp.test ", SMTP_URL: ` ${SMTP_URL} ` }],
  ])("%s: con un correo inexistente imprime solo la linea fija y no envia nada", async (_n, env) => {
    const salida = capturar();
    await main(["--correo", correoNuevo()], env);
    const texto = salida.texto();
    expect(texto).toContain("solicitud procesada");
    for (const secreto of [SMTP_URL, "CLAVE-SECRETA-029", SUFIJO]) expect(texto).not.toContain(secreto);
  });

  it("smtp inalcanzable con un usuario con TOTP: el TOTP ya esta restablecido y el error fijo no filtra SMTP_URL ni su clave", async () => {
    const u = await usuarioConTotp();
    const salida = capturar();
    const e = await main(["--correo", u.correo], { CORREO_PROVIDER: "smtp", CORREO_REMITENTE: "avisos@contapp.test", SMTP_URL }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ErrorCli);
    expect((e as ErrorCli).message).toBe("restablecimiento aplicado, pero no se pudo enviar el aviso");
    for (const secreto of [SMTP_URL, "CLAVE-SECRETA-029", u.correo]) {
      expect((e as ErrorCli).message).not.toContain(secreto);
      expect(salida.texto()).not.toContain(secreto);
    }
    expect((await cliente.query("select count(*)::int as n from auth.totp where usuario_id = $1", [u.id])).rows[0].n).toBe(0);
  });
});

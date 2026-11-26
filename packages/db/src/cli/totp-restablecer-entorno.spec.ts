// Spec 029 (T10a, U5, U8): eleccion del correo del CLI `db:totp-restablecer` segun el entorno, en los casos que fallan ANTES de abrir la BD.
// Todos terminan en ErrorCli con mensaje fijo: nunca el valor de SMTP_URL (puede traer la clave del SMTP) ni el correo.
import { describe, expect, it } from "vitest";
import { ErrorCli } from "./comun";
import { main } from "./totp-restablecer";

const CORREO = "nadie@totp-entorno.test";
const SMTP_URL = "smtp://usuario:CLAVE-SECRETA-029@smtp.invalido.test:587";

async function fallo(env: NodeJS.ProcessEnv): Promise<ErrorCli> {
  const e = await main(["--correo", CORREO], env).then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ErrorCli);
  const msg = (e as ErrorCli).message;
  for (const secreto of [SMTP_URL, "CLAVE-SECRETA-029", CORREO]) expect(msg).not.toContain(secreto);
  return e as ErrorCli;
}

describe("db:totp-restablecer · correo segun el entorno (falla antes de tocar la BD)", () => {
  it.each(["ses", "sendgrid", "memoria", "smtps", "consola smtp"])("CORREO_PROVIDER=%s no esta soportado", async (p) => {
    expect((await fallo({ CORREO_PROVIDER: p })).message).toBe("CORREO_PROVIDER no soportado");
  });

  it("el proveedor consola no se admite en produccion (aunque se escriba con espacios o mayusculas)", async () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", CORREO_PROVIDER: "consola" },
      { NODE_ENV: "production", CORREO_PROVIDER: "  CONSOLA " },
    ]) {
      expect((await fallo(env)).message).toBe("CORREO_PROVIDER no soportado en producción");
    }
  });

  it("smtp sin remitente o sin SMTP_URL (ausentes, vacios o solo espacios) da una configuracion invalida fija", async () => {
    for (const env of [
      { CORREO_PROVIDER: "smtp" },
      { CORREO_PROVIDER: "smtp", SMTP_URL },
      { CORREO_PROVIDER: "smtp", SMTP_URL, CORREO_REMITENTE: "" },
      { CORREO_PROVIDER: "smtp", SMTP_URL, CORREO_REMITENTE: "   " },
      { CORREO_PROVIDER: "smtp", CORREO_REMITENTE: "avisos@contapp.test" },
      { CORREO_PROVIDER: "smtp", CORREO_REMITENTE: "avisos@contapp.test", SMTP_URL: "  " },
      { CORREO_PROVIDER: " SMTP ", CORREO_REMITENTE: "avisos@contapp.test" },
    ]) {
      expect((await fallo(env)).message).toBe("configuración de correo inválida");
    }
  });
});

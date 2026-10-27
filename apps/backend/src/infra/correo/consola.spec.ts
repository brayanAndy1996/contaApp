import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorreoConsola } from "./consola.js";

// D11 / CA-10 (spec 004). Contrato (plan: Decisiones: Correo):
//   class CorreoConsola implements Correo   // new CorreoConsola()
//   enviar({ para, asunto, texto }) imprime el mensaje completo con process.stdout.write,
//   FUERA del logger (ni Logger de Nest ni console.*): es la única excepción de CA-10, que
//   permite imprimir el enlace de recuperación en desarrollo.
afterEach(() => {
  vi.restoreAllMocks();
});

const MENSAJE = {
  para: "ana@estudio.pe",
  asunto: "Recupera tu contraseña",
  texto: "Entra a http://localhost:3000/recuperar/nueva#t=TOKEN-DE-PRUEBA-123 para continuar.",
};

describe("CorreoConsola", () => {
  it("escribe en stdout el destinatario, el asunto y el texto con el enlace", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await new CorreoConsola().enviar(MENSAJE);
    const salida = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(salida).toContain(MENSAJE.para);
    expect(salida).toContain(MENSAJE.asunto);
    expect(salida).toContain("http://localhost:3000/recuperar/nueva#t=TOKEN-DE-PRUEBA-123");
  });

  it("no usa el logger de Nest ni console.*", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const espias = [
      vi.spyOn(Logger.prototype, "log"),
      vi.spyOn(Logger.prototype, "warn"),
      vi.spyOn(Logger.prototype, "error"),
      vi.spyOn(Logger.prototype, "debug"),
      vi.spyOn(Logger.prototype, "verbose"),
      vi.spyOn(Logger, "log"),
      vi.spyOn(Logger, "warn"),
      vi.spyOn(Logger, "error"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    await new CorreoConsola().enviar(MENSAJE);
    for (const espia of espias) expect(espia).not.toHaveBeenCalled();
  });

  it("resuelve sin lanzar", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(new CorreoConsola().enviar(MENSAJE)).resolves.toBeUndefined();
  });
});

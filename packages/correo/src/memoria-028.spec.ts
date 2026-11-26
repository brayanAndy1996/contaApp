import { describe, expect, it } from "vitest";
import { CorreoMemoria } from "./memoria.js";

// Spec 028 · T2 (rojo). `CorreoMemoria` guarda el mensaje COMPLETO, con `html`, `baja` e `idMensaje` (plan 028, Contratos: correo).
// Las pruebas del worker (T5) y E2E leen de aquí el enlace de baja y el Message-ID.
describe("CorreoMemoria 028", () => {
  it("conserva html, baja e idMensaje tal como llegaron", async () => {
    const correo = new CorreoMemoria();
    const m = {
      para: "ana@estudio.pe",
      asunto: "Aviso",
      texto: "t",
      html: "<p>x</p>",
      baja: { url: "https://app.contapp.pe/baja?t=abc" },
      idMensaje: "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10",
    };
    await correo.enviar(m);
    expect(correo.enviados).toEqual([m]);
  });

  it("un mensaje sin opcionales no gana claves", async () => {
    const correo = new CorreoMemoria();
    await correo.enviar({ para: "a@x.pe", asunto: "s", texto: "t" });
    expect(Object.keys(correo.enviados[0]!).sort()).toEqual(["asunto", "para", "texto"]);
  });
});

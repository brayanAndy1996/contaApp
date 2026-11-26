import { describe, expect, it } from "vitest";
import { CorreoMemoria } from "./memoria.js";

// Plan 004 (Contratos Backend): `CorreoMemoria` es el doble de pruebas que `crearApp({ correo })`
// recibe. Contrato: `enviados: MensajeCorreo[]` en orden de envío; `enviar` resuelve sin valor.
describe("CorreoMemoria", () => {
  it("guarda los mensajes en orden en `enviados`", async () => {
    const correo = new CorreoMemoria();
    expect(correo.enviados).toEqual([]);
    await correo.enviar({ para: "a@x.pe", asunto: "uno", texto: "t1" });
    await correo.enviar({ para: "b@x.pe", asunto: "dos", texto: "t2" });
    expect(correo.enviados).toEqual([
      { para: "a@x.pe", asunto: "uno", texto: "t1" },
      { para: "b@x.pe", asunto: "dos", texto: "t2" },
    ]);
  });

  it("enviar resuelve sin valor", async () => {
    await expect(
      new CorreoMemoria().enviar({ para: "a@x.pe", asunto: "s", texto: "t" }),
    ).resolves.toBeUndefined();
  });

  it("cada instancia tiene su propia lista", async () => {
    const a = new CorreoMemoria();
    const b = new CorreoMemoria();
    await a.enviar({ para: "a@x.pe", asunto: "s", texto: "t" });
    expect(b.enviados).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CorreoConsola } from "./consola.js";

// Spec 028 · T2 (rojo). `CorreoConsola` con `html` y `baja` (plan 028, Contratos: correo; R-7, R-8).
// Contrato fijado por estas pruebas (packages/correo/src/consola.ts), además de lo de 004:
//  - Imprime para, asunto y texto; si hay `html` imprime la marca «[html]» y NUNCA el HTML; si hay `baja` imprime la marca «[baja]».
//  - Nunca imprime la URL de baja ni el token que lleva: toda aparición de `baja.url` dentro de para, asunto o texto se sustituye por «[baja]»
//    (el texto del aviso lleva el enlace de baja; la consola es la única salida a stdout y no debe filtrar el token).
//  - No toca console.* ni el logger.
afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = "CANARIO-TOKEN-BAJA-0123456789abcdefghijklmnopq";
const URL_BAJA = `https://app.contapp.pe/baja?t=${TOKEN}`;
const MENSAJE = {
  para: "ana@estudio.pe",
  asunto: "Coactiva y avisos críticos del buzón · Estudio Sol",
  texto: `Tienes 2 avisos.\nVer: https://app.contapp.pe/ir?estudio=1\nDejar de recibir este tipo de correo: ${URL_BAJA}\n`,
};

const imprimir = async (m: Parameters<CorreoConsola["enviar"]>[0]): Promise<string> => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await new CorreoConsola().enviar(m);
  return stdout.mock.calls.map((c) => String(c[0])).join("");
};

describe("CorreoConsola 028", () => {
  it("con baja imprime la marca [baja] y no la URL ni el token", async () => {
    const salida = await imprimir({ ...MENSAJE, baja: { url: URL_BAJA } });
    expect(salida).toContain("[baja]");
    expect(salida).not.toContain(URL_BAJA);
    expect(salida).not.toContain(TOKEN);
    expect(salida).not.toContain("/baja?t=");
  });

  it("sigue imprimiendo para, asunto y el resto del texto", async () => {
    const salida = await imprimir({ ...MENSAJE, baja: { url: URL_BAJA } });
    expect(salida).toContain("ana@estudio.pe");
    expect(salida).toContain("Coactiva y avisos críticos del buzón · Estudio Sol");
    expect(salida).toContain("Tienes 2 avisos.");
    expect(salida).toContain("https://app.contapp.pe/ir?estudio=1");
  });

  it("la URL de baja repetida varias veces en el texto se oculta en todas", async () => {
    const salida = await imprimir({ ...MENSAJE, texto: `${URL_BAJA}\n${URL_BAJA}\nfin`, baja: { url: URL_BAJA } });
    expect(salida).not.toContain(TOKEN);
    expect(salida.match(/\[baja\]/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("con html imprime la marca [html] y no el HTML", async () => {
    const salida = await imprimir({ ...MENSAJE, html: `<table><tr><td>CANARIO-HTML-31</td></tr></table><a href="${URL_BAJA}">baja</a>`, baja: { url: URL_BAJA } });
    expect(salida).toContain("[html]");
    expect(salida).not.toContain("<table>");
    expect(salida).not.toContain("CANARIO-HTML-31");
    expect(salida).not.toContain(TOKEN);
  });

  it("sin html ni baja no imprime marcas", async () => {
    const salida = await imprimir({ para: "a@x.pe", asunto: "s", texto: "t" });
    expect(salida).not.toContain("[html]");
    expect(salida).not.toContain("[baja]");
  });

  it("no usa console.* con html y baja", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const espias = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await new CorreoConsola().enviar({ ...MENSAJE, html: "<p>x</p>", baja: { url: URL_BAJA }, idMensaje: "0192f0a0-7b1c-7a3e-8c11-2f9d5b6a7c10" });
    for (const espia of espias) expect(espia).not.toHaveBeenCalled();
  });
});

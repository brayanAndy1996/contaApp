import { afterEach, describe, expect, it, vi } from "vitest";
import { CorreoConsola } from "./consola.js";

// Spec 028 · T24a (rojo). D-T24-1: `baja.url` (la de `List-Unsubscribe`, `/api/correo/baja?t=`) y el enlace de la página del cuerpo
// (`/baja?t=`) son URLs distintas con el mismo token. La consola no debe imprimir el token por ninguna de las dos (contrato del plan:
// «nunca la URL con el token»); sustituye el valor de `t` de `baja.url` por «[baja]» en para, asunto y texto.
afterEach(() => {
  vi.restoreAllMocks();
});

const CANARIO = "CANARIO-T24-TOKEN-BAJA-9f8e7d6c5b4a3210";
const URL_BAJA = `https://app.x.pe/api/correo/baja?t=${CANARIO}`;
const ENLACE_PAGINA = `https://app.x.pe/baja?t=${CANARIO}`;

const imprimir = async (
  m: Parameters<CorreoConsola["enviar"]>[0],
): Promise<string> => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  await new CorreoConsola().enviar(m);
  return stdout.mock.calls.map((c) => String(c[0])).join("");
};

const MENSAJE = {
  para: "ana@estudio.pe",
  asunto: "Avisos críticos del buzón · Estudio Sol",
  texto: `Tienes 2 avisos.\nVer: https://app.x.pe/ir?estudio=1&pantalla=buzon_estudio\nDejar de recibir este correo: ${ENLACE_PAGINA}\nCódigo suelto: ${CANARIO}\nFin.\n`,
  baja: { url: URL_BAJA },
};

describe("CorreoConsola T24 (D-T24-1): el token de baja del enlace de la página", () => {
  it("el enlace /baja?t= del texto no deja el canario ni ?t= en stdout, y sí la marca [baja]", async () => {
    const salida = await imprimir(MENSAJE);
    expect(salida).toContain("[baja]");
    expect(salida).not.toContain(CANARIO);
    expect(salida).not.toContain("?t=");
  });

  it("el canario suelto en el texto también se oculta", async () => {
    const salida = await imprimir({
      ...MENSAJE,
      texto: `solo ${CANARIO} aquí\n`,
      baja: { url: URL_BAJA },
    });
    expect(salida).not.toContain(CANARIO);
  });

  it("el token en el para o en el asunto también se oculta", async () => {
    const salida = await imprimir({
      ...MENSAJE,
      para: `a+${CANARIO}@x.pe`,
      asunto: `Aviso ${CANARIO}`,
    });
    expect(salida).not.toContain(CANARIO);
  });

  it("sigue imprimiendo para, asunto, el resto del texto y el enlace /ir", async () => {
    const salida = await imprimir(MENSAJE);
    expect(salida).toContain("ana@estudio.pe");
    expect(salida).toContain("Avisos críticos del buzón · Estudio Sol");
    expect(salida).toContain("Tienes 2 avisos.");
    expect(salida).toContain("Fin.");
    expect(salida).toContain(
      "https://app.x.pe/ir?estudio=1&pantalla=buzon_estudio",
    );
  });

  it("una baja.url inválida no rompe el envío por consola", async () => {
    const salida = await imprimir({
      ...MENSAJE,
      baja: { url: "no es una url" },
    });
    expect(salida).toContain("[baja]");
    expect(salida).toContain("Tienes 2 avisos.");
  });
});

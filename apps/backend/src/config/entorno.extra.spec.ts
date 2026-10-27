import { describe, expect, it } from "vitest";
import { EntornoInvalidoError, leerEntorno } from "./entorno.js";

// Ramas de leerEntorno que entorno.spec.ts no ejercita: APP_ORIGIN, TRUST_PROXY y los datos
// obligatorios de smtp. Los mensajes nombran la variable, nunca su valor.
const BASE = { APP_ORIGIN: "http://localhost:3000" };

describe("APP_ORIGIN", () => {
  it("ausente: por defecto fuera de producción, error en producción", () => {
    expect(leerEntorno({}).appOrigin).toBe("http://localhost:3000");
    expect(() =>
      leerEntorno({
        NODE_ENV: "production",
        CORREO_PROVIDER: "smtp",
        SMTP_URL: "smtp://h:587",
        CORREO_REMITENTE: "a@x.pe",
      }),
    ).toThrow(EntornoInvalidoError);
  });

  it.each([
    ["no-es-url"],
    ["http://localhost:3000/"],
    ["http://localhost:3000/ruta"],
    ["ftp://x.pe"],
  ])("un origen inválido (%j) impide arrancar", (valor) => {
    expect(() => leerEntorno({ APP_ORIGIN: valor })).toThrow(
      EntornoInvalidoError,
    );
  });

  it("acepta https con puerto", () => {
    expect(
      leerEntorno({ APP_ORIGIN: "https://app.estudio.pe:8443" }).appOrigin,
    ).toBe("https://app.estudio.pe:8443");
  });
});

describe("otras variables", () => {
  it("TRUST_PROXY se lee tal cual (recortado)", () => {
    expect(leerEntorno({ ...BASE, TRUST_PROXY: " 1 " }).trustProxy).toBe("1");
  });

  it("consola acepta un remitente opcional", () => {
    expect(leerEntorno({ ...BASE, CORREO_REMITENTE: "a@x.pe" }).correo).toEqual(
      {
        provider: "consola",
        remitente: "a@x.pe",
      },
    );
  });

  it("smtp sin SMTP_URL o sin remitente impide arrancar y no nombra valores", () => {
    expect(() =>
      leerEntorno({
        ...BASE,
        CORREO_PROVIDER: "smtp",
        CORREO_REMITENTE: "a@x.pe",
      }),
    ).toThrow("SMTP_URL");
    expect(() =>
      leerEntorno({
        ...BASE,
        CORREO_PROVIDER: "smtp",
        SMTP_URL: "smtp://u:secreto@h:587",
      }),
    ).toThrow(/^Entorno inválido: CORREO_REMITENTE$/);
  });
});

// Correo y origen de los enlaces en el módulo de adaptadores (spec 028, plan «Worker»): misma validación que el backend (`leerEntorno`).
// `CORREO_PROVIDER` ausente = `consola` (no en producción); `smtp` exige `SMTP_URL` y `CORREO_REMITENTE`. Los errores nombran la variable
// y nunca imprimen su valor (la URL SMTP puede llevar una clave).
import { describe, expect, it } from "vitest";
import { CorreoConsola, CorreoSmtp } from "@contapp/correo";
import {
  APP_ORIGIN,
  CORREO,
  ConfiguracionAdaptadoresError,
  appOriginDesdeEntorno,
  correoDesdeEntorno,
} from "./adaptadores.module.js";

const falla = (f: () => unknown): ConfiguracionAdaptadoresError => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfiguracionAdaptadoresError);
    return e as ConfiguracionAdaptadoresError;
  }
  throw new Error("no falló");
};

describe("correoDesdeEntorno", () => {
  it("los tokens de inyección son «CORREO» y «APP_ORIGIN»", () => {
    expect(CORREO).toBe("CORREO");
    expect(APP_ORIGIN).toBe("APP_ORIGIN");
  });

  it("sin variables: consola; con smtp, URL y remitente: SMTP", () => {
    expect(correoDesdeEntorno({})).toBeInstanceOf(CorreoConsola);
    expect(correoDesdeEntorno({ CORREO_PROVIDER: " Consola " })).toBeInstanceOf(CorreoConsola);
    expect(
      correoDesdeEntorno({
        CORREO_PROVIDER: "smtp",
        SMTP_URL: "smtp://localhost:1025",
        CORREO_REMITENTE: "ContApp <avisos@contapp.test>",
      }),
    ).toBeInstanceOf(CorreoSmtp);
  });

  it("proveedor desconocido, consola en producción y smtp incompleto fallan nombrando la variable, sin su valor", () => {
    expect(falla(() => correoDesdeEntorno({ CORREO_PROVIDER: "CANARIO-x" })).variable).toBe("CORREO_PROVIDER");
    expect(falla(() => correoDesdeEntorno({ NODE_ENV: "production" })).variable).toBe("CORREO_PROVIDER");
    expect(falla(() => correoDesdeEntorno({ CORREO_PROVIDER: "smtp", SMTP_URL: "smtp://u:CANARIO@h" })).variable).toBe(
      "CORREO_REMITENTE",
    );
    const e = falla(() => correoDesdeEntorno({ CORREO_PROVIDER: "smtp", CORREO_REMITENTE: "a@b.test" }));
    expect(e.variable).toBe("SMTP_URL");
    expect(`${e.name} ${e.message}`).not.toContain("CANARIO");
  });
});

describe("appOriginDesdeEntorno", () => {
  it("ausente fuera de producción: el origen de desarrollo; con valor: el mismo origen", () => {
    expect(appOriginDesdeEntorno({})).toBe("http://localhost:3000");
    expect(appOriginDesdeEntorno({ APP_ORIGIN: "https://app.contapp.test" })).toBe("https://app.contapp.test");
  });

  it("ausente en producción, con ruta, con barra final o con otro protocolo falla con APP_ORIGIN", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { APP_ORIGIN: "https://app.contapp.test/x" },
      { APP_ORIGIN: "https://app.contapp.test/" },
      { APP_ORIGIN: "ftp://app.contapp.test" },
      { APP_ORIGIN: "no es una url" },
    ])
      expect(falla(() => appOriginDesdeEntorno(env)).variable).toBe("APP_ORIGIN");
  });
});

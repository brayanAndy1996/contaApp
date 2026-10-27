import { describe, expect, it } from "vitest";
import { leerEntorno } from "./entorno.js";

// CA-4 (parámetros bajo el piso impiden arrancar) y D11 (correo). Contrato (plan: Decisiones:
// Argon2, Correo, Entorno):
//   leerEntorno(env: Record<string, string | undefined>): Entorno   // síncrono; lanza al arrancar
//   Entorno = { appOrigin: string; trustProxy: string;
//               argon2: { memoriaKib: number; iteraciones: number; paralelismo: number };
//               correo: { provider: "consola" | "smtp"; remitente?: string; smtpUrl?: string };
//               produccion: boolean }
// Defaults: ARGON2_* = 19456 / 2 / 1, TRUST_PROXY = "loopback", CORREO_PROVIDER = "consola".
// CORREO_PROVIDER se normaliza con trim + minúsculas; NODE_ENV denota producción sin distinguir
// mayúsculas ni espacios (mismo criterio que `esProduccion` de la spec 003).
const BASE = { APP_ORIGIN: "http://localhost:3000" };
const con = (extra: Record<string, string | undefined>) => ({ ...BASE, ...extra });

describe("valores por defecto", () => {
  it("sin variables opcionales: piso de Argon2, loopback y consola", () => {
    const e = leerEntorno(BASE);
    expect(e.argon2).toEqual({ memoriaKib: 19456, iteraciones: 2, paralelismo: 1 });
    expect(e.trustProxy).toBe("loopback");
    expect(e.correo.provider).toBe("consola");
    expect(e.appOrigin).toBe("http://localhost:3000");
    expect(e.produccion).toBe(false);
  });

  it("lee ARGON2_* numéricos sobre el piso", () => {
    const e = leerEntorno(
      con({ ARGON2_MEMORIA_KIB: "32768", ARGON2_ITERACIONES: "3", ARGON2_PARALELISMO: "2" }),
    );
    expect(e.argon2).toEqual({ memoriaKib: 32768, iteraciones: 3, paralelismo: 2 });
  });

  it("los valores exactos del piso son aceptados", () => {
    expect(() =>
      leerEntorno(
        con({ ARGON2_MEMORIA_KIB: "19456", ARGON2_ITERACIONES: "2", ARGON2_PARALELISMO: "1" }),
      ),
    ).not.toThrow();
  });
});

describe("parámetros de Argon2 bajo el piso impiden arrancar (CA-4)", () => {
  it.each([
    ["memoria 19455", { ARGON2_MEMORIA_KIB: "19455" }],
    ["memoria 8192", { ARGON2_MEMORIA_KIB: "8192" }],
    ["memoria 0", { ARGON2_MEMORIA_KIB: "0" }],
    ["memoria negativa", { ARGON2_MEMORIA_KIB: "-19456" }],
    ["iteraciones 1", { ARGON2_ITERACIONES: "1" }],
    ["iteraciones 0", { ARGON2_ITERACIONES: "0" }],
    ["paralelismo 0", { ARGON2_PARALELISMO: "0" }],
    ["memoria no numérica", { ARGON2_MEMORIA_KIB: "mucha" }],
    ["iteraciones decimales", { ARGON2_ITERACIONES: "2.5" }],
    ["memoria en notación científica que cae bajo el piso", { ARGON2_MEMORIA_KIB: "1e3" }],
  ])("%s -> error de arranque", (_n, extra) => {
    expect(() => leerEntorno(con(extra))).toThrow();
  });
});

describe("CORREO_PROVIDER (D11)", () => {
  it.each([["ses"], ["sendgrid"], ["mock"], ["consola2"], ["console"]])(
    "un proveedor desconocido (%j) impide arrancar",
    (valor) => {
      expect(() => leerEntorno(con({ CORREO_PROVIDER: valor }))).toThrow();
    },
  );

  it.each([["consola"], ["Consola"], ["  CONSOLA  "]])(
    "'%s' se normaliza a consola fuera de producción",
    (valor) => {
      expect(leerEntorno(con({ CORREO_PROVIDER: valor })).correo.provider).toBe("consola");
    },
  );

  it.each([["smtp"], ["SMTP"], ["  Smtp "]])("'%s' se normaliza a smtp", (valor) => {
    const e = leerEntorno(
      con({
        CORREO_PROVIDER: valor,
        SMTP_URL: "smtp://usuario:clave@correo.interno:587",
        CORREO_REMITENTE: "no-responder@estudio.pe",
        NODE_ENV: "production",
      }),
    );
    expect(e.correo.provider).toBe("smtp");
    expect(e.correo.remitente).toBe("no-responder@estudio.pe");
  });

  it.each([["production"], ["Production"], ["PRODUCTION"], [" production "], ["\tProduction\n"]])(
    "consola con NODE_ENV=%j impide arrancar",
    (nodeEnv) => {
      expect(() => leerEntorno(con({ CORREO_PROVIDER: "consola", NODE_ENV: nodeEnv }))).toThrow();
    },
  );

  it("consola por defecto (sin CORREO_PROVIDER) con producción impide arrancar", () => {
    expect(() => leerEntorno(con({ NODE_ENV: "production" }))).toThrow();
  });

  it("la variante ' CONSOLA ' con ' Production ' también impide arrancar", () => {
    expect(() =>
      leerEntorno(con({ CORREO_PROVIDER: " CONSOLA ", NODE_ENV: " Production " })),
    ).toThrow();
  });

  it.each([[undefined], ["development"], ["test"], [""], ["prod"]])(
    "consola con NODE_ENV=%j arranca",
    (nodeEnv) => {
      expect(() =>
        leerEntorno(con({ CORREO_PROVIDER: "consola", NODE_ENV: nodeEnv })),
      ).not.toThrow();
    },
  );

  it("smtp en producción arranca y marca produccion", () => {
    const e = leerEntorno(
      con({
        CORREO_PROVIDER: "smtp",
        SMTP_URL: "smtp://usuario:clave@correo.interno:587",
        CORREO_REMITENTE: "no-responder@estudio.pe",
        NODE_ENV: " Production ",
      }),
    );
    expect(e.produccion).toBe(true);
  });
});

describe("el error de arranque no filtra valores (CA-10)", () => {
  it("un proveedor desconocido con SMTP_URL canario no menciona el canario", () => {
    const canario = "CANARIO-SMTP-9f3a";
    let error: unknown;
    try {
      leerEntorno(
        con({ CORREO_PROVIDER: "ses", SMTP_URL: `smtp://usuario:${canario}@correo.interno:587` }),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const e = error as Error;
    expect(e.message).not.toContain(canario);
    expect(String(e.stack)).not.toContain(canario);
  });
});

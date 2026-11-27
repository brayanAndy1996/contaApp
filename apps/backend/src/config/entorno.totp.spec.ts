import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EntornoInvalidoError, leerEntorno } from "./entorno.js";

// Spec 029 (plan: Entorno; D1; T6 «el backend no arranca sin TOTP_CLAVE válida»). Contrato:
//   TOTP_CLAVE=<versión>:<base64 de 32 B>   obligatoria (en cualquier NODE_ENV)
//   TOTP_CLAVE_ANTERIOR (opcional)          misma forma, otra versión; solo descifra
//   leerEntorno(env).totp = { actual: ClaveTotp, anterior?: ClaveTotp }   // ClaveTotp = { version: number; clave: Buffer }
// Fallo = EntornoInvalidoError(variable) síncrono; el mensaje nombra la variable, nunca el valor (CA-6).
const BASE = { APP_ORIGIN: "http://localhost:3000" };
const b64 = () => randomBytes(32).toString("base64");

describe("TOTP_CLAVE (obligatoria)", () => {
  it("válida: expone versión y 32 bytes", () => {
    const bytes = randomBytes(32);
    const e = leerEntorno({
      ...BASE,
      TOTP_CLAVE: `2:${bytes.toString("base64")}`,
    });
    expect(e.totp.actual.version).toBe(2);
    expect(e.totp.actual.clave.equals(bytes)).toBe(true);
    expect(e.totp.anterior).toBeUndefined();
  });

  it.each([
    ["ausente", undefined],
    ["vacía", ""],
    ["solo espacios", "   "],
    ["sin versión", b64()],
    ["versión 0", `0:${b64()}`],
    ["31 bytes", `1:${randomBytes(31).toString("base64")}`],
    ["33 bytes", `1:${randomBytes(33).toString("base64")}`],
    ["no es base64", "1:%%%%"],
  ])("%s impide arrancar con EntornoInvalidoError(TOTP_CLAVE)", (_n, valor) => {
    const env = {
      ...BASE,
      ...(valor === undefined ? {} : { TOTP_CLAVE: valor }),
    };
    expect(() => leerEntorno(env)).toThrow(EntornoInvalidoError);
    try {
      leerEntorno(env);
    } catch (e) {
      expect((e as EntornoInvalidoError).variable).toBe("TOTP_CLAVE");
    }
  });

  it("también es obligatoria en producción", () => {
    expect(() =>
      leerEntorno({
        NODE_ENV: "production",
        APP_ORIGIN: "https://app.estudio.pe",
        CORREO_PROVIDER: "smtp",
        SMTP_URL: "smtp://h:587",
        CORREO_REMITENTE: "a@x.pe",
      }),
    ).toThrow(EntornoInvalidoError);
  });

  it("el error no incluye el valor de la clave (CA-6)", () => {
    const malo = `0:${b64()}`;
    let error: unknown;
    try {
      leerEntorno({ ...BASE, TOTP_CLAVE: malo });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EntornoInvalidoError);
    const texto = `${(error as Error).message} ${String((error as Error).stack)}`;
    expect(texto).not.toContain(malo);
    expect(texto).not.toContain(malo.slice(2));
  });
});

describe("TOTP_CLAVE_ANTERIOR (opcional, solo descifra)", () => {
  it("válida con otra versión: se expone como `anterior`", () => {
    const actual = randomBytes(32);
    const anterior = randomBytes(32);
    const e = leerEntorno({
      ...BASE,
      TOTP_CLAVE: `2:${actual.toString("base64")}`,
      TOTP_CLAVE_ANTERIOR: `1:${anterior.toString("base64")}`,
    });
    expect(e.totp.actual.version).toBe(2);
    expect(e.totp.anterior?.version).toBe(1);
    expect(e.totp.anterior?.clave.equals(anterior)).toBe(true);
  });

  it("vacía se trata como ausente", () => {
    const e = leerEntorno({
      ...BASE,
      TOTP_CLAVE: `1:${b64()}`,
      TOTP_CLAVE_ANTERIOR: "  ",
    });
    expect(e.totp.anterior).toBeUndefined();
  });

  it.each([
    ["con formato inválido", `x:${b64()}`],
    ["con la misma versión que la actual", `1:${b64()}`],
  ])(
    "%s impide arrancar con EntornoInvalidoError(TOTP_CLAVE_ANTERIOR)",
    (_n, valor) => {
      const env = {
        ...BASE,
        TOTP_CLAVE: `1:${b64()}`,
        TOTP_CLAVE_ANTERIOR: valor,
      };
      expect(() => leerEntorno(env)).toThrow(EntornoInvalidoError);
      try {
        leerEntorno(env);
      } catch (e) {
        expect((e as EntornoInvalidoError).variable).toBe(
          "TOTP_CLAVE_ANTERIOR",
        );
      }
    },
  );
});

// Spec 029 T18b: en producción la clave de `.env.example` (pública en el repo) no sirve para cifrar secretos.
// El valor se lee del archivo de ejemplo para no duplicarlo ni fijarlo en la prueba.
function claveDeEjemplo(variable: string): string {
  const ruta = new URL("../../../../.env.example", import.meta.url);
  const linea = readFileSync(ruta, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${variable}=`));
  const valor = linea?.slice(variable.length + 1).trim() ?? "";
  if (valor === "") throw new Error(`.env.example no define ${variable}`);
  return valor;
}

describe("TOTP_CLAVE de ejemplo en producción (T18b)", () => {
  const PROD = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.estudio.pe",
    CORREO_PROVIDER: "smtp",
    SMTP_URL: "smtp://h:587",
    CORREO_REMITENTE: "a@x.pe",
  };
  const ejemplo = claveDeEjemplo("TOTP_CLAVE");
  const propia = () => `2:${b64()}`;

  function variableDelError(env: Record<string, string>): string | undefined {
    try {
      leerEntorno(env);
    } catch (e) {
      expect(e).toBeInstanceOf(EntornoInvalidoError);
      return (e as EntornoInvalidoError).variable;
    }
    return undefined;
  }

  it("TOTP_CLAVE igual a la de ejemplo impide arrancar con EntornoInvalidoError(TOTP_CLAVE)", () => {
    expect(variableDelError({ ...PROD, TOTP_CLAVE: ejemplo })).toBe("TOTP_CLAVE");
  });

  it("con espacios alrededor sigue siendo la de ejemplo", () => {
    expect(variableDelError({ ...PROD, TOTP_CLAVE: `  ${ejemplo}  ` })).toBe("TOTP_CLAVE");
  });

  it("NODE_ENV se compara sin distinguir mayúsculas ni espacios", () => {
    expect(variableDelError({ ...PROD, NODE_ENV: " Production ", TOTP_CLAVE: ejemplo })).toBe("TOTP_CLAVE");
  });

  it("TOTP_CLAVE_ANTERIOR igual a la de ejemplo impide arrancar con EntornoInvalidoError(TOTP_CLAVE_ANTERIOR)", () => {
    const env = { ...PROD, TOTP_CLAVE: propia(), TOTP_CLAVE_ANTERIOR: ejemplo };
    expect(variableDelError(env)).toBe("TOTP_CLAVE_ANTERIOR");
  });

  it("una clave propia en producción arranca", () => {
    const e = leerEntorno({ ...PROD, TOTP_CLAVE: propia(), TOTP_CLAVE_ANTERIOR: `1:${b64()}` });
    expect(e.produccion).toBe(true);
    expect(e.totp.anterior?.version).toBe(1);
  });

  it("fuera de producción la clave de ejemplo sigue valiendo (desarrollo local)", () => {
    const e = leerEntorno({ ...BASE, TOTP_CLAVE: ejemplo });
    expect(e.totp.actual.version).toBe(1);
  });

  it.each(["TOTP_CLAVE", "TOTP_CLAVE_ANTERIOR"] as const)(
    "el error por %s de ejemplo no incluye el valor (CA-6)",
    (variable) => {
      const env: Record<string, string> =
        variable === "TOTP_CLAVE"
          ? { ...PROD, TOTP_CLAVE: ejemplo }
          : { ...PROD, TOTP_CLAVE: propia(), TOTP_CLAVE_ANTERIOR: ejemplo };
      let error: unknown;
      try {
        leerEntorno(env);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EntornoInvalidoError);
      const texto = `${(error as Error).message} ${String((error as Error).stack)}`;
      expect(texto).not.toContain(ejemplo);
      expect(texto).not.toContain(ejemplo.slice(ejemplo.indexOf(":") + 1));
    },
  );
});

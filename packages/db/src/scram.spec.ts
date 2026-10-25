import { describe, expect, it } from "vitest";
import { generaVerificador, verificaPassword } from "./scram";

// Contrato (plan.md, "Contraseña sin variable"): verificador SCRAM-SHA-256 calculado en el cliente.
//   generaVerificador(password, { sal?, iteraciones? }) -> 'SCRAM-SHA-256$<it>:<sal b64>$<StoredKey b64>:<ServerKey b64>'
//   verificaPassword(verificador, password) -> boolean
// Vector fijo calculado con RFC 5802 (PBKDF2-HMAC-SHA256, HMAC "Client Key"/"Server Key"), contraseña de ejemplo del RFC 7677.
const PASSWORD = "pencil";
const SAL = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
const VERIFICADOR_FIJO =
  "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=";
const FORMATO =
  /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/;

describe("scram: generaVerificador", () => {
  it("misma contraseña + sal + 4096 iteraciones da el verificador del vector fijo", () => {
    expect(generaVerificador(PASSWORD, { sal: SAL, iteraciones: 4096 })).toBe(
      VERIFICADOR_FIJO,
    );
  });

  it("por defecto usa 4096 iteraciones y es determinista con la misma sal", () => {
    expect(generaVerificador(PASSWORD, { sal: SAL })).toBe(VERIFICADOR_FIJO);
  });

  it("tiene el formato SCRAM-SHA-256$4096:<sal>$<StoredKey>:<ServerKey>", () => {
    expect(generaVerificador(PASSWORD)).toMatch(FORMATO);
  });

  it("sin sal explícita genera una sal aleatoria distinta en cada llamada", () => {
    const a = generaVerificador(PASSWORD);
    const b = generaVerificador(PASSWORD);
    expect(a).not.toBe(b);
    expect(verificaPassword(a, PASSWORD)).toBe(true);
    expect(verificaPassword(b, PASSWORD)).toBe(true);
  });

  it("otra contraseña o otra sal dan otro verificador", () => {
    expect(generaVerificador("lapiz", { sal: SAL })).not.toBe(VERIFICADOR_FIJO);
    expect(
      generaVerificador(PASSWORD, { sal: Buffer.from("otra-sal-de-16by") }),
    ).not.toBe(VERIFICADOR_FIJO);
  });

  it("respeta un número de iteraciones distinto en el formato", () => {
    expect(
      generaVerificador(PASSWORD, { sal: SAL, iteraciones: 5000 }),
    ).toMatch(/^SCRAM-SHA-256\$5000:/);
  });

  it("no contiene la contraseña en claro", () => {
    const secreto = "ClaveMuySecreta-123";
    expect(generaVerificador(secreto)).not.toContain(secreto);
  });
});

describe("scram: verificaPassword", () => {
  it("devuelve true con la contraseña correcta", () => {
    expect(verificaPassword(VERIFICADOR_FIJO, PASSWORD)).toBe(true);
  });

  it("devuelve false con una contraseña incorrecta", () => {
    expect(verificaPassword(VERIFICADOR_FIJO, "Pencil")).toBe(false);
    expect(verificaPassword(VERIFICADOR_FIJO, "pencil ")).toBe(false);
  });

  it("devuelve false con contraseña vacía", () => {
    expect(verificaPassword(VERIFICADOR_FIJO, "")).toBe(false);
  });

  it("devuelve false (sin lanzar) con un verificador mal formado", () => {
    expect(verificaPassword("", PASSWORD)).toBe(false);
    expect(verificaPassword("texto-cualquiera", PASSWORD)).toBe(false);
    expect(verificaPassword("SCRAM-SHA-256$4096:abc", PASSWORD)).toBe(false);
    expect(verificaPassword(PASSWORD, PASSWORD)).toBe(false);
  });

  it("es coherente con generaVerificador (ida y vuelta)", () => {
    const v = generaVerificador("otra-clave-9");
    expect(verificaPassword(v, "otra-clave-9")).toBe(true);
    expect(verificaPassword(v, "otra-clave-8")).toBe(false);
  });
});

// --- T12d: ramas de validación y SASLprep -----------------------------------------------------
const b64 = (n: number) => Buffer.alloc(n, 7).toString("base64");
const CLAVE_OK = b64(32);
const armar = (it: string, sal: string, stored: string, server: string) =>
  `SCRAM-SHA-256$${it}:${sal}$${stored}:${server}`;

describe("scram: SASLprep (contraseña no ASCII)", () => {
  const v = (password: string) =>
    generaVerificador(password, { sal: SAL, iteraciones: 4 });

  it.each([
    ["U+00A0 (espacio de no separación)", "a b"],
    ["U+3000 (espacio ideográfico)", "a　b"],
    ["U+2003 (em space)", "a b"],
    ["U+202F (espacio estrecho)", "a b"],
  ])(
    "un espacio no ASCII (%s) da el verificador de su forma con U+0020",
    (_n, texto) => {
      expect(v(texto)).toBe(v("a b"));
      expect(verificaPassword(v("a b"), texto)).toBe(true);
    },
  );

  it.each([
    ["U+00AD (guion blando)", "a­b"],
    ["U+200D (unión de ancho cero)", "a‍b"],
    ["U+FE0F (selector de variación)", "a️b"],
    ["U+FEFF (marca de orden de bytes)", "a﻿b"],
    ["U+2060 (word joiner)", "a⁠b"],
  ])(
    "un carácter mapeado a nada (%s) da el verificador de su forma sin él",
    (_n, texto) => {
      expect(v(texto)).toBe(v("ab"));
      expect(verificaPassword(v("ab"), texto)).toBe(true);
    },
  );

  it("normaliza NFKC: la ligadura U+FB01 equivale a 'fi' y 'é' compuesta a descompuesta", () => {
    expect(v("ﬁn")).toBe(v("fin"));
    expect(v("café")).toBe(v("café"));
  });

  it("una contraseña no ASCII distinta sigue dando otro verificador", () => {
    expect(v("año")).not.toBe(v("ano"));
    expect(verificaPassword(v("año"), "ano")).toBe(false);
  });

  it("una contraseña ASCII imprimible no se altera (control)", () => {
    expect(v("a b")).not.toBe(v("ab"));
  });
});

describe("scram: generaVerificador rechaza entradas no válidas con mensaje fijo", () => {
  it.each([
    ["0", 0],
    ["negativo", -1],
    ["no entero", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["mayor que el máximo", 10_000_001],
  ])("iteraciones %s", (_n, iteraciones) => {
    expect(() =>
      generaVerificador(PASSWORD, { sal: SAL, iteraciones }),
    ).toThrow("Número de iteraciones SCRAM no válido");
  });

  it("sal null o undefined equivale a sin sal (se genera una aleatoria)", () => {
    expect(generaVerificador(PASSWORD, { sal: null as never })).toMatch(
      FORMATO,
    );
    expect(generaVerificador(PASSWORD, { sal: undefined })).toMatch(FORMATO);
  });

  it("1 iteración es válida (límite inferior)", () => {
    expect(generaVerificador(PASSWORD, { sal: SAL, iteraciones: 1 })).toMatch(
      /^SCRAM-SHA-256\$1:/,
    );
  });

  it.each([
    ["Buffer vacío", Buffer.alloc(0)],
    ["cadena", "sal-de-16-bytes!"],
    ["Uint8Array que no es Buffer", new Uint8Array(16)],
  ])("sal %s", (_n, sal) => {
    expect(() => generaVerificador(PASSWORD, { sal: sal as never })).toThrow(
      "Sal SCRAM no válida",
    );
  });

  it.each([
    ["vacía", ""],
    ["número", 12345],
    ["null", null],
    ["undefined", undefined],
    ["objeto", {}],
  ])("contraseña %s", (_n, password) => {
    expect(() => generaVerificador(password as never)).toThrow(
      "La contraseña para el verificador SCRAM no es válida",
    );
  });

  it("los mensajes de error no contienen la contraseña", () => {
    const secreto = "ClaveMuySecreta-123";
    try {
      generaVerificador(secreto, { iteraciones: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secreto);
    }
  });
});

describe("scram: verificaPassword devuelve false (sin lanzar) ante verificadores manipulados", () => {
  it.each([
    [
      "StoredKey de 33 bytes",
      armar("4096", "W22ZaJ0SNY7soEsUEjb6gQ==", b64(33), CLAVE_OK),
    ],
    [
      "StoredKey de 16 bytes (sal válida)",
      armar("4096", "W22ZaJ0SNY7soEsUEjb6gQ==", b64(16), CLAVE_OK),
    ],
    [
      "ServerKey de 16 bytes",
      armar("4096", "W22ZaJ0SNY7soEsUEjb6gQ==", CLAVE_OK, b64(16)),
    ],
    [
      "ServerKey de 64 bytes",
      armar("4096", "W22ZaJ0SNY7soEsUEjb6gQ==", CLAVE_OK, b64(64)),
    ],
  ])("%s", (_n, verificador) => {
    expect(verificaPassword(verificador, PASSWORD)).toBe(false);
  });

  it("sal que decodifica a 0 bytes", () => {
    expect(
      verificaPassword(armar("4096", "A", CLAVE_OK, CLAVE_OK), PASSWORD),
    ).toBe(false);
  });

  it.each([
    ["0 iteraciones", "0"],
    ["iteraciones por encima del máximo", "10000001"],
    ["9 dígitos de iteraciones (no cumple el formato)", "999999999"],
  ])("%s no gasta CPU y da false", (_n, it) => {
    const inicio = Date.now();
    expect(
      verificaPassword(
        armar(it, "W22ZaJ0SNY7soEsUEjb6gQ==", CLAVE_OK, CLAVE_OK),
        PASSWORD,
      ),
    ).toBe(false);
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it("con la StoredKey correcta pero otra ServerKey da false", () => {
    const malo = VERIFICADOR_FIJO.replace(/:[^:]+$/, `:${CLAVE_OK}`);
    expect(malo).not.toBe(VERIFICADOR_FIJO);
    expect(verificaPassword(malo, PASSWORD)).toBe(false);
  });

  it("con la ServerKey correcta pero otra StoredKey da false", () => {
    const malo = VERIFICADOR_FIJO.replace(/\$[^$:]+:/, `$${CLAVE_OK}:`);
    expect(malo).not.toBe(VERIFICADOR_FIJO);
    expect(verificaPassword(malo, PASSWORD)).toBe(false);
  });

  it.each([
    ["verificador número", 123, PASSWORD],
    ["verificador null", null, PASSWORD],
    ["verificador undefined", undefined, PASSWORD],
    ["verificador objeto", {}, PASSWORD],
    ["contraseña número", VERIFICADOR_FIJO, 123],
    ["contraseña null", VERIFICADOR_FIJO, null],
    ["contraseña undefined", VERIFICADOR_FIJO, undefined],
  ])("tipos no string: %s", (_n, verificador, password) => {
    expect(verificaPassword(verificador as never, password as never)).toBe(
      false,
    );
  });

  it("verifica correctamente con una sal de otro tamaño y otras iteraciones", () => {
    const v = generaVerificador("clave-9", {
      sal: Buffer.from("sal-corta"),
      iteraciones: 7,
    });
    expect(verificaPassword(v, "clave-9")).toBe(true);
    expect(verificaPassword(v, "clave-8")).toBe(false);
  });
});

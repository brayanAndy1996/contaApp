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

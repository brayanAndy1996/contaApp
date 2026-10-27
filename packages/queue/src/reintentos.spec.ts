import { describe, expect, it } from "vitest";
import { calcularBackoffMs, decidirTrasError } from "./reintentos.js";

// Contrato (plan 008, "Worker: Ejecutor", CA-8; funciones puras en packages/queue/src/reintentos.ts,
// exportadas tambien desde el indice):
//  - calcularBackoffMs(n, baseMs, azar = Math.random): n >= 1 es el numero de reintento. Devuelve un
//    entero = round(baseMs * 2^(n-1) * (0.8 + 0.4 * azar())) con azar() en [0, 1): backoff exponencial
//    con jitter de +-20 %. Con azar() = 0.5 es exactamente baseMs * 2^(n-1).
//  - decidirTrasError(clasificacion: { clase, motivo }, { intentos, reintentos, baseMs, ahora: Date,
//    azar? }) donde `intentos` = reintentos YA consumidos antes de este fallo (0 en el primer fallo) y
//    `reintentos` = config_sistema.reintentos:
//      - clase "transitorio" (incluye el error no clasificado) con intentos < reintentos ->
//        { accion: "reintentar", intentos: intentos + 1, disponibleDesde: ahora + backoff(intentos + 1) }
//      - transitorio con intentos >= reintentos -> { accion: "terminar", motivo: "sunat_no_responde" }
//      - credencial / datos / portal -> { accion: "terminar", motivo: clasificacion.motivo } SIEMPRE
//        (sin reintento, aunque queden intentos).
//    Con los valores por defecto (3 reintentos, base 5 s) los retrasos son 5 s, 10 s y 20 s (CA-8).
const MITAD = () => 0.5;
const AHORA = new Date("2026-10-27T15:00:00.000Z");
const TRANSITORIO = {
  clase: "transitorio",
  motivo: "sunat_no_responde",
} as const;

describe("calcularBackoffMs", () => {
  it("con azar 0.5 es base * 2^(n-1): 5 s, 10 s, 20 s", () => {
    expect(calcularBackoffMs(1, 5000, MITAD)).toBe(5000);
    expect(calcularBackoffMs(2, 5000, MITAD)).toBe(10_000);
    expect(calcularBackoffMs(3, 5000, MITAD)).toBe(20_000);
  });

  it("el jitter es +-20 %: extremos 0.8x y casi 1.2x", () => {
    expect(calcularBackoffMs(1, 5000, () => 0)).toBe(4000);
    expect(calcularBackoffMs(2, 5000, () => 0)).toBe(8000);
    const casi = calcularBackoffMs(1, 5000, () => 0.999999);
    expect(casi).toBeGreaterThanOrEqual(5990);
    expect(casi).toBeLessThanOrEqual(6000);
  });

  it("con azar real nunca sale de [0.8x, 1.2x] y devuelve enteros", () => {
    for (let n = 1; n <= 5; n++) {
      const nominal = 100 * 2 ** (n - 1);
      for (let i = 0; i < 300; i++) {
        const v = calcularBackoffMs(n, 100);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(nominal * 0.8);
        expect(v).toBeLessThanOrEqual(nominal * 1.2);
      }
    }
  });

  it("respeta la base configurada (100 ms en pruebas)", () => {
    expect(calcularBackoffMs(1, 100, MITAD)).toBe(100);
    expect(calcularBackoffMs(3, 100, MITAD)).toBe(400);
  });
});

describe("decidirTrasError", () => {
  const ctx = (intentos: number, reintentos = 3) => ({
    intentos,
    reintentos,
    baseMs: 5000,
    ahora: AHORA,
    azar: MITAD,
  });

  it("transitorio: reintenta 3 veces con 5 s, 10 s y 20 s y luego termina en sunat_no_responde", () => {
    const esperas = [5000, 10_000, 20_000];
    for (let i = 0; i < 3; i++) {
      expect(decidirTrasError(TRANSITORIO, ctx(i))).toEqual({
        accion: "reintentar",
        intentos: i + 1,
        disponibleDesde: new Date(AHORA.getTime() + esperas[i]!),
      });
    }
    expect(decidirTrasError(TRANSITORIO, ctx(3))).toEqual({
      accion: "terminar",
      motivo: "sunat_no_responde",
    });
  });

  it("el tope sale de la configuracion: 0 reintentos termina de inmediato, 5 permite 5", () => {
    expect(decidirTrasError(TRANSITORIO, ctx(0, 0))).toEqual({
      accion: "terminar",
      motivo: "sunat_no_responde",
    });
    expect(decidirTrasError(TRANSITORIO, ctx(4, 5)).accion).toBe("reintentar");
    expect(decidirTrasError(TRANSITORIO, ctx(5, 5)).accion).toBe("terminar");
  });

  it("nunca reintenta por encima del tope (intentos ya pasado)", () => {
    expect(decidirTrasError(TRANSITORIO, ctx(7, 3)).accion).toBe("terminar");
  });

  it.each([
    [{ clase: "credencial", motivo: "credencial_invalida" }],
    [{ clase: "datos", motivo: "datos_invalidos" }],
    [{ clase: "portal", motivo: "portal_cambio" }],
  ] as const)("%o no se reintenta aunque queden intentos", (clasificacion) => {
    for (const intentos of [0, 1, 2]) {
      expect(decidirTrasError(clasificacion, ctx(intentos))).toEqual({
        accion: "terminar",
        motivo: clasificacion.motivo,
      });
    }
  });

  it("aplica jitter con azar real dentro de +-20 %", () => {
    for (let i = 0; i < 200; i++) {
      const r = decidirTrasError(TRANSITORIO, {
        intentos: 0,
        reintentos: 3,
        baseMs: 5000,
        ahora: AHORA,
      });
      expect(r.accion).toBe("reintentar");
      if (r.accion === "reintentar") {
        const espera = r.disponibleDesde.getTime() - AHORA.getTime();
        expect(espera).toBeGreaterThanOrEqual(4000);
        expect(espera).toBeLessThanOrEqual(6000);
      }
    }
  });
});

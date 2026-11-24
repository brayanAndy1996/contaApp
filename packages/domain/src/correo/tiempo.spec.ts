// Spec 028 · T1 (rojo). Hora de Lima (UTC−5, sin horario de verano) para el correo (R-5, R-13; plan, Contratos: domain `tiempo.ts`).
// El dominio no lee reloj: cada función recibe el instante como `Date`. Contratos fijados por T1: `fechaHoraLima` → «dd/mm/aaaa hh:mm»
// de 24 h con ceros a la izquierda; una `Date` inválida lanza (cualquier error); no se muta el argumento.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diaLima, fechaHoraLima, periodoAnteriorLima } from "../index";
import { esperarLanza } from "../../tests/ayudas/correo";

const d = (iso: string): Date => new Date(iso);
const CINCO_HORAS = 5 * 3600_000;
const lima = (i: Date): Date => new Date(i.getTime() - CINCO_HORAS);
const dos = (n: number): string => String(n).padStart(2, "0");

describe("diaLima", () => {
  it.each([
    ["2026-11-24T04:59:59.999Z", "2026-11-23"],
    ["2026-11-24T05:00:00.000Z", "2026-11-24"],
    ["2026-11-24T12:00:00Z", "2026-11-24"],
    ["2026-11-24T23:59:59Z", "2026-11-24"],
    ["2026-11-25T04:59:59Z", "2026-11-24"],
    ["2026-11-25T05:00:00Z", "2026-11-25"],
  ])("%s → %s (borde 05:00Z = medianoche de Lima)", (iso, esperado) => {
    expect(diaLima(d(iso))).toBe(esperado);
  });

  it("año nuevo y bisiesto", () => {
    expect(diaLima(d("2027-01-01T04:59:59Z"))).toBe("2026-12-31");
    expect(diaLima(d("2027-01-01T05:00:00Z"))).toBe("2027-01-01");
    expect(diaLima(d("2028-03-01T04:59:59Z"))).toBe("2028-02-29");
    expect(diaLima(d("2028-03-01T05:00:00Z"))).toBe("2028-03-01");
  });

  it("no muta la fecha recibida y lanza con una fecha inválida", () => {
    const x = d("2026-11-24T05:00:00Z");
    const antes = x.getTime();
    diaLima(x);
    expect(x.getTime()).toBe(antes);
    esperarLanza(() => diaLima(new Date("no es fecha")));
  });
});

describe("fechaHoraLima", () => {
  it.each([
    ["2026-11-24T12:05:00Z", "24/11/2026 07:05"],
    ["2026-11-24T05:00:00Z", "24/11/2026 00:00"],
    ["2026-11-24T04:59:59Z", "23/11/2026 23:59"],
    ["2027-01-01T04:59:00Z", "31/12/2026 23:59"],
    ["2026-01-05T14:07:00Z", "05/01/2026 09:07"],
  ])("%s → %s", (iso, esperado) => {
    expect(fechaHoraLima(d(iso))).toBe(esperado);
  });

  it("lanza con una fecha inválida", () => {
    esperarLanza(() => fechaHoraLima(new Date(Number.NaN)));
  });
});

describe("periodoAnteriorLima · R-13 (mes anterior, en Lima)", () => {
  it.each([
    ["2026-11-24T12:00:00Z", "202610"],
    ["2026-12-10T12:00:00Z", "202611"],
    ["2026-01-15T12:00:00Z", "202512"], // enero → diciembre del año anterior
    ["2026-01-01T05:30:00Z", "202512"], // 1.º de enero 00:30 de Lima
    ["2026-03-01T05:30:00Z", "202602"], // 1.º de mes 00:30 de Lima → el mes que acaba de terminar
    ["2026-03-01T05:00:00Z", "202602"],
    ["2026-03-01T04:59:59Z", "202601"], // todavía 28 de febrero 23:59 en Lima
    ["2026-02-01T05:00:00Z", "202601"],
    ["2026-10-01T04:59:59Z", "202608"], // 30 de septiembre en Lima
    ["2027-01-01T04:59:59Z", "202611"], // 31 de diciembre 23:59 en Lima
    ["2028-03-01T04:59:59Z", "202801"], // 29 de febrero bisiesto en Lima
  ])("%s → %s", (iso, esperado) => {
    expect(periodoAnteriorLima(d(iso))).toBe(esperado);
  });

  it("lanza con una fecha inválida y no muta el argumento", () => {
    esperarLanza(() => periodoAnteriorLima(new Date("x")));
    const x = d("2026-01-01T05:30:00Z");
    periodoAnteriorLima(x);
    expect(x.toISOString()).toBe("2026-01-01T05:30:00.000Z");
  });
});

describe("tiempo de Lima · propiedades contra un oráculo independiente (desplazar 5 h y leer en UTC)", () => {
  const instante = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2040-12-31T23:59:59Z"), noInvalidDate: true });
  const OPCIONES = { seed: 20261124, numRuns: 500 };

  it("diaLima y fechaHoraLima coinciden con el oráculo", () => {
    fc.assert(
      fc.property(instante, (i) => {
        const l = lima(i);
        const dia = `${l.getUTCFullYear()}-${dos(l.getUTCMonth() + 1)}-${dos(l.getUTCDate())}`;
        expect(diaLima(i)).toBe(dia);
        expect(fechaHoraLima(i)).toBe(`${dos(l.getUTCDate())}/${dos(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${dos(l.getUTCHours())}:${dos(l.getUTCMinutes())}`);
      }),
      OPCIONES,
    );
  });

  it("periodoAnteriorLima es el mes anterior al mes de Lima del instante", () => {
    fc.assert(
      fc.property(instante, (i) => {
        const l = lima(i);
        const m = l.getUTCMonth(); // 0..11 del mes actual de Lima
        const anio = m === 0 ? l.getUTCFullYear() - 1 : l.getUTCFullYear();
        const mes = m === 0 ? 12 : m;
        expect(periodoAnteriorLima(i)).toBe(`${anio}${dos(mes)}`);
      }),
      OPCIONES,
    );
  });
});

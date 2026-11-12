import { describe, expect, it } from "vitest";
import { fechaCorta, fechaHoraLima } from "./fechas";

// Spec 020, T7 (DT-5, CA-7; D-8; P-3, P-7). Se corre con `TZ=UTC` y con `TZ=Asia/Tokyo`: la salida no depende del proceso.

describe("fechaHoraLima · instantes con hora, en hora de Lima", () => {
  it("15:00 UTC del 20/10/2026 es 10:00 a. m. en Lima", () => {
    expect(fechaHoraLima("2026-10-20T15:00:00.000Z")).toMatch(/^20\/10\/26,? 10:00\s?a\.\s?m\.$/);
  });

  it("un instante sin parsear sale «—», nunca «Invalid Date»", () => {
    expect(fechaHoraLima("no-es-fecha")).toBe("—");
  });
});

describe("fechaCorta · solo el día (P-7)", () => {
  it("un instante de las 23:30 de Lima (04:30 UTC del día siguiente) sale con el día de Lima, sin hora", () => {
    expect(fechaCorta("2026-10-21T04:30:00.000Z")).toBe("20/10/2026");
  });

  it("un instante de las 00:30 de Lima (05:30 UTC) ya es el día siguiente", () => {
    expect(fechaCorta("2026-10-21T05:30:00.000Z")).toBe("21/10/2026");
  });

  it("una fecha pura AAAA-MM-DD sale con el mismo día, sin pasar por una zona horaria", () => {
    expect(fechaCorta("2026-10-20")).toBe("20/10/2026");
    expect(fechaCorta("2026-11-05")).toBe("5/11/2026");
  });

  it("nunca muestra la hora", () => {
    expect(fechaCorta("2026-10-20T15:00:00.000Z")).not.toMatch(/:/);
  });

  it("un valor ilegible sale «—»", () => {
    expect(fechaCorta("no-es-fecha")).toBe("—");
  });
});

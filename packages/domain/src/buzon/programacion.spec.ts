// Spec 023, T1 (CA-1, D-5, P-2): franjas de captura programada en hora de Lima (UTC−5, sin
// horario de verano). Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  capturaVencida,
  desfaseCliente,
  seleccionarVencidos,
  ultimaFranja,
} from "./index";

/** Hora de Lima → instante UTC (Lima = UTC−5). */
const lima = (iso: string): Date => new Date(`${iso}-05:00`);

// uuid → desfase (FNV-1a 32 bits sobre el uuid en minúsculas, módulo 180; fijados a mano).
const U = (n: string) => `0192f3a0-7c00-7000-8000-${n.padStart(12, "0")}`;
const D0 = U("20");
const D179 = U("21");
const D20 = U("2d");
const D40 = U("6");
const D40_B = U("ee");
const D60 = U("15");
const D100 = U("68");

describe("desfaseCliente", () => {
  it("valores fijados: el desfase de un cliente no cambia entre versiones", () => {
    expect(desfaseCliente(U("1"))).toBe(33);
    expect(desfaseCliente(U("a"))).toBe(81);
    expect(desfaseCliente("018f0000-aaaa-7bbb-8ccc-dddddddddddd")).toBe(52);
    expect(desfaseCliente(D0)).toBe(0);
    expect(desfaseCliente(D179)).toBe(179);
    expect(desfaseCliente(D20)).toBe(20);
    expect(desfaseCliente(D40)).toBe(40);
    expect(desfaseCliente(D40_B)).toBe(40);
    expect(desfaseCliente(D60)).toBe(60);
    expect(desfaseCliente(D100)).toBe(100);
  });

  it("es estable: la misma entrada da lo mismo y las mayúsculas no cambian el resultado", () => {
    const id = "018F0000-AAAA-7BBB-8CCC-DDDDDDDDDDDD";
    expect(desfaseCliente(id)).toBe(desfaseCliente(id));
    expect(desfaseCliente(id)).toBe(desfaseCliente(id.toLowerCase()));
  });

  it("siempre es un entero entre 0 y 179 y reparte los clientes", () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const d = desfaseCliente(U(i.toString(16)));
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(179);
      vistos.add(d);
    }
    expect(vistos.size).toBeGreaterThan(150);
  });
});

describe("ultimaFranja", () => {
  it("plan 720 con ancla 02:40: franjas 02:40 y 14:40 de Lima", () => {
    const f = (ahora: string) =>
      ultimaFranja({ ahora: lima(ahora), frecuenciaMin: 720, desfaseMin: 40 });
    expect(f("2026-11-17T14:41:00").toISOString()).toBe(
      lima("2026-11-17T14:40:00").toISOString(),
    );
    expect(f("2026-11-17T14:40:00").toISOString()).toBe(
      lima("2026-11-17T14:40:00").toISOString(),
    );
    expect(f("2026-11-17T14:39:59").toISOString()).toBe(
      lima("2026-11-17T02:40:00").toISOString(),
    );
    expect(f("2026-11-17T23:59:59").toISOString()).toBe(
      lima("2026-11-17T14:40:00").toISOString(),
    );
    expect(f("2026-11-17T02:40:00").toISOString()).toBe(
      lima("2026-11-17T02:40:00").toISOString(),
    );
  });

  it("plan 1440: una sola franja al día, en la ancla (02:00 + desfase)", () => {
    const f = (ahora: string, desfaseMin: number) =>
      ultimaFranja({
        ahora: lima(ahora),
        frecuenciaMin: 1440,
        desfaseMin,
      }).toISOString();
    expect(f("2026-11-17T15:00:00", 0)).toBe(
      lima("2026-11-17T02:00:00").toISOString(),
    );
    expect(f("2026-11-17T15:00:00", 179)).toBe(
      lima("2026-11-17T04:59:00").toISOString(),
    );
    expect(f("2026-11-17T04:58:00", 179)).toBe(
      lima("2026-11-16T04:59:00").toISOString(),
    );
  });

  it("plan 240: seis franjas desde la ancla", () => {
    const f = (ahora: string) =>
      ultimaFranja({
        ahora: lima(ahora),
        frecuenciaMin: 240,
        desfaseMin: 40,
      }).toISOString();
    expect(f("2026-11-17T06:39:00")).toBe(
      lima("2026-11-17T02:40:00").toISOString(),
    );
    expect(f("2026-11-17T06:40:00")).toBe(
      lima("2026-11-17T06:40:00").toISOString(),
    );
    expect(f("2026-11-17T21:00:00")).toBe(
      lima("2026-11-17T18:40:00").toISOString(),
    );
    expect(f("2026-11-17T23:50:00")).toBe(
      lima("2026-11-17T22:40:00").toISOString(),
    );
  });

  it("plan 60: una franja por hora desde la ancla", () => {
    const f = (ahora: string) =>
      ultimaFranja({
        ahora: lima(ahora),
        frecuenciaMin: 60,
        desfaseMin: 40,
      }).toISOString();
    expect(f("2026-11-17T09:39:59")).toBe(
      lima("2026-11-17T08:40:00").toISOString(),
    );
    expect(f("2026-11-17T09:40:00")).toBe(
      lima("2026-11-17T09:40:00").toISOString(),
    );
    expect(f("2026-11-17T23:10:00")).toBe(
      lima("2026-11-17T22:40:00").toISOString(),
    );
  });

  it("antes de la ancla del día, la última franja es la del día anterior (cambio de día)", () => {
    const f = ultimaFranja({
      ahora: lima("2026-11-17T00:30:00"),
      frecuenciaMin: 720,
      desfaseMin: 40,
    });
    expect(f.toISOString()).toBe(lima("2026-11-16T14:40:00").toISOString());
  });

  it("cambio de mes y de año en hora de Lima, no en UTC", () => {
    // 2026-06-01 01:00 Lima = 06:00Z; la franja es la del 31 de mayo, 14:40 Lima (19:40Z).
    const mes = ultimaFranja({
      ahora: lima("2026-06-01T01:00:00"),
      frecuenciaMin: 720,
      desfaseMin: 40,
    });
    expect(mes.toISOString()).toBe("2026-05-31T19:40:00.000Z");
    // 2027-01-01 00:10 Lima = 05:10Z; 1440 → franja del 31 de diciembre a las 02:00 Lima (07:00Z).
    const anio = ultimaFranja({
      ahora: lima("2027-01-01T00:10:00"),
      frecuenciaMin: 1440,
      desfaseMin: 0,
    });
    expect(anio.toISOString()).toBe("2026-12-31T07:00:00.000Z");
  });

  it("las 23:30 de Lima ya son el día siguiente en UTC, pero la franja sigue siendo del día de Lima", () => {
    // 2026-11-17 23:30 Lima = 2026-11-18T04:30Z.
    const f = ultimaFranja({
      ahora: new Date("2026-11-18T04:30:00Z"),
      frecuenciaMin: 1440,
      desfaseMin: 0,
    });
    expect(f.toISOString()).toBe(lima("2026-11-17T02:00:00").toISOString());
  });
});

describe("capturaVencida", () => {
  const base = { frecuenciaMin: 720, clienteId: D40 } as const;

  it("CA-1: a las 14:41 vence si la última fue a las 02:41 y no si fue a las 14:40", () => {
    const ahora = lima("2026-11-17T14:41:00");
    expect(
      capturaVencida({
        ...base,
        ahora,
        ultimaProgramadaEn: lima("2026-11-17T02:41:00"),
      }),
    ).toBe(true);
    expect(
      capturaVencida({
        ...base,
        ahora,
        ultimaProgramadaEn: lima("2026-11-17T14:40:00"),
      }),
    ).toBe(false);
  });

  it("nunca capturado (null) siempre está vencido", () => {
    expect(
      capturaVencida({
        ...base,
        ahora: lima("2026-11-17T03:00:00"),
        ultimaProgramadaEn: null,
      }),
    ).toBe(true);
    expect(
      capturaVencida({
        ...base,
        ahora: lima("2026-11-17T23:59:00"),
        ultimaProgramadaEn: null,
      }),
    ).toBe(true);
  });

  it("no vence antes de la franja: 14:39 con la última de las 02:41", () => {
    expect(
      capturaVencida({
        ...base,
        ahora: lima("2026-11-17T14:39:00"),
        ultimaProgramadaEn: lima("2026-11-17T02:41:00"),
      }),
    ).toBe(false);
  });

  it("vence exactamente en la franja", () => {
    expect(
      capturaVencida({
        ...base,
        ahora: lima("2026-11-17T14:40:00"),
        ultimaProgramadaEn: lima("2026-11-17T02:41:00"),
      }),
    ).toBe(true);
  });

  it("plan 1440: no vence antes de su ancla y vence desde ella (desfase 179 → 04:59)", () => {
    const p = {
      frecuenciaMin: 1440,
      clienteId: D179,
      ultimaProgramadaEn: lima("2026-11-16T05:00:00"),
    };
    expect(capturaVencida({ ...p, ahora: lima("2026-11-17T02:00:00") })).toBe(
      false,
    );
    expect(capturaVencida({ ...p, ahora: lima("2026-11-17T04:58:59") })).toBe(
      false,
    );
    expect(capturaVencida({ ...p, ahora: lima("2026-11-17T04:59:00") })).toBe(
      true,
    );
  });

  it("plan 1440: con la captura del día hecha, no vuelve a vencer en todo el día", () => {
    const p = {
      frecuenciaMin: 1440,
      clienteId: D20,
      ultimaProgramadaEn: lima("2026-11-17T02:21:00"),
    };
    for (let minutos = 0; minutos < 24 * 60; minutos += 15) {
      const ahora = new Date(
        lima("2026-11-17T02:21:00").getTime() + minutos * 60_000,
      );
      if (ahora >= lima("2026-11-18T02:20:00")) break;
      expect(capturaVencida({ ...p, ahora }), ahora.toISOString()).toBe(false);
    }
    expect(capturaVencida({ ...p, ahora: lima("2026-11-18T02:20:00") })).toBe(
      true,
    );
  });

  it("plan 1440: a las 03:00 vence el cliente de ancla 02:00, no el de ancla 04:59", () => {
    const ahora = lima("2026-11-17T03:00:00");
    const ayer = lima("2026-11-16T05:00:00");
    expect(
      capturaVencida({
        frecuenciaMin: 1440,
        clienteId: D0,
        ahora,
        ultimaProgramadaEn: ayer,
      }),
    ).toBe(true);
    expect(
      capturaVencida({
        frecuenciaMin: 1440,
        clienteId: D179,
        ahora,
        ultimaProgramadaEn: ayer,
      }),
    ).toBe(false);
  });

  it("plan 240 y plan 60: la siguiente franja vence a su hora", () => {
    const ult = lima("2026-11-17T02:41:00");
    expect(
      capturaVencida({
        frecuenciaMin: 240,
        clienteId: D40,
        ahora: lima("2026-11-17T06:39:00"),
        ultimaProgramadaEn: ult,
      }),
    ).toBe(false);
    expect(
      capturaVencida({
        frecuenciaMin: 240,
        clienteId: D40,
        ahora: lima("2026-11-17T06:40:00"),
        ultimaProgramadaEn: ult,
      }),
    ).toBe(true);
    expect(
      capturaVencida({
        frecuenciaMin: 60,
        clienteId: D40,
        ahora: lima("2026-11-17T03:39:00"),
        ultimaProgramadaEn: ult,
      }),
    ).toBe(false);
    expect(
      capturaVencida({
        frecuenciaMin: 60,
        clienteId: D40,
        ahora: lima("2026-11-17T03:40:00"),
        ultimaProgramadaEn: ult,
      }),
    ).toBe(true);
  });

  it("cambiar la frecuencia cambia el resultado con los mismos datos", () => {
    const p = {
      clienteId: D40,
      ahora: lima("2026-11-17T08:00:00"),
      ultimaProgramadaEn: lima("2026-11-17T02:41:00"),
    };
    expect(capturaVencida({ ...p, frecuenciaMin: 720 })).toBe(false);
    expect(capturaVencida({ ...p, frecuenciaMin: 240 })).toBe(true);
  });
});

describe("seleccionarVencidos", () => {
  const ahora = lima("2026-11-17T20:00:00");
  const ayer = lima("2026-11-16T03:00:00");
  const hoyTarde = lima("2026-11-17T19:50:00");
  const p = { ahora, frecuenciaMin: 720 };

  it("solo devuelve los vencidos", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: D20, ultimaProgramadaEn: ayer },
        { clienteId: D40, ultimaProgramadaEn: hoyTarde },
      ],
      { ...p, cupo: 10 },
    );
    expect(r).toEqual([D20]);
  });

  it("respeta el cupo", () => {
    const candidatos = [D20, D40, D60, D100].map((clienteId) => ({
      clienteId,
      ultimaProgramadaEn: ayer,
    }));
    expect(seleccionarVencidos(candidatos, { ...p, cupo: 2 })).toHaveLength(2);
    expect(seleccionarVencidos(candidatos, { ...p, cupo: 0 })).toEqual([]);
    expect(seleccionarVencidos(candidatos, { ...p, cupo: 99 })).toHaveLength(4);
  });

  it("primero los nunca capturados, luego por franja más antigua", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: D100, ultimaProgramadaEn: ayer },
        { clienteId: D20, ultimaProgramadaEn: ayer },
        { clienteId: D60, ultimaProgramadaEn: null },
        { clienteId: D40, ultimaProgramadaEn: ayer },
      ],
      { ...p, cupo: 10 },
    );
    // Nunca capturado primero; después las franjas 14:20 (D20), 14:40 (D40) y 15:40 (D100).
    expect(r).toEqual([D60, D20, D40, D100]);
  });

  it("con la misma franja, desempata por id", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: D40_B, ultimaProgramadaEn: ayer },
        { clienteId: D40, ultimaProgramadaEn: ayer },
      ],
      { ...p, cupo: 10 },
    );
    expect(r).toEqual([D40, D40_B].sort());
  });

  it("entre nunca capturados con el mismo desfase, desempata por id", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: D40_B, ultimaProgramadaEn: null },
        { clienteId: D40, ultimaProgramadaEn: null },
      ],
      { ...p, cupo: 10 },
    );
    expect(r).toEqual([D40, D40_B].sort());
  });

  it("el cupo corta después de ordenar: se van los más recientes", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: D100, ultimaProgramadaEn: ayer },
        { clienteId: D20, ultimaProgramadaEn: ayer },
        { clienteId: D60, ultimaProgramadaEn: null },
      ],
      { ...p, cupo: 2 },
    );
    expect(r).toEqual([D60, D20]);
  });

  it("no modifica la lista de entrada", () => {
    const candidatos = [
      { clienteId: D100, ultimaProgramadaEn: ayer },
      { clienteId: D20, ultimaProgramadaEn: null },
    ];
    const copia = candidatos.map((c) => ({ ...c }));
    seleccionarVencidos(candidatos, { ...p, cupo: 10 });
    expect(candidatos).toEqual(copia);
  });

  it("lista vacía → vacío", () => {
    expect(seleccionarVencidos([], { ...p, cupo: 10 })).toEqual([]);
  });
});

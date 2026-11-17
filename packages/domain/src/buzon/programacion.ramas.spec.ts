// Spec 023, T15: ramas de programacion.ts sin cubrir (validaciones, UTF-8 multibyte y desempate).
import { describe, expect, it } from "vitest";
import {
  capturaVencida,
  desfaseCliente,
  seleccionarVencidos,
  ultimaFranja,
} from "./index";

/** Bytes UTF-8 por otra vía que la del código bajo prueba: encodeURIComponent da %XX por cada byte no ASCII. */
function bytesUtf8(texto: string): number[] {
  const trozos = encodeURIComponent(texto).match(/%[0-9A-F]{2}|[^%]/g) ?? [];
  return trozos.map((t) =>
    t.length === 3 ? parseInt(t.slice(1), 16) : t.charCodeAt(0),
  );
}

/** FNV-1a de 32 bits sobre los bytes UTF-8 reales, como referencia independiente. */
function referencia(texto: string): number {
  let h = 0x811c9dc5;
  for (const b of bytesUtf8(texto.toLowerCase())) {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  }
  return h % 180;
}

describe("desfaseCliente con caracteres no ASCII", () => {
  it.each([
    ["dos bytes", "cliente-é-ñ"],
    ["tres bytes", "cliente-€-日本"],
    ["cuatro bytes", "cliente-😀-𝄞"],
    ["mezcla de largos", "aé€😀z"],
  ])("%s: coincide con el FNV-1a sobre los bytes UTF-8", (_n, id) => {
    expect(desfaseCliente(id)).toBe(referencia(id));
    expect(desfaseCliente(id)).toBeGreaterThanOrEqual(0);
    expect(desfaseCliente(id)).toBeLessThan(180);
  });
});

const AHORA = new Date("2026-11-17T15:00:00Z");
const ID = "0192f3a0-7c00-7000-8000-000000000001";

describe("validación de frecuenciaMin", () => {
  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ultimaFranja, capturaVencida y seleccionarVencidos rechazan %s",
    (frecuenciaMin) => {
      expect(() =>
        ultimaFranja({ ahora: AHORA, frecuenciaMin, desfaseMin: 0 }),
      ).toThrow(RangeError);
      expect(() =>
        capturaVencida({
          ahora: AHORA,
          frecuenciaMin,
          clienteId: ID,
          ultimaProgramadaEn: null,
        }),
      ).toThrow(RangeError);
      expect(() =>
        seleccionarVencidos([], { ahora: AHORA, frecuenciaMin, cupo: 1 }),
      ).toThrow(RangeError);
    },
  );
});

describe("validación de desfaseMin", () => {
  it.each([-1, 180, 200, 1.5, Number.NaN])("rechaza %s", (desfaseMin) => {
    expect(() =>
      ultimaFranja({ ahora: AHORA, frecuenciaMin: 720, desfaseMin }),
    ).toThrow(/desfaseMin/);
  });

  it("acepta los extremos 0 y 179", () => {
    expect(() =>
      ultimaFranja({ ahora: AHORA, frecuenciaMin: 720, desfaseMin: 0 }),
    ).not.toThrow();
    expect(() =>
      ultimaFranja({ ahora: AHORA, frecuenciaMin: 720, desfaseMin: 179 }),
    ).not.toThrow();
  });
});

describe("fechas inválidas", () => {
  it("ultimaFranja rechaza un `ahora` ilegible", () => {
    expect(() =>
      ultimaFranja({
        ahora: new Date("no es fecha"),
        frecuenciaMin: 720,
        desfaseMin: 0,
      }),
    ).toThrow(/ahora/);
  });

  it("capturaVencida rechaza una `ultimaProgramadaEn` ilegible", () => {
    expect(() =>
      capturaVencida({
        ahora: AHORA,
        frecuenciaMin: 720,
        clienteId: ID,
        ultimaProgramadaEn: new Date("x"),
      }),
    ).toThrow(/ultimaProgramadaEn/);
  });

  it("seleccionarVencidos rechaza una `ultimaProgramadaEn` ilegible", () => {
    expect(() =>
      seleccionarVencidos(
        [{ clienteId: ID, ultimaProgramadaEn: new Date("x") }],
        { ahora: AHORA, frecuenciaMin: 720, cupo: 5 },
      ),
    ).toThrow(/ultimaProgramadaEn/);
  });
});

describe("seleccionarVencidos: desempate por id", () => {
  const A = "0192f3a0-7c00-7000-8000-00000000000a";

  it("un mismo cliente repetido conserva ambas entradas (comparación igual)", () => {
    const r = seleccionarVencidos(
      [
        { clienteId: A, ultimaProgramadaEn: null },
        { clienteId: A, ultimaProgramadaEn: null },
      ],
      { ahora: AHORA, frecuenciaMin: 720, cupo: 10 },
    );
    expect(r).toEqual([A, A]);
  });

  it("ids con la misma franja se ordenan alfabéticamente (mayor después de menor)", () => {
    // Se busca un par de ids con el mismo desfase, o sea la misma franja.
    const porDesfase = new Map<number, string[]>();
    for (let i = 0; i < 500; i++) {
      const id = `0192f3a0-7c00-7000-8000-${i.toString(16).padStart(12, "0")}`;
      const d = desfaseCliente(id);
      porDesfase.set(d, [...(porDesfase.get(d) ?? []), id]);
    }
    const par = [...porDesfase.values()].find((v) => v.length >= 2);
    expect(par).toBeDefined();
    const [x, y] = par as string[];
    const menor = x! < y! ? x! : y!;
    const mayor = x! < y! ? y! : x!;
    const r = seleccionarVencidos(
      [
        { clienteId: mayor, ultimaProgramadaEn: null },
        { clienteId: menor, ultimaProgramadaEn: null },
      ],
      { ahora: AHORA, frecuenciaMin: 720, cupo: 10 },
    );
    expect(r).toEqual([menor, mayor]);
  });
});

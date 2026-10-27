import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ConfirmacionInvalidaError,
  DICCIONARIO_GLOSAS_BASE,
  EntradaReglasInvalidaError,
  MontosComprobante,
  Money,
  SugerenciaObsoletaError,
  TASA_IGV_10,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  TipoCambio,
  aplicarSugerencia,
  convertirAPen,
  evaluarReglas,
  igvCuadra,
  igvEsperado,
  verificarCuadre,
} from "../index";
import type {
  ColumnaCompra,
  ContextoReglas,
  DocProveedor,
  FilaEvaluable,
  Hallazgo,
  Moneda,
  ResumenXml,
} from "../index";

// Ronda adversarial 1a (T12a, caja negra): lista obligatoria de la spec 011 ("Ataques
// obligatorios") y catálogo de dinero/reglas de 04 §2.3. Solo API pública de @contapp/domain
// (plan 011, Contratos). Cada prueba cita el CA o la D que exige. Deterministas.

const SEMILLA = 20261027;
const CORRIDAS = 1000;

const PROV: DocProveedor = { tipo: "6", numero: "20100070970" };
const COMP = { tipo: "01", serie: "F001", numero: "123" } as const;

type Valores = Partial<Record<ColumnaCompra, string>> & { total: string };

const m$ = (moneda: Moneda, v: Valores): MontosComprobante =>
  MontosComprobante.desde(moneda, v);
const pen = (s: string): Money => Money.desde(s, "PEN");

function ctx(over: Partial<ContextoReglas> = {}): ContextoReglas {
  return {
    proveedoresConocidos: [{ ...PROV }],
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
    ...over,
  };
}

/** Entorno con el que se evaluó el hallazgo (T15b-1): las filas y el contexto. */
const ent = (filas: FilaEvaluable[], contexto: ContextoReglas = ctx()) => ({ filas, contexto });

function fila(
  montos: MontosComprobante,
  over: Partial<FilaEvaluable> = {},
): FilaEvaluable {
  return {
    id: "f1",
    proveedor: { ...PROV },
    comprobante: { ...COMP },
    montos,
    ...over,
  };
}

function xml(
  moneda: Moneda,
  v: Partial<
    Record<"gravado" | "igv" | "noGravado" | "isc" | "icbper" | "total", string>
  >,
  over: Partial<ResumenXml> = {},
): ResumenXml {
  const z = (s: string | undefined): Money => Money.desde(s ?? "0.00", moneda);
  return {
    proveedor: { ...PROV },
    comprobante: { ...COMP },
    moneda,
    gravado: z(v.gravado),
    igv: z(v.igv),
    noGravado: z(v.noGravado),
    isc: z(v.isc),
    icbper: z(v.icbper),
    total: z(v.total),
    glosas: [],
    ...over,
  };
}

const de = (hs: readonly Hallazgo[], regla: Hallazgo["regla"]): Hallazgo[] =>
  hs.filter((h) => h.regla === regla);
const json = (m: MontosComprobante): unknown => m.toJSON();

// Centavos (bigint) → string canónico.
function cs(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}
function centavos(s: string): bigint {
  const neg = s.startsWith("-");
  const [e, d = ""] = (neg ? s.slice(1) : s).split(".");
  const c = BigInt(e! + d.padEnd(2, "0"));
  return neg ? -c : c;
}
const ceilDiv = (a: bigint, b: bigint): bigint =>
  a >= 0n ? (a + b - 1n) / b : -(-a / b);

/**
 * Oráculo independiente del rango (D-3) en valor absoluto: igvEsperado(g, 18 %) = I con
 * redondeo SUNAT (mitad hacia arriba) ⇔ 100·I − 50 ≤ 18·g < 100·I + 50; ∩ [0.01, |BI|].
 */
function rangoOraculo(
  biC: bigint,
  igvC: bigint,
): { lo: bigint; hi: bigint; est: bigint } | null {
  const I = igvC < 0n ? -igvC : igvC;
  const B = biC < 0n ? -biC : biC;
  let lo = ceilDiv(100n * I - 50n, 18n);
  let hi = ceilDiv(100n * I + 50n, 18n) - 1n;
  if (lo < 1n) lo = 1n;
  if (hi > B) hi = B;
  if (lo > hi) return null;
  // estimado = redondearSunat(IGV / 0.18) = floor((10000·I + 900) / 1800), acotado al rango.
  let est = (10000n * I + 900n) / 1800n;
  if (est < lo) est = lo;
  if (est > hi) est = hi;
  return { lo, hi, est };
}

describe("ronda 1a · rango de R-MIX con IGV a 1 céntimo de los bordes (CA-2, CA-4, CA-5, CA-10, D-3, D-7)", () => {
  // Ataques: "IGV a 1 céntimo del borde del rango", montos enormes, notas de crédito, USD.
  it("min/max/estimado exactos, ±0.01 fuera del rango rechazado y total conservado al aplicar", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 50_000_000_000_000n }), // BI hasta 500,000,000,000.00
        fc.integer({ min: -6, max: 6 }),
        fc.boolean(), // tasa base 18 % o 10 %
        fc.boolean(), // nota de crédito
        fc.constantFrom<Moneda>("PEN", "USD"),
        (biAbs, delta, a18, nc, moneda) => {
          const signo = nc ? -1n : 1n;
          const biM = Money.desde(cs(signo * biAbs), moneda);
          const base = igvEsperado(biM, a18 ? TASA_IGV_18 : TASA_IGV_10);
          const igvAbs =
            (centavos(base.toString()) < 0n
              ? -centavos(base.toString())
              : centavos(base.toString())) + BigInt(delta);
          if (igvAbs <= 0n) return;
          const igvM = Money.desde(cs(signo * igvAbs), moneda);
          const m = m$(moneda, {
            biDg: biM.toString(),
            igvDg: igvM.toString(),
            total: cs(signo * (biAbs + igvAbs)),
          });
          const r = evaluarReglas([fila(m)], ctx());
          const mix = de(r.hallazgos, "R-MIX");
          // CA-5: con IGV ≠ 0 nunca R-ISC; si cuadra a 18 % o 10 % (±0.01) no hay R-MIX.
          expect(de(r.hallazgos, "R-ISC")).toEqual([]);
          const cuadra =
            igvCuadra(biM, igvM, TASA_IGV_18) ||
            igvCuadra(biM, igvM, TASA_IGV_10);
          if (cuadra) {
            expect(mix).toEqual([]);
            return;
          }
          expect(mix).toHaveLength(1);
          const h = mix[0]!;
          expect(h.destino).toBe("DG");
          const o = rangoOraculo(signo * biAbs, signo * igvAbs);
          if (o === null) {
            expect(h.sugerencia).toBeNull(); // CA-4: rango vacío → hallazgo sin sugerencia
            return;
          }
          const s = h.sugerencia;
          if (s === null || s.tipo !== "separar")
            throw new Error("se esperaba separar");
          const min = signo > 0n ? o.lo : -o.hi;
          const max = signo > 0n ? o.hi : -o.lo;
          expect([
            s.min.toString(),
            s.max.toString(),
            s.estimado.toString(),
          ]).toEqual([cs(min), cs(max), cs(signo * o.est)]);
          expect([s.min.moneda, s.max.moneda, s.estimado.moneda]).toEqual([
            moneda,
            moneda,
            moneda,
          ]); // CA-10
          expect(s.exacto).toBeNull();
          expect(h.requiereConfirmacion).toBe(true);
          for (const g of [min, max]) {
            const ap = aplicarSugerencia(
              m,
              h,
              { gravado: Money.desde(cs(g), moneda) },
              ent([fila(m)]),
            );
            expect(ap.montos.total.toString()).toBe(m.total.toString()); // CA-9
            expect(ap.montos.obtener("biDg").toString()).toBe(cs(g));
            expect(ap.montos.obtener("noGravado").toString()).toBe(
              cs(signo * biAbs - g),
            );
            expect(ap.montos.obtener("igvDg").toString()).toBe(igvM.toString());
          }
          for (const g of [min - 1n, max + 1n]) {
            expect(() =>
              aplicarSugerencia(
                m,
                h,
                { gravado: Money.desde(cs(g), moneda) },
                ent([fila(m)]),
              ),
            ).toThrow(ConfirmacionInvalidaError);
          }
        },
      ),
      { seed: SEMILLA, numRuns: CORRIDAS },
    );
  });
});

describe("ronda 1a · rango vacío: BI 0 con IGV ≠ 0, IGV > BI, IGV > 18 % de la BI (CA-4, CA-5)", () => {
  it.each([
    ["biDg", "igvDg", "DG", "0.00", "1.61"],
    ["biDg", "igvDg", "DG", "0.00", "-1.61"],
    ["biDgng", "igvDgng", "DGNG", "0.00", "1.61"],
    ["biDng", "igvDng", "DNG", "5.00", "6.00"],
    ["biDg", "igvDg", "DG", "21.48", "4.00"],
    ["biDg", "igvDg", "DG", "-21.48", "-4.00"],
    ["biDg", "igvDg", "DG", "0.05", "0.03"],
  ] as const)(
    "%s/%s (%s) BI %s IGV %s → R-MIX sin sugerencia, sin R-ISC, aplicar lanza",
    (bi, igv, destino, b, i) => {
      const total = cs(centavos(b) + centavos(i));
      const m = m$("PEN", { [bi]: b, [igv]: i, total } as Valores);
      const r = evaluarReglas([fila(m)], ctx());
      expect(de(r.hallazgos, "R-ISC")).toEqual([]);
      const mix = de(r.hallazgos, "R-MIX");
      expect(mix.map((h) => [h.destino, h.sugerencia])).toEqual([
        [destino, null],
      ]);
      expect(() =>
        aplicarSugerencia(m, mix[0]!, { gravado: pen("0.01") }, ent([fila(m)])),
      ).toThrow(EntradaReglasInvalidaError);
    },
  );
});

describe("ronda 1a · todos los tributos, tres destinos y reglas cruzadas en la misma fila (CA-5, CA-9, D-6)", () => {
  // DG 770/0 (R-ISC), DGNG 21.48/1.61 (R-MIX), DNG 100/18 (cuadra), resto de tributos ≠ 0,
  // total = Σ + 0.01 (R-RED dentro del umbral: 9 componentes ≠ 0 → 0.09).
  const v: Valores = {
    biDg: "770.00",
    igvDg: "0.00",
    biDgng: "21.48",
    igvDgng: "1.61",
    biDng: "100.00",
    igvDng: "18.00",
    noGravado: "5.00",
    isc: "3.00",
    icbper: "0.50",
    otrosTributos: "1.00",
    total: "920.60",
  };
  const m = m$("PEN", v);
  const r = evaluarReglas([fila(m)], ctx());
  const h = (regla: Hallazgo["regla"]): Hallazgo => {
    const l = de(r.hallazgos, regla);
    if (l.length !== 1) throw new Error(`${regla}: ${l.length}`);
    return l[0]!;
  };
  const gravado = { gravado: pen("8.97") };

  it("dispara exactamente R-ISC DG, R-MIX DGNG y R-RED (en ese orden); aplicar en cualquier orden no corrompe montos", () => {
    expect(r.hallazgos.map((x) => [x.regla, x.destino])).toEqual([
      ["R-ISC", "DG"],
      ["R-MIX", "DGNG"],
      ["R-RED", null],
    ]);
    // R-ISC y R-MIX tocan destinos distintos: se encadenan en ambos órdenes (lecturas = BI e IGV del destino).
    const e = ent([fila(m)]);
    const a = aplicarSugerencia(
      aplicarSugerencia(m, h("R-ISC"), undefined, e).montos,
      h("R-MIX"),
      gravado,
      e,
    ).montos;
    const b = aplicarSugerencia(
      aplicarSugerencia(m, h("R-MIX"), gravado, e).montos,
      h("R-ISC"),
      undefined,
      e,
    ).montos;
    const esperado = MontosComprobante.desde("PEN", {
      ...v,
      biDg: "0.00",
      isc: "773.00",
      biDgng: "8.97",
      noGravado: "17.51",
    });
    expect(json(a)).toEqual(json(esperado));
    expect(json(b)).toEqual(json(esperado));
    // R-RED primero (solo cambia el total) no invalida R-ISC ni R-MIX; al final la fila cuadra.
    const red = aplicarSugerencia(m, h("R-RED"), undefined, e).montos;
    const c = aplicarSugerencia(
      aplicarSugerencia(red, h("R-ISC"), undefined, e).montos,
      h("R-MIX"),
      gravado,
      e,
    ).montos;
    expect(c.total.toString()).toBe("920.59");
    expect(verificarCuadre(c, TOLERANCIA_CUADRE).cuadra).toBe(true);
    // R-RED después: o se aplica y cuadra, o es obsoleta; nunca un resultado descuadrado.
    let d: MontosComprobante | null = null;
    try {
      d = aplicarSugerencia(a, h("R-RED"), undefined, e).montos;
    } catch (e) {
      expect(e).toBeInstanceOf(SugerenciaObsoletaError);
    }
    if (d !== null)
      expect(verificarCuadre(d, TOLERANCIA_CUADRE).cuadra).toBe(true);
    // Repetir R-ISC sobre el resultado: obsoleta (CA-9).
    expect(() => aplicarSugerencia(a, h("R-ISC"), undefined, e)).toThrow(
      SugerenciaObsoletaError,
    );
  });
});

describe("ronda 1a · R-RED con origen USD y TC de 3 decimales (CA-6, D7 de 010; valores sintéticos)", () => {
  const tc = TipoCambio.desde("3.759");
  const origen = m$("USD", {
    biDg: "33.33",
    igvDg: "6.00",
    noGravado: "0.07",
    isc: "1.11",
    total: "40.51",
  });
  const conv = convertirAPen(origen, tc);
  const cv = (c: ColumnaCompra): bigint => centavos(conv.obtener(c).toString());
  const base = (): Record<string, string> => ({
    biDg: conv.obtener("biDg").toString(),
    igvDg: conv.obtener("igvDg").toString(),
    noGravado: conv.obtener("noGravado").toString(),
    isc: conv.obtener("isc").toString(),
    total: conv.total.toString(),
  });

  it.each([
    ["igual a la conversión", {}],
    [
      "columna +0.01 (fila cuadra sola)",
      {
        biDg: cs(cv("biDg") + 1n),
        total: cs(centavos(conv.total.toString()) + 1n),
      },
    ],
    ["total +0.01", { total: cs(centavos(conv.total.toString()) + 1n) }],
    ["isc −0.01 y total sin cambio", { isc: cs(cv("isc") - 1n) }],
    [
      "columna +1.00 (fuera del umbral de D-6)",
      {
        biDg: cs(cv("biDg") + 100n),
        total: cs(centavos(conv.total.toString()) + 100n),
      },
    ],
  ])(
    "PEN %s → sin R-RED si coincide; si no, R-RED exacta sin confirmación que deja la fila convertida",
    (_n, cambio) => {
      const m = m$("PEN", { ...base(), ...cambio } as Valores);
      const f = fila(m, { origenUsd: { montos: origen, tipoCambio: tc } });
      const r = evaluarReglas([f], ctx());
      const red = de(r.hallazgos, "R-RED");
      if (Object.keys(cambio).length === 0) {
        expect(red).toEqual([]);
        return;
      }
      expect(red).toHaveLength(1);
      expect(red[0]!.requiereConfirmacion).toBe(false);
      expect(red[0]!.sugerencia?.tipo).toBe("ajustar");
      expect(json(aplicarSugerencia(m, red[0]!, undefined, ent([f])).montos)).toEqual(json(conv));
    },
  );
});

describe("ronda 1a · XML de otro comprobante (CA-11, CA-1, D-1)", () => {
  const sanJuan = m$("PEN", { biDg: "770.00", total: "770.00" });
  it.each([
    ["otro RUC", { proveedor: { tipo: "6", numero: "20100070971" } }],
    [
      "otro tipo de documento del proveedor",
      { proveedor: { tipo: "1", numero: "20100070970" } },
    ],
    ["otra serie", { comprobante: { ...COMP, serie: "F002" } }],
    ["otro número", { comprobante: { ...COMP, numero: "124" } }],
    ["otro tipo de comprobante", { comprobante: { ...COMP, tipo: "03" } }],
  ] as const)("%s → aviso XML_AJENO y R-ISC como sin XML", (_n, over) => {
    const x = xml(
      "PEN",
      { isc: "770.00", total: "770.00" },
      over as Partial<ResumenXml>,
    );
    const r = evaluarReglas([fila(sanJuan, { xml: x })], ctx());
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([
      ["f1", "XML_AJENO"],
    ]);
    expect(r.avisos[0]!.explicacion).toContain(
      "El XML no corresponde a este comprobante",
    );
    const isc = de(r.hallazgos, "R-ISC");
    expect(isc).toHaveLength(1);
    expect(isc[0]!.requiereConfirmacion).toBe(true);
    expect(isc[0]!.explicacion).not.toContain("el XML indica");
    expect(isc[0]!.sugerencia).toEqual({
      tipo: "mover",
      origen: "biDg",
      destino: "isc",
      monto: pen("770.00"),
    });
  });
});

describe("ronda 1a · XML con montos que no suman (D-6, CA-6)", () => {
  // SIRE 100.00 + 18.00 con total 118.01 (descuadre 0.01). Toda sugerencia de R-RED, al
  // aplicarse, debe dejar la fila cuadrada: R-RED existe para corregir el descuadre (RF-083).
  const m = m$("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
  it.each([
    [
      "XML que suma y respalda la BI (control)",
      { gravado: "100.01", igv: "18.00", total: "118.01" },
    ],
    [
      "XML que no suma: gravado 50.00 con total 118.01",
      { gravado: "50.00", igv: "18.00", total: "118.01" },
    ],
    [
      "XML que no suma: ISC 5.00 que la fila no tiene",
      { gravado: "100.00", igv: "18.00", isc: "5.00", total: "118.01" },
    ],
    [
      "XML que suma pero difiere en dos columnas",
      { gravado: "100.00", igv: "17.00", noGravado: "1.01", total: "118.01" },
    ],
    [
      "XML que no suma con total distinto",
      { gravado: "100.00", igv: "18.00", total: "200.00" },
    ],
  ])("%s → R-RED; si sugiere, el resultado cuadra", (_n, v) => {
    const f = fila(m, { xml: xml("PEN", v) });
    const r = evaluarReglas([f], ctx());
    const red = de(r.hallazgos, "R-RED");
    expect(red).toHaveLength(1);
    if (v.gravado === "100.01") {
      // Control (D-6, ratificación d): el XML respalda la columna → ajuste exacto sin confirmación.
      expect(red[0]!.sugerencia).toEqual({
        tipo: "ajustar",
        valores: { biDg: pen("100.01") },
      });
      expect(red[0]!.requiereConfirmacion).toBe(false);
    }
    if (red[0]!.sugerencia !== null) {
      const ap = aplicarSugerencia(m, red[0]!, undefined, ent([f])).montos;
      expect(verificarCuadre(ap, TOLERANCIA_CUADRE).cuadra).toBe(true);
    }
  });
});

describe("ronda 1a · R-NEW con documentos normalizados y orden por unidades de código (CA-7, CA-8)", () => {
  it("espacios y minúsculas se normalizan; tipo distinto y ceros extra son otro proveedor; orden sin locale", () => {
    const m = m$("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const conocidos: DocProveedor[] = [
      { tipo: "6", numero: " 2010 0070970 " },
      { tipo: "0", numero: "ABC-12" },
    ];
    const filas: FilaEvaluable[] = [
      fila(m, { id: "a", proveedor: { tipo: "6", numero: "20100070970" } }),
      fila(m, { id: "B", proveedor: { tipo: "6", numero: "2010007 0970" } }),
      fila(m, { id: "Z", proveedor: { tipo: "0", numero: "abc-12" } }),
      fila(m, { id: "_", proveedor: { tipo: "1", numero: "20100070970" } }),
      fila(m, { id: "-", proveedor: { tipo: "6", numero: "020100070970" } }),
      fila(m, { id: "10", proveedor: { tipo: "6", numero: "20600000001" } }),
      fila(m, { id: "9", proveedor: { tipo: "6", numero: " 20600 000001" } }),
    ];
    const cx = ctx({ proveedoresConocidos: conocidos });
    const r = evaluarReglas(filas, cx);
    expect(
      r.hallazgos.map((h) => [
        h.filaId,
        h.regla,
        h.destino,
        h.dato,
        h.sugerencia,
      ]),
    ).toEqual(
      ["-", "10", "9", "_"].map((id) => [
        id,
        "R-NEW",
        null,
        "destino",
        { tipo: "clasificar" },
      ]),
    );
    const ap = aplicarSugerencia(
      m,
      r.hallazgos[0]!,
      { destino: "DGNG" },
      ent(filas, cx),
    ).montos;
    expect([
      ap.obtener("biDgng").toString(),
      ap.obtener("igvDgng").toString(),
      ap.total.toString(),
    ]).toEqual(["100.00", "18.00", "118.00"]);
  });
});

describe("ronda 1a · glosas Unicode, plurales y enormes en R-GP (CA-12, D-5)", () => {
  const m = m$("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
  const evaluarGlosa = (g: string): Hallazgo[] =>
    de(
      evaluarReglas(
        [
          fila(m, {
            xml: xml(
              "PEN",
              { gravado: "100.00", igv: "18.00", total: "118.00" },
              { glosas: [g] },
            ),
          }),
        ],
        ctx(),
      ).hallazgos,
      "R-GP",
    );
  const MB = 1_000_000;

  it.each([
    ["ZAPATÍLLAS URBANAS", "zapatilla", "calzado-ropa"],
    ["ＺＡＰＡＴＩＬＬＡＳ", "zapatilla", "calzado-ropa"],
    ["MUÑECAS DE TRAPO", "muneca", "juguetes"],
    ["Muñecas", "muneca", "juguetes"],
    ["PELUCHES GRANDES", "peluche", "juguetes"],
    ["PERFUMES|LOCION", "perfume", "cuidado-personal"],
    ["VIDEOJUEGOS\tconsola", "videojuego", "entretenimiento"],
    ["x".repeat(MB - 10) + " zapatilla", "zapatilla", "calzado-ropa"],
    ["́".repeat(MB / 2) + "polo", "polo", "calzado-ropa"],
    ["zapata de concreto", null, null],
    ["zap. de seguridad", null, null],
    ["POLONIA", null, null],
    ["CINEMATOGRAFICA", null, null],
    ["zapat".repeat(MB / 5), null, null],
    [".".repeat(MB), null, null],
    ["a.".repeat(MB / 2), null, null],
  ] as const)("glosa %# → %s (%s)", (g, palabra, categoria) => {
    const h = evaluarGlosa(g);
    if (palabra === null) {
      expect(h).toEqual([]);
      return;
    }
    expect(h.map((x) => x.sugerencia)).toEqual([
      { tipo: "excluir", palabra, categoria },
    ]);
    expect(h[0]!.explicacion).toContain(palabra);
  });
});

// Spec 025 · T1 (rojo). aprenderDeHistorial: deducción pura del destino por proveedor a partir del registro presentado
// (RF-112, HU-29; spec D-3, U-2, U-8; CA-2; plan Contratos: domain). Tabla de casos; las propiedades están en
// aprender.propiedades.spec.ts. Sin implementación: `aprenderDeHistorial` aún no se exporta de `./index`.
import { describe, expect, it } from "vitest";
import { aprenderDeHistorial } from "./index";
import type { CandidataDeducida, FilaHistorial } from "./index";

type Dest = "DG" | "DGNG" | "DNG";

const RUC = "20100070970";
const OTRO_RUC = "20555555555";

/** Un comprobante (una fila) cuya única base ≠ 0 está en `destino`. */
function conBase(destino: Dest, over: Partial<FilaHistorial> = {}): FilaHistorial {
  return {
    periodo: "202601",
    numeroDocProveedor: RUC,
    tipoComprobante: "01",
    biDg: destino === "DG" ? "100.00" : "0.00",
    biDgng: destino === "DGNG" ? "100.00" : "0.00",
    biDng: destino === "DNG" ? "100.00" : "0.00",
    ...over,
  };
}
const varias = (n: number, destino: Dest, over: Partial<FilaHistorial> = {}): FilaHistorial[] =>
  Array.from({ length: n }, () => conBase(destino, over));
const enCero = (over: Partial<FilaHistorial> = {}): FilaHistorial =>
  conBase("DG", { biDg: "0.00", biDgng: "0.00", biDng: "0.00", ...over });

/** La única candidata del resultado (falla si hay 0 o más de 1). */
function unica(filas: readonly FilaHistorial[]): CandidataDeducida {
  const { candidatas } = aprenderDeHistorial(filas);
  expect(candidatas).toHaveLength(1);
  return candidatas[0] as CandidataDeducida;
}
const conteos = (dg: number, dgng: number, dng: number, mixto: number) => ({
  DG: dg,
  DGNG: dgng,
  DNG: dng,
  mixto,
  total: dg + dgng + dng + mixto,
});

describe("aprenderDeHistorial: forma del resultado", () => {
  it("sin filas: sin candidatas y nada descartado", () => {
    expect(aprenderDeHistorial([])).toEqual({ candidatas: [], descartadas: { sinProveedor: 0, sinBase: 0 } });
  });

  it("destino único: propone ese destino con sus conteos y el proveedor normalizado", () => {
    const c = unica(varias(3, "DNG"));
    expect(c.proveedor).toEqual({ tipo: "6", numero: RUC });
    expect(c.destino).toBe("DNG");
    expect(c.conteos).toEqual(conteos(0, 0, 3, 0));
    expect(c.periodosConProveedor).toBe(1);
  });

  it("no muta las filas recibidas (aunque vengan congeladas)", () => {
    const filas = varias(3, "DG").map((f) => Object.freeze({ ...f }));
    const copia = JSON.stringify(filas);
    expect(() => aprenderDeHistorial(filas)).not.toThrow();
    expect(JSON.stringify(filas)).toBe(copia);
  });
});

describe("aprenderDeHistorial: umbral de U-2 (≥ 80 % de los comprobantes contados y al menos 2)", () => {
  it.each<[string, Dest, number, Dest, number, Dest | null]>([
    ["2 de 2 propone (el mínimo es 2)", "DG", 2, "DNG", 0, "DG"],
    ["1 de 1 no propone", "DNG", 1, "DG", 0, null],
    ["4 de 5 = 80 % justo propone", "DNG", 4, "DG", 1, "DNG"],
    ["3 de 4 = 75 % no propone", "DNG", 3, "DG", 1, null],
    ["10 de 12 = 83,3 % propone", "DGNG", 10, "DNG", 2, "DGNG"],
    ["9 de 12 = 75 % no propone", "DGNG", 9, "DNG", 3, null],
    ["8 de 10 = 80 % justo propone DG", "DG", 8, "DGNG", 2, "DG"],
    ["empate 2 y 2 no propone", "DG", 2, "DNG", 2, null],
    ["empate 3 y 3 no propone", "DGNG", 3, "DNG", 3, null],
  ])("%s", (_nombre, dominante, n, otro, m, esperado) => {
    const c = unica([...varias(n, dominante), ...varias(m, otro)]);
    expect(c.destino).toBe(esperado);
    expect(c.conteos[dominante]).toBe(n);
    if (m > 0) expect(c.conteos[otro]).toBe(m);
    expect(c.conteos.total).toBe(n + m);
  });

  it("el umbral se mide con enteros: 400 de 500 propone y 399 de 500 no (sin redondeos de coma flotante)", () => {
    expect(unica([...varias(400, "DNG"), ...varias(100, "DG")]).destino).toBe("DNG");
    expect(unica([...varias(399, "DNG"), ...varias(101, "DG")]).destino).toBeNull();
  });

  it("sin criterio claro la candidata igual se devuelve, con sus conteos (U-8)", () => {
    const c = unica([...varias(3, "DNG"), ...varias(2, "DG")]);
    expect(c.destino).toBeNull();
    expect(c.conteos).toEqual(conteos(2, 0, 3, 0));
  });

  it("el destino DG también se propone (marca al proveedor como conocido, D-3)", () => {
    expect(unica(varias(5, "DG")).destino).toBe("DG");
  });
});

describe("aprenderDeHistorial: comprobantes con base en varios destinos (mixtos, D-3)", () => {
  const mixto = (over: Partial<FilaHistorial> = {}) => conBase("DG", { biDg: "60.00", biDng: "40.00", ...over });

  it("un comprobante con base en dos destinos suma a «mixto» y a ninguno de los dos, pero sí al total", () => {
    const c = unica([...varias(4, "DNG"), mixto()]);
    expect(c.conteos).toEqual(conteos(0, 0, 4, 1));
    expect(c.destino).toBe("DNG");
  });

  it("los mixtos bajan el porcentaje: 4 de 5 propone y 3 de 4 no", () => {
    expect(unica([...varias(4, "DNG"), mixto()]).destino).toBe("DNG");
    expect(unica([...varias(3, "DNG"), mixto()]).destino).toBeNull();
  });

  it("4 DNG y 2 mixtos: 4 de 6 no propone", () => {
    const c = unica([...varias(4, "DNG"), mixto(), mixto()]);
    expect(c.destino).toBeNull();
    expect(c.conteos).toEqual(conteos(0, 0, 4, 2));
  });

  it("base en los tres destinos también es un solo «mixto»", () => {
    const c = unica([...varias(4, "DG"), conBase("DG", { biDg: "10.00", biDgng: "20.00", biDng: "30.00" })]);
    expect(c.conteos).toEqual(conteos(4, 0, 0, 1));
  });

  it("solo mixtos: sin criterio claro, con el total contado", () => {
    const c = unica([mixto(), mixto(), mixto()]);
    expect(c.destino).toBeNull();
    expect(c.conteos).toEqual(conteos(0, 0, 0, 3));
  });
});

describe("aprenderDeHistorial: base 0 no cuenta (D-3)", () => {
  it("los comprobantes con las tres bases en cero no suman al total ni a ningún destino", () => {
    const c = unica([...varias(2, "DNG"), enCero(), enCero({ biDg: "0", biDgng: "0.0", biDng: "-0.00" }), enCero()]);
    expect(c.conteos).toEqual(conteos(0, 0, 2, 0));
    expect(c.destino).toBe("DNG");
  });

  it("se informan como descartados «sin base», sin tocar «sin proveedor»", () => {
    const r = aprenderDeHistorial([...varias(2, "DNG"), enCero(), enCero(), enCero()]);
    expect(r.descartadas).toEqual({ sinProveedor: 0, sinBase: 3 });
  });

  it("un proveedor con todos sus comprobantes en cero no genera candidata (no hay nada que contar)", () => {
    const r = aprenderDeHistorial([enCero(), enCero()]);
    expect(r.candidatas).toEqual([]);
    expect(r.descartadas).toEqual({ sinProveedor: 0, sinBase: 2 });
  });

  it("una base en cero en un destino y distinta de cero en otro es de destino único, no mixta", () => {
    const c = unica([conBase("DG", { biDg: "100.00", biDgng: "0.00", biDng: "-0.00" }), conBase("DG", { biDg: "50.00", biDgng: "0", biDng: "0.00" })]);
    expect(c.conteos).toEqual(conteos(2, 0, 0, 0));
  });
});

describe("aprenderDeHistorial: notas de crédito (valor absoluto, D-3)", () => {
  it("una nota de crédito (07) con bases negativas cuenta para el destino de su base", () => {
    const nc = conBase("DNG", { tipoComprobante: "07", biDng: "-100.00" });
    const c = unica([...varias(2, "DNG"), nc]);
    expect(c.conteos).toEqual(conteos(0, 0, 3, 0));
    expect(c.destino).toBe("DNG");
  });

  it("una nota de crédito con bases negativas en dos destinos es mixta", () => {
    const nc = conBase("DG", { tipoComprobante: "07", biDg: "-60.00", biDng: "-40.00" });
    expect(unica([...varias(4, "DNG"), nc]).conteos).toEqual(conteos(0, 0, 4, 1));
  });

  it("el signo no decide: la misma base en positivo o negativo da el mismo resultado", () => {
    const positivas = [...varias(3, "DG"), ...varias(2, "DNG")];
    const negativas = positivas.map((f) => ({ ...f, biDg: neg(f.biDg), biDgng: neg(f.biDgng), biDng: neg(f.biDng) }));
    expect(aprenderDeHistorial(negativas)).toEqual(aprenderDeHistorial(positivas));
  });

  it("el tipo de comprobante no cambia el conteo (01, 03, 07, 08, 14)", () => {
    const base = varias(5, "DNG", { tipoComprobante: "01" });
    const otros = ["01", "03", "07", "08", "14"].map((t) => conBase("DNG", { tipoComprobante: t }));
    expect(unica(otros).conteos).toEqual(unica(base).conteos);
    expect(unica(otros).destino).toBe("DNG");
  });
});

/** «100.00» → «-100.00»; el cero queda en cero. */
function neg(s: string): string {
  return /^-?0+(\.0+)?$/.test(s) ? s : s.startsWith("-") ? s.slice(1) : `-${s}`;
}

describe("aprenderDeHistorial: identidad del proveedor (como la clave de R-NEW)", () => {
  it("tipo ausente = «6» (RUC): se agrupa con el tipo «6» explícito", () => {
    const c = unica([...varias(2, "DNG"), ...varias(2, "DNG", { tipoDocProveedor: "6" })]);
    expect(c.proveedor).toEqual({ tipo: "6", numero: RUC });
    expect(c.conteos.total).toBe(4);
  });

  it("DNI (tipo 1) es otro proveedor que un RUC con el mismo número", () => {
    const { candidatas } = aprenderDeHistorial([
      ...varias(3, "DNG", { tipoDocProveedor: "1", numeroDocProveedor: "20100070" }),
      ...varias(3, "DG", { numeroDocProveedor: "20100070" }),
    ]);
    expect(candidatas.map((c) => [c.proveedor.tipo, c.proveedor.numero, c.destino])).toEqual([
      ["1", "20100070", "DNG"],
      ["6", "20100070", "DG"],
    ]);
  });

  it("mismo RUC con espacios: se agrupa y el número sale sin espacios", () => {
    const c = unica([
      conBase("DNG", { numeroDocProveedor: RUC }),
      conBase("DNG", { numeroDocProveedor: ` ${RUC} ` }),
      conBase("DNG", { numeroDocProveedor: "2010 0070970" }),
    ]);
    expect(c.proveedor).toEqual({ tipo: "6", numero: RUC });
    expect(c.conteos.total).toBe(3);
  });

  it("minúsculas y espacios en documentos alfanuméricos: «ab- 12» = «AB-12»", () => {
    const c = unica([
      conBase("DG", { tipoDocProveedor: "1", numeroDocProveedor: "AB-12" }),
      conBase("DG", { tipoDocProveedor: "1", numeroDocProveedor: " ab- 12 " }),
    ]);
    expect(c.proveedor).toEqual({ tipo: "1", numero: "AB-12" });
    expect(c.conteos).toEqual(conteos(2, 0, 0, 0));
    expect(c.destino).toBe("DG");
  });

  it("proveedores distintos dan candidatas distintas, cada una con su propio porcentaje", () => {
    const { candidatas } = aprenderDeHistorial([
      ...varias(3, "DNG"),
      ...varias(3, "DG", { numeroDocProveedor: OTRO_RUC }),
      conBase("DNG", { numeroDocProveedor: OTRO_RUC }),
    ]);
    expect(candidatas.map((c) => [c.proveedor.numero, c.destino])).toEqual([
      [RUC, "DNG"],
      [OTRO_RUC, null],
    ]);
  });

  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["guion", "-"],
    ["guion con espacios", " - "],
  ])("documento ausente (%s): sin proveedor identificable, no cuenta y no genera candidata", (_n, doc) => {
    const r = aprenderDeHistorial([...varias(2, "DNG"), ...varias(3, "DG", { numeroDocProveedor: doc })]);
    expect(r.candidatas).toHaveLength(1);
    expect(r.candidatas[0]?.conteos).toEqual(conteos(0, 0, 2, 0));
    expect(r.descartadas).toEqual({ sinProveedor: 3, sinBase: 0 });
  });

  it("sin proveedor, aunque haya tipo de documento", () => {
    const r = aprenderDeHistorial(varias(2, "DNG", { tipoDocProveedor: "1", numeroDocProveedor: "-" }));
    expect(r.candidatas).toEqual([]);
    expect(r.descartadas.sinProveedor).toBe(2);
  });
});

describe("aprenderDeHistorial: razón social y periodos", () => {
  it("la razón social es la del periodo más reciente", () => {
    const c = unica([
      conBase("DNG", { periodo: "202511", razonSocial: "NOMBRE VIEJO SAC" }),
      conBase("DNG", { periodo: "202601", razonSocial: "NOMBRE NUEVO SAC" }),
      conBase("DNG", { periodo: "202512", razonSocial: "NOMBRE INTERMEDIO SAC" }),
    ]);
    expect(c.razonSocial).toBe("NOMBRE NUEVO SAC");
  });

  it("sin razón social en el registro: null", () => {
    expect(unica(varias(2, "DNG")).razonSocial).toBeNull();
    expect(unica(varias(2, "DNG", { razonSocial: "" })).razonSocial).toBeNull();
  });

  it("se limpia de caracteres de control y de dirección de texto (bidi)", () => {
    const sucia = "ACME\u0000\u0007‮⁦ SAC‏\n\t";
    const razon = unica(varias(2, "DNG", { razonSocial: sucia })).razonSocial;
    expect(razon).not.toBeNull();
    expect(razon).not.toMatch(/[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/);
    expect(razon).toContain("ACME");
    expect(razon).toContain("SAC");
  });

  it("se recorta a 200 caracteres", () => {
    const razon = unica(varias(2, "DNG", { razonSocial: "A".repeat(300) })).razonSocial;
    expect(razon).toBe("A".repeat(200));
  });

  it("periodosConProveedor cuenta los periodos distintos en que aparece el proveedor", () => {
    const c = unica([
      conBase("DNG", { periodo: "202601" }),
      conBase("DNG", { periodo: "202601" }),
      conBase("DNG", { periodo: "202603" }),
      conBase("DNG", { periodo: "202604" }),
    ]);
    expect(c.periodosConProveedor).toBe(3);
  });

  it("periodosConProveedor es por proveedor, no del conjunto", () => {
    const { candidatas } = aprenderDeHistorial([
      conBase("DNG", { periodo: "202601" }),
      conBase("DNG", { periodo: "202602" }),
      conBase("DG", { periodo: "202601", numeroDocProveedor: OTRO_RUC }),
      conBase("DG", { periodo: "202601", numeroDocProveedor: OTRO_RUC }),
    ]);
    expect(candidatas.map((c) => [c.proveedor.numero, c.periodosConProveedor])).toEqual([
      [RUC, 2],
      [OTRO_RUC, 1],
    ]);
  });
});

describe("aprenderDeHistorial: orden de salida", () => {
  it("por tipo y luego por número, por unidades de código y sin importar el orden de entrada", () => {
    const filas = [
      ...varias(2, "DNG", { numeroDocProveedor: "20555555555" }),
      ...varias(2, "DNG", { tipoDocProveedor: "1", numeroDocProveedor: "AB-12" }),
      ...varias(2, "DNG", { numeroDocProveedor: "20111111111" }),
      ...varias(2, "DNG", { tipoDocProveedor: "1", numeroDocProveedor: "12345678" }),
    ];
    const claves = (r: ReturnType<typeof aprenderDeHistorial>) => r.candidatas.map((c) => `${c.proveedor.tipo}:${c.proveedor.numero}`);
    const esperado = ["1:12345678", "1:AB-12", "6:20111111111", "6:20555555555"];
    expect(claves(aprenderDeHistorial(filas))).toEqual(esperado);
    expect(claves(aprenderDeHistorial([...filas].reverse()))).toEqual(esperado);
  });
});

describe("aprenderDeHistorial: caso del cliente de la selva (01 §7.3, Huánuco)", () => {
  it("proveedor recurrente con compras gravadas en DNG todos los meses: propone DNG con 6 de 6 periodos", () => {
    const filas = ["202601", "202602", "202603", "202604", "202605", "202606"].map((periodo) =>
      conBase("DNG", { periodo, razonSocial: "FERRETERIA SELVA SAC" }),
    );
    const c = unica(filas);
    expect(c.destino).toBe("DNG");
    expect(c.conteos).toEqual(conteos(0, 0, 6, 0));
    expect(c.periodosConProveedor).toBe(6);
    expect(c.razonSocial).toBe("FERRETERIA SELVA SAC");
  });
});

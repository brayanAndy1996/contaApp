// Casos reales de los videos aplicados a la prevalidación (spec 012: CA-1, CA-2 y «Casos reales
// aplicables»; docs/01-definiciones-base.md §7 puntos 9, 10, 11 y 15; HU-25 y HU-26).
// Las cifras se copiaron a mano de fixtures/sire/20700000002-compras-202610.json (009); la prueba
// de packages/sunat/src/formatos/fixture-012.spec.ts lee el JSON real y repite estas conclusiones.
// Solo API pública (plan 012, Contratos). Boleta 291: no aplica (013). Redondeo USD: diferido.
import { describe, expect, it } from "vitest";
import {
  ArchivoNoPrevalidadoError,
  DICCIONARIO_GLOSAS_BASE,
  Money,
  aplicarSugerencia,
  generarTxt,
  prevalidar,
  type ContextoReglas,
  type FilaEvaluable,
  type FilaReemplazo,
  type Hallazgo,
} from "../../src/index";
import {
  CABECERA,
  filaReemplazo,
  filaSanJuan,
  filasFixture,
  filasFixtureCorregidas,
  lineasCrlf,
  PROV,
  xmlDe,
} from "../ayudas/filas-reemplazo";

const REGLAS: ContextoReglas = {
  proveedoresConocidos: filasFixture().map((f) => ({ tipo: f.proveedor.tipo, numero: f.proveedor.numero })),
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
};
const prev = (filas: readonly FilaReemplazo[], conReglas = true) =>
  prevalidar(filas, { cabecera: CABECERA, ...(conReglas ? { reglas: REGLAS } : {}) });
const deFila = (r: ReturnType<typeof prev>, id: string) => r.errores.filter((e) => e.filaId === id);

describe("CA-1 · propuesta del fixture sin corregir (HU-25, mixta + San Juan)", () => {
  const r = prev(filasFixture());

  it("no es apta y el único error es el IGV de F001-2056", () => {
    expect(r.apto).toBe(false);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatchObject({ filaId: "F001-2056", codigo: "IGV", campo: "igvDg", destino: "DG" });
  });

  it("la explicación dice «1.61 no es 18 % ni 10 % de 21.48»", () => {
    expect(r.errores[0]?.explicacion).toBe("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("el error trae la sugerencia de R-MIX: gravado entre 8.92 y 8.97, estimado 8.94", () => {
    const s = r.errores[0]?.sugerencia?.sugerencia;
    if (s?.tipo !== "separar") throw new Error("se esperaba separar");
    expect(r.errores[0]?.sugerencia?.regla).toBe("R-MIX");
    expect([s.columnaBi, s.min.toString(), s.max.toString(), s.estimado.toString()]).toEqual(["biDg", "8.92", "8.97", "8.94"]);
  });

  it("F001-1040 (San Juan, BI 770.00 con IGV 0.00) no bloquea: solo trae un aviso R-ISC", () => {
    expect(deFila(r, "F001-1040")).toEqual([]);
    const avisos = r.avisos.filter((a) => a.filaId === "F001-1040");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.codigo).toBe("R-ISC");
    const s = avisos[0]?.hallazgo.sugerencia;
    if (s?.tipo !== "mover") throw new Error("se esperaba mover");
    expect([s.origen, s.destino, s.monto.toString()]).toEqual(["biDg", "isc", "770.00"]);
  });

  it("F001-3064, F001-4062 y F001-5070 no tienen errores ni avisos", () => {
    for (const id of ["F001-3064", "F001-4062", "F001-5070"]) {
      expect(deFila(r, id)).toEqual([]);
      expect(r.avisos.filter((a) => a.filaId === id)).toEqual([]);
    }
  });

  it("los avisos son exactamente el de San Juan", () => {
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([["F001-1040", "R-ISC"]]);
  });

  it("sin reglas el bloqueo es el mismo (solo el IGV de la mixta), sin sugerencia ni avisos", () => {
    const sin = prev(filasFixture(), false);
    expect(sin.apto).toBe(false);
    expect(sin.errores.map((e) => [e.filaId, e.codigo, e.explicacion])).toEqual(
      r.errores.map((e) => [e.filaId, e.codigo, e.explicacion]),
    );
    expect(sin.errores[0]?.sugerencia).toBeNull();
    expect(sin.avisos).toEqual([]);
  });

  it("generarTxt con la propuesta sin corregir lanza ArchivoNoPrevalidadoError (CA-7)", () => {
    expect(() => generarTxt(filasFixture(), CABECERA, { permitirProvisional: true })).toThrow(ArchivoNoPrevalidadoError);
  });
});

describe("CA-2 · tras aplicar las sugerencias de 011", () => {
  it("las sugerencias reales (R-MIX con gravado 8.97, R-ISC) dejan las filas del fixture corregido y aptas", () => {
    const inicial = prev(filasFixture());
    const filas = filasFixture();
    const entornoDe = (f: FilaReemplazo): { filas: FilaEvaluable[]; contexto: ContextoReglas } => ({
      filas: [{ id: f.id, proveedor: { ...f.proveedor }, comprobante: { ...f.comprobante }, montos: f.montos }],
      contexto: REGLAS,
    });
    const aplicarA = (id: string, h: Hallazgo, confirmacion?: { gravado: Money }): FilaReemplazo => {
      const f = filas.find((x) => x.id === id) as FilaReemplazo;
      const { montos } = aplicarSugerencia(f.montos, h, confirmacion, entornoDe(f));
      return { ...f, estado: "modificada", montos };
    };
    const mixta = aplicarA("F001-2056", inicial.errores[0]?.sugerencia as Hallazgo, { gravado: Money.desde("8.97", "PEN") });
    const sanJuan = aplicarA("F001-1040", inicial.avisos[0]?.hallazgo as Hallazgo);
    const corregidas = filasFixtureCorregidas();
    expect(mixta.montos.toJSON()).toEqual(corregidas[1]?.montos.toJSON());
    expect(sanJuan.montos.toJSON()).toEqual(corregidas[0]?.montos.toJSON());

    const r = prev(filas.map((f) => (f.id === mixta.id ? mixta : f.id === sanJuan.id ? sanJuan : f)));
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it("el fixture corregido (mixta 8.97 + 12.51; San Juan con ISC 770.00) es apto, sin errores", () => {
    const r = prev(filasFixtureCorregidas());
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(prev(filasFixtureCorregidas(), false).apto).toBe(true);
  });

  it("generarTxt produce una línea por fila no excluida: 5 líneas exactas, en orden de fecha", () => {
    const r = generarTxt(filasFixtureCorregidas(), CABECERA, { permitirProvisional: true });
    expect(r.lineas).toBe(5);
    const fila = (k: string, v: string[], moneda = "PEN", tc = "") =>
      ["202610", "01", "F001", k, ...v.slice(0, 1), "6", ...v.slice(1, 2), "", moneda, tc, ...v.slice(2)].join("|");
    // [fecha, RUC proveedor, biDg, igvDg, biDgng, igvDgng, biDng, igvDng, noGravado, isc, icbper, otros, total]
    const esperado = [
      fila("1040", ["02/10/2026", "20700000011", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "770.00", "0.00", "0.00", "770.00"]),
      fila("2056", ["05/10/2026", "20700000045", "8.97", "1.61", "0.00", "0.00", "0.00", "0.00", "12.51", "0.00", "0.00", "0.00", "23.09"]),
      fila("3064", ["08/10/2026", "20700000053", "100.00", "18.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "1.50", "0.00", "119.50"]),
      fila("4062", ["12/10/2026", "20700000061", "0.15", "0.03", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.18"], "USD", "3.300"),
      fila("5070", ["14/10/2026", "20700000070", "150.00", "27.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "177.00"]),
    ];
    expect(lineasCrlf(r.bytes)).toEqual(esperado);
  });
});

describe("caso real: gasto personal, glosa 'zapatilla' · R-GP solo avisa", () => {
  // El proveedor de `conGlosa` (PROV) no está en el fixture: se declara conocido solo en este bloque,
  // para que R-NEW no se mezcle con el aviso R-GP y no cambie el contexto de los demás bloques.
  const prevZ = (filas: readonly FilaReemplazo[]) =>
    prevalidar(filas, {
      cabecera: CABECERA,
      reglas: { ...REGLAS, proveedoresConocidos: [...REGLAS.proveedoresConocidos, { ...PROV }] },
    });
  const conGlosa = (glosa: string): FilaReemplazo =>
    filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, {
      xml: xmlDe({ gravado: "100.00", igv: "18.00", total: "118.00", glosas: [glosa] }),
    });

  it.each(["ZAPATILLAS URBANAS T-42", "zapat. dep."])("la glosa %j da un aviso R-GP y la fila es apta", (glosa) => {
    const r = prevZ([conGlosa(glosa)]);
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toMatchObject({ filaId: "f1", codigo: "R-GP" });
    expect(r.avisos[0]?.explicacion.toLowerCase()).toContain("zapatilla");
  });

  it("nunca bloquea: generarTxt la serializa igual", () => {
    expect(generarTxt([conGlosa("ZAPATILLAS URBANAS T-42")], CABECERA, { permitirProvisional: true }).lineas).toBe(1);
  });

  it("'zapata de concreto' no da aviso", () => {
    expect(prevZ([conGlosa("zapata de concreto")]).avisos).toEqual([]);
  });
});

describe("caso real: Cervecería San Juan (ISC en DG) · el aviso no bloquea", () => {
  it("sola, la fila de San Juan es apta con un aviso R-ISC y se puede generar el TXT provisional", () => {
    const f = filaSanJuan();
    const r = prev([f]);
    expect(r.apto).toBe(true);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["R-ISC"]);
    expect(generarTxt([f], CABECERA, { permitirProvisional: true }).lineas).toBe(1);
  });
});

describe("casos reales diferidos", () => {
  // Cuando el equipo entregue el caso real USD (redondeo SUNAT por componente, 010 D7), se agrega aquí
  // con cifras reales y se contrasta con CONVERSION_USD y el impacto de resumirCambios (CA-4 sigue sintético).
  it.todo("redondeo USD: caso real con TC de 3 decimales (diferido, sin cifras; ver CA-4 sintético)");
});

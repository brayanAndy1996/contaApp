// Spec 025 · T1 (rojo). R-STD, el modo estándar (RF-113, HU-30; spec D-8, U-3, U-4; CA-9, CA-10; plan Contratos: domain).
// Sugiere DNG por fila en clientes con perfil de la Amazonía, ventas exoneradas y sin ventas mixtas, para los proveedores sin
// regla aprendida activa. Rojo: `R-STD`, `cumpleModoEstandar`, `modoEstandar` y `proveedoresConRegla` aún no existen.
import { describe, expect, it } from "vitest";
import { ctx, de, evaluar, fila, montos, pen, ser, usd, xml } from "../../tests/ayudas/filas-motor";
import { cambiarDestino } from "../comprobante/index";
import { sugerenciaEsMasiva } from "../compras/masivas";
import {
  CATALOGO_REGLAS_MOTOR,
  EntradaReglasInvalidaError,
  SugerenciaObsoletaError,
  aplicarMasivo,
  aplicarSugerencia,
  cumpleModoEstandar,
} from "./index";
import type { ContextoReglas, FilaEvaluable, Hallazgo } from "./index";

const PROV = { tipo: "6", numero: "20100000001" };
const OTRO = { tipo: "6", numero: "20999999999" };
const COM = (numero: string) => ({ tipo: "01", serie: "F001", numero });
const STD = { modoEstandar: true } satisfies Partial<ContextoReglas>;
const conStd = (over: Partial<ContextoReglas> = {}) => ctx({ ...STD, ...over });

const gravadaDg = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
const stdDe = (filas: readonly FilaEvaluable[], c: ContextoReglas = conStd()): Hallazgo[] => de(evaluar(filas, c).hallazgos, "R-STD");
const unaStd = (f: FilaEvaluable, c: ContextoReglas = conStd()): Hallazgo => {
  const hs = stdDe([f], c);
  expect(hs).toHaveLength(1);
  return hs[0] as Hallazgo;
};

describe("cumpleModoEstandar (U-4): las 8 combinaciones de zona, ventas exoneradas y ventas mixtas", () => {
  it.each<[string, "amazonia" | "general", boolean, boolean, boolean]>([
    ["amazonia, exoneradas, sin mixtas", "amazonia", true, false, true],
    ["amazonia, exoneradas, con mixtas", "amazonia", true, true, false],
    ["amazonia, sin exoneradas, sin mixtas", "amazonia", false, false, false],
    ["amazonia, sin exoneradas, con mixtas", "amazonia", false, true, false],
    ["general, exoneradas, sin mixtas", "general", true, false, false],
    ["general, exoneradas, con mixtas", "general", true, true, false],
    ["general, sin exoneradas, sin mixtas", "general", false, false, false],
    ["general, sin exoneradas, con mixtas", "general", false, true, false],
  ])("%s → %s", (_n, zona, ventasExoneradas, ventasMixtas, esperado) => {
    expect(cumpleModoEstandar({ zona, ventasExoneradas, ventasMixtas })).toBe(esperado);
  });

  it("solo «amazonia» exacta cuenta: otra caja o un valor desconocido no cumple", () => {
    for (const zona of ["Amazonia", "AMAZONIA", "amazonía", "selva", "", " amazonia"]) {
      expect(cumpleModoEstandar({ zona: zona as "amazonia", ventasExoneradas: true, ventasMixtas: false })).toBe(false);
    }
  });

  it("devuelve un booleano real (no un valor «truthy»)", () => {
    expect(typeof cumpleModoEstandar({ zona: "amazonia", ventasExoneradas: true, ventasMixtas: false })).toBe("boolean");
    expect(typeof cumpleModoEstandar({ zona: "general", ventasExoneradas: true, ventasMixtas: false })).toBe("boolean");
  });
});

describe("R-STD: el hallazgo (D-8)", () => {
  it("fila gravada en DG, proveedor sin regla, cliente en modo estándar: sugiere DNG sin pedir confirmación ni dato", () => {
    const h = unaStd(fila({ montos: gravadaDg() }));
    expect(h.filaId).toBe("f1");
    expect(h.regla).toBe("R-STD");
    expect(h.destino).toBe("DNG");
    expect(h.sugerencia).toEqual({ tipo: "clasificar" });
    expect(h.requiereConfirmacion).toBe(false);
    expect(h.dato).toBeNull();
  });

  it("la explicación es «DNG por perfil del cliente», fija y sin montos", () => {
    const h = unaStd(fila({ montos: gravadaDg() }));
    expect(h.explicacion).toContain("DNG por perfil del cliente");
    expect(h.explicacion).not.toMatch(/100\.00|118\.00|18\.00/);
    expect(h.explicacion).toBe(unaStd(fila({ id: "otra", montos: montos("PEN", { biDg: "55.00", igvDg: "9.90", total: "64.90" }) })).explicacion);
  });

  it("lecturas: biDg, igvDg, biDgng e igvDgng, con sus montos", () => {
    const h = unaStd(fila({ montos: montos("PEN", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" }) }));
    expect(Object.keys(h.lecturas).sort()).toEqual(["biDg", "biDgng", "igvDg", "igvDgng"]);
    expect(h.lecturas.biDg?.toString()).toBe("60.00");
    expect(h.lecturas.igvDg?.toString()).toBe("10.80");
    expect(h.lecturas.biDgng?.toString()).toBe("40.00");
    expect(h.lecturas.igvDgng?.toString()).toBe("7.20");
  });

  it("el hallazgo sale congelado, con su sugerencia y sus lecturas", () => {
    const h = unaStd(fila({ montos: gravadaDg() }));
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.sugerencia)).toBe(true);
    expect(Object.isFrozen(h.lecturas)).toBe(true);
  });

  it("sugiere con DGNG solo, con DG y DGNG a la vez y también en USD y en notas de crédito", () => {
    expect(stdDe([fila({ montos: montos("PEN", { biDgng: "100.00", igvDgng: "18.00", total: "118.00" }) })])).toHaveLength(1);
    expect(stdDe([fila({ montos: montos("PEN", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" }) })])).toHaveLength(1);
    expect(stdDe([fila({ montos: montos("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" }) })])).toHaveLength(1);
    expect(stdDe([fila({ montos: montos("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" }) })])).toHaveLength(1);
  });

  it("un solo hallazgo por fila aunque la base esté en DG y en DGNG", () => {
    const m = montos("PEN", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" });
    expect(stdDe([fila({ montos: m })])).toHaveLength(1);
  });

  it("una fila con parte ya en DNG y parte en DG también se sugiere (queda base gravada fuera de DNG)", () => {
    const m = montos("PEN", { biDg: "50.00", igvDg: "9.00", biDng: "50.00", igvDng: "9.00", total: "118.00" });
    expect(stdDe([fila({ montos: m })])).toHaveLength(1);
  });

  it("evalúa cada fila por separado: solo las del proveedor sin regla", () => {
    const filas = [
      fila({ id: "a", montos: gravadaDg() }),
      fila({ id: "b", proveedor: OTRO, comprobante: COM("2"), montos: gravadaDg() }),
      fila({ id: "c", comprobante: COM("3"), montos: gravadaDg() }),
    ];
    const r = stdDe(filas, conStd({ proveedoresConRegla: [OTRO] }));
    expect(r.map((h) => h.filaId)).toEqual(["a", "c"]);
  });

  it("sugerenciaEsMasiva es verdadero: R-STD se acepta en masa (U-3)", () => {
    expect(sugerenciaEsMasiva(unaStd(fila({ montos: gravadaDg() })))).toBe(true);
  });
});

describe("R-STD: cuándo no sugiere", () => {
  it("control: la misma fila gravada en DG, sin regla y en modo estándar, sí sugiere (las negativas de abajo parten de esto)", () => {
    expect(stdDe([fila({ montos: gravadaDg() })])).toHaveLength(1);
  });

  it("cliente fuera del modo estándar: ni sin la marca ni con ella en false", () => {
    expect(stdDe([fila({ montos: gravadaDg() })], ctx())).toEqual([]);
    expect(stdDe([fila({ montos: gravadaDg() })], ctx({ modoEstandar: false }))).toEqual([]);
  });

  it("proveedor con regla aprendida activa (la lista no lleva destino: también las reglas DG)", () => {
    expect(stdDe([fila({ montos: gravadaDg() })], conStd({ proveedoresConRegla: [PROV] }))).toEqual([]);
  });

  it("el documento de la regla se normaliza: espacios y minúsculas, de ambos lados", () => {
    const f = fila({ proveedor: { tipo: "1", numero: " ab- 12 " }, montos: gravadaDg() });
    expect(stdDe([f], conStd({ proveedoresConRegla: [{ tipo: "1", numero: "AB-12" }] }))).toEqual([]);
    const g = fila({ proveedor: { tipo: "1", numero: "AB-12" }, montos: gravadaDg() });
    expect(stdDe([g], conStd({ proveedoresConRegla: [{ tipo: "1", numero: "ab -12 " }] }))).toEqual([]);
  });

  it("otro proveedor, o el mismo número con otro tipo de documento, no excluye a la fila", () => {
    expect(stdDe([fila({ montos: gravadaDg() })], conStd({ proveedoresConRegla: [OTRO] }))).toHaveLength(1);
    expect(stdDe([fila({ montos: gravadaDg() })], conStd({ proveedoresConRegla: [{ tipo: "1", numero: PROV.numero }] }))).toHaveLength(1);
  });

  it("no depende del historial: un proveedor conocido pero sin regla activa sí se sugiere, y uno nuevo también", () => {
    expect(stdDe([fila({ montos: gravadaDg() })], conStd({ proveedoresConocidos: [PROV] }))).toHaveLength(1);
    expect(stdDe([fila({ proveedor: OTRO, montos: gravadaDg() })], conStd({ proveedoresConocidos: [PROV] }))).toHaveLength(1);
  });

  it("la fila ya está toda en DNG", () => {
    const m = montos("PEN", { biDng: "100.00", igvDng: "18.00", total: "118.00" });
    expect(stdDe([fila({ montos: m })])).toEqual([]);
  });

  it("sin base gravada: solo no gravado, solo ISC o solo IGV sin base", () => {
    expect(stdDe([fila({ montos: montos("PEN", { noGravado: "50.00", total: "50.00" }) })])).toEqual([]);
    expect(stdDe([fila({ montos: montos("PEN", { isc: "70.00", total: "70.00" }) })])).toEqual([]);
    expect(stdDe([fila({ montos: montos("PEN", { igvDg: "18.00", total: "18.00" }) })])).toEqual([]);
  });

  it("una fila en cero no sugiere nada", () => {
    expect(stdDe([fila({ montos: montos("PEN", { total: "0.00" }) })])).toEqual([]);
  });

  it("R-STD apagada por el estudio (RF-089): ni el código es inválido ni sale el hallazgo; las demás siguen", () => {
    const f = fila({ montos: gravadaDg(), proveedor: OTRO });
    const c = conStd({ reglasApagadas: ["R-STD"] });
    expect(() => evaluar([f], c)).not.toThrow();
    expect(stdDe([f], c)).toEqual([]);
    expect(de(evaluar([f], c).hallazgos, "R-NEW")).toHaveLength(1);
  });

  it("apagar otra regla no apaga R-STD", () => {
    expect(stdDe([fila({ montos: gravadaDg() })], conStd({ reglasApagadas: ["R-NEW", "R-HIS", "R-GP"] }))).toHaveLength(1);
  });
});

describe("R-STD convive con R-NEW, R-ISC, R-MIX, R-RED y R-GP en la misma fila (orden de ORDEN_REGLAS)", () => {
  const reglas = (f: FilaEvaluable, c: ContextoReglas = conStd()) => evaluar([f], c).hallazgos.map((h) => h.regla);

  it("proveedor nuevo (R-NEW): sale R-NEW y luego R-STD", () => {
    expect(reglas(fila({ proveedor: OTRO, montos: gravadaDg() }))).toEqual(["R-NEW", "R-STD"]);
  });

  it("San Juan, ISC sin IGV (BI 770.00): R-ISC y R-STD", () => {
    expect(reglas(fila({ montos: montos("PEN", { biDg: "770.00", total: "770.00" }) }))).toEqual(["R-ISC", "R-STD"]);
  });

  it("mixta 21.48 con IGV 1.61 (no cuadra): R-MIX y R-STD", () => {
    expect(reglas(fila({ montos: montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" }) }))).toEqual(["R-MIX", "R-STD"]);
  });

  it("descuadre de redondeo del total: R-RED y R-STD", () => {
    expect(reglas(fila({ montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }) }))).toEqual(["R-RED", "R-STD"]);
  });

  it("zapatillas en la glosa del XML: R-GP y R-STD", () => {
    const f = fila({ montos: gravadaDg(), xml: xml({ glosas: ["ZAPATILLAS URBANAS T-42"] }) });
    expect(reglas(f)).toEqual(["R-GP", "R-STD"]);
  });

  it("todas juntas: R-ISC, R-NEW y R-STD, en ese orden", () => {
    expect(reglas(fila({ proveedor: OTRO, montos: montos("PEN", { biDg: "770.00", total: "770.00" }) }))).toEqual(["R-ISC", "R-NEW", "R-STD"]);
  });

  it("la salida entre filas sigue ordenada por id y, dentro de cada fila, por regla", () => {
    const filas = [
      fila({ id: "b", proveedor: OTRO, comprobante: COM("2"), montos: gravadaDg() }),
      fila({ id: "a", comprobante: COM("1"), montos: gravadaDg() }),
    ];
    expect(evaluar(filas, conStd()).hallazgos.map((h) => `${h.filaId}:${h.regla}`)).toEqual(["a:R-STD", "b:R-NEW", "b:R-STD"]);
  });

  it("no cambia lo que dan las demás reglas: con y sin modo estándar solo difiere R-STD", () => {
    const filas = [
      fila({ id: "a", comprobante: COM("1"), montos: montos("PEN", { biDg: "770.00", total: "770.00" }) }),
      fila({ id: "b", comprobante: COM("2"), proveedor: OTRO, montos: montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" }) }),
    ];
    const con = evaluar(filas, conStd()).hallazgos.filter((h) => h.regla !== "R-STD");
    const sin = evaluar(filas, ctx()).hallazgos;
    expect(ser(con)).toBe(ser(sin));
  });
});

describe("R-STD: contexto estricto (EntradaReglasInvalidaError)", () => {
  const f = fila({ montos: gravadaDg() });
  const con = (over: Record<string, unknown>) => () => evaluar([f], ctx(over as Partial<ContextoReglas>));

  it("modoEstandar debe ser un booleano", () => {
    expect(con({ modoEstandar: true })).not.toThrow();
    for (const v of [1, 0, "true", "", null, {}, []]) {
      expect(con({ modoEstandar: v })).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("proveedoresConRegla: lista vacía o de documentos válidos; ausente equivale a vacía", () => {
    expect(con({ modoEstandar: true, proveedoresConRegla: [] })).not.toThrow();
    expect(con({ modoEstandar: true, proveedoresConRegla: [PROV, OTRO] })).not.toThrow();
    expect(stdDe([f], conStd())).toHaveLength(1);
    expect(stdDe([f], conStd({ proveedoresConRegla: [] }))).toHaveLength(1);
  });

  it("proveedoresConRegla inválida lanza (no es un arreglo, o un documento fuera de gramática o con claves de más)", () => {
    expect(con({ modoEstandar: true, proveedoresConRegla: [PROV] })).not.toThrow();
    for (const v of ["x", 1, null, {}, [null], [{ tipo: "66", numero: "1" }], [{ tipo: "6", numero: "con|barra" }], [{ tipo: "6" }], [{ tipo: "6", numero: "1", extra: 1 }]]) {
      expect(con({ modoEstandar: true, proveedoresConRegla: v })).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("valida antes de evaluar: no hay resultados parciales con una lista inválida", () => {
    expect(con({ modoEstandar: true, proveedoresConRegla: [PROV, OTRO] })).not.toThrow();
    expect(con({ modoEstandar: true, proveedoresConRegla: [PROV, { tipo: "66", numero: "1" }] })).toThrow(EntradaReglasInvalidaError);
  });

  it("no muta el contexto recibido", () => {
    const lista = [{ ...PROV }];
    const c = conStd({ proveedoresConRegla: lista });
    evaluar([f], c);
    expect(lista).toEqual([PROV]);
    expect(c.proveedoresConRegla).toBe(lista);
  });
});

describe("R-STD: aplicar (clasificar sin dato usa el destino del hallazgo, D-8)", () => {
  const entorno = (filas: FilaEvaluable[], c: ContextoReglas = conStd()) => ({ filas, contexto: c });

  it("aplicar da los mismos montos que clasificar a mano en DNG (cambiarDestino de 010) y conserva el total", () => {
    const f = fila({ montos: gravadaDg() });
    const h = unaStd(f);
    const r = aplicarSugerencia(f.montos, h, undefined, entorno([f]));
    expect(r.excluir).toBe(false);
    expect(ser(r.montos)).toBe(ser(cambiarDestino(f.montos, "DNG").montos));
    expect(r.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r.montos.obtener("igvDng").toString()).toBe("18.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("118.00");
  });

  it("con DG y DGNG a la vez, en USD: ambos pares terminan en DNG y los montos son los de cambiarDestino", () => {
    const m = montos("USD", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" });
    const f = fila({ montos: m });
    const r = aplicarSugerencia(m, unaStd(f), undefined, entorno([f]));
    expect(ser(r.montos)).toBe(ser(cambiarDestino(m, "DNG").montos));
    expect(r.montos.moneda).toBe("USD");
    expect(r.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r.montos.obtener("igvDng").toString()).toBe("18.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.obtener("biDgng").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("118.00");
  });

  it("con una parte ya en DNG suma lo que había: la base final es la de los tres destinos", () => {
    const m = montos("PEN", { biDg: "50.00", igvDg: "9.00", biDng: "50.00", igvDng: "9.00", total: "118.00" });
    const f = fila({ montos: m });
    const r = aplicarSugerencia(m, unaStd(f), undefined, entorno([f]));
    expect(r.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r.montos.obtener("igvDng").toString()).toBe("18.00");
  });

  it("no muta los montos recibidos", () => {
    const f = fila({ montos: gravadaDg() });
    const antes = ser(f.montos);
    aplicarSugerencia(f.montos, unaStd(f), undefined, entorno([f]));
    expect(ser(f.montos)).toBe(antes);
  });

  it("sin pedir dato: aplicarMasivo la acepta sin confirmación y encadena filas distintas", () => {
    const filas = [
      fila({ id: "a", comprobante: COM("1"), montos: gravadaDg() }),
      fila({ id: "b", comprobante: COM("2"), montos: montos("PEN", { biDgng: "200.00", igvDgng: "36.00", total: "236.00" }) }),
    ];
    const hs = stdDe(filas);
    expect(hs).toHaveLength(2);
    const r = aplicarMasivo(
      hs.map((h) => ({ montos: (filas.find((x) => x.id === h.filaId) as FilaEvaluable).montos, hallazgo: h })),
      entorno(filas),
    );
    expect(r.rechazadas).toEqual([]);
    expect(r.aplicadas.map((a) => a.filaId)).toEqual(["a", "b"]);
    expect(r.aplicadas[0]?.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r.aplicadas[1]?.montos.obtener("biDng").toString()).toBe("200.00");
    expect(r.aplicadas[1]?.montos.obtener("igvDng").toString()).toBe("36.00");
  });

  it("si la fila cambió después de evaluar (ya está en DNG): SugerenciaObsoletaError y, en masa, rechazada como SUGERENCIA_OBSOLETA", () => {
    const f = fila({ montos: gravadaDg() });
    const h = unaStd(f);
    const clasificada = cambiarDestino(f.montos, "DNG").montos;
    expect(() => aplicarSugerencia(clasificada, h, undefined, entorno([f]))).toThrow(SugerenciaObsoletaError);
    const r = aplicarMasivo([{ montos: clasificada, hallazgo: h }], entorno([f]));
    expect(r.aplicadas).toEqual([]);
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-STD", codigo: "SUGERENCIA_OBSOLETA" }]);
  });

  it("si el proveedor ya tiene regla activa en el entorno, o el cliente dejó el modo estándar, o R-STD se apagó: obsoleta", () => {
    const f = fila({ montos: gravadaDg() });
    const h = unaStd(f);
    for (const c of [conStd({ proveedoresConRegla: [PROV] }), ctx(), conStd({ reglasApagadas: ["R-STD"] })]) {
      expect(() => aplicarSugerencia(f.montos, h, undefined, entorno([f], c))).toThrow(SugerenciaObsoletaError);
    }
  });

  it("un hallazgo R-STD forjado (otro destino o otra sugerencia) no se aplica", () => {
    const f = fila({ montos: gravadaDg() });
    const h = unaStd(f);
    const otroDestino = { ...h, destino: "DG" } as Hallazgo;
    expect(() => aplicarSugerencia(f.montos, otroDestino, undefined, entorno([f]))).toThrow();
    const otraSugerencia = {
      ...h,
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: pen("100.00") },
    } as unknown as Hallazgo;
    expect(() => aplicarSugerencia(f.montos, otraSugerencia, undefined, entorno([f]))).toThrow();
  });

  it("también aplica en USD con montos en la moneda de la fila (sin convertir)", () => {
    const m = montos("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const f = fila({ montos: m });
    const r = aplicarSugerencia(m, unaStd(f), undefined, entorno([f]));
    expect(r.montos.total.toString()).toBe(usd("118.00").toString());
  });
});

describe("R-STD en el catálogo del motor (RF-089, D-8)", () => {
  it("figura en CATALOGO_REGLAS_MOTOR con una descripción que lo explica", () => {
    const r = CATALOGO_REGLAS_MOTOR.find((x) => x.codigo === "R-STD");
    expect(r).toBeDefined();
    expect(r?.descripcion).toMatch(/DNG/);
    expect(r?.descripcion).toMatch(/Amazon/i);
  });
});

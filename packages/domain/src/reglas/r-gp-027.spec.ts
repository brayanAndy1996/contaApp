// Spec 027 · T1 (rojo). R-GP completa en `evaluarReglas` (R-1, R-2, R-5, R-8, R-9, R-11; CA-1, CA-2, CA-10, CA-11; plan, Contratos: domain
// `reglas/r-gp.ts`): con `ctx.gastos` puntúa y crea el hallazgo si `puntaje ≥ umbral`; sin `ctx.gastos` marca como 011 (diccionario del
// contexto, umbral 3, sin CIIU, historial ni ajuste). Sugerencia `{tipo, palabra, categoria, puntaje, senales}`; explicación
// fija «Posible gasto no deducible»; sin XML no se evalúa; la entrada no se muta. Cambia por contrato la forma que fijaba 011.
// T21a (decisión del usuario 2026-11-22): sin palabra clave (S1) no hay hallazgo aunque S2…S7 alcancen el umbral; la forma con
// `palabra: null` solo se lee de hallazgos guardados antes.
import { beforeEach, describe, expect, it } from "vitest";
import { detalleMixta } from "../../tests/ayudas/ubl";
import { ctx, de, evaluar, fila, montos, unico, xml } from "../../tests/ayudas/filas-motor";
import {
  FECHA_FERIADO,
  FECHA_HABIL,
  FECHA_SABADO,
  PROV_MOTOR,
  contextoGastos,
  contextoNeutro,
  diccionarioSemilla,
  entrada,
} from "../../tests/ayudas/gastos";
import type { ContextoPlano } from "../../tests/ayudas/gastos";
import { aceptarSugerenciaGuardada } from "../compras/aceptar";
import type { EntradaAceptar } from "../compras/aceptar";
import { hallazgoAJson } from "../compras/evaluar";
import type { CompraEvaluable } from "../compras/evaluar";
import { detallarHallazgo } from "../compras/hallazgo-vista";
import { aResumenXml } from "../ubl/index";
import { DiccionarioGlosas } from "../texto/index";
import { EntradaReglasInvalidaError, SugerenciaObsoletaError, aplicarSugerencia } from "./index";
import { puntuarGastoPersonal } from "../index";
import type { ContextoReglas, Hallazgo } from "./index";

const EXPLICACION = "Posible gasto no deducible";
const conGastos = (g: ReturnType<typeof contextoGastos>, over: Partial<ContextoReglas> = {}): ContextoReglas =>
  ctx({ gastos: g, ...over } as Partial<ContextoReglas>);
/** Contexto de CA-1: cliente ferretería 4752, proveedor de la fila de ropa 4771. */
const gastosCa1 = (over: Partial<ContextoPlano> = {}) =>
  contextoGastos({ ciiuProveedores: [{ proveedor: { ...PROV_MOTOR }, ciiu: "4771" }], ...over });
const filaCon = (glosas: string[], fechaEmision?: string) =>
  fila({ xml: xml({ glosas, ...(fechaEmision === undefined ? {} : { fechaEmision }) } as never) });
const gp = (f: ReturnType<typeof fila>, c: ContextoReglas): Hallazgo | undefined => de(evaluar([f], c).hallazgos, "R-GP")[0];
const senales = (h: Hallazgo | undefined): string[] =>
  ((h?.sugerencia as unknown as { senales: { codigo: string }[] }).senales ?? []).map((s) => s.codigo);
const sug = (h: Hallazgo | undefined) =>
  h?.sugerencia as unknown as { tipo: string; palabra: string | null; categoria: string | null; puntaje: number; senales: { codigo: string; puntos: number }[] };

describe("R-GP completa · CA-1 (hallazgo con puntaje y señales)", () => {
  it("«ZAPATILLA URBANA T42» de una tienda de ropa a una ferretería: puntaje 8 con S1, S2 y S3", () => {
    const h = gp(filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL), conGastos(gastosCa1()));
    expect(h).toBeDefined();
    expect(h!.regla).toBe("R-GP");
    expect(h!.filaId).toBe("f1");
    expect(h!.destino).toBeNull();
    expect(h!.dato).toBeNull();
    expect(h!.lecturas).toEqual({});
    expect(h!.requiereConfirmacion).toBe(true); // R-1: nunca excluye solo
    expect(h!.explicacion).toBe(EXPLICACION);
    expect(sug(h)).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
    expect(senales(h)).toEqual(["S1", "S2", "S3"]);
  });

  it("la sugerencia es exactamente lo que devuelve `puntuarGastoPersonal` (misma entrada, mismo contexto)", () => {
    const g = gastosCa1();
    const h = gp(filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL), conGastos(g));
    const r = puntuarGastoPersonal(entrada({ proveedor: { ...PROV_MOTOR } }), g);
    expect(h!.sugerencia).toEqual({ tipo: "excluir", palabra: r.palabra, categoria: r.categoria, puntaje: r.puntaje, senales: r.senales });
  });

  it("proveedor nuevo para el cliente: puntaje 9 con S5, aunque R-NEW esté apagada", () => {
    const f = filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL);
    const h = gp(f, conGastos(gastosCa1(), { proveedoresConocidos: [], reglasApagadas: ["R-NEW"] }));
    expect(sug(h).puntaje).toBe(9);
    expect(senales(h)).toEqual(["S1", "S2", "S3", "S5"]);
  });

  it("calzado-ropa permitida al cliente: puntaje 6 y sin S3", () => {
    const g = gastosCa1({ categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] } });
    const h = gp(filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL), conGastos(g));
    expect(sug(h).puntaje).toBe(6);
    expect(senales(h)).toEqual(["S1", "S2"]);
  });

  it("la glosa de F001-5070 de 016 («Par de zapatillas deportivas de prueba (PRUEBA)») puntúa S1", () => {
    const h = gp(filaCon(["Par de zapatillas deportivas de prueba (PRUEBA)"], FECHA_HABIL), conGastos(gastosCa1()));
    expect(senales(h)).toContain("S1");
    expect(sug(h).palabra).toBe("zapatilla");
  });

  it("R-GP convive con las demás reglas: proveedor nuevo da R-NEW y R-GP, en el orden del catálogo (R-9)", () => {
    const f = filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL);
    const r = evaluar([f], conGastos(gastosCa1(), { proveedoresConocidos: [] })).hallazgos.map((h) => h.regla);
    expect(r).toEqual(["R-NEW", "R-GP"]);
  });
});

describe("R-GP completa · umbral (R-11, CA-10)", () => {
  const f = filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL); // puntaje 8
  it.each([
    [1, true], [3, true], [8, true], [9, false], [20, false],
  ])("umbral %i con puntaje 8 → hallazgo: %s", (umbral, marca) => {
    expect(gp(f, conGastos(gastosCa1({ umbral }))) !== undefined).toBe(marca);
  });

  it("umbral 1 con solo el proveedor nuevo (S5, puntaje 1): sin palabra no hay hallazgo (T21a)", () => {
    const g = contextoNeutro({ umbral: 1 });
    expect(gp(filaCon(["servicio de cemento"]), conGastos(g, { proveedoresConocidos: [] }))).toBeUndefined();
    const r = puntuarGastoPersonal(entrada({ glosas: ["servicio de cemento"], fechaEmision: null, proveedor: { ...PROV_MOTOR }, esNuevo: true }), g);
    expect(r).toMatchObject({ puntaje: 1, palabra: null, categoria: null });
    // Con palabra, el mismo umbral 1 sí marca.
    expect(senales(gp(filaCon(["zapatillas"]), conGastos(g, { proveedoresConocidos: [] })))).toEqual(["S1", "S5"]);
  });

  it("umbral 3 con un puntaje de 1 (sin palabra): no hay hallazgo", () => {
    expect(gp(filaCon(["servicio de cemento"]), conGastos(contextoNeutro({ umbral: 3 }), { proveedoresConocidos: [] }))).toBeUndefined();
  });

  it("sin palabra pero con S2 (+3) y umbral 3: NO hay hallazgo (T21a: el rubro solo no marca)", () => {
    const g = gastosCa1();
    expect(gp(filaCon(["servicio de cemento"], FECHA_HABIL), conGastos(g))).toBeUndefined();
    const r = puntuarGastoPersonal(entrada({ glosas: ["servicio de cemento"], proveedor: { ...PROV_MOTOR } }), g);
    expect(r).toMatchObject({ puntaje: 3, palabra: null, categoria: null });
    expect(r.senales.map((s) => s.codigo)).toEqual(["S2"]);
  });

  it("sin palabra, S2 + S5 + S6 (puntaje 8) con umbral 3: NO hay hallazgo (T21a)", () => {
    const historial = [{ proveedor: { ...PROV_MOTOR }, aceptadas6: 0, excluidas6: 2, excluidas12: 2 }];
    const c = conGastos(gastosCa1({ historial }), { proveedoresConocidos: [] });
    expect(gp(filaCon(["servicio de cemento"], FECHA_HABIL), c)).toBeUndefined();
  });
});

describe("R-GP completa · historial y fecha en el hallazgo (CA-2, S4)", () => {
  const f = filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL);
  const historial = [{ proveedor: { ...PROV_MOTOR }, aceptadas6: 3, excluidas6: 0, excluidas12: 0 }];

  it("S7 baja el puntaje a 4 y sigue marcado con umbral 3", () => {
    const h = gp(f, conGastos(gastosCa1({ historial })));
    expect(sug(h).puntaje).toBe(4);
    expect(senales(h)).toEqual(["S1", "S2", "S3", "S7"]);
  });

  it("con el proveedor sin CIIU en caché el puntaje es 1: bajo el umbral, sin hallazgo", () => {
    const g = gastosCa1({ historial, ciiuProveedores: [{ proveedor: { ...PROV_MOTOR }, ciiu: null }] });
    expect(gp(f, conGastos(g))).toBeUndefined();
  });

  it("la fecha de emisión del XML alimenta S4: un restaurante en sábado o feriado suma +1 a una compra con palabra", () => {
    const g = (umbral: number) =>
      contextoGastos({ umbral, ciiuCliente: null, ciiuProveedores: [{ proveedor: { ...PROV_MOTOR }, ciiu: "5610" }] });
    for (const fecha of [FECHA_SABADO, FECHA_FERIADO]) {
      const h = gp(filaCon(["zapatillas"], fecha), conGastos(g(4)));
      expect(sug(h)).toMatchObject({ puntaje: 4 });
      expect(senales(h)).toEqual(["S1", "S4"]);
      // S4 sola (sin palabra) no marca, ni con umbral 1 (T21a).
      expect(gp(filaCon(["servicio de cemento"], fecha), conGastos(g(1)))).toBeUndefined();
    }
    expect(gp(filaCon(["zapatillas"], FECHA_HABIL), conGastos(g(4)))).toBeUndefined();
    expect(gp(filaCon(["zapatillas"]), conGastos(g(4)))).toBeUndefined(); // sin fecha en el XML: sin S4
  });
});

describe("R-GP completa · sin XML, apagada y XML ajeno (R-5, R-8, 011)", () => {
  it("sin XML no se evalúa ni puntúa, ni con contexto de gastos ni con proveedor nuevo", () => {
    expect(de(evaluar([fila()], conGastos(gastosCa1(), { proveedoresConocidos: [] })).hallazgos, "R-GP")).toEqual([]);
    expect(de(evaluar([fila()]).hallazgos, "R-GP")).toEqual([]);
  });

  it("R-GP apagada en «Reglas del motor» no se evalúa ni puntúa", () => {
    const h = evaluar([filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL)], conGastos(gastosCa1(), { reglasApagadas: ["R-GP"] })).hallazgos;
    expect(de(h, "R-GP")).toEqual([]);
  });

  it("un XML de otro comprobante se ignora: sin R-GP y con aviso XML_AJENO", () => {
    const f = fila({ xml: xml({ comprobante: { tipo: "01", serie: "F001", numero: "777" }, glosas: ["zapatillas"] }) });
    const r = evaluar([f], conGastos(gastosCa1()));
    expect(de(r.hallazgos, "R-GP")).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_AJENO"]);
  });
});

describe("R-GP completa · `ctx.gastos` ausente marca como 011", () => {
  it("usa el diccionario del contexto, umbral 3 y sin señales de CIIU, historial ni ajuste: puntaje 3 con S1", () => {
    const h = gp(filaCon(["ZAPATILLAS URBANAS T-42"]), ctx());
    expect(h!.explicacion).toBe(EXPLICACION);
    expect(h!.sugerencia).toEqual({
      tipo: "excluir",
      palabra: "zapatilla",
      categoria: "calzado-ropa",
      puntaje: 3,
      senales: [expect.objectContaining({ codigo: "S1", puntos: 3, palabra: "zapatilla" })],
    });
    expect(h!.requiereConfirmacion).toBe(true);
  });

  it("proveedor nuevo suma S5 también sin `ctx.gastos`: puntaje 4", () => {
    const h = gp(filaCon(["ZAPATILLAS URBANAS T-42"]), ctx({ proveedoresConocidos: [] }));
    expect(sug(h).puntaje).toBe(4);
    expect(senales(h)).toEqual(["S1", "S5"]);
  });

  it("con `ctx.gastos`, el diccionario de gastos manda sobre `ctx.diccionario`", () => {
    const soloTornillo = DiccionarioGlosas.desde([{ categoria: "ferreteria", palabras: ["tornillo"] }]);
    const c = conGastos(gastosCa1({ diccionario: diccionarioSemilla() }), { diccionario: soloTornillo });
    expect(sug(gp(filaCon(["zapatillas urbanas"], FECHA_HABIL), c)).palabra).toBe("zapatilla");
    // Sin palabra no hay hallazgo (T21a); además, sin CIIU del proveedor no hay S2.
    const sinS2 = conGastos(gastosCa1({ diccionario: diccionarioSemilla(), ciiuProveedores: [] }), { diccionario: soloTornillo });
    expect(gp(filaCon(["tornillos de 2 pulgadas"], FECHA_HABIL), sinS2)).toBeUndefined();
  });
});

describe("R-GP completa · texto no confiable (R-5, CA-11)", () => {
  it("la explicación es fija y nada del XML sale en el hallazgo salvo la palabra del diccionario", () => {
    const f = filaCon(["ZAPATILLAS <script>alert(1)</script> CANARIO-URBANAS"], FECHA_HABIL);
    const h = gp(f, conGastos(gastosCa1()));
    expect(h!.explicacion).toBe(EXPLICACION);
    const json = JSON.stringify(h).toLowerCase();
    for (const prohibido of ["script", "alert", "canario", "urbanas"]) expect(json).not.toContain(prohibido);
    expect(sug(h).palabra).toBe("zapatilla");
  });

  it("sin coincidencia ni señales no hay hallazgo y nada se filtra", () => {
    expect(gp(filaCon(["<script>alert(1)</script>"], FECHA_HABIL), conGastos(contextoNeutro()))).toBeUndefined();
  });
});

describe("R-GP completa · contexto estricto (CA-6)", () => {
  const f = filaCon(["zapatillas"]);
  const malo = (g: unknown): ContextoReglas => ctx({ gastos: g } as never);

  // Hoy cualquier clave `gastos` se rechaza como clave extra: se exige primero que un contexto válido sí se acepte.
  beforeEach(() => {
    expect(() => evaluar([f], ctx({ gastos: contextoGastos() } as never))).not.toThrow();
  });

  const base = (): Record<string, unknown> => ({ ...contextoGastos() });
  const casos: [string, () => unknown][] = [
    ["clave extra", () => ({ ...base(), extra: 1 })],
    ["umbral 0", () => ({ ...base(), umbral: 0 })],
    ["umbral 21", () => ({ ...base(), umbral: 21 })],
    ["umbral decimal", () => ({ ...base(), umbral: 3.5 })],
    ["diccionario ajeno", () => ({ ...base(), diccionario: { coincidenciasPorItem: () => [] } })],
    ["CIIU numérico", () => ({ ...base(), ciiuCliente: 4752 })],
    [
      "conteo decimal",
      () => ({ ...base(), historial: [{ proveedor: { tipo: "6", numero: "20100000001" }, aceptadas6: 1.5, excluidas6: 0, excluidas12: 0 }] }),
    ],
    ["null", () => null],
    ["un arreglo", () => []],
  ];
  it.each(casos)("%s → EntradaReglasInvalidaError", (_n, g) => {
    expect(() => evaluar([f], malo(g()))).toThrow(EntradaReglasInvalidaError);
  });

  it("un `__proto__` propio en `gastos` se rechaza", () => {
    const g: Record<string, unknown> = { ...contextoGastos() };
    Object.defineProperty(g, "__proto__", { value: {}, enumerable: true, configurable: true, writable: true });
    expect(() => evaluar([f], malo(g))).toThrow(EntradaReglasInvalidaError);
  });

  it("la entrada no se muta: el contexto congelado no lanza", () => {
    const g = Object.freeze({ ...contextoGastos() });
    expect(() => evaluar([f], ctx({ gastos: g } as never))).not.toThrow();
  });
});

describe("R-GP completa · aplicar y obsolescencia (D-5, R-1)", () => {
  const m = montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });

  it("aplicar excluye y deja los montos intactos; sin palabra (solo S2) no hay hallazgo que aplicar (T21a)", () => {
    const contexto = conGastos(gastosCa1());
    const sinPalabra = fila({ montos: m, xml: xml({ glosas: ["servicio de cemento"], fechaEmision: FECHA_HABIL } as never) });
    expect(de(evaluar([sinPalabra], contexto).hallazgos, "R-GP")).toEqual([]);
    const f = fila({ montos: m, xml: xml({ glosas: ["ZAPATILLA URBANA T42"], fechaEmision: FECHA_HABIL } as never) });
    const h = unico(evaluar([f], contexto).hallazgos, "R-GP");
    expect(sug(h).palabra).toBe("zapatilla");
    const r = aplicarSugerencia(m, h, undefined, { filas: [f], contexto });
    expect(r.excluir).toBe(true);
    expect(JSON.stringify(r.montos)).toBe(JSON.stringify(m));
  });

  it("si el contexto cambió (umbral más alto), aplicar es obsoleto", () => {
    const f = fila({ montos: m, xml: xml({ glosas: ["ZAPATILLA URBANA T42"], fechaEmision: FECHA_HABIL } as never) });
    const h = unico(evaluar([f], conGastos(gastosCa1())).hallazgos, "R-GP");
    expect(() => aplicarSugerencia(m, h, undefined, { filas: [f], contexto: conGastos(gastosCa1({ umbral: 9 })) })).toThrow(SugerenciaObsoletaError);
  });

  it("si el diccionario cambió (se desactivó la palabra), aplicar es obsoleto", () => {
    const f = fila({ montos: m, xml: xml({ glosas: ["ZAPATILLA URBANA T42"], fechaEmision: FECHA_HABIL } as never) });
    const h = unico(evaluar([f], conGastos(gastosCa1())).hallazgos, "R-GP");
    const vacio = DiccionarioGlosas.desde([]);
    expect(() =>
      aplicarSugerencia(m, h, undefined, { filas: [f], contexto: conGastos(gastosCa1({ diccionario: vacio, ciiuProveedores: [], umbral: 3 })) }),
    ).toThrow(SugerenciaObsoletaError);
  });
});

describe("lectores de 014/016 con la forma nueva (y la vieja sigue legible)", () => {
  const nueva = { tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8, senales: [{ codigo: "S1", puntos: 3, palabra: "zapatilla", items: { coinciden: 1, total: 1 } }] };
  const sinPalabra = { tipo: "excluir", palabra: null, categoria: null, puntaje: 3, senales: [{ codigo: "S2", puntos: 3 }] };
  const COMPRA: CompraEvaluable = {
    docTipo: "6", docNumero: "20100070970", tipoDoc: "01", serie: "F001", numero: "1040", moneda: "PEN", clasificada: false,
    montos: { biDg: "500.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "500.00" },
  };
  const entradaAceptar = (sugerencia: unknown): EntradaAceptar => ({
    compra: COMPRA,
    hallazgo: { regla: "R-GP", sugerencia, lecturas: {}, requiereConfirmacion: false },
    proveedoresConocidos: [{ tipo: "6", numero: "20100070970" }],
    confirmar: false,
    dato: undefined,
    enMasa: false,
  });

  it("`hallazgoAJson` conserva puntaje, señales y palabra al guardar (sin palabra ya no hay hallazgo, T21a)", () => {
    expect(de(evaluar([filaCon(["servicio de cemento"], FECHA_HABIL)], conGastos(gastosCa1())).hallazgos, "R-GP")).toEqual([]);
    const h = unico(evaluar([filaCon(["ZAPATILLA URBANA T42"], FECHA_HABIL)], conGastos(gastosCa1())).hallazgos, "R-GP");
    const j = hallazgoAJson(h);
    expect(j.regla).toBe("R-GP");
    expect(j.requiereConfirmacion).toBe(true);
    expect(j.sugerencia).toEqual(h.sugerencia);
    expect(j.sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
  });

  it("`detallarHallazgo` da la explicación fija con la forma nueva, con y sin palabra", () => {
    for (const sugerencia of [nueva, sinPalabra]) {
      const d = detallarHallazgo({ regla: "R-GP", sugerencia, lecturas: {}, requiereConfirmacion: true });
      expect(d).toEqual({ destino: null, explicacion: EXPLICACION, dato: null, masiva: false });
    }
  });

  it("`aceptarSugerenciaGuardada` lee la forma nueva (con y sin palabra) y excluye la fila", () => {
    for (const sugerencia of [nueva, sinPalabra]) {
      expect(aceptarSugerenciaGuardada(entradaAceptar(sugerencia))).toMatchObject({ ok: true, excluir: true });
    }
  });

  it("la forma vieja (sin puntaje) se sigue leyendo", () => {
    expect(aceptarSugerenciaGuardada(entradaAceptar({ tipo: "excluir", palabra: "zapatillas", categoria: "calzado" }))).toMatchObject({ ok: true, excluir: true });
  });

  it("una palabra que no es cadena ni null sigue siendo ilegible (revisar de nuevo)", () => {
    expect(aceptarSugerenciaGuardada(entradaAceptar({ ...nueva, palabra: 1 }))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });
});

describe("`aResumenXml` lleva la fecha de emisión (S4)", () => {
  it("fechaEmision = IssueDate del detalle", () => {
    const d = detalleMixta();
    expect((aResumenXml(d) as unknown as { fechaEmision?: string }).fechaEmision).toBe(d.fecha);
  });
});

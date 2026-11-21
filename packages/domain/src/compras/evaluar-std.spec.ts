// Spec 025 · T1 (rojo). crearEvaluarCompras con `perfil` (R-STD, RF-113, HU-30; D-8, D-9; CA-9, CA-10, CA-11), la vista del
// hallazgo guardado y su aceptación (una a una y en masa). Rojo: `OpcionesEvaluar.perfil` aún no existe y R-STD no se evalúa.
import { describe, expect, it, vi } from "vitest";
import { cambiarDestino, MontosComprobante } from "../comprobante/index";
import type { ColumnaCompra } from "../comprobante/index";
import * as entrada from "../reglas/entrada";
import { aceptarSugerenciaGuardada } from "./aceptar";
import type { EntradaAceptar } from "./aceptar";
import { crearEvaluarCompras } from "./evaluar";
import type { CompraEvaluable, HallazgoJson } from "./evaluar";
import { detallarHallazgo } from "./hallazgo-vista";

vi.mock("../reglas/entrada", async (original) => {
  const real = await original<typeof import("../reglas/entrada")>();
  return { ...real, validarContexto: vi.fn(real.validarContexto) };
});
const validarContexto = vi.mocked(entrada.validarContexto);

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const PROV = { tipo: "6", numero: "20100070970" };
const OTRO = { tipo: "6", numero: "20999999999" };
const SELVA = { zona: "amazonia", ventasExoneradas: true, ventasMixtas: false } as const;
const GENERAL = { zona: "general", ventasExoneradas: true, ventasMixtas: false } as const;
const SIN_EXONERADAS = { zona: "amazonia", ventasExoneradas: false, ventasMixtas: false } as const;
const CON_MIXTAS = { zona: "amazonia", ventasExoneradas: true, ventasMixtas: true } as const;

const compra = (o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
  docTipo: PROV.tipo,
  docNumero: PROV.numero,
  tipoDoc: "01",
  serie: "F001",
  numero: "1040",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.00" },
  ...o,
});
const conMontos = (m: Partial<typeof CERO>, o: Partial<CompraEvaluable> = {}) => compra({ montos: { ...CERO, ...m }, ...o });
const SAN_JUAN = { ...CERO, biDg: "770.00", total: "770.00" };
const MIXTA = { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" };

type Opciones = Parameters<typeof crearEvaluarCompras>[1];
const opciones = (o: Record<string, unknown> = {}): Opciones => ({ xmlSimuladoEnReglas: false, ...o }) as Opciones;
const evaluador = (o: Record<string, unknown> = {}, conocidos = [PROV]) => crearEvaluarCompras(conocidos, opciones(o));
const reglasDe = (e: ReturnType<typeof crearEvaluarCompras>, c: CompraEvaluable) => e(c).map((h) => h.regla);
const stdDe = (e: ReturnType<typeof crearEvaluarCompras>, c: CompraEvaluable): HallazgoJson | undefined => e(c).find((h) => h.regla === "R-STD");

describe("crearEvaluarCompras con perfil: R-STD (D-8)", () => {
  it("cliente de la selva (01 §7.3, Huánuco), proveedor sin regla, base gravada en DG: sugiere DNG por perfil", () => {
    const h = stdDe(evaluador({ perfil: SELVA }), compra());
    expect(h).toEqual({
      regla: "R-STD",
      sugerencia: { tipo: "clasificar" },
      lecturas: { biDg: "100.00", igvDg: "18.00", biDgng: "0.00", igvDgng: "0.00" },
      requiereConfirmacion: false,
    });
  });

  it("sin perfil el resultado es el de hoy (sin R-STD): igual que no pasar la opción", () => {
    const c = compra();
    expect(reglasDe(evaluador({}), c)).not.toContain("R-STD");
    expect(evaluador({})(c)).toEqual(crearEvaluarCompras([PROV])(c));
  });

  it.each([
    ["zona general", GENERAL],
    ["sin ventas exoneradas", SIN_EXONERADAS],
    ["con ventas mixtas", CON_MIXTAS],
  ])("cliente fuera del criterio (%s): no sugiere", (_n, perfil) => {
    const e = evaluador({ perfil });
    expect(reglasDe(e, compra())).not.toContain("R-STD");
    expect(stdDe(evaluador({ perfil: SELVA }), compra())).toBeDefined();
  });

  it("proveedor con regla aprendida activa: no sugiere (tampoco R-NEW); otro proveedor sin regla sí", () => {
    const e = evaluador({ perfil: SELVA, proveedoresConRegla: [PROV] }, []);
    expect(reglasDe(e, compra())).toEqual([]);
    expect(reglasDe(e, compra({ docNumero: OTRO.numero }))).toEqual(["R-NEW", "R-STD"]);
  });

  it("el documento de la regla se normaliza (espacios y minúsculas) y uno fuera de gramática se omite sin vaciar la evaluación", () => {
    const e = evaluador({ perfil: SELVA, proveedoresConRegla: [{ tipo: "66", numero: "con|barra" }, { tipo: "6", numero: " 2010 0070970 " }] });
    expect(reglasDe(e, compra())).not.toContain("R-STD");
    expect(reglasDe(e, compra({ docNumero: OTRO.numero }))).toContain("R-STD");
  });

  it("una lista vacía de proveedores con regla equivale a no pasarla", () => {
    expect(reglasDe(evaluador({ perfil: SELVA, proveedoresConRegla: [] }), compra())).toContain("R-STD");
  });

  it("proveedor conocido por el historial pero sin regla activa: sí sugiere (R-STD no mira el historial)", () => {
    expect(reglasDe(evaluador({ perfil: SELVA }, [PROV]), compra())).toEqual(["R-STD"]);
  });

  it("fila clasificada por el contador: no vuelve a sugerirse (D-8, análogo a R-NEW)", () => {
    const e = evaluador({ perfil: SELVA }, []);
    expect(reglasDe(e, compra({ clasificada: false }))).toEqual(["R-NEW", "R-STD"]);
    expect(reglasDe(e, compra({ clasificada: true }))).toEqual([]);
  });

  it("filas ya en DNG, sin base gravada o en cero: no sugiere", () => {
    const e = evaluador({ perfil: SELVA });
    expect(reglasDe(e, compra())).toContain("R-STD");
    expect(reglasDe(e, conMontos({ biDng: "100.00", igvDng: "18.00", total: "118.00" }))).not.toContain("R-STD");
    expect(reglasDe(e, conMontos({ noGravado: "50.00", total: "50.00" }))).not.toContain("R-STD");
    expect(reglasDe(e, conMontos({}))).not.toContain("R-STD");
  });

  it("base en DGNG sola y en USD: sugiere; un solo hallazgo aunque la base esté en DG y DGNG", () => {
    const e = evaluador({ perfil: SELVA });
    expect(reglasDe(e, conMontos({ biDgng: "100.00", igvDgng: "18.00", total: "118.00" }))).toEqual(["R-STD"]);
    const usd = conMontos({ biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" }, { moneda: "USD" });
    expect(e(usd).filter((h) => h.regla === "R-STD")).toHaveLength(1);
    expect(stdDe(e, usd)?.lecturas).toEqual({ biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20" });
  });

  it("R-STD apagada en el estudio (RF-089): no se evalúa y las demás siguen", () => {
    const e = evaluador({ perfil: SELVA, reglasApagadas: ["R-STD"] }, []);
    expect(reglasDe(e, compra())).toEqual(["R-NEW"]);
  });

  it("convive con R-NEW, R-ISC y R-MIX en la misma compra (San Juan y la mixta 21.48 / 1.61)", () => {
    const e = evaluador({ perfil: SELVA }, []);
    expect(reglasDe(e, conMontos(SAN_JUAN))).toEqual(["R-ISC", "R-NEW", "R-STD"]);
    expect(reglasDe(e, conMontos(MIXTA))).toEqual(["R-MIX", "R-NEW", "R-STD"]);
  });

  it("D-9: el perfil rige al evaluar; la misma compra con otro perfil se evalúa con otro resultado y no se afectan entre sí", () => {
    const antes = evaluador({});
    const despues = evaluador({ perfil: SELVA });
    const c = compra();
    expect(reglasDe(antes, c)).toEqual([]);
    expect(reglasDe(despues, c)).toEqual(["R-STD"]);
    expect(reglasDe(antes, c)).toEqual([]);
  });

  it("el contexto se valida una sola vez al crear, también con perfil y proveedores con regla (T25c)", () => {
    validarContexto.mockClear();
    const e = evaluador({ perfil: SELVA, proveedoresConRegla: [OTRO] });
    expect(validarContexto).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) expect(reglasDe(e, compra({ numero: String(2000 + i) }))).toContain("R-STD");
    expect(validarContexto).toHaveBeenCalledTimes(1);
  });
});

describe("detallarHallazgo de R-STD guardado", () => {
  it("destino DNG, explicación «DNG por perfil del cliente», sin dato y aceptable en masa", () => {
    const h = stdDe(evaluador({ perfil: SELVA }), compra()) as HallazgoJson;
    expect(h).toBeDefined();
    const d = detallarHallazgo(h);
    expect(d.destino).toBe("DNG");
    expect(d.explicacion).toContain("DNG por perfil del cliente");
    expect(d.dato).toBeNull();
    expect(d.masiva).toBe(true);
  });
});

describe("aceptarSugerenciaGuardada de R-STD (CA-9: los mismos montos que clasificar a mano en DNG)", () => {
  const entradaDe = (c: CompraEvaluable, h: HallazgoJson | undefined, o: Partial<EntradaAceptar> = {}): EntradaAceptar => ({
    compra: c,
    hallazgo: h,
    proveedoresConocidos: [PROV],
    confirmar: true,
    dato: undefined,
    enMasa: false,
    ...o,
  });
  const guardado = (c: CompraEvaluable) => stdDe(evaluador({ perfil: SELVA }), c) as HallazgoJson;
  /** Lo que da clasificar a mano en DNG, como cadenas. */
  const aMano = (c: CompraEvaluable) => {
    const m = MontosComprobante.desde(c.moneda, c.montos);
    const r = cambiarDestino(m, "DNG").montos;
    return Object.fromEntries(Object.keys(CERO).map((k) => [k, k === "total" ? r.total.toString() : r.obtener(k as ColumnaCompra).toString()]));
  };

  it("una a una, sin pedir dato: deja la base en DNG y el total igual", () => {
    const c = compra();
    const r = aceptarSugerenciaGuardada(entradaDe(c, guardado(c)));
    expect(r).toMatchObject({ ok: true, excluir: false });
    if (r.ok) {
      expect(r.montos).toMatchObject({ biDg: "0.00", igvDg: "0.00", biDng: "100.00", igvDng: "18.00", total: "118.00" });
      expect(r.montos).toEqual(aMano(c));
    }
  });

  it("también sin confirmar (no la pide) y en masa", () => {
    const c = compra();
    for (const o of [{ confirmar: false }, { enMasa: true }, { confirmar: false, enMasa: true }]) {
      const r = aceptarSugerenciaGuardada(entradaDe(c, guardado(c), o));
      expect(r.ok && r.montos).toEqual(aMano(c));
    }
  });

  it("con DG y DGNG a la vez, en USD: los mismos montos que clasificar a mano", () => {
    const c = conMontos({ biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" }, { moneda: "USD" });
    const r = aceptarSugerenciaGuardada(entradaDe(c, guardado(c), { enMasa: true }));
    expect(r.ok && r.montos).toEqual(aMano(c));
    expect(r.ok && r.montos).toMatchObject({ biDng: "100.00", igvDng: "18.00", biDg: "0.00", biDgng: "0.00" });
  });

  it("la fila cambió desde que se evaluó (el contador la clasificó o editó): revisar_de_nuevo, también en masa", () => {
    const c = compra();
    const h = guardado(c);
    expect(h).toBeDefined();
    const clasificada = conMontos({ biDng: "100.00", igvDng: "18.00", total: "118.00" });
    const editada = conMontos({ biDg: "120.00", igvDg: "21.60", total: "141.60" });
    for (const actual of [clasificada, editada]) {
      for (const enMasa of [false, true]) {
        expect(aceptarSugerenciaGuardada(entradaDe(actual, h, { enMasa }))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
      }
    }
  });

  it("R-STD apagada en el estudio: lo guardado ya no se acepta (revisar_de_nuevo), sin borrar lo guardado", () => {
    const c = compra();
    const h = guardado(c);
    expect(aceptarSugerenciaGuardada(entradaDe(c, h, { reglasApagadas: ["R-STD"] }))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
    expect(aceptarSugerenciaGuardada(entradaDe(c, h, { reglasApagadas: ["R-NEW"] })).ok).toBe(true);
  });

  it("un R-STD guardado con otro tipo de sugerencia es ilegible: revisar_de_nuevo", () => {
    const c = compra();
    expect(guardado(c)).toBeDefined();
    const mala: HallazgoJson = { ...guardado(c), sugerencia: { tipo: "excluir", palabra: "x", categoria: "y" } };
    expect(aceptarSugerenciaGuardada(entradaDe(c, mala))).toEqual({ ok: false, rechazo: "revisar_de_nuevo" });
  });
});

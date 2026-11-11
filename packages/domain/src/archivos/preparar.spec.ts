// Spec 012b (T1, rojo): `prepararArchivo`, la única composición del previo (D1, D2, D12, P-6; CA-1, CA-5, CA-10, CA-15).
// Contrato que fija la prueba (T7):
//  - `prepararArchivo({ libro, cabecera, original, vigente, reglas?, saltos?, permitirProvisional })` →
//    `{ resultado, resumen, avisos, generable, motivo, canon }`. `libro` debe ser el de `cabecera.libro` (si no, lanza).
//  - `resultado` = `prevalidar`; `resumen` = `resumirCambios` del libro; `canon` = `canonHuella` con el formato del resultado.
//  - `generable` = `resultado.apto` y (formato oficial o `permitirProvisional`); `motivo` = «prevalidacion_fallida» si no es
//    apto, «formato_no_oficial» si es apto pero el formato no es oficial y no se permite lo provisional, `null` si generable.
//  - `avisos` = `{ codigo, filaId, explicacion }`: R-ISC/R-NEW/R-GP (compras, con `reglas`) y SALTO_CORRELATIVIDAD (ventas).
//    El salto dice «Falta B001-291» (un número) y desaparece si está justificado en `saltos`; las excluidas y las agregadas
//    cuentan como presentes. Los avisos nunca bloquean. Ventas con `reglas` lanza.
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, canonHuella, generarTxt, prepararArchivo, prevalidar, resumirCambios } from "../index";
import type { ArchivoPreparado, FilaReemplazo, FilaReemplazoVenta, Justificado } from "../index";
import {
  CABECERA,
  filaMixta,
  filaReemplazo,
  filaSanJuan,
  filaSimple,
  filasFixture,
  filasFixtureCorregidas,
  lineasCrlf,
  montosDe,
} from "../../tests/ayudas/filas-reemplazo";
import { ctxBase } from "../../tests/ayudas/filas";
import { CABECERA_VENTAS, comoExcluida, filaVenta, filasFixtureVentas, ventaNum } from "../../tests/ayudas/filas-venta";

const PROVEEDORES = ["20700000011", "20700000045", "20700000053", "20700000061", "20700000070"].map((numero) => ({ tipo: "6", numero }));
const reglas = () => ctxBase({ proveedoresConocidos: PROVEEDORES });

const compras = (original: FilaReemplazo[], vigente: FilaReemplazo[], over: { permitirProvisional?: boolean; conReglas?: boolean } = {}): ArchivoPreparado =>
  prepararArchivo({
    libro: "compras",
    cabecera: CABECERA,
    original,
    vigente,
    ...(over.conReglas === false ? {} : { reglas: reglas() }),
    permitirProvisional: over.permitirProvisional ?? true,
  });

const ventas = (
  original: FilaReemplazoVenta[],
  vigente: FilaReemplazoVenta[],
  over: { permitirProvisional?: boolean; saltos?: Justificado[] } = {},
): ArchivoPreparado =>
  prepararArchivo({
    libro: "ventas",
    cabecera: CABECERA_VENTAS,
    original,
    vigente,
    ...(over.saltos === undefined ? {} : { saltos: over.saltos }),
    permitirProvisional: over.permitirProvisional ?? true,
  });

const saltos = (p: ArchivoPreparado) => p.avisos.filter((a) => a.codigo === "SALTO_CORRELATIVIDAD");

describe("prepararArchivo · compras · CA-1 (HU-25): el periodo sin corregir", () => {
  const p = () => compras(filasFixture(), filasFixture());

  it("no es apto: F001-2056 trae el error de IGV «1.61 no es 18 % ni 10 % de 21.48» con su filaId, y no hay otro", () => {
    const { resultado } = p();
    expect(resultado.apto).toBe(false);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({ filaId: "F001-2056", codigo: "IGV", campo: "igvDg", destino: "DG" });
    expect(resultado.errores[0]?.explicacion).toContain("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("no se puede generar: motivo prevalidacion_fallida, aunque el entorno permita lo provisional", () => {
    expect(p()).toMatchObject({ generable: false, motivo: "prevalidacion_fallida" });
  });

  it("San Juan (F001-1040) trae el aviso R-ISC con su filaId", () => {
    const aviso = p().avisos.find((a) => a.codigo === "R-ISC");
    expect(aviso).toMatchObject({ filaId: "F001-1040", codigo: "R-ISC" });
    expect(typeof aviso?.explicacion).toBe("string");
  });

  it("San Juan solo: R-ISC avisa y NO bloquea (apto, generable)", () => {
    const sj = filaSanJuan();
    const r = compras([sj], [sj]);
    expect(r.resultado.apto).toBe(true);
    expect(r.generable).toBe(true);
    expect(r.motivo).toBeNull();
    expect(r.avisos.map((a) => a.codigo)).toEqual(["R-ISC"]);
  });

  it("cada aviso trae solo código, filaId y explicación", () => {
    for (const a of p().avisos) expect(Object.keys(a).sort()).toEqual(["codigo", "explicacion", "filaId"]);
  });

  it("sin `reglas` no hay avisos de reglas", () => {
    expect(compras(filasFixture(), filasFixture(), { conReglas: false }).avisos).toEqual([]);
  });
});

describe("prepararArchivo · compras · tras aplicar las sugerencias (CA-2) y la zapatilla excluida", () => {
  const original = () => filasFixture();
  const vigente = () => filasFixtureCorregidas().map((f) => (f.id === "F001-5070" ? { ...f, estado: "excluida" as const } : f));

  it("es apto y generable, con el resumen: 2 modificadas, 1 excluida (la zapatilla), 0 agregadas", () => {
    const p = compras(original(), vigente());
    expect(p.resultado.errores).toEqual([]);
    expect(p.resultado.apto).toBe(true);
    expect(p).toMatchObject({ generable: true, motivo: null });
    const r = p.resumen as { modificadas: number; excluidas: number; agregadas: number };
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([2, 1, 0]);
  });

  it("el TXT que sale de las mismas filas no trae la zapatilla y tiene una línea por fila no excluida", () => {
    const txt = generarTxt(vigente(), CABECERA, { permitirProvisional: true });
    expect(txt.lineas).toBe(4);
    const lineas = lineasCrlf(txt.bytes);
    expect(lineas).toHaveLength(4);
    expect(lineas.some((l) => l.includes("|F001|5070|"))).toBe(false);
    expect(lineas.some((l) => l.includes("|F001|2056|"))).toBe(true);
  });

  it("CA-5: N modificadas, M excluidas, K agregadas e impacto en IGV por destino y total, exacto", () => {
    // Original: IGV DG 0.00 (San Juan) + 1.61 + 18.00 + 0.10 (USD) + 27.00 (zapatilla). Vigente: 0.00 + 1.61 + 18.00 + 0.10, la
    // zapatilla excluida (-27.00), una agregada con BI DG 100.00 / IGV DG 18.00 (+18.00) y otra con BI DGNG 25.00 / IGV DGNG 4.50.
    const a1 = filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, { id: "nueva-1", estado: "agregada", comprobante: { tipo: "01", serie: "F001", numero: "9990" } });
    const a2 = filaReemplazo({ biDgng: "25.00", igvDgng: "4.50" }, { id: "nueva-2", estado: "agregada", comprobante: { tipo: "01", serie: "F001", numero: "9991" } });
    const p = compras(original(), [...vigente(), a1, a2]);
    const r = p.resumen as {
      modificadas: number;
      excluidas: number;
      agregadas: number;
      impactoIgv: { DG: { toString(): string }; DGNG: { toString(): string }; DNG: { toString(): string }; total: { toString(): string } };
    };
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([2, 1, 2]);
    expect(r.impactoIgv.DG.toString()).toBe("-9.00");
    expect(r.impactoIgv.DGNG.toString()).toBe("4.50");
    expect(r.impactoIgv.DNG.toString()).toBe("0.00");
    expect(r.impactoIgv.total.toString()).toBe("-4.50");
  });

  it("el resumen es el de resumirCambios y el resultado, el de prevalidar (misma verdad)", () => {
    const o = original();
    const v = vigente();
    const p = compras(o, v);
    expect(p.resumen).toEqual(resumirCambios(o, v));
    expect(p.resultado.apto).toBe(prevalidar(v, { cabecera: CABECERA, reglas: reglas() }).apto);
    expect(p.resultado.formato).toEqual({ id: "RCE-REEMPLAZO", version: "0-provisional", oficial: false });
  });

  it("canon = canonHuella con el formato del resultado", () => {
    const o = original();
    const v = vigente();
    const p = compras(o, v);
    expect(p.canon).toBe(canonHuella({ cabecera: CABECERA, formato: p.resultado.formato, original: o, vigente: v }));
    expect(p.canon).toMatch(/^h1/);
  });

  it("el canon no cambia con los avisos: con y sin `reglas` es el mismo", () => {
    const con = compras(original(), vigente());
    const sin = compras(original(), vigente(), { conReglas: false });
    expect(sin.canon).toBe(con.canon);
  });

  it("la mixta corregida a 8.97 + 12.51 con IGV 1.61 pasa; sin corregir, la misma fila mixta bloquea", () => {
    const corregida = filaMixta({ estado: "modificada", montos: montosDe("PEN", { biDg: "8.97", igvDg: "1.61", noGravado: "12.51" }) });
    expect(compras([filaMixta()], [corregida]).resultado.apto).toBe(true);
    expect(compras([filaMixta()], [filaMixta()]).resultado.apto).toBe(false);
  });

  it("todas las filas excluidas: SIN_FILAS, no generable", () => {
    const s = filaSimple();
    const p = compras([s], [{ ...s, estado: "excluida" }]);
    expect(p.resultado.errores.map((e) => e.codigo)).toEqual(["SIN_FILAS"]);
    expect(p).toMatchObject({ generable: false, motivo: "prevalidacion_fallida" });
  });
});

describe("prepararArchivo · D2: formato provisional en producción", () => {
  const sj = () => filaSanJuan();

  it("fuera de producción un periodo apto es generable", () => {
    expect(compras([sj()], [sj()], { permitirProvisional: true })).toMatchObject({ generable: true, motivo: null });
  });

  it("en producción (permitirProvisional = false) con solo formatos no oficiales: el previo funciona pero generable = false, motivo formato_no_oficial", () => {
    const p = compras([sj()], [sj()], { permitirProvisional: false });
    expect(p.resultado.apto).toBe(true);
    expect(p.resultado.errores).toEqual([]);
    expect(p).toMatchObject({ generable: false, motivo: "formato_no_oficial" });
    expect(p.avisos.map((a) => a.codigo)).toEqual(["R-ISC"]);
    expect(p.canon).toMatch(/^h1/);
  });

  it("lo mismo en ventas", () => {
    const v = filaVenta();
    expect(ventas([v], [v], { permitirProvisional: false })).toMatchObject({ generable: false, motivo: "formato_no_oficial" });
    expect(ventas([v], [v], { permitirProvisional: true })).toMatchObject({ generable: true, motivo: null });
  });

  it("el permiso de lo provisional no vuelve generable un periodo con errores", () => {
    const mala = filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    expect(ventas([mala], [mala], { permitirProvisional: true })).toMatchObject({ generable: false, motivo: "prevalidacion_fallida" });
  });
});

describe("prepararArchivo · ventas · CA-10", () => {
  it("una venta cuadrada es apta y generable, con su resumen sin cambios y el formato RVIE provisional", () => {
    const v = filaVenta();
    const p = ventas([v], [v]);
    expect(p.resultado.apto).toBe(true);
    expect(p.resultado.formato).toEqual({ id: "RVIE-REEMPLAZO", version: "0-provisional", oficial: false });
    expect(p).toMatchObject({ generable: true, motivo: null, avisos: [] });
    expect(p.resumen).toMatchObject({ modificadas: 0, excluidas: 0, agregadas: 0 });
    expect(p.canon).toBe(canonHuella({ cabecera: CABECERA_VENTAS, formato: p.resultado.formato, original: [v], vigente: [v] }));
  });

  it("una venta descuadrada bloquea con CUADRE y su filaId", () => {
    const mala = filaVenta({ id: "v-desc", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    const p = ventas([mala], [mala]);
    expect(p.resultado.apto).toBe(false);
    expect(p.resultado.errores.map((e) => [e.filaId, e.codigo])).toEqual([["v-desc", "CUADRE"]]);
    expect(p).toMatchObject({ generable: false, motivo: "prevalidacion_fallida" });
  });

  it("boleta 291: B001-290 y B001-292 es apto con el aviso «Falta B001-291» y genera el RVIE provisional", () => {
    const filas = [ventaNum("03", "B001", "290"), ventaNum("03", "B001", "292")];
    const p = ventas(filas, filas);
    expect(p.resultado.apto).toBe(true);
    expect(p).toMatchObject({ generable: true, motivo: null });
    expect(saltos(p)).toHaveLength(1);
    expect(saltos(p)[0]?.explicacion).toContain("Falta B001-291");
    const txt = generarTxt(filas, CABECERA_VENTAS, { permitirProvisional: true });
    expect(txt.lineas).toBe(2);
    expect(txt.provisional).toBe(true);
  });

  it("justificada la 291 en `saltos`, el aviso desaparece", () => {
    const filas = [ventaNum("03", "B001", "290"), ventaNum("03", "B001", "292")];
    expect(saltos(ventas(filas, filas))).toHaveLength(1);
    const j: Justificado = { tipo: "03", serie: "B001", desde: 291, hasta: 291, comentario: "Boleta anulada en caja" };
    const p = ventas(filas, filas, { saltos: [j] });
    expect(saltos(p)).toEqual([]);
    expect(p.avisos).toEqual([]);
    expect(p.generable).toBe(true);
  });

  it("una justificación de otra serie o de otro número no quita el aviso", () => {
    const filas = [ventaNum("03", "B001", "290"), ventaNum("03", "B001", "292")];
    expect(saltos(ventas(filas, filas))).toHaveLength(1);
    const otra: Justificado = { tipo: "03", serie: "B002", desde: 291, hasta: 291, comentario: "x" };
    const otroNumero: Justificado = { tipo: "03", serie: "B001", desde: 300, hasta: 300, comentario: "x" };
    expect(saltos(ventas(filas, filas, { saltos: [otra, otroNumero] }))).toHaveLength(1);
  });

  it("la 291 agregada a mano, o presente como excluida, cuenta como presente: no hay aviso", () => {
    const base = [ventaNum("03", "B001", "290"), ventaNum("03", "B001", "292")];
    expect(saltos(ventas(base, base))).toHaveLength(1);
    const agregada = ventaNum("03", "B001", "291", { estado: "agregada" });
    expect(saltos(ventas(base, [...base, agregada]))).toEqual([]);
    const excluible = ventaNum("03", "B001", "291", { montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    const original = [base[0]!, excluible, base[1]!];
    expect(ventas(original, original).resultado.apto).toBe(false);
    const conExcluida = ventas(original, [base[0]!, comoExcluida(excluible), base[1]!]);
    expect(saltos(conExcluida)).toEqual([]);
    expect(conExcluida.resultado.apto).toBe(true);
  });

  it("el fixture de ventas con la USD sin tipo de cambio excluida: apto, con los saltos de B001 (291) y B003 (402 a 404), sin bloquear", () => {
    const todas = filasFixtureVentas();
    const vigente = todas.map((f) => (f.id === "01-F002-2" ? comoExcluida(f) : f));
    const p = ventas(todas, vigente);
    expect(p.resultado.errores).toEqual([]);
    expect(p).toMatchObject({ generable: true, motivo: null });
    const avisos = saltos(p);
    expect(avisos).toHaveLength(2);
    expect(avisos.some((a) => a.explicacion.includes("B001-291"))).toBe(true);
    expect(avisos.some((a) => a.explicacion.includes("B003-402") && a.explicacion.includes("B003-404"))).toBe(true);
    expect(p.resumen).toMatchObject({ excluidas: 1, agregadas: 0, modificadas: 0, filasSinConvertir: ["01-F002-2"] });
  });

  it("con la USD sin tipo de cambio sin excluir, el previo bloquea con USD_SIN_TC", () => {
    const todas = filasFixtureVentas();
    const p = ventas(todas, todas);
    expect(p.resultado.errores.map((e) => [e.filaId, e.codigo])).toEqual([["01-F002-2", "USD_SIN_TC"]]);
    expect(p.generable).toBe(false);
  });
});

describe("prepararArchivo · ventas · CA-15: excluir y restaurar", () => {
  const ok = ventaNum("03", "B001", "1");
  const desc = ventaNum("03", "B001", "2", { id: "v-desc", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
  const usd = ventaNum("01", "F002", "2", { id: "v-usd", moneda: "USD", montos: { baseGravada: "100.00", igv: "18.00" } });
  const original = [ok, desc, usd];

  it("con las dos excluidas: sin errores, apto, excluidas = 2, impacto = −18.00 (la descuadrada) y la USD en filasSinConvertir", () => {
    const p = ventas(original, [ok, comoExcluida(desc), comoExcluida(usd)]);
    expect(p.resultado.errores).toEqual([]);
    expect(p.resultado.apto).toBe(true);
    expect(p).toMatchObject({ generable: true, motivo: null });
    const r = p.resumen as { excluidas: number; impactoIgv: { total: { toString(): string } }; filasSinConvertir: readonly string[] };
    expect(r.excluidas).toBe(2);
    expect(r.impactoIgv.total.toString()).toBe("-18.00");
    expect(r.filasSinConvertir).toEqual(["v-usd"]);
  });

  it("el TXT de las mismas filas no tiene las líneas de las excluidas", () => {
    const txt = generarTxt([ok, comoExcluida(desc), comoExcluida(usd)], CABECERA_VENTAS, { permitirProvisional: true });
    expect(txt.lineas).toBe(1);
    expect(lineasCrlf(txt.bytes)).toHaveLength(1);
  });

  it("restaurar la descuadrada la devuelve: el previo vuelve a dar su CUADRE y bloquea, y el canon vuelve al de antes de excluirla", () => {
    const excluida = ventas(original, [ok, comoExcluida(desc), comoExcluida(usd)]);
    const restaurada = ventas(original, [ok, desc, comoExcluida(usd)]);
    expect(restaurada.resultado.errores.map((e) => [e.filaId, e.codigo])).toEqual([["v-desc", "CUADRE"]]);
    expect(restaurada).toMatchObject({ generable: false, motivo: "prevalidacion_fallida" });
    expect(restaurada.canon).not.toBe(excluida.canon);
    const ningunaExcluida = ventas(original, original);
    const vuelta = ventas(original, [ok, desc, usd]);
    expect(vuelta.canon).toBe(ningunaExcluida.canon);
  });

  it("excluir o restaurar cambia el canon (P-2: 409 resumen_cambiado)", () => {
    const antes = ventas(original, original).canon;
    const despues = ventas(original, [ok, comoExcluida(desc), usd]).canon;
    expect(despues).not.toBe(antes);
  });

  it("todas excluidas: SIN_FILAS", () => {
    const p = ventas([ok], [comoExcluida(ok)]);
    expect(p.resultado.errores.map((e) => e.codigo)).toEqual(["SIN_FILAS"]);
    expect(p.generable).toBe(false);
  });
});

describe("prepararArchivo · entrada imposible lanza", () => {
  it("ventas con `reglas` lanza (con la misma llamada sin ellas funciona)", () => {
    const v = filaVenta();
    expect(ventas([v], [v]).resultado.apto).toBe(true);
    expect(() =>
      prepararArchivo({ libro: "ventas", cabecera: CABECERA_VENTAS, original: [v], vigente: [v], reglas: reglas(), permitirProvisional: true } as never),
    ).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("el libro y la cabecera deben coincidir; y las filas, ser del libro", () => {
    const v = filaVenta();
    const c = filaSanJuan();
    expect(ventas([v], [v]).resultado.apto).toBe(true);
    expect(() =>
      prepararArchivo({ libro: "compras", cabecera: CABECERA_VENTAS, original: [c], vigente: [c], permitirProvisional: true } as never),
    ).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() =>
      prepararArchivo({ libro: "ventas", cabecera: CABECERA, original: [v], vigente: [v], permitirProvisional: true } as never),
    ).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() =>
      prepararArchivo({ libro: "ventas", cabecera: CABECERA_VENTAS, original: [c], vigente: [c], permitirProvisional: true } as never),
    ).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("una vigente sin una fila de la original (forma imposible) lanza, en compras y en ventas", () => {
    const o = [filaSanJuan(), filaSimple()];
    expect(compras(o, o).resultado.apto).toBe(true);
    expect(() => compras(o, [filaSanJuan()])).toThrow(EntradaPrevalidacionInvalidaError);
    const vo = [ventaNum("03", "B001", "1"), ventaNum("03", "B001", "2")];
    expect(ventas(vo, vo).resultado.apto).toBe(true);
    expect(() => ventas(vo, [vo[0]!])).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("no muta ni congela lo recibido", () => {
    const v = filaVenta();
    const filas = [v];
    const copia = JSON.stringify(filas);
    ventas(filas, filas);
    expect(JSON.stringify(filas)).toBe(copia);
    expect(Object.isFrozen(v)).toBe(false);
  });
});

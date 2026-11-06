// Spec 012 · T15b · Ronda adversarial 2b (caja blanca) contra las rutas nuevas de T14 y T14a:
// evaluación fila a fila cuando falla el lote de reglas (coste y resultados), relecturas del
// contexto de reglas, R-ISC con `xml.isc − isc` fuera de rango, validación de los campos no
// textuales y del periodo, `valorDeCampo` al registrar, `impactoEnRango` y la clave de duplicados
// con caracteres no ASCII. Las pruebas que fallan son H-012-60 y H-012-61, más H-012-40 de T15a (ver
// tasks.md, T15b); las que pasan quedan como regresión. Solo API pública.
import { describe, expect, it } from "vitest";
import {
  DefinicionFormatoInvalidaError,
  EntradaReglasInvalidaError,
  MontosComprobante,
  RegistroFormatos,
  prevalidar,
  resumirCambios,
  seleccionarFormato,
} from "../index";
import type { CampoTxt, ContextoReglas, FilaReemplazo, FormatoTxt, ResultadoPrevalidacion } from "../index";
import {
  CABECERA,
  ctxBase,
  filaReemplazo,
  filasFixture,
  montosDe,
  xmlDe,
} from "../../tests/ayudas/filas-reemplazo";

type Contexto = Parameters<typeof prevalidar>[1];
const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}): ResultadoPrevalidacion =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Contexto);

const PROVISIONAL = seleccionarFormato("compras", "202610");

/** Copia plana de los campos del provisional (el patrón de la copia registrada es un getter). */
function camposProvisional(): CampoTxt[] {
  return PROVISIONAL.campos.map((c) => {
    const base = { nombre: c.nombre, obligatorio: c.obligatorio, longitudMax: c.longitudMax, tipo: c.tipo };
    const patron = c.patron;
    return patron === undefined ? base : { ...base, patron };
  });
}

/** Campos del provisional con `cambio` aplicado al campo `nombre` (sin su patrón si `sinPatron`). */
function camposCon(nombre: string, cambio: Partial<CampoTxt>, sinPatron = false): CampoTxt[] {
  return camposProvisional().map((c) => {
    if (c.nombre !== nombre) return c;
    const { patron, ...resto } = c as CampoTxt & { patron?: RegExp };
    const base = sinPatron || patron === undefined ? resto : { ...resto, patron };
    return { ...base, ...cambio } as CampoTxt;
  });
}

function registroCon(campos: CampoTxt[], over: Partial<FormatoTxt> = {}): RegistroFormatos {
  return RegistroFormatos.desde([{ ...PROVISIONAL, version: "adv-2b", oficial: true, campos, ...over }]);
}

/** Serie sin patrón: más laxa que la gramática de 011, así que «F-01» hace lanzar al lote (H-012-21). */
const REGISTRO_LAXO = (): RegistroFormatos => registroCon(camposCon("serie", {}, true));

/** Fila que pasa la estructura del registro laxo pero que 011 rechaza (serie F-01). */
const veneno = (id: string, over: Partial<FilaReemplazo> = {}): FilaReemplazo =>
  filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F-01", numero: "999" }, ...over });

const sinVeneno = <T extends { filaId: string | null }>(xs: readonly T[], id: string) => xs.filter((x) => x.filaId !== id);

// ---------------------------------------------------------------- lote que falla → fila a fila
describe("ronda 2b · evaluación fila a fila cuando falla el lote de reglas (D19)", () => {
  it("H-012-60 · el contexto de reglas se valida una vez por fila: el coste crece con filas × proveedores conocidos", () => {
    // 012b prevalida en línea (422). Con el lote roto por una sola fila, cada fila vuelve a validar
    // todo el historial de proveedores: (N + 3) pasadas sobre el contexto en vez de un número fijo.
    const M = 200;
    const N = 50;
    let lecturas = 0;
    const conocidos = Array.from({ length: M }, (_, i) => ({
      get tipo() {
        lecturas++;
        return "6";
      },
      numero: `2010007${String(i).padStart(4, "0")}`,
    }));
    const reglas: ContextoReglas = { ...ctxBase(), proveedoresConocidos: conocidos };
    const filas = Array.from({ length: N }, (_, i) =>
      filaReemplazo(undefined, { id: `f${i}`, comprobante: { tipo: "01", serie: "F001", numero: String(i + 1) } }),
    );
    const registro = REGISTRO_LAXO();

    lecturas = 0;
    prev(filas, { registro, reglas });
    const conLoteSano = lecturas;
    lecturas = 0;
    prev([...filas, veneno("zz")], { registro, reglas });
    const conLoteRoto = lecturas;

    expect(conLoteSano).toBeLessThanOrEqual(3 * M);
    // Esperado: un número fijo de pasadas, independiente de N. Obtenido: (N + 3) × M.
    expect(conLoteRoto).toBeLessThanOrEqual(3 * M);
  });

  it("H-012-40 (T15a, confirmado en caja blanca) · un contexto que solo es válido en la primera lectura ya no lanza: los avisos desaparecen en silencio", () => {
    // Antes de T14 el contexto se leía una vez (evaluarReglas). Ahora se lee 2 + N veces y el catch
    // genérico traga el EntradaReglasInvalidaError de la segunda lectura: San Juan pierde su R-ISC.
    const sanJuan = filaReemplazo({ biDg: "770.00" }, { id: "sanjuan" });
    const base = ctxBase();
    const esperado = prev([sanJuan], { reglas: base });
    expect(esperado.avisos.map((a) => a.codigo)).toEqual(["R-ISC"]);

    let lecturas = 0;
    const reglas = {
      proveedoresConocidos: base.proveedoresConocidos,
      proveedoresIsc: base.proveedoresIsc,
      get diccionario() {
        lecturas++;
        return lecturas === 1 ? base.diccionario : {};
      },
    } as ContextoReglas;

    let lanzo: unknown = null;
    let r: ResultadoPrevalidacion | null = null;
    try {
      r = prev([sanJuan], { reglas });
    } catch (e) {
      lanzo = e;
    }
    // Esperado: o lanza EntradaReglasInvalidaError (D19: contexto malformado) o da los mismos avisos.
    if (lanzo !== null) expect(lanzo).toBeInstanceOf(EntradaReglasInvalidaError);
    else expect(r?.avisos).toEqual(esperado.avisos);
  });

  it("la fila que rompe el lote no cambia los errores, sugerencias ni avisos de las demás (esté primera o última)", () => {
    const registro = REGISTRO_LAXO();
    const reglas = ctxBase();
    const filas = filasFixture();
    const base = prev(filas, { registro, reglas });
    expect(base.avisos.length).toBeGreaterThan(0);
    for (const id of ["00-veneno", "zz-veneno"]) {
      const con = prev([veneno(id), ...filas], { registro, reglas });
      expect(sinVeneno(con.errores, id)).toEqual(base.errores);
      expect(sinVeneno(con.avisos, id)).toEqual(base.avisos);
      expect(con.avisos.filter((a) => a.filaId === id)).toEqual([]);
    }
  });

  it("la fila que rompe el lote conserva sus errores (sin sugerencia) y con o sin reglas salen los mismos errores", () => {
    const registro = REGISTRO_LAXO();
    const mala = veneno("v", { montos: montosDe("PEN", { biDg: "21.48", igvDg: "1.61", noGravado: "5.00" }) });
    const sana = filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id: "w" });
    const sin = prev([mala, sana], { registro });
    const con = prev([mala, sana], { registro, reglas: ctxBase() });
    const quitar = (r: ResultadoPrevalidacion) => r.errores.map((e) => ({ ...e, sugerencia: null }));
    expect(quitar(con)).toEqual(quitar(sin));
    const igvMala = con.errores.find((e) => e.filaId === "v" && e.codigo === "IGV");
    const igvSana = con.errores.find((e) => e.filaId === "w" && e.codigo === "IGV");
    expect(igvMala?.sugerencia).toBeNull();
    expect(igvSana?.sugerencia).toMatchObject({ regla: "R-MIX", filaId: "w" });
  });

  it("`reglas: undefined` propio equivale a «sin reglas» y no lanza; `reglas: null` sigue lanzando", () => {
    const f = filaReemplazo({ biDg: "770.00" });
    expect(prev([f], { reglas: undefined }).avisos).toEqual([]);
    expect(() => prev([f], { reglas: null })).toThrow();
  });
});

// ---------------------------------------------------------------- R-ISC de 011 (D19)
describe("ronda 2b · R-ISC con xml.isc − isc fuera de NUMERIC(14,2), por prevalidar", () => {
  it("con el signo contrario al de T14 (isc positivo, xml.isc negativo) no lanza y avisa sin sugerencia, en los dos caminos", () => {
    const xml = xmlDe({ gravado: "100.00", isc: "-999999999999.99", total: "100.00" });
    // Camino IGV 0.00 (D-1) y camino proveedor marcado con IGV que cuadra (D-2).
    const igvCero = filaReemplazo(undefined, {
      id: "a",
      montos: MontosComprobante.desde("PEN", { biDg: "100.00", isc: "999999999800.00", total: "999999999900.00" }),
      xml,
    });
    const marcado = filaReemplazo(undefined, {
      id: "b",
      comprobante: { tipo: "01", serie: "F001", numero: "124" },
      montos: MontosComprobante.desde("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        isc: "999999999800.00",
        total: "999999999918.00",
      }),
      xml: { ...xml, comprobante: { tipo: "01", serie: "F001", numero: "124" } },
    });
    const reglas = ctxBase({ proveedoresIsc: [{ tipo: "6", numero: "20100070970" }] });
    let r: ResultadoPrevalidacion | null = null;
    expect(() => {
      r = prev([igvCero, marcado], { reglas });
    }).not.toThrow();
    const res = r as unknown as ResultadoPrevalidacion;
    expect(res.errores).toEqual([]);
    const isc = res.avisos.filter((a) => a.codigo === "R-ISC");
    expect(isc.map((a) => a.filaId)).toEqual(["a", "b"]);
    for (const a of isc) expect(a.hallazgo.sugerencia).toBeNull();
  });
});

// ---------------------------------------------------------------- campos no textuales y periodo
describe("ronda 2b · validación de todos los campos con el valor serializado (H-012-23)", () => {
  it("una fecha o un TC inválidos solo dan su propio error, aunque el formato sea más estricto en ese campo", () => {
    const registroTc = registroCon(camposCon("tipoCambio", { longitudMax: 1, patron: /^X$/ }));
    const registroFecha = registroCon(camposCon("fechaEmision", { longitudMax: 1, patron: /^X$/ }));
    const usdMalo = filaReemplazo(undefined, { id: "u", moneda: "USD", tipoCambio: "abc" });
    const usdNulo = filaReemplazo(undefined, { id: "n", moneda: "USD", tipoCambio: null, comprobante: { tipo: "01", serie: "F001", numero: "2" } });
    const penConTc = filaReemplazo(undefined, { id: "p", tipoCambio: "3.5", comprobante: { tipo: "01", serie: "F001", numero: "3" } });
    const fechaMala = filaReemplazo(undefined, { id: "x", fechaEmision: "2026-02-30" });
    const r = prev([usdMalo, usdNulo, penConTc], { registro: registroTc });
    const de = (id: string) => r.errores.filter((e) => e.filaId === id).map((e) => `${e.codigo}:${e.campo}`);
    expect(de("u")).toEqual(["TC_INVALIDO:tipoCambio"]);
    expect(de("n")).toEqual(["USD_SIN_TC:tipoCambio"]);
    expect(de("p")).toEqual(["TC_INVALIDO:tipoCambio"]);
    expect(prev([fechaMala], { registro: registroFecha }).errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual([
      "x:FECHA_INVALIDA:fechaEmision",
    ]);
  });

  it("el TC válido se valida como se escribe (`3.5` → `3.500`): con longitudMax 4 es LONGITUD", () => {
    const registro = registroCon(camposCon("tipoCambio", { longitudMax: 4 }));
    const f = filaReemplazo(undefined, { moneda: "USD", tipoCambio: "3.5" });
    expect(prev([f], { registro }).errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual([
      "f1:LONGITUD:tipoCambio",
    ]);
    expect(prev([filaReemplazo(undefined, { moneda: "USD", tipoCambio: "3.50" })], { registro: registroCon(camposCon("tipoCambio", { longitudMax: 5 })) }).apto).toBe(true);
  });

  it("un periodo que no cumple el formato da un solo error con filaId null, sea cual sea el número de filas, y no quita los avisos", () => {
    const registro = registroCon(camposCon("periodo", { longitudMax: 4 }));
    const filas = [filaReemplazo({ biDg: "770.00" }, { id: "a" }), ...[1, 2, 3].map((i) => filaReemplazo(undefined, { id: `b${i}`, comprobante: { tipo: "01", serie: "F001", numero: String(i) } }))];
    const r = prev(filas, { registro, reglas: ctxBase() });
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`)).toEqual(["null:LONGITUD:periodo"]);
    expect(r.avisos.map((a) => `${a.filaId}:${a.codigo}`)).toEqual(["a:R-ISC"]);
  });
});

// ---------------------------------------------------------------- valorDeCampo al registrar (D21)
describe("ronda 2b · campos conocidos pero incoherentes con el valor que se escribe", () => {
  /** O el registro rechaza la definición, o una fila correcta sale apta. */
  function rechazaOApta(campos: CampoTxt[], filas: FilaReemplazo[]): void {
    let registro: RegistroFormatos;
    try {
      registro = registroCon(campos);
    } catch (e) {
      expect(e).toBeInstanceOf(DefinicionFormatoInvalidaError);
      return;
    }
    const aptas = filas.map((f) => prev([f], { registro }));
    expect(aptas.map((r) => r.errores.map((e) => `${e.codigo}:${e.campo}`))).toContainEqual([]);
  }

  it("H-012-61 · un monto declarado `tipo: \"ruc\"` se registra y bloquea toda fila con RUC_INVALIDO en `total`", () => {
    // Antes de T14 los montos no pasaban por validarCampo; ahora el tipo de un campo conocido decide
    // y RegistroFormatos.desde no comprueba que sea coherente con su valor.
    rechazaOApta(camposCon("total", { tipo: "ruc" }), [filaReemplazo()]);
  });

  it("H-012-61 · `tipoCambio` obligatorio se registra y una fila PEN nunca sale apta (vacío → obligatorio; con TC → TC_INVALIDO)", () => {
    rechazaOApta(camposCon("tipoCambio", { obligatorio: true }), [
      filaReemplazo(),
      filaReemplazo(undefined, { tipoCambio: "1.000" }),
    ]);
  });
});

// ---------------------------------------------------------------- impactoEnRango (D22)
describe("ronda 2b · impactoEnRango", () => {
  const X = "999999999999.99";
  it("una suma parcial que desborda pero cuyo resultado cabe no lanza (solo se comprueba el resultado)", () => {
    const grande = (id: string, estado: FilaReemplazo["estado"]) =>
      filaReemplazo(undefined, { id, estado, comprobante: { tipo: "01", serie: "F001", numero: id.length.toString() }, montos: MontosComprobante.desde("PEN", { igvDg: X, total: X }) });
    const o = grande("o", "original");
    const nueva = { ...grande("nn", "agregada") };
    // Σ = X (o vigente) + X (agregada) − X (o original): la parcial 2X desborda; el resultado es X.
    const r = resumirCambios([o], [o, nueva]);
    expect(r.impactoIgv.DG.toString()).toBe(X);
    expect(r.impactoIgv.total.toString()).toBe(X);
  });

  it("destinos en el borde con signos opuestos: cada uno cabe y el total 0.00 no lanza", () => {
    const o = filaReemplazo(undefined, { id: "o", montos: MontosComprobante.desde("PEN", { total: "0.00" }) });
    const nueva = filaReemplazo(undefined, {
      id: "n",
      estado: "agregada",
      comprobante: { tipo: "01", serie: "F001", numero: "9" },
      montos: MontosComprobante.desde("PEN", { igvDg: X, igvDgng: `-${X}`, total: "0.00" }),
    });
    const r = resumirCambios([o], [o, nueva]);
    expect([r.impactoIgv.DG, r.impactoIgv.DGNG, r.impactoIgv.total].map((m) => m.toString())).toEqual([X, `-${X}`, "0.00"]);
  });
});

// ---------------------------------------------------------------- clave de duplicados (D20)
describe("ronda 2b · clave de duplicados en mayúsculas ASCII", () => {
  it("con un formato sin patrón en el documento: `ab-12`/`AB-12` es DUPLICADO; `ñ12`/`Ñ12`, `ÿ1`/`Ÿ1` y `ß1`/`SS1` no se pliegan", () => {
    const registro = registroCon(camposCon("numeroDocProveedor", {}, true));
    const par = (a: string, b: string, n: string): FilaReemplazo[] => [
      filaReemplazo(undefined, { id: `${n}a`, comprobante: { tipo: "01", serie: "F001", numero: n }, proveedor: { tipo: "7", numero: a } }),
      filaReemplazo(undefined, { id: `${n}b`, comprobante: { tipo: "01", serie: "F001", numero: n }, proveedor: { tipo: "7", numero: b } }),
    ];
    const filas = [...par("ab-12", "AB-12", "1"), ...par("ñ12", "Ñ12", "2"), ...par("ß1", "SS1", "3")];
    const r = prev(filas, { registro });
    expect(r.errores.filter((e) => e.codigo === "DUPLICADO").map((e) => e.filaId)).toEqual(["1a", "1b"]);
    // `Ÿ` (U+0178) no está en latin1: CARACTER_NO_PERMITIDO y tampoco se pliega con `ÿ`.
    const r2 = prev(par("ÿ1", "Ÿ1", "4"), { registro });
    expect(r2.errores.map((e) => `${e.filaId}:${e.codigo}`)).toEqual(["4b:CARACTER_NO_PERMITIDO"]);
  });

  it("21 copias nombran 20 sin «más»; 22 copias nombran 20 y «y 1 más» en todas", () => {
    const copias = (n: number) =>
      Array.from({ length: n }, (_, i) => filaReemplazo(undefined, { id: `c${String(i).padStart(2, "0")}` }));
    const e21 = prev(copias(21)).errores.filter((e) => e.codigo === "DUPLICADO");
    expect(e21).toHaveLength(21);
    for (const e of e21) {
      expect(e.explicacion).not.toContain("más");
      expect(e.explicacion.split(", ")).toHaveLength(20);
      expect(e.explicacion).not.toContain(e.filaId as string);
    }
    const e22 = prev(copias(22)).errores.filter((e) => e.codigo === "DUPLICADO");
    for (const e of e22) {
      expect(e.explicacion.endsWith(" y 1 más")).toBe(true);
      expect(e.explicacion.replace(" y 1 más", "").split(", ")).toHaveLength(20);
      expect(e.explicacion).not.toContain(`${e.filaId as string},`);
    }
  });
});

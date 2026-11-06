// Spec 012 · T16: rutas nuevas tras la ronda adversarial 2 (H-012-40, H-012-41, H-012-60 y H-012-61).
// Las variantes adversariales están en ronda2a y ronda2b; aquí, el caso feliz y el de error de cada
// comportamiento. Solo API pública.
import { describe, expect, it } from "vitest";
import { DefinicionFormatoInvalidaError, EntradaReglasInvalidaError, RegistroFormatos, prevalidar, seleccionarFormato } from "../index";
import type { CampoTxt, ContextoReglas, FilaReemplazo, TipoCampo } from "../index";
import { CABECERA, ctxBase, filaReemplazo, filaSanJuan } from "../../tests/ayudas/filas-reemplazo";

type Contexto = Parameters<typeof prevalidar>[1];
const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}) =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Contexto);

const PROVISIONAL = seleccionarFormato("compras", "202610");
/** Campos del provisional con `cambio` en `nombre`; `sinPatron` quita su patrón. */
function camposCon(nombre: string, cambio: Partial<CampoTxt>, sinPatron = false): CampoTxt[] {
  return PROVISIONAL.campos.map((c) => {
    const base = { nombre: c.nombre, obligatorio: c.obligatorio, longitudMax: c.longitudMax, tipo: c.tipo };
    const patron = c.patron;
    const plano = patron === undefined || (sinPatron && c.nombre === nombre) ? base : { ...base, patron };
    return c.nombre === nombre ? { ...plano, ...cambio } : plano;
  });
}
const registroCon = (campos: readonly CampoTxt[]) =>
  RegistroFormatos.desde([{ ...PROVISIONAL, version: "t16", oficial: true, campos }]);

/** Contexto cuyo `proveedoresIsc` cuenta sus lecturas. */
function contextoContado(isc: ContextoReglas["proveedoresIsc"]): { reglas: ContextoReglas; lecturas: () => string } {
  let n = "";
  const reglas = {
    ...ctxBase(),
    get proveedoresIsc() {
      n += "x";
      return isc;
    },
  } as ContextoReglas;
  return { reglas, lecturas: () => n };
}

describe("H-012-40 y H-012-60 · el contexto de reglas se valida una vez y cada fila se evalúa sobre esa copia", () => {
  it("con el lote roto por una fila, el contexto se lee una sola vez y las demás filas conservan sus avisos en orden de id", () => {
    const registro = registroCon(camposCon("serie", {}, true));
    const { reglas, lecturas } = contextoContado([]);
    const sanJuanB = filaSanJuan({ id: "b", comprobante: { tipo: "01", serie: "F001", numero: "2" } });
    // Dos destinos con IGV 0.00 en la misma fila: R-ISC en DG, luego en DGNG y después R-NEW, como evaluarReglas.
    const dos = filaReemplazo({ biDg: "100.00", biDgng: "50.00" }, { id: "a", proveedor: { tipo: "6", numero: "20700000011" } });
    const veneno = filaReemplazo(undefined, { id: "c", comprobante: { tipo: "01", serie: "F-01", numero: "9" } });
    const r = prev([sanJuanB, veneno, dos], { registro, reglas });
    expect(lecturas()).toBe("x");
    expect(r.avisos.map((a) => `${a.filaId}:${a.codigo}:${a.hallazgo.destino}`)).toEqual([
      "a:R-ISC:DG",
      "a:R-ISC:DGNG",
      "a:R-NEW:null",
      "b:R-ISC:DG",
      "b:R-NEW:null",
    ]);
  });

  it("un contexto malformado lanza EntradaReglasInvalidaError aunque una fila rompa el lote", () => {
    const registro = registroCon(camposCon("serie", {}, true));
    const veneno = filaReemplazo(undefined, { id: "c", comprobante: { tipo: "01", serie: "F-01", numero: "9" } });
    const { reglas } = contextoContado("basura" as unknown as []);
    expect(() => prev([filaSanJuan(), veneno], { registro, reglas })).toThrow(EntradaReglasInvalidaError);
  });
});

describe("H-012-41 · los ceros a la izquierda nunca dejan vacío el número de la clave de duplicados", () => {
  it("«007» y «7», y «000» y «0», son el mismo comprobante", () => {
    const fila = (id: string, numero: string) => filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F001", numero } });
    const r = prev([fila("a", "007"), fila("b", "7"), fila("c", "000"), fila("d", "0")]);
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}`)).toEqual(["a:DUPLICADO", "b:DUPLICADO", "c:DUPLICADO", "d:DUPLICADO"]);
  });

  it("«0» y «» no son el mismo comprobante: el vacío solo da CAMPO_OBLIGATORIO", () => {
    const r = prev([
      filaReemplazo(undefined, { id: "a", comprobante: { tipo: "01", serie: "F001", numero: "0" } }),
      filaReemplazo(undefined, { id: "b", comprobante: { tipo: "01", serie: "F001", numero: "" } }),
    ]);
    expect(r.errores.map((e) => `${e.filaId}:${e.codigo}`)).toEqual(["b:CAMPO_OBLIGATORIO"]);
  });
});

describe("H-012-61 · un campo de valor fijo solo admite el tipo de su valor", () => {
  it("el provisional con sus tipos se registra y una fila correcta sale apta", () => {
    expect(prev([filaReemplazo()], { registro: registroCon(camposCon("total", {})) }).apto).toBe(true);
  });

  it.each<[string, TipoCampo]>([
    ["total", "ruc"],
    ["biDg", "texto"],
    ["fechaEmision", "codigo"],
    ["tipoCambio", "monto"],
    ["moneda", "ruc"],
    ["periodo", "fecha"],
  ])("«%s» con tipo «%s» lanza DefinicionFormatoInvalidaError al registrar", (nombre, tipo) => {
    expect(() => registroCon(camposCon(nombre, { tipo }))).toThrow(DefinicionFormatoInvalidaError);
  });
});

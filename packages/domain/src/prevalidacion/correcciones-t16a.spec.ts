// Spec 012 · T16a: D23 (P-12, H-012-61 (2)). La obligatoriedad que un formato declare para
// `tipoCambio` rige solo en las filas USD; en PEN el TC se escribe «» y no se valida como
// obligatorio. Caso feliz y de error. Solo API pública.
import { describe, expect, it } from "vitest";
import { RegistroFormatos, generarTxt, prevalidar, seleccionarFormato } from "../index";
import type { CampoTxt, FilaReemplazo } from "../index";
import { CABECERA, filaReemplazo, latin1 } from "../../tests/ayudas/filas-reemplazo";

type Contexto = Parameters<typeof prevalidar>[1];
const PROVISIONAL = seleccionarFormato("compras", "202610");
const campos: CampoTxt[] = PROVISIONAL.campos.map((c) => (c.nombre === "tipoCambio" ? { ...c, obligatorio: true } : c));
const registro = RegistroFormatos.desde([{ ...PROVISIONAL, version: "t16a", oficial: true, campos }]);
const prev = (filas: readonly FilaReemplazo[]) => prevalidar(filas, { cabecera: CABECERA, registro } as Contexto);
const claves = (filas: readonly FilaReemplazo[]) => prev(filas).errores.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`);

describe("D23 · tipoCambio obligatorio solo en filas USD", () => {
  it("una fila PEN sin TC sale apta y genera con el TC vacío; una USD con TC válido también", () => {
    const pen = filaReemplazo(undefined, { id: "a" });
    const usd = filaReemplazo(undefined, { id: "b", moneda: "USD", tipoCambio: "3.5" });
    expect(prev([pen]).apto).toBe(true);
    expect(prev([usd]).errores).toEqual([]);
    const txt = latin1(generarTxt([pen], CABECERA, { registro }).bytes);
    expect(txt.split("|")[9]).toBe("");
  });

  it("una fila USD sin TC da solo USD_SIN_TC y una PEN con TC solo TC_INVALIDO, nunca CAMPO_OBLIGATORIO", () => {
    const usd = filaReemplazo(undefined, { id: "a", moneda: "USD", tipoCambio: null });
    const pen = filaReemplazo(undefined, { id: "b", tipoCambio: "3.500" });
    expect(claves([usd])).toEqual(["a:USD_SIN_TC:tipoCambio"]);
    expect(claves([pen])).toEqual(["b:TC_INVALIDO:tipoCambio"]);
  });
});

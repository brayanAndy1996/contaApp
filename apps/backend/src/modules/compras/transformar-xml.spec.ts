// Spec 016 · aceptar una sugerencia con XML en el comprobante (H-016-10, H-016-11): la sugerencia guardada se contrasta con una
// evaluación nueva en el entorno actual (`sigueVigente`) y solo se aplica si coincide. Unitarias sin BD: filas armadas a mano.
import { describe, expect, it, vi } from "vitest";
import type { CompraConXml, EvaluarCompra, HallazgoGuardadoCompra } from "@contapp/db";
import { transformarSugerencia } from "./transformar.js";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const ID = "0190a000-0000-7000-8000-0000000000b1";
const XML = { origen: "real", detalle: { marca: "x" } } as unknown as NonNullable<CompraConXml["xml"]>;
const fila = (xml: CompraConXml["xml"]): CompraConXml => ({
  id: ID, clienteId: "c", periodo: "202610", propuestaId: null, origen: "sire", clave: "k", tipoDoc: "01", serie: "F001", numero: "1",
  docTipo: "6", docNumero: "20100070970", razonSocial: null, fecha: "2026-10-01", moneda: "PEN", tipoCambio: null, version: 1,
  excluida: false, motivo: null, clasificada: false, montos: { ...CERO, biDg: "500.00", total: "500.00" }, xml,
});
const guardado: HallazgoGuardadoCompra = {
  compraId: ID,
  regla: "R-ISC",
  sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "500.00" },
  lecturas: { biDg: "500.00", igvDg: "0.00" },
  requiereConfirmacion: false,
};
const base = { conocidos: [], enMasa: false, confirmar: false, dato: undefined, regla: "R-ISC", cargarHallazgos: async () => new Map([[ID, [guardado]]]) };
/** Lo que da `evaluar` hoy; `hoy` es el hallazgo R-ISC (o lo que se quiera) y `evaluar` anota con qué fila se llamó. */
const evaluarCon = (hallazgos: unknown): { evaluar: EvaluarCompra; llamadas: CompraConXml[] } => {
  const llamadas: CompraConXml[] = [];
  const evaluar = vi.fn(async (f: CompraConXml) => {
    llamadas.push(f);
    return hallazgos as never;
  }) as unknown as EvaluarCompra;
  return { evaluar, llamadas };
};

describe("transformarSugerencia con XML en el comprobante", () => {
  it("si las reglas de hoy dan lo mismo que lo guardado (aunque jsonb haya reordenado las claves), se aplica", async () => {
    const { evaluar, llamadas } = evaluarCon([
      { regla: "R-ISC", sugerencia: { monto: "500.00", destino: "isc", origen: "biDg", tipo: "mover" }, lecturas: { igvDg: "0.00", biDg: "500.00" }, requiereConfirmacion: false },
    ]);
    const f = fila(XML);
    const r = await transformarSugerencia({ ...base, evaluar })(f, {});
    expect(r).toMatchObject({ excluida: false, montos: { biDg: "0.00", isc: "500.00" } });
    expect(llamadas).toEqual([f]); // se evaluó la fila vigente, con su XML
  });

  it("los campos indefinidos y las listas cuentan igual al comparar (un campo undefined es como no estar)", async () => {
    const conLista: HallazgoGuardadoCompra = { ...guardado, sugerencia: { ...(guardado.sugerencia as object), notas: ["a", { b: 1 }] } };
    const { evaluar } = evaluarCon([
      { regla: "R-ISC", sugerencia: { ...(guardado.sugerencia as object), extra: undefined, notas: ["a", { b: 1 }] }, lecturas: guardado.lecturas, requiereConfirmacion: false },
    ]);
    const r = await transformarSugerencia({ ...base, cargarHallazgos: async () => new Map([[ID, [conLista]]]), evaluar })(fila(XML), {});
    expect(r).toMatchObject({ montos: { isc: "500.00" } });
  });

  it("si lo de hoy difiere (otro XML vigente o la bandera cambió): revisar_de_nuevo", async () => {
    const { evaluar } = evaluarCon([
      { regla: "R-ISC", sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "499.00" }, lecturas: guardado.lecturas, requiereConfirmacion: false },
    ]);
    expect(await transformarSugerencia({ ...base, evaluar })(fila(XML), {})).toEqual({ rechazo: "revisar_de_nuevo" });
    const otraConfirmacion = evaluarCon([{ ...guardado, requiereConfirmacion: true }]);
    expect(await transformarSugerencia({ ...base, evaluar: otraConfirmacion.evaluar })(fila(XML), {})).toEqual({ rechazo: "revisar_de_nuevo" });
  });

  it("si la regla ya no sale hoy (o evaluar no devuelve nada): revisar_de_nuevo", async () => {
    for (const hoy of [[{ ...guardado, regla: "R-OTRA" }], [], undefined, null]) {
      const { evaluar } = evaluarCon(hoy);
      expect(await transformarSugerencia({ ...base, evaluar })(fila(XML), {}), String(hoy)).toEqual({ rechazo: "revisar_de_nuevo" });
    }
  });

  it("con XML y sin forma de re-evaluar (no se pasó el entorno): revisar_de_nuevo, nunca se aplica a ciegas", async () => {
    expect(await transformarSugerencia({ ...base })(fila(XML), {})).toEqual({ rechazo: "revisar_de_nuevo" });
  });

  it("sin XML no se re-evalúa: basta el contraste de 014 y evaluar ni se llama", async () => {
    const { evaluar } = evaluarCon([]);
    const r = await transformarSugerencia({ ...base, evaluar })(fila(null), {});
    expect(r).toMatchObject({ montos: { isc: "500.00" } });
    expect(evaluar).not.toHaveBeenCalled();
  });

  it("sin XML y sin entorno también se aplica (la rama «sin XML» no necesita evaluar)", async () => {
    expect(await transformarSugerencia({ ...base })(fila(null), {})).toMatchObject({ montos: { isc: "500.00" } });
  });
});

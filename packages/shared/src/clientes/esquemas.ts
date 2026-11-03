// STUB (spec 007a T2): lo reemplaza T6. Solo existe para que las pruebas compilen y fallen en rojo.
interface EsquemaStub {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const pendiente: EsquemaStub = {
  safeParse: () => {
    throw new Error("no implementado (007a T6)");
  },
};
export const perfilFiscalSchema = pendiente;
export const clienteCrearSchema = pendiente;
export const clienteEditarSchema = pendiente;
export const filtrosClientesSchema = pendiente;

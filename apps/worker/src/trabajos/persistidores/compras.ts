// STUB de T8 (rojo): existe solo para que las pruebas compilen. T13 lo reemplaza por el persistidor real de compras
// (spec 014, plan «Archivos»); no se registra en `index.ts` hasta entonces.
import type { PersistidorLibro } from "./tipos.js";

const PENDIENTE = "persistidor de compras sin implementar (spec 014, T13)";

export const persistidorCompras: PersistidorLibro = {
  preparar() {
    throw new Error(PENDIENTE);
  },
  leerExistentes() {
    return Promise.reject(new Error(PENDIENTE));
  },
  insertar() {
    return Promise.reject(new Error(PENDIENTE));
  },
};

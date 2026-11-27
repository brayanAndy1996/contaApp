// STUB de 041 · T2 (rojo): T5 lo implementa (plan 041, «txt/mapeo-compras.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { FilaPropuestaSire } from "../../puertos.js";
import type { TxtLeido } from "./leer-txt.js";
export interface EsperadoTxt {
  ruc: string;
  periodo: string;
}
export function mapearCompras(_txt: TxtLeido, _esperado: EsperadoTxt): FilaPropuestaSire[] {
  throw new Error("no implementado: mapearCompras");
}

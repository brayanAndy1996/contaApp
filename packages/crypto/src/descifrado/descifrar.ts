/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
import type { ContextoAad, Sobre, TipoCredencial } from "../comun/sobre";
import type { KeyUnwrapper } from "./fabrica";
import type { Secreto } from "./secreto";
export function descifrarSobre<T extends TipoCredencial>(
  _u: KeyUnwrapper,
  _ctx: ContextoAad & { tipo: T },
  _s: Sobre,
): Promise<Secreto<T>> {
  throw new Error("no implementado");
}

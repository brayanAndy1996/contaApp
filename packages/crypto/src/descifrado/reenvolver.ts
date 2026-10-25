/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
import type { KeyWrapper } from "../cifrado/fabrica";
import type { Sobre } from "../comun/sobre";
import type { KeyUnwrapper } from "./fabrica";
export function reenvolverDek(
  _s: Sobre,
  _anterior: KeyUnwrapper,
  _activa: KeyUnwrapper & KeyWrapper,
): Promise<Pick<Sobre, "dekEnvuelta" | "kekId">> {
  throw new Error("no implementado");
}

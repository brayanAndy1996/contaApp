/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
import type {
  CredencialSireApi,
  CredencialSol,
  ContextoAad,
  Sobre,
} from "../comun/sobre";
import type { KeyWrapper } from "./fabrica";
export function cifrarCredencial(
  _w: KeyWrapper,
  _ctx: ContextoAad,
  _valor: CredencialSol | CredencialSireApi,
): Promise<Sobre> {
  throw new Error("no implementado");
}

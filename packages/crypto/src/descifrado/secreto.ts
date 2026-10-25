/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo)
import type { ValorDe } from "../comun/sobre";
export class Secreto<T> {
  usar<R>(_fn: (v: ValorDe<T>) => R): R {
    throw new Error("no implementado");
  }
  destruir(): void {
    throw new Error("no implementado");
  }
  toJSON(): "[REDACTADO]" {
    throw new Error("no implementado");
  }
}

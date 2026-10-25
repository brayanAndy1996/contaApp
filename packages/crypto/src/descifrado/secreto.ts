// Secreto (D8): guarda el plano fuera del objeto (WeakMap) y se redacta en toda serialización.
import { inspect } from "node:util";
import { CryptoError, SecretoInvalidoError } from "../comun/errores";
import { parsearSecreto } from "../comun/secreto-plano";
import type { TipoCredencial, ValorDe } from "../comun/sobre";

const REDACTADO = "[REDACTADO]" as const;

interface Contenido {
  tipo: TipoCredencial;
  plano: Buffer;
}

const contenidos = new WeakMap<object, Contenido>();

export class SecretoDestruidoError extends CryptoError {
  constructor() {
    super("secreto_destruido", false, "Secreto destruido");
  }
}

export class Secreto<T extends TipoCredencial = TipoCredencial> {
  /** Toma posesión de `plano` (lo pondrá a cero al destruir). */
  constructor(tipo: T, plano: Buffer) {
    if (parsearSecreto(tipo, plano) === null) throw new SecretoInvalidoError();
    contenidos.set(this, { tipo, plano });
  }

  /** Entrega el valor a `fn`. Las copias que haga `fn` no se pueden borrar (los string de JS). */
  usar<R>(fn: (v: ValorDe<T>) => R): R {
    const c = contenidos.get(this);
    if (c === undefined) throw new SecretoDestruidoError();
    return fn(parsearSecreto(c.tipo, c.plano) as ValorDe<T>);
  }

  destruir(): void {
    contenidos.get(this)?.plano.fill(0);
    contenidos.delete(this);
  }

  toJSON(): typeof REDACTADO {
    return REDACTADO;
  }

  toString(): string {
    return REDACTADO;
  }

  [Symbol.toPrimitive](): string {
    return REDACTADO;
  }

  [inspect.custom](): string {
    return `Secreto ${REDACTADO}`;
  }
}

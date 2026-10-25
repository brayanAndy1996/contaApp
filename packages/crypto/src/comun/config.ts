// Lectura y validación del entorno del proveedor. Todo fallo aquí es síncrono e impide arrancar.
import { ConfiguracionKeyProviderError } from "./errores";
import { resolverRuta } from "./raiz";
import { KEK_ID_MOCK } from "./rsa";
import { PATRON_KEK_ID } from "./sobre";

export type Entorno = Record<string, string | undefined>;
export type NombreProveedor = "mock" | "local";

/** Dependencias inyectables de los adaptadores (pruebas de fallas sin tocar disco). */
export interface OpcionesProveedor {
  plazoMs?: number;
  leerArchivo?: (ruta: string) => Buffer | Promise<Buffer>;
}

/** KEY_PROVIDER es obligatorio y cerrado: `mock` o `local`, sin fallback. */
export function leerProveedor(env: Entorno): NombreProveedor {
  const valor = env.KEY_PROVIDER;
  if (valor === "mock" || valor === "local") return valor;
  throw new ConfiguracionKeyProviderError();
}

/** `mock` nunca arranca en producción ni con un KEK_ID distinto de `mock`. */
export function validarEntornoMock(env: Entorno): void {
  if (env.NODE_ENV === "production") throw new ConfiguracionKeyProviderError();
  if (env.KEK_ID && env.KEK_ID !== KEK_ID_MOCK) {
    throw new ConfiguracionKeyProviderError();
  }
}

/** KEK_ID de `local`: obligatorio, con el formato de la tabla y distinto del reservado `mock`. */
export function validarKekIdLocal(kekId: string | undefined): string {
  if (
    typeof kekId !== "string" ||
    !PATRON_KEK_ID.test(kekId) ||
    kekId === KEK_ID_MOCK
  ) {
    throw new ConfiguracionKeyProviderError();
  }
  return kekId;
}

/** Ruta de llave obligatoria, resuelta contra la raíz del repo si es relativa. */
export function exigirRuta(ruta: string | undefined): string {
  if (typeof ruta !== "string" || ruta.trim() === "") {
    throw new ConfiguracionKeyProviderError();
  }
  return resolverRuta(ruta);
}

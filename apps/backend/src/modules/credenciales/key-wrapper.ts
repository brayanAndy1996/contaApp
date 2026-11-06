import { crearKeyWrapper, type KeyWrapper } from "@contapp/crypto";

/** Token de inyección del `KeyWrapper` (llave pública; el backend no puede descifrar). */
export const KEY_WRAPPER = Symbol("KEY_WRAPPER");

export type ObtenerKeyWrapper = () => KeyWrapper;

/** Variables que lee `crearKeyWrapper` (3 de 003, D1). */
const VARIABLES = ["KEY_PROVIDER", "KEK_ID", "KEK_PUBLIC_KEY_PATH", "NODE_ENV"] as const;

/**
 * Falla cerrado (H-007b-3): solo con `NODE_ENV` exactamente `development` o `test` se filtra el entorno, porque el
 * `.env` raíz lo comparten backend y worker y el backend no necesita (ni lee) `KEK_PRIVATE_KEY_PATH`. Con cualquier
 * otro valor, o sin `NODE_ENV`, pasa el entorno entero: si trae `KEK_PRIVATE_KEY_PATH` el proveedor no arranca (el
 * backend no puede tener la llave privada).
 */
function entornoDeCifrado(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
    return Object.fromEntries(VARIABLES.map((v) => [v, env[v]]));
  }
  return env;
}

/**
 * `KeyWrapper` según `KEY_PROVIDER` (mock por defecto en `.env`), creado en el primer uso y memoizado: un entorno
 * mal configurado falla al guardar una credencial (500 genérico) y no al arrancar rutas que no cifran.
 */
export function keyWrapperPerezoso(env: Record<string, string | undefined>): ObtenerKeyWrapper {
  let wrapper: KeyWrapper | undefined;
  return () => (wrapper ??= crearKeyWrapper(entornoDeCifrado(env)));
}

/**
 * `KeyWrapper` del backend (spec 009, D10). Con `NODE_ENV` distinto de `development` y `test` (incluido sin
 * definir) se crea ya al instanciar el módulo: un `KEK_PRIVATE_KEY_PATH` presente o un `KEY_PROVIDER` inválido
 * es un error de arranque y no un 500 al guardar la primera credencial. En `development` y `test` sigue perezoso.
 * El error es el de `crearKeyWrapper`, que nunca incluye valores de variables.
 */
export function keyWrapperDelBackend(env: Record<string, string | undefined>): ObtenerKeyWrapper {
  const obtener = keyWrapperPerezoso(env);
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") obtener();
  return obtener;
}

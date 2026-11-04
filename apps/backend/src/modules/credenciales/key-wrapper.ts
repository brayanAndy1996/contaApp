import { crearKeyWrapper, type KeyWrapper } from "@contapp/crypto";

/** Token de inyección del `KeyWrapper` (llave pública; el backend no puede descifrar). */
export const KEY_WRAPPER = Symbol("KEY_WRAPPER");

export type ObtenerKeyWrapper = () => KeyWrapper;

/** Variables que lee `crearKeyWrapper` (3 de 003, D1). */
const VARIABLES = ["KEY_PROVIDER", "KEK_ID", "KEK_PUBLIC_KEY_PATH", "NODE_ENV"] as const;

/**
 * En producción pasa el entorno entero: si trae `KEK_PRIVATE_KEY_PATH` el proveedor no arranca (el backend no puede
 * tener la llave privada). En desarrollo el `.env` raíz lo comparten backend y worker, así que se le entregan solo
 * las variables que el backend necesita; el backend nunca lee ni usa esa ruta.
 */
function entornoDeCifrado(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.NODE_ENV?.trim().toLowerCase() === "production") return env;
  return Object.fromEntries(VARIABLES.map((v) => [v, env[v]]));
}

/**
 * `KeyWrapper` según `KEY_PROVIDER` (mock por defecto en `.env`), creado en el primer uso y memoizado: un entorno
 * mal configurado falla al guardar una credencial (500 genérico) y no al arrancar rutas que no cifran.
 */
export function keyWrapperPerezoso(env: Record<string, string | undefined>): ObtenerKeyWrapper {
  let wrapper: KeyWrapper | undefined;
  return () => (wrapper ??= crearKeyWrapper(entornoDeCifrado(env)));
}

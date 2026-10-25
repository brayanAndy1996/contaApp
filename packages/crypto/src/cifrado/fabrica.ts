// Fábrica del backend: solo devuelve KeyWrapper (CA-4a).
import {
  exigirRuta,
  leerProveedor,
  validarEntornoMock,
  validarKekIdLocal,
  type Entorno,
  type OpcionesProveedor,
} from "../comun/config";
import { ConfiguracionKeyProviderError } from "../comun/errores";
import { crearLocalWrapper } from "./local";
import { MockKeyProvider } from "./mock";

export type { OpcionesProveedor } from "../comun/config";

export interface KeyWrapper {
  readonly kekId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  verificar(): Promise<void>;
}

/**
 * Lee solo KEY_PROVIDER, KEK_ID, KEK_PUBLIC_KEY_PATH y NODE_ENV. Si el entorno trae
 * KEK_PRIVATE_KEY_PATH no arranca. Los errores de entorno son síncronos; los de la llave,
 * del primer uso (o de `verificar()`).
 */
export function crearKeyWrapper(
  env: Entorno,
  o: OpcionesProveedor = {},
): KeyWrapper {
  const proveedor = leerProveedor(env);
  if (env.KEK_PRIVATE_KEY_PATH !== undefined) {
    throw new ConfiguracionKeyProviderError();
  }
  if (proveedor === "mock") {
    validarEntornoMock(env);
    return new MockKeyProvider({ plazoMs: o.plazoMs });
  }
  const kekId = validarKekIdLocal(env.KEK_ID);
  return crearLocalWrapper(kekId, exigirRuta(env.KEK_PUBLIC_KEY_PATH), o);
}

// Fábricas del worker: llave activa (wrap + unwrap) y llave anterior (solo rotación).
import type { KeyWrapper } from "../cifrado/fabrica";
import {
  exigirRuta,
  leerProveedor,
  validarEntornoMock,
  validarKekIdLocal,
  type Entorno,
  type OpcionesProveedor,
} from "../comun/config";
import { crearLocalAnterior, crearLocalCompleto } from "./local";
import { MockKeyProvider } from "./mock";

export interface KeyUnwrapper {
  readonly kekId: string;
  unwrap(dekEnvuelta: Buffer, kekId: string): Promise<Buffer>;
  verificar(): Promise<void>;
}

/** Llave activa (KEK_ID). Con `local`, la pública se deriva de KEK_PRIVATE_KEY_PATH. */
export function crearKeyUnwrapper(
  env: Entorno,
  o: OpcionesProveedor = {},
): KeyUnwrapper & KeyWrapper {
  if (leerProveedor(env) === "mock") {
    validarEntornoMock(env);
    return new MockKeyProvider({ plazoMs: o.plazoMs });
  }
  const kekId = validarKekIdLocal(env.KEK_ID);
  return crearLocalCompleto(kekId, exigirRuta(env.KEK_PRIVATE_KEY_PATH), o);
}

/** Llave retirada, recibida por argumento en `kek:rotar` (D6). Siempre `local`. */
export function crearKeyUnwrapperAnterior(
  a: { kekId: string; rutaPrivada: string },
  o: OpcionesProveedor = {},
): KeyUnwrapper {
  return crearLocalAnterior(
    validarKekIdLocal(a.kekId),
    exigirRuta(a.rutaPrivada),
    o,
  );
}

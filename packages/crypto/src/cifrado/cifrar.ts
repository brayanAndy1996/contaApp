// cifrarCredencial: AES-256-GCM con DEK por secreto, envuelta con el KeyWrapper.
import { createCipheriv } from "node:crypto";
import { construirAad } from "../comun/aad";
import { crearGeneradorMaterial } from "../comun/aleatorio";
import { aErrorProveedor } from "../comun/errores";
import { serializarSecreto } from "../comun/secreto-plano";
import {
  LARGO_TAG,
  type ContextoAad,
  type CredencialSireApi,
  type CredencialSol,
  type Sobre,
} from "../comun/sobre";
import type { KeyWrapper } from "./fabrica";

const generarMaterial = crearGeneradorMaterial();

/**
 * Valida contexto y secreto antes de tocar la llave. Si el proveedor falla no devuelve nada.
 * La DEK y el plano se ponen a cero al terminar.
 */
export async function cifrarCredencial(
  w: KeyWrapper,
  ctx: ContextoAad,
  valor: CredencialSol | CredencialSireApi,
): Promise<Sobre> {
  const aad = construirAad(ctx);
  const sensibles = [serializarSecreto(ctx.tipo, valor)];
  try {
    const plano = sensibles[0] as Buffer;
    const { dek, nonce } = generarMaterial();
    const paraEnvolver = Buffer.from(dek);
    sensibles.push(dek, paraEnvolver);
    const cifrador = createCipheriv("aes-256-gcm", dek, nonce, {
      authTagLength: LARGO_TAG,
    });
    cifrador.setAAD(aad);
    const ciphertext = Buffer.concat([cifrador.update(plano), cifrador.final()]);
    const tag = cifrador.getAuthTag();
    let dekEnvuelta: Buffer;
    try {
      dekEnvuelta = Buffer.from(await w.wrap(paraEnvolver));
    } catch (e) {
      throw aErrorProveedor(e);
    }
    return { ciphertext, nonce, tag, dekEnvuelta, kekId: w.kekId, version: 1 };
  } finally {
    for (const b of sensibles) b.fill(0);
  }
}

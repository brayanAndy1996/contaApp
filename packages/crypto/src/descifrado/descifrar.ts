// descifrarSobre: valida contexto y sobre antes de tocar la llave; solo entrega el plano tras un
// `final()` correcto. Todo fallo de autenticación es el mismo IntegridadError.
import { createDecipheriv } from "node:crypto";
import { construirAad } from "../comun/aad";
import {
  IntegridadError,
  KekDesconocidaError,
  aErrorProveedor,
} from "../comun/errores";
import {
  LARGO_DEK,
  LARGO_TAG,
  validarSobre,
  type ContextoAad,
  type Sobre,
  type TipoCredencial,
} from "../comun/sobre";
import type { KeyUnwrapper } from "./fabrica";
import { Secreto } from "./secreto";

/** Desenvuelve la DEK del sobre con `u`, comprobando antes el kek_id. Normaliza errores. */
export async function abrirDek(u: KeyUnwrapper, s: Sobre): Promise<Buffer> {
  if (s.kekId !== u.kekId) throw new KekDesconocidaError();
  let dek: Buffer;
  try {
    dek = Buffer.from(await u.unwrap(s.dekEnvuelta, s.kekId));
  } catch (e) {
    throw aErrorProveedor(e);
  }
  if (dek.length !== LARGO_DEK) {
    dek.fill(0);
    throw new IntegridadError();
  }
  return dek;
}

export async function descifrarSobre<T extends TipoCredencial>(
  u: KeyUnwrapper,
  ctx: ContextoAad & { tipo: T },
  s: Sobre,
): Promise<Secreto<T>> {
  const aad = construirAad(ctx);
  validarSobre(s);
  const dek = await abrirDek(u, s);
  const parciales: Buffer[] = [dek];
  try {
    let plano: Buffer;
    try {
      const descifrador = createDecipheriv("aes-256-gcm", dek, s.nonce, {
        authTagLength: LARGO_TAG,
      });
      descifrador.setAAD(aad);
      descifrador.setAuthTag(s.tag);
      parciales.push(descifrador.update(s.ciphertext));
      parciales.push(descifrador.final());
      plano = Buffer.concat(parciales.slice(1));
    } catch {
      throw new IntegridadError();
    }
    try {
      return new Secreto(ctx.tipo, plano);
    } catch {
      plano.fill(0);
      throw new IntegridadError();
    }
  } finally {
    for (const b of parciales) b.fill(0);
  }
}

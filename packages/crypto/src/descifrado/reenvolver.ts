// reenvolverDek (D6): abre la DEK con la llave anterior, la envuelve con la activa y comprueba que
// la activa la abre igual. No descifra el ciphertext ni toca nonce/tag. La activa nunca puede ser la
// llave `mock` (su privada está en el repo): se rechaza y no se devuelve nada.
import { timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "../cifrado/fabrica";
import { MockKeyProvider } from "../cifrado/mock";
import {
  IntegridadError,
  RotacionConMockError,
  aErrorProveedor,
} from "../comun/errores";
import { KEK_ID_MOCK } from "../comun/rsa";
import { validarSobre, type Sobre } from "../comun/sobre";
import { abrirDek } from "./descifrar";
import type { KeyUnwrapper } from "./fabrica";

/** true si el proveedor es (o dice ser) la llave del fixture `mock`. */
export function esLlaveMock(p: { readonly kekId: string }): boolean {
  return p instanceof MockKeyProvider || p.kekId === KEK_ID_MOCK;
}

export async function reenvolverDek(
  s: Sobre,
  anterior: KeyUnwrapper,
  activa: KeyUnwrapper & KeyWrapper,
): Promise<Pick<Sobre, "dekEnvuelta" | "kekId">> {
  validarSobre(s);
  const dek = await abrirDek(anterior, s);
  const sensibles: Buffer[] = [dek];
  try {
    const paraEnvolver = Buffer.from(dek);
    sensibles.push(paraEnvolver);
    let dekEnvuelta: Buffer;
    try {
      dekEnvuelta = Buffer.from(await activa.wrap(paraEnvolver));
    } catch (e) {
      throw aErrorProveedor(e);
    }
    // Tras el wrap para que un proveedor caído siga dando su error reintentable; la DEK envuelta con
    // `mock` se borra y nunca sale de aquí. rotarKekTenant y kek:rotar lo rechazan antes de tocar la BD.
    if (esLlaveMock(activa)) {
      dekEnvuelta.fill(0);
      throw new RotacionConMockError();
    }
    const nueva: Sobre = { ...s, dekEnvuelta, kekId: activa.kekId };
    const comprobada = await abrirDek(activa, nueva);
    sensibles.push(comprobada);
    if (!timingSafeEqual(comprobada, dek)) throw new IntegridadError();
    return { dekEnvuelta, kekId: activa.kekId };
  } finally {
    for (const b of sensibles) b.fill(0);
  }
}

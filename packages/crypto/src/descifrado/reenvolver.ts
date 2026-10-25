// reenvolverDek (D6): abre la DEK con la llave anterior, la envuelve con la activa y comprueba que
// la activa la abre igual. No descifra el ciphertext ni toca nonce/tag.
import { timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "../cifrado/fabrica";
import { IntegridadError, aErrorProveedor } from "../comun/errores";
import { validarSobre, type Sobre } from "../comun/sobre";
import { abrirDek } from "./descifrar";
import type { KeyUnwrapper } from "./fabrica";

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
    const nueva: Sobre = { ...s, dekEnvuelta, kekId: activa.kekId };
    const comprobada = await abrirDek(activa, nueva);
    sensibles.push(comprobada);
    if (!timingSafeEqual(comprobada, dek)) throw new IntegridadError();
    return { dekEnvuelta, kekId: activa.kekId };
  } finally {
    for (const b of sensibles) b.fill(0);
  }
}

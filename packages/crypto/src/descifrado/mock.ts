/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo): MockKeyProvider completo (wrap + unwrap) para el worker.
import type { KeyWrapper } from "../cifrado/fabrica";
import type { OpcionesMock } from "../cifrado/mock";
import type { KeyUnwrapper } from "./fabrica";
export class MockKeyProvider implements KeyUnwrapper, KeyWrapper {
  readonly kekId = "mock";
  constructor(_o?: OpcionesMock) {}
  wrap(_dek: Buffer): Promise<Buffer> {
    throw new Error("no implementado");
  }
  unwrap(_dekEnvuelta: Buffer, _kekId: string): Promise<Buffer> {
    throw new Error("no implementado");
  }
  verificar(): Promise<void> {
    throw new Error("no implementado");
  }
}

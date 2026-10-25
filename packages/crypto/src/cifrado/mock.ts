/* eslint-disable @typescript-eslint/no-unused-vars */
// STUB (T5, rojo): lado cifrado de MockKeyProvider (solo wrap).
import type { KeyWrapper } from "./fabrica";
export interface OpcionesMock {
  falla?: "timeout" | "error" | "corrupta";
  plazoMs?: number;
}
export class MockKeyProvider implements KeyWrapper {
  readonly kekId = "mock";
  constructor(_o?: OpcionesMock) {}
  wrap(_dek: Buffer): Promise<Buffer> {
    throw new Error("no implementado");
  }
  verificar(): Promise<void> {
    throw new Error("no implementado");
  }
}

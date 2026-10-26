import { describe, expect, it } from "vitest";
import { crearHasher, type LibArgon2 } from "./hasher.js";

// Rama de verificar que hasher.spec.ts no ejercita: la librería lanza -> false.
describe("verificar cuando la librería lanza", () => {
  it("devuelve false y no propaga el error", async () => {
    const lib: LibArgon2 = {
      hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
      verify: async () => {
        throw new Error("fallo interno de la librería");
      },
    };
    const hasher = await crearHasher(
      { memoriaKib: 19456, iteraciones: 2, paralelismo: 1 },
      lib,
    );
    await expect(
      hasher.verificar(hasher.hashFicticio, "cualquier-cosa-12"),
    ).resolves.toBe(false);
  });

  it("un argon2id con versión distinta de 19 necesita rehash", async () => {
    const lib: LibArgon2 = {
      hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
      verify: async () => true,
    };
    const hasher = await crearHasher(
      { memoriaKib: 19456, iteraciones: 2, paralelismo: 1 },
      lib,
    );
    expect(
      hasher.necesitaRehash("$argon2id$v=16$m=19456,t=2,p=1$c2FsdA$aGFzaA"),
    ).toBe(true);
  });
});

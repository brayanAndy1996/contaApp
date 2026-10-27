import { describe, expect, it } from "vitest";
import { MockKeyProvider, ConfiguracionKeyProviderError, KeyProviderError } from "./index";

// Cobertura del lado cifrado del mock: `verificar` con la pública del fixture y con fallas simuladas.
describe("MockKeyProvider (cifrado).verificar", () => {
  it("resuelve sin valor cuando la pública del fixture carga", async () => {
    await expect(new MockKeyProvider().verificar()).resolves.toBeUndefined();
  });

  it.each(["error", "corrupta"] as const)(
    "falla simulada '%s' -> KeyProviderError",
    async (falla) => {
      await expect(new MockKeyProvider({ falla }).verificar()).rejects.toBeInstanceOf(
        KeyProviderError,
      );
    },
  );

  it("la falla simulada 'timeout' se corta por el plazo", async () => {
    await expect(
      new MockKeyProvider({ falla: "timeout", plazoMs: 20 }).verificar(),
    ).rejects.toBeInstanceOf(KeyProviderError);
  });

  it("en producción no se puede construir", () => {
    const previo = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MockKeyProvider()).toThrow(ConfiguracionKeyProviderError);
    } finally {
      process.env.NODE_ENV = previo;
    }
  });
});

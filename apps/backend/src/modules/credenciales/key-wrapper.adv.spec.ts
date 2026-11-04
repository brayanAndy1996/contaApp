// Spec 007b T16 · ronda adversarial (caja blanca) de `keyWrapperPerezoso` (T10) con el `crearKeyWrapper` REAL.
// El guard de 003 («el backend no arranca si ve KEK_PRIVATE_KEY_PATH») solo sirve si ve el entorno. El filtrado de
// T10 lo oculta siempre que NODE_ENV no sea exactamente `production`: un servidor real con NODE_ENV ausente o
// distinto (`staging`, `prod`) y la llave privada en el entorno del backend arranca y cifra sin aviso.
// La ruta es un canario: no existe ni se lee.
import { describe, expect, it } from "vitest";
import { keyWrapperPerezoso } from "./key-wrapper.js";

const RUTA_PRIVADA = "/no-existe/CANARIO-kek-privada.pem";

describe("T16 · keyWrapperPerezoso con el proveedor real", () => {
  it("adv-k1: con KEK_PRIVATE_KEY_PATH y NODE_ENV ausente, `staging` o `prod`, el backend se niega a cifrar", () => {
    const entornos: Record<string, string | undefined>[] = [
      {
        KEY_PROVIDER: "mock",
        KEK_ID: "mock",
        KEK_PRIVATE_KEY_PATH: RUTA_PRIVADA,
      },
      {
        KEY_PROVIDER: "mock",
        KEK_ID: "mock",
        KEK_PRIVATE_KEY_PATH: RUTA_PRIVADA,
        NODE_ENV: "staging",
      },
      {
        KEY_PROVIDER: "mock",
        KEK_ID: "mock",
        KEK_PRIVATE_KEY_PATH: RUTA_PRIVADA,
        NODE_ENV: "prod",
      },
    ];
    const aceptados = entornos.filter((env) => {
      try {
        keyWrapperPerezoso(env)();
        return true;
      } catch {
        return false;
      }
    });
    expect(aceptados.map((e) => e.NODE_ENV ?? "(ausente)")).toEqual([]);
  });
});

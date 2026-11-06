// Spec 009 (T12a, M2, CA-7) · `keyWrapperDelBackend` con el `crearKeyWrapper` REAL, sin `vi.mock` de `@contapp/crypto`.
// `arranque.spec.ts` sustituye el factory por un mock, así que «ruta privada presente → falla al arrancar» solo se
// demostraba por composición. Aquí el fallo lo lanza el guardia real de `crearKeyWrapper`. Las rutas son canarios: no
// existen ni se leen (el proveedor `local` solo abre la llave pública al primer uso).
import { describe, expect, it } from "vitest";
import { ConfiguracionKeyProviderError } from "@contapp/crypto";
import { keyWrapperDelBackend } from "./key-wrapper.js";

const RUTA_PRIVADA = "/no-existe/CANARIO-kek-privada.pem";
const RUTA_PUBLICA = "/no-existe/CANARIO-kek-publica.pem";
// `local` y no `mock`: con `mock` en producción el factory también falla (validarEntornoMock) y la prueba no aislaría
// la ruta privada como causa.
const ENTORNO = { KEY_PROVIDER: "local", KEK_ID: "k1", KEK_PUBLIC_KEY_PATH: RUTA_PUBLICA };

describe("keyWrapperDelBackend con el crearKeyWrapper real (CA-7)", () => {
  it("en producción con la ruta privada presente el arranque falla y el error no trae valores", () => {
    let error: unknown;
    try {
      keyWrapperDelBackend({ ...ENTORNO, NODE_ENV: "production", KEK_PRIVATE_KEY_PATH: RUTA_PRIVADA });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfiguracionKeyProviderError);
    const mensaje = (error as Error).message;
    expect(mensaje).not.toContain(RUTA_PRIVADA);
    expect(mensaje).not.toContain(RUTA_PUBLICA);
  });

  it("control: el mismo entorno de producción sin la ruta privada arranca, así que la causa es la ruta", () => {
    expect(() => keyWrapperDelBackend({ ...ENTORNO, NODE_ENV: "production" })).not.toThrow();
  });

  it("en development la ruta privada se filtra: no falla al arrancar ni al primer uso", () => {
    const obtener = keyWrapperDelBackend({ ...ENTORNO, NODE_ENV: "development", KEK_PRIVATE_KEY_PATH: RUTA_PRIVADA });
    expect(obtener().kekId).toBe("k1");
  });
});

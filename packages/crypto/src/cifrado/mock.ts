// MockKeyProvider, lado cifrado (solo wrap). Usa la pública del fixture `mock` (D1), leída por ruta
// desde __dirname. Las fallas simuladas solo se activan por constructor, nunca por entorno.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import {
  ConfiguracionKeyProviderError,
  KeyProviderError,
} from "../comun/errores";
import { esProduccion } from "../comun/config";
import { PLAZO_POR_DEFECTO_MS, Perezoso } from "../comun/plazo";
import { KEK_ID_MOCK, cargarPublica, envolverDek } from "../comun/rsa";
import type { KeyWrapper } from "./fabrica";

export interface OpcionesMock {
  falla?: "timeout" | "error" | "corrupta";
  plazoMs?: number;
}

/** Carpeta del fixture: igual profundidad desde src/cifrado y dist/cifrado. */
export const DIR_FIXTURE_MOCK = join(__dirname, "..", "..", "fixtures", "mock-kek");
const RUTA_PUBLICA = join(DIR_FIXTURE_MOCK, "SOLO-PRUEBAS-kek-mock-public.pem");

/** Ejecuta la carga real o simula la falla pedida. */
export function cargaSimulada<T>(
  falla: OpcionesMock["falla"],
  real: () => T,
): Promise<T> {
  switch (falla) {
    case "timeout":
      return new Promise<T>(() => {});
    case "error":
    case "corrupta":
      return Promise.reject(new KeyProviderError());
    default:
      return Promise.resolve().then(real);
  }
}

export class MockKeyProvider implements KeyWrapper {
  readonly kekId = KEK_ID_MOCK;
  protected readonly plazoMs: number;
  readonly #publica: Perezoso<KeyObject>;

  constructor(o: OpcionesMock = {}) {
    if (esProduccion(process.env.NODE_ENV)) {
      throw new ConfiguracionKeyProviderError();
    }
    this.plazoMs = o.plazoMs ?? PLAZO_POR_DEFECTO_MS;
    this.#publica = new Perezoso(() =>
      cargaSimulada(o.falla, () =>
        cargarPublica(readFileSync(RUTA_PUBLICA), false),
      ),
    );
  }

  wrap(dek: Buffer): Promise<Buffer> {
    return this.#publica.usar(
      (k) => envolverDek(k, KEK_ID_MOCK, dek),
      this.plazoMs,
    );
  }

  verificar(): Promise<void> {
    return this.#publica.usar(() => undefined, this.plazoMs);
  }
}

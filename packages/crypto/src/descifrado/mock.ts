// MockKeyProvider completo (wrap + unwrap) para el worker, con el par fijo del fixture (D1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIR_FIXTURE_MOCK,
  MockKeyProvider as MockWrapper,
  cargaSimulada,
  type OpcionesMock,
} from "../cifrado/mock";
import { KekDesconocidaError } from "../comun/errores";
import { Perezoso } from "../comun/plazo";
import { KEK_ID_MOCK } from "../comun/rsa";
import type { KeyUnwrapper } from "./fabrica";
import { cargarPrivada, desenvolverDek, type ParRsa } from "./rsa-privada";

const RUTA_PRIVADA = join(DIR_FIXTURE_MOCK, "SOLO-PRUEBAS-kek-mock-private.pem");

export class MockKeyProvider extends MockWrapper implements KeyUnwrapper {
  readonly #par: Perezoso<ParRsa>;

  constructor(o: OpcionesMock = {}) {
    super(o);
    this.#par = new Perezoso(() =>
      cargaSimulada(o.falla, () =>
        cargarPrivada(readFileSync(RUTA_PRIVADA), false),
      ),
    );
  }

  async unwrap(dekEnvuelta: Buffer, kekId: string): Promise<Buffer> {
    if (kekId !== KEK_ID_MOCK) throw new KekDesconocidaError();
    return this.#par.usar(
      (k) => desenvolverDek(k.privada, KEK_ID_MOCK, dekEnvuelta),
      this.plazoMs,
    );
  }
}

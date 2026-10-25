// LocalKeyProvider, lado cifrado: solo abre la llave pública (CA-4a).
import { readFile } from "node:fs/promises";
import type { OpcionesProveedor } from "../comun/config";
import { PLAZO_POR_DEFECTO_MS, Perezoso, leerLlave } from "../comun/plazo";
import { cargarPublica, envolverDek } from "../comun/rsa";
import type { KeyWrapper } from "./fabrica";

export function crearLocalWrapper(
  kekId: string,
  rutaPublica: string,
  o: OpcionesProveedor,
): KeyWrapper {
  const leer = o.leerArchivo ?? ((ruta: string) => readFile(ruta));
  const plazoMs = o.plazoMs ?? PLAZO_POR_DEFECTO_MS;
  const publica = new Perezoso(async () =>
    cargarPublica(await leerLlave(leer, rutaPublica), true),
  );
  return {
    kekId,
    wrap: (dek) => publica.usar((k) => envolverDek(k, kekId, dek), plazoMs),
    verificar: () => publica.usar(() => undefined, plazoMs),
  };
}

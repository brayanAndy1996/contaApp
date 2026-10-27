// LocalKeyProvider, lado worker: abre la privada y deriva la pública (llave activa), o solo abre
// la privada anterior (rotación).
import { readFile, stat } from "node:fs/promises";
import type { KeyWrapper } from "../cifrado/fabrica";
import type { OpcionesProveedor } from "../comun/config";
import {
  ConfiguracionKeyProviderError,
  KekDesconocidaError,
  KeyProviderError,
} from "../comun/errores";
import { PLAZO_POR_DEFECTO_MS, Perezoso, leerLlave } from "../comun/plazo";
import { envolverDek, huellaSpki } from "../comun/rsa";
import type { KeyUnwrapper } from "./fabrica";
import { cargarPrivada, desenvolverDek } from "./rsa-privada";

/** Opciones internas: plataforma y modo de archivo inyectables para probar la regla POSIX. */
export interface OpcionesLocal extends OpcionesProveedor {
  plataforma?: NodeJS.Platform;
  modoArchivo?: (ruta: string) => number | Promise<number>;
}

/** En POSIX, una privada legible o escribible por grupo u otros se rechaza. */
async function exigirPermisos(ruta: string, o: OpcionesLocal): Promise<void> {
  if ((o.plataforma ?? process.platform) === "win32") return;
  const modoArchivo =
    o.modoArchivo ?? (async (r: string) => (await stat(r)).mode);
  let modo: number;
  try {
    modo = await modoArchivo(ruta);
  } catch {
    throw new KeyProviderError();
  }
  if ((modo & 0o077) !== 0) throw new ConfiguracionKeyProviderError();
}

export function crearLocalCompleto(
  kekId: string,
  rutaPrivada: string,
  o: OpcionesLocal,
): KeyUnwrapper & KeyWrapper {
  const leer = o.leerArchivo ?? ((ruta: string) => readFile(ruta));
  const plazoMs = o.plazoMs ?? PLAZO_POR_DEFECTO_MS;
  const par = new Perezoso(async () => {
    const pem = await leerLlave(leer, rutaPrivada);
    try {
      const cargado = cargarPrivada(pem, true);
      await exigirPermisos(rutaPrivada, o);
      return cargado;
    } finally {
      pem.fill(0);
    }
  });
  return {
    kekId,
    wrap: (dek) => par.usar((k) => envolverDek(k.publica, kekId, dek), plazoMs),
    unwrap: async (dekEnvuelta, kekIdSobre) => {
      if (kekIdSobre !== kekId) throw new KekDesconocidaError();
      return par.usar(
        (k) => desenvolverDek(k.privada, kekId, dekEnvuelta),
        plazoMs,
      );
    },
    verificar: () => par.usar(() => undefined, plazoMs),
    huellaPublica: () => par.usar((k) => huellaSpki(k.publica), plazoMs),
  };
}

/** Llave anterior para rotación: unwrap y verificar, sin wrap. */
export function crearLocalAnterior(
  kekId: string,
  rutaPrivada: string,
  o: OpcionesLocal,
): KeyUnwrapper {
  const completo = crearLocalCompleto(kekId, rutaPrivada, o);
  return {
    kekId,
    unwrap: completo.unwrap,
    verificar: completo.verificar,
    huellaPublica: completo.huellaPublica,
  };
}

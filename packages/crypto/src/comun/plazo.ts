// Timeout por operación del proveedor y carga perezosa de llaves sin cachear fallos.
import { KeyProviderError, aErrorProveedor } from "./errores";

export const PLAZO_POR_DEFECTO_MS = 5_000;

/** Rechaza con KeyProviderError si `p` no termina en `ms`; `alVencer` se llama al vencer. */
export function conPlazo<T>(
  p: Promise<T>,
  ms: number,
  alVencer: () => void,
): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const vencimiento = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => {
      alVencer();
      rechazar(new KeyProviderError());
    }, ms);
  });
  return Promise.race([p, vencimiento]).finally(() =>
    clearTimeout(temporizador),
  );
}

/**
 * Carga una llave en el primer uso y la reutiliza. Un fallo (o un timeout) no se cachea:
 * el siguiente uso vuelve a intentar.
 */
export class Perezoso<T> {
  private carga: Promise<T> | undefined;

  constructor(private readonly cargar: () => Promise<T>) {}

  private obtener(): Promise<T> {
    if (this.carga === undefined) {
      const carga = this.cargar();
      this.carga = carga;
      carga.catch(() => this.olvidar(carga));
    }
    return this.carga;
  }

  private olvidar(carga: Promise<T>): void {
    if (this.carga === carga) this.carga = undefined;
  }

  /** Ejecuta `fn` con la llave dentro del plazo; normaliza los errores del proveedor. */
  async usar<R>(fn: (llave: T) => R, plazoMs: number): Promise<R> {
    const carga = this.obtener();
    try {
      return await conPlazo(carga.then(fn), plazoMs, () =>
        this.olvidar(carga),
      );
    } catch (e) {
      throw aErrorProveedor(e);
    }
  }
}

/** Lee un archivo de llave con la dependencia inyectada; cualquier fallo es KeyProviderError. */
export async function leerLlave(
  leer: (ruta: string) => Buffer | Promise<Buffer>,
  ruta: string,
): Promise<Buffer> {
  try {
    return Buffer.from(await leer(ruta));
  } catch {
    throw new KeyProviderError();
  }
}

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { ArchivoNoEncontradoError, RutaStorageError, StorageIOError } from "./errores.js";
import type { StorageProvider } from "./puerto.js";
import { validarRuta } from "./ruta.js";

function codigoFs(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

const AUSENTE = new Set(["ENOENT", "ENOTDIR"]);
const esAusente = (e: unknown): boolean => AUSENTE.has(codigoFs(e) ?? "");

/** Los errores propios pasan; cualquier otro (del sistema, con rutas en el mensaje) se reemplaza por uno fijo. */
function sanear(e: unknown): Error {
  if (
    e instanceof RutaStorageError ||
    e instanceof ArchivoNoEncontradoError ||
    e instanceof StorageIOError
  ) {
    return e;
  }
  return new StorageIOError();
}

/**
 * Almacenamiento en disco (`STORAGE=local`, raíz `STORAGE_DIR`). Escritura atómica (temporal + `rename`) y
 * `realpath` en cada acceso: una ruta cuya resolución real sale de la raíz (enlace simbólico) se rechaza.
 * Ningún error incluye rutas ni contenido.
 */
export class LocalStorage implements StorageProvider {
  constructor(readonly raiz: string = "./storage") {}

  async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    try {
      validarRuta(ruta);
      await mkdir(this.raiz, { recursive: true });
      const base = await realpath(this.raiz);
      const partes = ruta.split("/");
      const nombre = partes.pop() as string;
      let dir = base;
      for (const parte of partes) {
        dir = await this.entrar(base, dir, parte);
      }
      const destino = join(dir, nombre);
      await this.verificarHoja(base, destino);

      const temporal = join(dir, `.${randomUUID()}.tmp`);
      let creado = false;
      try {
        const f = await open(temporal, "wx", 0o600);
        creado = true;
        try {
          await f.writeFile(bytes);
          await f.sync();
        } finally {
          await f.close();
        }
        await rename(temporal, destino);
      } catch (e) {
        if (creado) await unlink(temporal).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      throw sanear(e);
    }
  }

  async leer(ruta: string): Promise<Uint8Array> {
    try {
      validarRuta(ruta);
      const base = await this.baseExistente();
      const real = await realpath(join(base, ruta));
      if (!real.startsWith(base + sep)) throw new RutaStorageError();
      const f = await open(real, "r");
      try {
        if (!(await f.stat()).isFile()) throw new ArchivoNoEncontradoError();
        return Uint8Array.from(await f.readFile());
      } finally {
        await f.close();
      }
    } catch (e) {
      if (esAusente(e)) throw new ArchivoNoEncontradoError();
      throw sanear(e);
    }
  }

  async eliminar(ruta: string): Promise<void> {
    try {
      validarRuta(ruta);
      let base: string;
      let dir: string;
      try {
        base = await realpath(this.raiz);
        dir = await realpath(join(base, dirname(ruta)));
      } catch (e) {
        if (esAusente(e)) return;
        throw e;
      }
      if (dir !== base && !dir.startsWith(base + sep)) throw new RutaStorageError();
      // `unlink` sobre un enlace quita el enlace, nunca su destino.
      await unlink(join(dir, basename(ruta))).catch((e: unknown) => {
        if (!esAusente(e)) throw e;
      });
    } catch (e) {
      throw sanear(e);
    }
  }

  private async baseExistente(): Promise<string> {
    return realpath(this.raiz);
  }

  /** Resuelve `dir/parte` (creándolo si falta) y comprueba que su ruta real sigue dentro de `base`. */
  private async entrar(base: string, dir: string, parte: string): Promise<string> {
    const candidato = join(dir, parte);
    try {
      await mkdir(candidato);
    } catch (e) {
      if (codigoFs(e) !== "EEXIST") throw e;
    }
    // Si no resuelve (enlace colgante) tampoco es seguro usarlo.
    const real = await realpath(candidato).catch(() => {
      throw new RutaStorageError();
    });
    if (!real.startsWith(base + sep)) throw new RutaStorageError();
    return real;
  }

  /** Si el destino ya existe como enlace, su destino real debe quedar dentro de `base`. */
  private async verificarHoja(base: string, destino: string): Promise<void> {
    const st = await lstat(destino).catch(() => null);
    if (st === null || !st.isSymbolicLink()) return;
    const real = await realpath(destino).catch(() => {
      throw new RutaStorageError();
    });
    if (!real.startsWith(base + sep)) throw new RutaStorageError();
  }
}

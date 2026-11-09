// LocalStorage: lo propio del disco (persistencia, escritura atómica, enlaces simbólicos). Directorios temporales.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RutaStorageError } from "./errores.js";
import { LocalStorage } from "./local.js";
import { rutaXml } from "./ruta.js";

let base: string;
let raiz: string;
let fuera: string;
const bases: string[] = [];
afterAll(() => {
  for (const b of bases) rmSync(b, { recursive: true, force: true });
});
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "storage-local-"));
  bases.push(base);
  raiz = join(base, "raiz");
  fuera = join(base, "fuera");
  mkdirSync(raiz);
  mkdirSync(fuera);
});

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

/** Todos los archivos (ruta relativa) bajo `dir`, recursivo. */
function archivos(dir: string, prefijo = ""): string[] {
  const salida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefijo === "" ? e.name : `${prefijo}/${e.name}`;
    if (e.isDirectory()) salida.push(...archivos(join(dir, e.name), rel));
    else salida.push(rel);
  }
  return salida.sort();
}

describe("LocalStorage · disco", () => {
  it("crea los directorios que faltan y deja el archivo bajo la raíz en la ruta lógica", async () => {
    const s = new LocalStorage(raiz);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await s.guardar(ruta, bytes(1, 2, 3));
    expect(Array.from(readFileSync(join(raiz, ruta)))).toEqual([1, 2, 3]);
  });

  it("crea también la raíz si no existe", async () => {
    const nueva = join(base, "no", "existe", "aun");
    const s = new LocalStorage(nueva);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await s.guardar(ruta, bytes(7));
    expect(Array.from(readFileSync(join(nueva, ruta)))).toEqual([7]);
  });

  it("lo guardado persiste: otra instancia sobre la misma raíz lo lee", async () => {
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await new LocalStorage(raiz).guardar(ruta, bytes(4, 5));
    expect(Array.from(await new LocalStorage(raiz).leer(ruta))).toEqual([4, 5]);
  });

  it("eliminar borra el archivo del disco", async () => {
    const s = new LocalStorage(raiz);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await s.guardar(ruta, bytes(1));
    await s.eliminar(ruta);
    expect(existsSync(join(raiz, ruta))).toBe(false);
  });

  it("una ruta inválida no crea nada en la raíz", async () => {
    const s = new LocalStorage(raiz);
    await expect(s.guardar("../escape.xml", bytes(1))).rejects.toBeInstanceOf(RutaStorageError);
    await expect(s.guardar("/tmp/escape.xml", bytes(1))).rejects.toBeInstanceOf(RutaStorageError);
    expect(readdirSync(raiz)).toEqual([]);
    expect(readdirSync(base).sort()).toEqual(["fuera", "raiz"]);
  });
});

describe("LocalStorage · escritura atómica", () => {
  it("tras guardar solo existe el archivo final (ningún temporal)", async () => {
    const s = new LocalStorage(raiz);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await s.guardar(ruta, bytes(1, 2, 3));
    await s.guardar(ruta, bytes(4, 5, 6, 7));
    expect(archivos(raiz)).toEqual([ruta]);
  });

  it("si falla el paso final no queda archivo parcial ni temporal", async () => {
    const s = new LocalStorage(raiz);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    // El destino es un directorio no vacío: escribir el temporal funciona, renombrarlo encima falla.
    mkdirSync(join(raiz, ruta), { recursive: true });
    writeFileSync(join(raiz, ruta, "ocupado.txt"), "x");
    await expect(s.guardar(ruta, bytes(1, 2, 3))).rejects.toThrow();
    expect(archivos(raiz)).toEqual([`${ruta}/ocupado.txt`]);
    expect(readdirSync(dirname(join(raiz, ruta))).sort()).toEqual([ruta.split("/").pop()]);
  });

  it("si falla la sobrescritura el contenido anterior queda intacto", async () => {
    const s = new LocalStorage(raiz);
    const t = randomUUID();
    const c = randomUUID();
    const a = rutaXml(t, c, randomUUID());
    const b = rutaXml(t, c, randomUUID());
    await s.guardar(a, bytes(1, 2, 3));
    await s.guardar(b, bytes(9));
    // Se provoca el fallo en `b` y se comprueba que `a` (vecino) y los directorios siguen sanos.
    rmSync(join(raiz, b));
    mkdirSync(join(raiz, b));
    writeFileSync(join(raiz, b, "ocupado.txt"), "x");
    await expect(s.guardar(b, bytes(8, 8, 8))).rejects.toThrow();
    expect(Array.from(await s.leer(a))).toEqual([1, 2, 3]);
    expect(archivos(join(raiz, "xml", t, c)).sort()).toEqual(
      [`${a.split("/").pop()}`, `${b.split("/").pop()}/ocupado.txt`].sort(),
    );
  });
});

describe("LocalStorage · enlaces simbólicos que salen de la raíz", () => {
  it("guardar a través de un directorio-enlace que sale de la raíz se rechaza y no escribe fuera", async () => {
    const t = randomUUID();
    const c = randomUUID();
    mkdirSync(join(raiz, "xml"), { recursive: true });
    symlinkSync(fuera, join(raiz, "xml", t), "dir");
    const s = new LocalStorage(raiz);
    await expect(s.guardar(rutaXml(t, c, randomUUID()), bytes(1))).rejects.toBeInstanceOf(
      RutaStorageError,
    );
    expect(readdirSync(fuera)).toEqual([]);
  });

  it("un enlace al nivel del cliente que sale de la raíz también se rechaza", async () => {
    const t = randomUUID();
    const c = randomUUID();
    mkdirSync(join(raiz, "xml", t), { recursive: true });
    symlinkSync(fuera, join(raiz, "xml", t, c), "dir");
    const s = new LocalStorage(raiz);
    await expect(s.guardar(rutaXml(t, c, randomUUID()), bytes(1))).rejects.toBeInstanceOf(
      RutaStorageError,
    );
    expect(readdirSync(fuera)).toEqual([]);
  });

  it("un archivo-enlace hacia fuera de la raíz no se puede leer", async () => {
    const t = randomUUID();
    const c = randomUUID();
    const u = randomUUID();
    writeFileSync(join(fuera, "secreto.txt"), "contenido-secreto");
    mkdirSync(join(raiz, "xml", t, c), { recursive: true });
    symlinkSync(join(fuera, "secreto.txt"), join(raiz, "xml", t, c, `${u}.xml`));
    const s = new LocalStorage(raiz);
    const e = await s.leer(rutaXml(t, c, u)).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RutaStorageError);
    expect((e as Error).message).not.toContain("secreto");
  });

  it("un archivo-enlace hacia fuera no se sobrescribe al guardar", async () => {
    const t = randomUUID();
    const c = randomUUID();
    const u = randomUUID();
    writeFileSync(join(fuera, "objetivo.txt"), "original");
    mkdirSync(join(raiz, "xml", t, c), { recursive: true });
    symlinkSync(join(fuera, "objetivo.txt"), join(raiz, "xml", t, c, `${u}.xml`));
    const s = new LocalStorage(raiz);
    await expect(s.guardar(rutaXml(t, c, u), bytes(1, 2))).rejects.toBeInstanceOf(RutaStorageError);
    expect(readFileSync(join(fuera, "objetivo.txt"), "utf8")).toBe("original");
  });

  it("eliminar a través de un directorio-enlace que sale de la raíz se rechaza y no borra fuera", async () => {
    const t = randomUUID();
    const c = randomUUID();
    const u = randomUUID();
    mkdirSync(join(fuera, c), { recursive: true });
    writeFileSync(join(fuera, c, `${u}.xml`), "no me borres");
    mkdirSync(join(raiz, "xml"), { recursive: true });
    symlinkSync(fuera, join(raiz, "xml", t), "dir");
    const s = new LocalStorage(raiz);
    await expect(s.eliminar(rutaXml(t, c, u))).rejects.toBeInstanceOf(RutaStorageError);
    expect(readFileSync(join(fuera, c, `${u}.xml`), "utf8")).toBe("no me borres");
  });

  it("un enlace que apunta dentro de la raíz sí es válido", async () => {
    const t = randomUUID();
    const c = randomUUID();
    const real = join(raiz, "almacen");
    mkdirSync(real);
    mkdirSync(join(raiz, "xml"), { recursive: true });
    symlinkSync(real, join(raiz, "xml", t), "dir");
    const s = new LocalStorage(raiz);
    const ruta = rutaXml(t, c, randomUUID());
    await s.guardar(ruta, bytes(5));
    expect(Array.from(await s.leer(ruta))).toEqual([5]);
  });
});

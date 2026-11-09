// Contrato común de StorageProvider: lo cumplen MockStorage y LocalStorage por igual.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ArchivoNoEncontradoError, RutaStorageError } from "./errores.js";
import { LocalStorage } from "./local.js";
import { MockStorage } from "./mock.js";
import type { StorageProvider } from "./puerto.js";
import { rutaXml } from "./ruta.js";

const raices: string[] = [];
afterAll(() => {
  for (const r of raices) rmSync(r, { recursive: true, force: true });
});

const fabricas: ReadonlyArray<[string, () => StorageProvider]> = [
  ["MockStorage", () => new MockStorage()],
  [
    "LocalStorage",
    () => {
      const raiz = mkdtempSync(join(tmpdir(), "storage-contrato-"));
      raices.push(raiz);
      return new LocalStorage(raiz);
    },
  ],
];

const nuevaRuta = (): string => rutaXml(randomUUID(), randomUUID(), randomUUID());
/** Todos los valores de byte, incluidos NUL y los de ISO-8859-1 (el XML se guarda tal cual llegó). */
const todosLosBytes = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => i);

describe.each(fabricas)("%s · contrato StorageProvider", (_nombre, crear) => {
  it("guardar y leer devuelven los mismos bytes (ida y vuelta)", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, todosLosBytes());
    expect(Array.from(await s.leer(ruta))).toEqual(Array.from(todosLosBytes()));
  });

  it("conserva bytes ISO-8859-1 sin reinterpretarlos", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const latin1 = Uint8Array.from([0x3c, 0x61, 0x3e, 0xf1, 0xe1, 0xe9, 0x3c, 0x2f, 0x61, 0x3e]);
    await s.guardar(ruta, latin1);
    expect(Array.from(await s.leer(ruta))).toEqual(Array.from(latin1));
  });

  it("guarda un archivo vacío", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, new Uint8Array(0));
    expect((await s.leer(ruta)).byteLength).toBe(0);
  });

  it("guarda 1 MiB (el tope del XML)", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const grande = new Uint8Array(1024 * 1024).fill(0x61);
    await s.guardar(ruta, grande);
    const leido = await s.leer(ruta);
    expect(leido.byteLength).toBe(grande.byteLength);
    expect(leido[0]).toBe(0x61);
    expect(leido[leido.byteLength - 1]).toBe(0x61);
  });

  it("guardar de nuevo la misma ruta reemplaza el contenido", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, Uint8Array.from([1, 2, 3, 4]));
    await s.guardar(ruta, Uint8Array.from([9]));
    expect(Array.from(await s.leer(ruta))).toEqual([9]);
  });

  it("guarda una copia: cambiar los bytes de entrada después no altera lo guardado", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const entrada = Uint8Array.from([1, 2, 3]);
    await s.guardar(ruta, entrada);
    entrada[0] = 99;
    expect(Array.from(await s.leer(ruta))).toEqual([1, 2, 3]);
  });

  it("devuelve una copia: cambiar lo leído no altera lo guardado", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, Uint8Array.from([1, 2, 3]));
    const primera = await s.leer(ruta);
    primera[0] = 99;
    expect(Array.from(await s.leer(ruta))).toEqual([1, 2, 3]);
  });

  it("rutas distintas no se mezclan", async () => {
    const s = crear();
    const a = nuevaRuta();
    const b = nuevaRuta();
    await s.guardar(a, Uint8Array.from([1]));
    await s.guardar(b, Uint8Array.from([2]));
    expect(Array.from(await s.leer(a))).toEqual([1]);
    expect(Array.from(await s.leer(b))).toEqual([2]);
  });

  it("leer algo inexistente lanza ArchivoNoEncontradoError sin la ruta en el mensaje", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const e = await s.leer(ruta).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ArchivoNoEncontradoError);
    const err = e as ArchivoNoEncontradoError;
    expect(err.codigo).toBe("storage_no_encontrado");
    expect(err.message).not.toContain(ruta);
    expect(err.message).not.toContain("xml/");
    expect(JSON.stringify(err)).not.toContain(ruta);
  });

  it("eliminar borra el archivo: leer después lanza ArchivoNoEncontradoError", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, Uint8Array.from([1]));
    await s.eliminar(ruta);
    await expect(s.leer(ruta)).rejects.toBeInstanceOf(ArchivoNoEncontradoError);
  });

  it("eliminar es idempotente: lo inexistente y la segunda vez no fallan", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await expect(s.eliminar(ruta)).resolves.toBeUndefined();
    await s.guardar(ruta, Uint8Array.from([1]));
    await expect(s.eliminar(ruta)).resolves.toBeUndefined();
    await expect(s.eliminar(ruta)).resolves.toBeUndefined();
  });

  it("eliminar no toca otras rutas", async () => {
    const s = crear();
    const a = nuevaRuta();
    const b = nuevaRuta();
    await s.guardar(a, Uint8Array.from([1]));
    await s.guardar(b, Uint8Array.from([2]));
    await s.eliminar(a);
    expect(Array.from(await s.leer(b))).toEqual([2]);
  });

  const U = randomUUID();
  const T = randomUUID();
  const C = randomUUID();
  describe.each([
    ["con «..»", `xml/${T}/../${C}/${U}.xml`],
    ["absoluta", `/xml/${T}/${C}/${U}.xml`],
    ["absoluta del sistema", "/etc/passwd"],
    ["con NUL", `xml/${T}/${C}/${U}.xml\0`],
    ["con barras invertidas", `xml\\${T}\\${C}\\${U}.xml`],
    ["con nombre libre", `xml/${T}/${C}/factura.xml`],
    ["vacía", ""],
  ])("ruta %s", (_n, mala) => {
    it("guardar, leer y eliminar la rechazan con RutaStorageError", async () => {
      const s = crear();
      await expect(s.guardar(mala, Uint8Array.from([1]))).rejects.toBeInstanceOf(RutaStorageError);
      await expect(s.leer(mala)).rejects.toBeInstanceOf(RutaStorageError);
      await expect(s.eliminar(mala)).rejects.toBeInstanceOf(RutaStorageError);
    });
  });

  it("el error de ruta inválida no incluye la ruta", async () => {
    const s = crear();
    const e = await s.leer("/etc/passwd-secreto").then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RutaStorageError);
    expect((e as Error).message).not.toContain("passwd-secreto");
  });
});

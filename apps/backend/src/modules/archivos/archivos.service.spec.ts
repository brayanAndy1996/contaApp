// Spec 012b (T16a) · `ArchivosService.descargar` sin BD: un fallo inesperado del storage (ni alterado, ni ausente, ni ruta inválida)
// no se disfraza de `archivo_alterado`: se propaga para que el filtro global lo responda como 500 genérico. Los casos de ZIP
// alterado, truncado o ausente los cubre `descarga.int.spec.ts`.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerVersion: vi.fn(),
}));
vi.mock("../compras/apoyo.js", async (original) => ({
  ...(await original<typeof import("../compras/apoyo.js")>()),
  exigirCliente: vi.fn().mockResolvedValue(undefined),
}));

import { leerVersion, type Alcance } from "@contapp/db";
import { rutaArchivo } from "@contapp/storage";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ArchivosError } from "./errores.js";
import { ArchivosService } from "./archivos.service.js";

const TENANT = "0190a000-0000-7000-8000-0000000000a1";
const USUARIO = "0190a000-0000-7000-8000-0000000000b1";
const CLIENTE = "0190a000-0000-7000-8000-0000000000c1";
const ARCHIVO = "0190a000-0000-7000-8000-0000000000d1";
const sesion = { tenantActivo: TENANT, usuarioId: USUARIO } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const HASH = "a".repeat(64);

const version = {
  id: ARCHIVO,
  nombreZip: "CONTAPP-PROVISIONAL-20100000001-202610-RCE.zip",
  ruta: rutaArchivo(TENANT, CLIENTE, ARCHIVO),
  sha256Zip: HASH,
};

function armar(leer: (ruta: string) => Promise<Uint8Array>) {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ tx: true })));
  const storage = { guardar: vi.fn(), leer: vi.fn(leer), eliminar: vi.fn() };
  return { storage, servicio: new ArchivosService({ withTenant } as never, { encolar: vi.fn() } as never, storage as never) };
}

beforeEach(() => {
  vi.mocked(leerVersion).mockResolvedValue(version as never);
});

describe("descargar · fallo inesperado del storage", () => {
  it("se propaga tal cual, sin convertirse en archivo_alterado", async () => {
    const falla = new Error("EIO: error de disco");
    const { servicio, storage } = armar(() => Promise.reject(falla));
    const r = servicio.descargar(sesion, alcance, CLIENTE, "202610", "compras", ARCHIVO);
    await expect(r).rejects.toBe(falla);
    await expect(r).rejects.not.toBeInstanceOf(ArchivosError);
    expect(storage.leer).toHaveBeenCalledExactlyOnceWith(version.ruta);
  });

  it("control: un ZIP cuyo hash no coincide sí es archivo_alterado", async () => {
    const { servicio } = armar(() => Promise.resolve(new Uint8Array([1, 2, 3])));
    await expect(servicio.descargar(sesion, alcance, CLIENTE, "202610", "compras", ARCHIVO)).rejects.toMatchObject({ codigo: "archivo_alterado" });
  });
});

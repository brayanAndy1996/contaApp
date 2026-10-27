// T17 · R2b-4 (CA-11): exigirSalidaIgnorada decide si kek:generar puede escribir la privada en `salida`.
// No genera llaves: solo consulta a git. Las raíces falsas viven en un directorio temporal y
// GIT_CEILING_DIRECTORIES impide que git suba a un repositorio padre.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raizRepo } from "../comun/raiz";
import { borrarDir, crearDirTemporal } from "../soporte-pruebas";
import { exigirSalidaIgnorada } from "./kek-generar";

let dir: string;
let techoPrevio: string | undefined;

beforeAll(async () => {
  dir = await crearDirTemporal();
  techoPrevio = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
});

afterAll(async () => {
  if (techoPrevio === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = techoPrevio;
  if (dir) await borrarDir(dir);
});

describe("exigirSalidaIgnorada", () => {
  it("acepta una carpeta del repo que git ignora (secrets/) y una fuera del repo", () => {
    const raiz = raizRepo();
    expect(() => exigirSalidaIgnorada(join(raiz, "secrets", "t17"), raiz)).not.toThrow();
    expect(() => exigirSalidaIgnorada(join(dir, "fuera"), raiz)).not.toThrow();
  });

  it("rechaza una carpeta del repo que git no ignora, sin repetir la ruta", () => {
    const raiz = raizRepo();
    const salida = join(raiz, "packages", "crypto", "t17-no-ignorada");
    expect(() => exigirSalidaIgnorada(salida, raiz)).toThrow(/git no la ignora/);
    try {
      exigirSalidaIgnorada(salida, raiz);
    } catch (e) {
      expect((e as Error).message).not.toContain("t17-no-ignorada");
    }
  });

  it("sin repositorio git no hay nada que versionar; con un .git que git no reconoce, falla cerrado", async () => {
    const sinGit = join(dir, "sin-git");
    const conGit = join(dir, "con-git");
    await mkdir(sinGit, { recursive: true });
    await mkdir(join(conGit, ".git"), { recursive: true });
    expect(() => exigirSalidaIgnorada(join(sinGit, "llaves"), sinGit)).not.toThrow();
    expect(() => exigirSalidaIgnorada(join(conGit, "llaves"), conGit)).toThrow(/git no la ignora/);
  });
});

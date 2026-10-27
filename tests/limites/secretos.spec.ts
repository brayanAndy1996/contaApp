import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CA-11 (spec 003): `./secrets/` está ignorado por git y en el repo no hay ninguna llave
// privada salvo el fixture `mock`, marcado. El encabezado se arma por concatenación para que
// este archivo no se detecte a sí mismo.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = "packages/crypto/fixtures/mock-kek/SOLO-PRUEBAS-kek-mock-private.pem";
const ENCABEZADO = "-----BEGIN " + "([A-Z]+ )?PRIVATE KEY-----";

function git(...args: string[]) {
  return spawnSync("git", args, { cwd: RAIZ, encoding: "utf8" });
}

describe("CA-11: llaves locales fuera del repo", () => {
  it.each([
    "secrets/kek-private.pem",
    "secrets/kek-public.pem",
    "apps/worker/.env",
    ".env",
  ])("git ignora %s", (ruta) => {
    const r = git("check-ignore", ruta);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(ruta);
  });

  it("la única llave privada versionada es el fixture mock", () => {
    const r = git("grep", "-lE", "--", ENCABEZADO);
    // status 0 = hay coincidencias; 1 = ninguna; otro = error de git.
    expect([0, 1]).toContain(r.status);
    const archivos = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(archivos).toEqual([FIXTURE]);
  });

  it("el fixture mock está marcado como solo para pruebas", () => {
    expect(path.basename(FIXTURE)).toMatch(/^SOLO-PRUEBAS-/);
    expect(existsSync(path.join(RAIZ, FIXTURE))).toBe(true);
    const leeme = path.join(RAIZ, "packages/crypto/fixtures/mock-kek/LEEME.md");
    expect(existsSync(leeme)).toBe(true);
  });

  it("el fixture mock está versionado (git lo conoce)", () => {
    const salida = execFileSync("git", ["ls-files", "--", FIXTURE], {
      cwd: RAIZ,
      encoding: "utf8",
    });
    expect(salida.trim()).toBe(FIXTURE);
  });

  it(".env.example no contiene llaves privadas", () => {
    const r = git("grep", "-lE", "--", ENCABEZADO, "--", ".env.example");
    expect(r.status).toBe(1);
  });
});

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as entradaCifrado from "./index";
import * as entradaDescifrado from "./descifrado";

// Estructura (plan.md, Decisiones: Estructura): el punto de entrada de cifrado (lo usa el backend)
// nunca alcanza el código de descifrado, ni transitivamente.
const SRC = __dirname;
const DIST = resolve(SRC, "..", "dist");
const DIST_INDEX = join(DIST, "index.js");

function esArchivo(ruta: string): boolean {
  return existsSync(ruta) && statSync(ruta).isFile();
}

function resolverRelativo(desde: string, especificador: string): string | null {
  const base = resolve(dirname(desde), especificador);
  for (const candidato of [
    base,
    `${base}.ts`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ]) {
    if (esArchivo(candidato) && !candidato.endsWith(".d.ts")) return candidato;
  }
  return null;
}

/** Recorre import/export/require relativos y devuelve los archivos alcanzables y los especificadores no relativos. */
function alcanzables(raiz: string): { archivos: string[]; externos: string[] } {
  const vistos = new Set<string>();
  const externos = new Set<string>();
  const pendientes = [raiz];
  const patron =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  while (pendientes.length > 0) {
    const archivo = pendientes.pop() as string;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const texto = readFileSync(archivo, "utf8");
    for (const m of texto.matchAll(patron)) {
      const especificador = m[1] as string;
      if (especificador.startsWith(".")) {
        const destino = resolverRelativo(archivo, especificador);
        if (destino) pendientes.push(destino);
        else externos.add(especificador);
      } else {
        externos.add(especificador);
      }
    }
  }
  return { archivos: [...vistos], externos: [...externos] };
}

const esDescifrado = (base: string) => (a: string) =>
  /[\\/]descifrado([\\/.]|$)/.test(a.slice(base.length));

describe("estructura: el lado de cifrado no alcanza el descifrado", () => {
  it("src/index.ts no alcanza (transitivamente) ningún archivo de descifrado", () => {
    const { archivos } = alcanzables(resolve(SRC, "index.ts"));
    expect(archivos.filter(esDescifrado(SRC))).toEqual([]);
    expect(archivos.length).toBeGreaterThan(1);
  });

  it("src/index.ts no importa el CLI ni especificadores de descifrado", () => {
    const { archivos, externos } = alcanzables(resolve(SRC, "index.ts"));
    expect(archivos.some((a) => /[\\/]cli[\\/]/.test(a))).toBe(false);
    expect(externos.filter((e) => e.includes("descifrado"))).toEqual([]);
  });

  it("dist/index.js (si está compilado) no requiere descifrado", () => {
    if (!existsSync(DIST_INDEX)) return;
    const { archivos, externos } = alcanzables(DIST_INDEX);
    expect(archivos.filter(esDescifrado(DIST))).toEqual([]);
    expect(externos.filter((e) => e.includes("descifrado"))).toEqual([]);
  });

  it("la entrada de cifrado expone cifrado y no expone descifrado", () => {
    const nombres = Object.keys(entradaCifrado);
    expect(nombres).toEqual(
      expect.arrayContaining(["cifrarCredencial", "crearKeyWrapper"]),
    );
    for (const prohibido of [
      "descifrarSobre",
      "crearKeyUnwrapper",
      "crearKeyUnwrapperAnterior",
      "reenvolverDek",
      "Secreto",
    ]) {
      expect(nombres).not.toContain(prohibido);
    }
  });

  it("la entrada de descifrado expone el contrato del worker", () => {
    expect(Object.keys(entradaDescifrado)).toEqual(
      expect.arrayContaining([
        "descifrarSobre",
        "crearKeyUnwrapper",
        "crearKeyUnwrapperAnterior",
        "reenvolverDek",
        "Secreto",
      ]),
    );
  });

  it("ambas entradas comparten las mismas clases de error", () => {
    for (const nombre of [
      "CryptoError",
      "IntegridadError",
      "KeyProviderError",
      "KekDesconocidaError",
      "SobreInvalidoError",
      "ContextoAadInvalidoError",
      "SecretoInvalidoError",
      "ConfiguracionKeyProviderError",
    ]) {
      const a = (entradaCifrado as Record<string, unknown>)[nombre];
      const b = (entradaDescifrado as Record<string, unknown>)[nombre];
      expect(typeof a, nombre).toBe("function");
      expect(a, nombre).toBe(b);
    }
  });
});

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Prueba estática del diseño visual (spec 038, T-final; CA-5, regla 4 de la fase 2):
// ninguna pantalla ni componente de `app/` y `components/` usa colores sueltos. Los colores salen de los
// tokens de `app/globals.css` (que es donde se definen) y de `components/ui/` (los componentes base).
// Es el mismo patrón de la regla 4 de `tasks.md`:
//   grep -nE "(text|bg|border|ring|outline|divide|fill|stroke)-(red|green|…|white)\b|#[0-9a-fA-F]{6}" <archivos>

const RAIZ = dirname(fileURLToPath(import.meta.url));
const IGNORADOS = new Set(["node_modules", ".next", "coverage", "dist"]);

const COLOR_SUELTO =
  /(text|bg|border|ring|outline|divide|fill|stroke)-(red|green|blue|yellow|amber|gray|slate|zinc|neutral|stone|orange|emerald|sky|indigo|black|white)\b|#[0-9a-fA-F]{6}/;

const esPrueba = (ruta: string): boolean =>
  /\.(spec|test|e2e)\.[cm]?[tj]sx?$/.test(ruta);

function archivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    if (IGNORADOS.has(nombre)) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else salida.push(ruta);
  }
  return salida;
}

const rel = (ruta: string): string => relative(RAIZ, ruta).split(sep).join("/");

/** Archivos de pantalla: `app/` y `components/`, sin `components/ui/`, sin pruebas y sin `app/globals.css`. */
const REVISADOS = [
  ...archivos(join(RAIZ, "app")),
  ...archivos(join(RAIZ, "components")),
]
  .map(rel)
  .filter(
    (r) =>
      !r.startsWith("components/ui/") &&
      r !== "app/globals.css" &&
      !esPrueba(r) &&
      /\.(ts|tsx|css)$/.test(r),
  );

function sueltos(rutas: readonly string[]): string[] {
  const hallazgos: string[] = [];
  for (const r of rutas) {
    readFileSync(join(RAIZ, r), "utf8")
      .split("\n")
      .forEach((linea, i) => {
        if (COLOR_SUELTO.test(linea))
          hallazgos.push(`${r}:${i + 1}: ${linea.trim()}`);
      });
  }
  return hallazgos;
}

describe("diseño visual · colores solo con tokens (CA-5)", () => {
  it("revisa las pantallas y los componentes (no un conjunto vacío)", () => {
    expect(REVISADOS.length).toBeGreaterThan(70);
    expect(REVISADOS.some((r) => r.startsWith("app/"))).toBe(true);
    expect(REVISADOS.some((r) => r.startsWith("components/compras/"))).toBe(
      true,
    );
    expect(REVISADOS.some((r) => r.startsWith("components/ui/"))).toBe(false);
    expect(REVISADOS.some((r) => esPrueba(r))).toBe(false);
  });

  it("ningún archivo de app/ ni components/ usa colores sueltos", () => {
    expect(sueltos(REVISADOS)).toEqual([]);
  });

  it("el patrón detecta los colores sueltos típicos y deja pasar los tokens", () => {
    for (const malo of [
      'className="text-red-600"',
      'className="bg-black/30"',
      'className="border-gray-200"',
      'style={{ color: "#ff0000" }}',
      'className="fill-white"',
    ]) {
      expect(COLOR_SUELTO.test(malo), malo).toBe(true);
    }
    for (const bueno of [
      'className="text-tinta bg-hoja border-linea"',
      'className="ring-primario text-error"',
      'className="bg-primario-suave text-ok"',
    ]) {
      expect(COLOR_SUELTO.test(bueno), bueno).toBe(false);
    }
  });

  it("los colores literales viven solo en los tokens de globals.css y en components/ui/", () => {
    const css = archivos(join(RAIZ, "app"))
      .map(rel)
      .filter((r) => r.endsWith(".css"));
    expect(css).toEqual(["app/globals.css"]);
    expect(readFileSync(join(RAIZ, "app/globals.css"), "utf8")).toMatch(
      /--color-primario:\s*#[0-9a-fA-F]{6}/,
    );
  });
});

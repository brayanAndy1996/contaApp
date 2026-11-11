import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pruebas estáticas de la pantalla de compras (spec 015, T2; D-2, D-3, CA-5, CA-17):
// - `apps/frontend` solo importa `@contapp/shared` (más las librerías externas de P-1 y P-2).
// - `decimal.js` solo se importa en `lib/montos-compras.ts`, y ese archivo no convierte nada a `number`.
// - `lib/compras.ts` y `components/compras/` no convierten ni formatean montos con `number` y no inyectan HTML
//   del SIRE (razón social, motivo y glosa son texto no confiable que React escapa).
// Los `number` de conteos (posiciones, filas) son legítimos: lo que se prohíbe es convertir o formatear con
// `parseFloat`, `parseInt`, `Number(`, `toFixed`, `toLocaleString`, y declarar `number` en un campo monetario.

const RAIZ = dirname(fileURLToPath(import.meta.url));
const IGNORADOS = new Set(["node_modules", ".next", "coverage", "dist"]);
const MONTOS = "lib/montos-compras.ts";

function archivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    if (IGNORADOS.has(nombre)) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.(ts|tsx|mts)$/.test(nombre)) salida.push(ruta);
  }
  return salida;
}

const sinComentarios = (fuente: string): string =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Especificadores de `import … from "x"`, `import "x"`, `import("x")`, `require("x")` y `export … from "x"`. */
function especificadores(fuente: string): string[] {
  const limpia = sinComentarios(fuente);
  const encontrados: string[] = [];
  const patrones = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const patron of patrones) {
    for (const m of limpia.matchAll(patron)) encontrados.push(m[1]!);
  }
  return encontrados;
}

const TODOS = archivos(RAIZ);

/** Código de producción de la pantalla de compras: `lib/compras.ts`, `lib/edicion-compras.ts`, `lib/filas-compras.ts`, `lib/lupa-compras.ts` (016), `lib/archivos.ts` y `components/archivos/` (012b) y `components/compras/` (sin pruebas). */
function codigoDeCompras(): { ruta: string; texto: string }[] {
  const candidatos = [
    join(RAIZ, "lib/compras.ts"),
    join(RAIZ, "lib/edicion-compras.ts"),
    join(RAIZ, "lib/filas-compras.ts"),
    join(RAIZ, "lib/lupa-compras.ts"),
    join(RAIZ, "lib/archivos.ts"),
    ...archivos(join(RAIZ, "components/compras")),
    ...archivos(join(RAIZ, "components/archivos")),
  ].filter((r) => existsSync(r) && !/\.spec\.(ts|tsx)$/.test(r));
  return candidatos.map((r) => ({
    ruta: relative(RAIZ, r),
    texto: sinComentarios(readFileSync(r, "utf8")),
  }));
}

describe("apps/frontend · solo depende de @contapp/shared (D-2, CA-17)", () => {
  it("ningún archivo importa otro @contapp/* ni sale de apps/frontend con una ruta relativa", () => {
    const infracciones: string[] = [];
    for (const archivo of TODOS) {
      for (const spec of especificadores(readFileSync(archivo, "utf8"))) {
        const visible = `${relative(RAIZ, archivo)} → ${spec}`;
        if (spec.startsWith("@contapp/") && spec !== "@contapp/shared") {
          infracciones.push(visible);
        } else if (spec.startsWith(".")) {
          const destino = resolve(dirname(archivo), spec);
          if (destino !== RAIZ && !destino.startsWith(RAIZ + sep)) {
            infracciones.push(visible);
          }
        } else if (/(^|\/)(packages|apps\/(backend|worker))\//.test(spec)) {
          infracciones.push(visible);
        }
      }
    }
    expect(infracciones).toEqual([]);
  });

  it("package.json: solo @contapp/shared entre los paquetes propios y las tres librerías de la grilla con versión exacta", () => {
    const paquete = JSON.parse(
      readFileSync(join(RAIZ, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const propios = Object.keys(paquete.dependencies).filter((n) =>
      n.startsWith("@contapp/"),
    );
    expect(propios).toEqual(["@contapp/shared"]);
    for (const nombre of [
      "@tanstack/react-table",
      "@tanstack/react-virtual",
      "decimal.js",
    ]) {
      expect(paquete.dependencies[nombre]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("decimal.js solo en lib/montos-compras.ts (D-3, CA-5)", () => {
  it("existe el archivo de montos y es el único que importa decimal.js", () => {
    expect(existsSync(join(RAIZ, MONTOS))).toBe(true);
    const importan = TODOS.filter((archivo) =>
      especificadores(readFileSync(archivo, "utf8")).includes("decimal.js"),
    ).map((archivo) => relative(RAIZ, archivo));
    expect(importan).toEqual([MONTOS]);
  });

  it("lib/montos-compras.ts no convierte nada a number ni formatea con la configuración regional", () => {
    const texto = sinComentarios(readFileSync(join(RAIZ, MONTOS), "utf8"));
    expect(texto).not.toMatch(
      /\btoNumber\s*\(|\bNumber\s*[(.]|\bparseFloat\b|\bparseInt\b|\.toLocaleString\s*\(|Intl\.NumberFormat|\.valueOf\s*\(|\bMath\./,
    );
  });
});

describe("lib/compras.ts y components/compras/ · montos como cadenas (D-3, CA-5)", () => {
  it("hay código de compras que revisar", () => {
    expect(codigoDeCompras().length).toBeGreaterThanOrEqual(1);
  });

  it("no convierte ni formatea con number (parseFloat, parseInt, Number(, toFixed, toLocaleString, Intl.NumberFormat, Decimal)", () => {
    const prohibido =
      /\bparseFloat\b|\bparseInt\b|\bNumber\s*[(.]|\.toFixed\s*\(|\.toLocaleString\s*\(|Intl\.NumberFormat|\btoNumber\s*\(|\bnew\s+Decimal\b|from\s+["']decimal\.js["']/;
    const infracciones = codigoDeCompras()
      .filter((c) => prohibido.test(c.texto))
      .map((c) => c.ruta);
    expect(infracciones).toEqual([]);
  });

  it("ningún campo monetario se declara como number", () => {
    const monetario =
      /\b(monto|montos|total|totales|igv|bi[A-Z]\w*|isc|icbper|importe|saldo|casillero\w*|suma|base)\w*\s*\??\s*:\s*number\b/i;
    const infracciones = codigoDeCompras()
      .filter((c) => monetario.test(c.texto))
      .map((c) => c.ruta);
    expect(infracciones).toEqual([]);
  });

  it("no inyecta HTML del SIRE (dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML)", () => {
    const infracciones = codigoDeCompras()
      .filter((c) =>
        /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/.test(
          c.texto,
        ),
      )
      .map((c) => c.ruta);
    expect(infracciones).toEqual([]);
  });
});

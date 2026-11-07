import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pruebas estáticas de la pantalla de ventas (spec 013, T7; D14, CA-13):
// - `apps/frontend` solo depende de `@contapp/shared` (CLAUDE.md): ningún otro `@contapp/*`, ninguna
//   importación relativa que salga de `apps/frontend` y ninguna dependencia de otro paquete del monorepo.
// - La pantalla de ventas no calcula cifras con `number` ni da formato numérico a los montos: muestra las
//   cadenas del servidor.

const RAIZ = dirname(fileURLToPath(import.meta.url));
const IGNORADOS = new Set(["node_modules", ".next", "coverage", "dist"]);

function archivos(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    if (IGNORADOS.has(nombre)) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (/\.(ts|tsx|mts)$/.test(nombre)) salida.push(ruta);
  }
  return salida;
}

/** Especificadores de `import … from "x"`, `import "x"`, `import("x")`, `require("x")` y `export … from "x"`. */
function especificadores(fuente: string): string[] {
  const sinComentarios = fuente
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const encontrados: string[] = [];
  const patrones = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const patron of patrones) {
    for (const m of sinComentarios.matchAll(patron)) encontrados.push(m[1]!);
  }
  return encontrados;
}

const TODOS = archivos(RAIZ);

describe("apps/frontend · solo depende de @contapp/shared (CA-13)", () => {
  it("hay archivos que revisar", () => {
    expect(TODOS.length).toBeGreaterThan(20);
  });

  it("ningún archivo importa otro @contapp/* ni sale de apps/frontend con una ruta relativa", () => {
    const infracciones: string[] = [];
    for (const archivo of TODOS) {
      for (const spec of especificadores(readFileSync(archivo, "utf8"))) {
        const visible = `${relative(RAIZ, archivo)} → ${spec}`;
        if (spec.startsWith("@contapp/") && spec !== "@contapp/shared") {
          infracciones.push(visible);
        } else if (spec.startsWith("@contapp/shared/")) {
          // Subrutas internas de shared: solo se importa su entrada pública.
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

  it("package.json solo declara @contapp/shared entre los paquetes del monorepo", () => {
    const paquete = JSON.parse(
      readFileSync(join(RAIZ, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const propios = [
      ...Object.keys(paquete["dependencies"] ?? {}),
      ...Object.keys(paquete["devDependencies"] ?? {}),
    ].filter((n) => n.startsWith("@contapp/"));
    expect(propios).toEqual(["@contapp/shared"]);
  });
});

describe("pantalla de ventas · archivos del plan y montos como cadenas (D14)", () => {
  const PAGINA = "app/(app)/clientes/[clienteId]/ventas/page.tsx";
  const IMPORTAR = "app/(app)/clientes/[clienteId]/ventas/importar/page.tsx";
  const CLIENTE = "lib/ventas.ts";

  it.each([PAGINA, IMPORTAR, CLIENTE])("existe %s", (ruta) => {
    expect(existsSync(join(RAIZ, ruta))).toBe(true);
  });

  /** Código de la pantalla de ventas: sus páginas, `lib/ventas.ts` y `components/ventas/`. */
  function codigoDeVentas(): { ruta: string; texto: string }[] {
    const candidatos = [
      ...archivos(join(RAIZ, "app/(app)/clientes/[clienteId]/ventas")),
      ...(existsSync(join(RAIZ, "components/ventas"))
        ? archivos(join(RAIZ, "components/ventas"))
        : []),
      ...(existsSync(join(RAIZ, CLIENTE)) ? [join(RAIZ, CLIENTE)] : []),
    ];
    return candidatos
      .filter((r) => !/\.spec\.(ts|tsx)$/.test(r))
      .map((r) => ({
        ruta: relative(RAIZ, r),
        texto: readFileSync(r, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1"),
      }));
  }

  it("hay código de ventas que revisar", () => {
    expect(codigoDeVentas().length).toBeGreaterThanOrEqual(3);
  });

  it("no convierte ni formatea montos con number (parseFloat, toFixed, toLocaleString, Intl.NumberFormat, Decimal)", () => {
    const prohibido =
      /\bparseFloat\s*\(|\.toFixed\s*\(|\.toLocaleString\s*\(|Intl\.NumberFormat|\bnew\s+Decimal\b|from\s+["']decimal\.js["']/;
    const infracciones = codigoDeVentas()
      .filter((c) => prohibido.test(c.texto))
      .map((c) => c.ruta);
    expect(infracciones).toEqual([]);
  });

  it("no inyecta HTML del SIRE (dangerouslySetInnerHTML, innerHTML)", () => {
    const infracciones = codigoDeVentas()
      .filter((c) => /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/.test(c.texto))
      .map((c) => c.ruta);
    expect(infracciones).toEqual([]);
  });
});

// Spec 012b (T4, rojo): reglas de capas y superficie publica de `packages/db/src/archivos/` y de los archivos nuevos de
// `src/ventas/`. Unitarias (leen el codigo fuente; no usan Postgres). Regla de capas (plan «Archivos»): `packages/db` no depende de
// `domain` ni de `storage` (los adaptadores de fila entran inyectados). Dinero: ningun monto como `number`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = `${resolve(__dirname, "..")}/`;
const fuentesDe = (carpeta: string, solo?: string[]) => {
  const dir = `${raiz}${carpeta}/`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts") &&
        !f.endsWith(".int.spec.ts"),
    )
    .filter((f) => !solo || solo.includes(f))
    .map((f) => ({
      ruta: `${carpeta}/${f}`,
      codigo: readFileSync(`${dir}${f}`, "utf8"),
    }));
};
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ARCHIVOS = ["errores.ts", "versiones.ts", "lectura.ts", "index.ts"];
const NUEVOS_VENTAS = ["periodo.ts", "exclusion.ts", "filas-reemplazo.ts"];

describe("estructura de packages/db/src/archivos y de los archivos nuevos de ventas (plan «Archivos»)", () => {
  it.each(ARCHIVOS)("existe archivos/%s", (f) => {
    expect(
      fuentesDe("archivos").map((x) => x.ruta.split("/")[1]),
      "falta la carpeta o el archivo (T10)",
    ).toContain(f);
  });
  it.each(NUEVOS_VENTAS)("existe ventas/%s", (f) => {
    expect(
      fuentesDe("ventas").map((x) => x.ruta.split("/")[1]),
      "falta el archivo (T10)",
    ).toContain(f);
  });
});

describe("regla de capas: packages/db no depende del dominio, de SUNAT ni de storage", () => {
  it("ningun archivo nuevo importa @contapp/domain, sunat, storage, queue ni crypto", () => {
    const todos = [
      ...fuentesDe("archivos"),
      ...fuentesDe("ventas", NUEVOS_VENTAS),
    ];
    expect(todos.length, "no hay codigo todavia").toBeGreaterThan(0);
    for (const { ruta, codigo } of todos) {
      const c = sinComentarios(codigo);
      expect(c, ruta).not.toMatch(
        /@contapp\/(domain|sunat|storage|queue|crypto)/,
      );
      expect(c, ruta).not.toMatch(/packages\/(domain|sunat|storage)/);
    }
  });

  it("package.json de packages/db no declara domain ni storage como dependencia", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    });
    expect(deps).not.toContain("@contapp/domain");
    expect(deps).not.toContain("@contapp/storage");
  });
});

describe("dinero y logs", () => {
  it("sin parseFloat, toFixed ni Math.round, y ningun campo de monto tipado number", () => {
    const todos = [
      ...fuentesDe("archivos"),
      ...fuentesDe("ventas", NUEVOS_VENTAS),
    ];
    expect(todos.length, "no hay codigo todavia").toBeGreaterThan(0);
    for (const { ruta, codigo } of todos) {
      const c = sinComentarios(codigo);
      expect(c, `${ruta}: aritmetica de punto flotante`).not.toMatch(
        /parseFloat|\.toFixed\(|Math\.(round|floor|ceil)\(/,
      );
      expect(c, `${ruta}: monto tipado number`).not.toMatch(
        /\b(impacto\w*|igv\w*|monto\w*|total|baseGravada)\s*\??:\s*number\b/i,
      );
    }
  });

  it("no registra nada con console (ninguna ruta, hash ni motivo va a un log)", () => {
    const todos = [
      ...fuentesDe("archivos"),
      ...fuentesDe("ventas", NUEVOS_VENTAS),
    ];
    expect(todos.length, "no hay codigo todavia").toBeGreaterThan(0);
    for (const { ruta, codigo } of todos)
      expect(sinComentarios(codigo), ruta).not.toMatch(
        /console\.(log|info|warn|error|debug)/,
      );
  });
});

describe("superficie publica de @contapp/db (T10 la exporta desde index.ts)", () => {
  const indice = () => readFileSync(`${raiz}index.ts`, "utf8");
  const nombres = (): { nombre: string; origen: string }[] =>
    [
      ...indice().matchAll(
        /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
      ),
    ].flatMap((m) =>
      m[1]
        .split(",")
        .map((n) =>
          n
            .replace(/\btype\b/, "")
            .trim()
            .split(/\s+as\s+/)
            .pop()!,
        )
        .filter(Boolean)
        .map((nombre) => ({ nombre, origen: m[2] })),
    );

  it("exporta las funciones de archivos, de ventas y las tablas del contrato", () => {
    const n = nombres().map((x) => x.nombre);
    for (const esperado of [
      "ultimaVersion",
      "insertarVersion",
      "listarVersiones",
      "leerVersion",
      "ArchivosRepoError",
      "leerEstadoPeriodoVentas",
      "fijarEstadoPeriodoVentas",
      "excluirVenta",
      "restaurarVenta",
      "exclusionVigente",
      "leerFilasReemplazoVentas",
      "leerExcluidasVentas",
      "archivoGenerado",
      "ventaPeriodo",
      "ventaExclusion",
    ])
      expect(n, `falta exportar ${esperado}`).toContain(esperado);
  });

  it("las funciones salen de los archivos del plan", () => {
    const origenDe = (nombre: string) =>
      nombres().find((x) => x.nombre === nombre)?.origen ?? "";
    expect(origenDe("leerEstadoPeriodoVentas")).toMatch(/ventas\/periodo$/);
    expect(origenDe("fijarEstadoPeriodoVentas")).toMatch(/ventas\/periodo$/);
    expect(origenDe("excluirVenta")).toMatch(/ventas\/exclusion$/);
    expect(origenDe("leerFilasReemplazoVentas")).toMatch(
      /ventas\/filas-reemplazo$/,
    );
    expect(origenDe("ultimaVersion")).toMatch(/archivos\//);
    expect(origenDe("archivoGenerado")).toMatch(/schema\/archivos$/);
    expect(origenDe("ventaExclusion")).toMatch(/schema\/ventas$/);
  });

  it("no hay nombres exportados repetidos (no pisa a 013, 014 ni 016)", () => {
    const n = nombres().map((x) => x.nombre);
    expect(n.filter((x, i) => n.indexOf(x) !== i)).toEqual([]);
  });
});

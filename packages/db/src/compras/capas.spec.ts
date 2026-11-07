// Spec 014 (T6, rojo): reglas de capas de `packages/db/src/compras/` y superficie publica. Unitarias (leen el codigo fuente; no
// usan Postgres). Regla de capas (013 D16, plan «Archivos»): `packages/db` no depende de `packages/domain`; lo que necesite el
// dominio entra como funcion inyectada. CA-16: ningun monto como `number` en repositorios.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const carpeta = `${__dirname}/`;
const raiz = `${resolve(__dirname, "..")}/`;
const fuentes = () =>
  existsSync(carpeta)
    ? readdirSync(carpeta).filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.endsWith(".spec.ts") &&
          !f.endsWith(".int.spec.ts"),
      )
    : [];
const leer = (f: string) => readFileSync(`${carpeta}${f}`, "utf8");
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ARCHIVOS = [
  "errores.ts",
  "repositorio.ts",
  "versiones.ts",
  "operaciones.ts",
  "periodo.ts",
  "existentes.ts",
  "filas-reemplazo.ts",
];

describe("estructura de packages/db/src/compras (plan «Archivos»)", () => {
  it.each(ARCHIVOS)("existe %s", (f) => {
    expect(fuentes(), "falta la carpeta o el archivo (T12)").toContain(f);
  });
});

describe("regla de capas: packages/db no depende del dominio ni de SUNAT (013 D16)", () => {
  it("ningun archivo de compras/ importa @contapp/domain, @contapp/sunat ni rutas de packages/domain", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de compras todavia").toBeGreaterThan(
      0,
    );
    for (const f of archivos) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, f).not.toMatch(/@contapp\/(domain|sunat|queue|crypto)/);
      expect(codigo, f).not.toMatch(/packages\/(domain|sunat)/);
      expect(codigo, f).not.toMatch(/from\s+["'][^"']*\/domain\//);
    }
  });

  it("package.json de packages/db no declara @contapp/domain como dependencia", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    expect(Object.keys(deps)).not.toContain("@contapp/domain");
  });
});

describe("dinero: ningun monto como number (CA-16, regla de CLAUDE.md)", () => {
  it("sin parseFloat, toFixed ni Math.round, y ningun campo de monto tipado number", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de compras todavia").toBeGreaterThan(
      0,
    );
    for (const f of archivos) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, `${f}: aritmetica de punto flotante`).not.toMatch(
        /parseFloat|\.toFixed\(|Math\.(round|floor|ceil)\(/,
      );
      expect(codigo, `${f}: monto tipado number`).not.toMatch(
        /\b(bi\w*|igv\w*|isc|icbper|total|monto\w*|noGravado|otrosTributos)\s*\??:\s*number\b/i,
      );
    }
  });

  it("no registra nada con console (ningun log lleva montos, claves ni razones sociales; D-12)", () => {
    expect(
      fuentes().length,
      "no hay codigo de compras todavia",
    ).toBeGreaterThan(0);
    for (const f of fuentes())
      expect(sinComentarios(leer(f)), f).not.toMatch(
        /console\.(log|info|warn|error|debug)/,
      );
  });
});

describe("superficie publica de @contapp/db (T12 la exporta desde index.ts)", () => {
  const indice = () => readFileSync(`${raiz}index.ts`, "utf8");
  const exportadosDe = (origen: RegExp): string[] => {
    const nombres: string[] = [];
    for (const m of indice().matchAll(
      /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      if (origen.test(m[2]))
        nombres.push(
          ...m[1]
            .split(",")
            .map((n) =>
              n
                .replace(/\btype\b/, "")
                .trim()
                .split(/\s+as\s+/)
                .pop()!,
            )
            .filter(Boolean),
        );
    }
    return nombres;
  };

  it("exporta las funciones del contrato (con `leerExistentesCompras`: `leerExistentes` ya es de ventas)", () => {
    const nombres = exportadosDe(/^\.\/compras\//);
    for (const n of [
      "crearVersion",
      "aplicarAccion",
      "aplicarMasiva",
      "deshacer",
      "rehacer",
      "agregarCompra",
      "descartar",
      "insertarCompras",
      "leerExistentesCompras",
      "leerProveedoresConocidos",
      "leerEstadoPeriodo",
      "fijarEstadoPeriodo",
      "leerFilasReemplazo",
      "ComprasRepoError",
      "ComprasReglaError",
    ]) {
      expect(nombres, `falta exportar ${n} desde ./compras/*`).toContain(n);
    }
  });

  it("no pisa los nombres que 013 ya exporta (leerExistentes de ventas se conserva una sola vez)", () => {
    const todos = [
      ...indice().matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g),
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
        .filter(Boolean),
    );
    expect(todos.filter((n) => n === "leerExistentes")).toHaveLength(1);
    const duplicados = todos.filter((n, i) => todos.indexOf(n) !== i);
    expect(duplicados).toEqual([]);
  });

  it("exporta las tablas de drizzle de compras desde ./schema/compras", () => {
    const nombres = exportadosDe(/^\.\/schema\/compras$/);
    for (const n of [
      "compra",
      "compraVersion",
      "compraOperacion",
      "compraHallazgo",
      "compraPeriodo",
    ]) {
      expect(nombres, `falta exportar la tabla ${n}`).toContain(n);
    }
  });
});

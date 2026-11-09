// Spec 016 (T5, rojo): reglas de capas de `packages/db/src/xml/` y superficie publica. Unitarias (leen el codigo fuente; no usan
// Postgres). Regla de capas (013 D16, plan «Archivos»): `packages/db` no depende de `domain` ni de `storage`; el dominio (parser,
// mapeo a ResumenXml, evaluar) entra como funcion inyectada. Dinero: ningun monto como `number`. D-11: nada se registra con console.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const carpeta = `${__dirname}/`;
const raiz = `${resolve(__dirname, "..")}/`;
const fuentes = () =>
  existsSync(carpeta)
    ? readdirSync(carpeta).filter(
        (f) => f.endsWith(".ts") && !/\.(adv\.|int\.)?spec\.ts$/.test(f),
      )
    : [];
const leer = (f: string) => readFileSync(`${carpeta}${f}`, "utf8");
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ARCHIVOS = [
  "documentos.ts",
  "obtencion.ts",
  "reevaluar.ts",
  "detalle.ts",
  "historial.ts",
];

describe("estructura de packages/db/src/xml (plan «Archivos»)", () => {
  it.each(ARCHIVOS)("existe %s", (f) => {
    expect(fuentes(), "falta el archivo (T11)").toContain(f);
  });
});

describe("regla de capas: packages/db no depende del dominio, de SUNAT ni del storage", () => {
  it("ningun archivo de xml/ importa @contapp/domain, @contapp/sunat, @contapp/storage, @contapp/queue ni @contapp/crypto", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de xml/ todavia").toBeGreaterThan(0);
    for (const f of archivos) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, f).not.toMatch(
        /@contapp\/(domain|sunat|storage|queue|crypto)/,
      );
      expect(codigo, f).not.toMatch(/packages\/(domain|sunat|storage)/);
      expect(codigo, f).not.toMatch(/from\s+["'][^"']*\/(domain|storage)\//);
    }
  });

  it("package.json de packages/db no declara @contapp/domain ni @contapp/storage", () => {
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

describe("dinero y registros (CA-17, D-11)", () => {
  it("sin parseFloat, toFixed ni Math.round, y ningun campo de monto tipado number", () => {
    expect(fuentes().length, "no hay codigo de xml/ todavia").toBeGreaterThan(
      0,
    );
    for (const f of fuentes()) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, `${f}: aritmetica de punto flotante`).not.toMatch(
        /parseFloat|\.toFixed\(|Math\.(round|floor|ceil)\(/,
      );
      expect(codigo, `${f}: monto tipado number`).not.toMatch(
        /\b(bi\w*|igv\w*|isc|icbper|total|monto\w*|noGravado|otrosTributos)\s*\??:\s*number\b/i,
      );
    }
  });

  it("no registra nada con console (ningun log lleva XML, montos, glosas, razones sociales ni rutas de storage)", () => {
    expect(fuentes().length, "no hay codigo de xml/ todavia").toBeGreaterThan(
      0,
    );
    for (const f of fuentes())
      expect(sinComentarios(leer(f)), f).not.toMatch(
        /console\.(log|info|warn|error|debug)/,
      );
  });
});

describe("superficie publica de @contapp/db (T11 la exporta desde index.ts)", () => {
  const indice = () => readFileSync(`${raiz}index.ts`, "utf8");
  const exportadosDe = (origen: RegExp): string[] => {
    const nombres: string[] = [];
    for (const m of indice().matchAll(
      /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      if (origen.test(m[2]!))
        nombres.push(
          ...m[1]!
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

  it("exporta las funciones del contrato desde ./xml/*", () => {
    const nombres = exportadosDe(/^\.\/xml\//);
    for (const n of [
      "guardarDocumentoXml",
      "leerXmlVigente",
      "fijarObtencion",
      "listarPorObtener",
      "reevaluarCompra",
      "leerHistorialProveedor",
    ])
      expect(nombres, `falta exportar ${n} desde ./xml/*`).toContain(n);
  });

  it("no pisa ningun nombre ya exportado (p. ej. leerDetalleCompra de 014 se conserva una sola vez)", () => {
    const todos = [
      ...indice().matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g),
    ].flatMap((m) =>
      m[1]!
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
    expect(todos.filter((n, i) => todos.indexOf(n) !== i)).toEqual([]);
  });

  it("exporta las tablas de drizzle de 016", () => {
    const nombres = exportadosDe(/^\.\/schema\/(xml|compras)$/);
    for (const n of [
      "documentoXml",
      "documentoXmlObtencion",
      "compraEvaluacion",
    ])
      expect(nombres, `falta exportar la tabla ${n}`).toContain(n);
  });
});

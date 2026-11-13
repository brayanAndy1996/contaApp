// Spec 021 (T3, rojo): reglas de capas de `packages/db/src/reglas/` y superficie publica. Unitarias (leen el codigo fuente; no usan
// Postgres). `packages/db` no depende de `packages/domain` (R-HIS y `cambiarDestino` entran como funcion inyectada, plan 021),
// ningun monto como `number` (CLAUDE.md), sin logs (D-10: nada lleva RUC, razon social ni montos) y todo con la `tx` de withTenant.
// El comportamiento contra la BD real esta en tests/aislamiento/reglas-*.spec.ts. Hasta T9 fallan: la carpeta no existe.
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

const ARCHIVOS = ["lectura.ts", "escritura.ts", "motor.ts", "aplicar.ts", "index.ts"];

describe("estructura de packages/db/src/reglas (plan 021 «Archivos»)", () => {
  it.each(ARCHIVOS)("existe %s", (f) => {
    expect(fuentes(), "falta la carpeta o el archivo (T9)").toContain(f);
  });
});

describe("regla de capas: packages/db no depende del dominio ni de SUNAT", () => {
  it("ningun archivo de reglas/ importa @contapp/domain, @contapp/sunat, @contapp/queue ni @contapp/crypto", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de reglas todavia").toBeGreaterThan(0);
    for (const f of archivos) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, f).not.toMatch(/@contapp\/(domain|sunat|queue|crypto)/);
      expect(codigo, f).not.toMatch(/packages\/(domain|sunat)/);
      expect(codigo, f).not.toMatch(/from\s+["'][^"']*\/domain\//);
    }
  });

  it("package.json de packages/db sigue sin declarar @contapp/domain", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    expect(Object.keys(deps)).not.toContain("@contapp/domain");
  });
});

describe("dinero y secretos: ningun monto como number, ningun log (D-10)", () => {
  it("sin parseFloat, toFixed ni Math.round, y ningun campo de monto tipado number", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de reglas todavia").toBeGreaterThan(0);
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

  it("no registra nada con console", () => {
    expect(fuentes().length, "no hay codigo de reglas todavia").toBeGreaterThan(0);
    for (const f of fuentes())
      expect(sinComentarios(leer(f)), f).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("toda consulta va por la `tx` recibida: no abre pools ni conexiones propias, ni desactiva RLS", () => {
    expect(fuentes().length, "no hay codigo de reglas todavia").toBeGreaterThan(0);
    for (const f of fuentes()) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, f).not.toMatch(/new\s+(Pool|Client)\s*\(/);
      expect(codigo, f).not.toMatch(/row_security|DISABLE\s+ROW\s+LEVEL|NO\s+FORCE|session_replication_role|BYPASSRLS/i);
      expect(codigo, f).not.toMatch(/process\.env/);
    }
  });

  it("el repositorio no escribe versiones `historial` ni regla_aplicacion: eso es solo de la funcion de BD del worker (D-6)", () => {
    for (const f of fuentes().filter((x) => x !== "aplicar.ts" && x !== "index.ts")) {
      const codigo = sinComentarios(leer(f));
      expect(codigo, f).not.toMatch(/insert\s+into\s+(public\.)?(regla_aplicacion|regla_aceptacion)/i);
      expect(codigo, f).not.toMatch(/insert\s+into\s+(public\.)?compra_version/i);
    }
  });

  it("las funciones acotadas de 0048 se llaman desde aplicar.ts (con lectura.ts y motor.ts como unicos otros usuarios)", () => {
    const archivos = fuentes();
    expect(archivos.length, "no hay codigo de reglas todavia").toBeGreaterThan(0);
    const usos = archivos.filter((f) =>
      /aplicar_regla_historial|reglas_historial_vigentes/.test(sinComentarios(leer(f))),
    );
    expect(usos.every((f) => f === "aplicar.ts" || f === "lectura.ts" || f === "motor.ts")).toBe(true);
    expect(usos).toContain("aplicar.ts");
  });
});

describe("superficie publica de @contapp/db (T9 la exporta desde index.ts)", () => {
  const indice = () => readFileSync(`${raiz}index.ts`, "utf8");
  const exportadosDe = (origen: RegExp): string[] => {
    const nombres: string[] = [];
    for (const m of indice().matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      if (origen.test(m[2]!))
        nombres.push(
          ...m[1]!
            .split(",")
            .map((n) => n.replace(/\btype\b/, "").trim().split(/\s+as\s+/).pop()!)
            .filter(Boolean),
        );
    }
    return nombres;
  };

  it("exporta las funciones del contrato desde ./reglas/*", () => {
    const nombres = exportadosDe(/^\.\/reglas(\/|$)/);
    for (const n of [
      "listarReglas",
      "recordarRegla",
      "editarRegla",
      "eliminarRegla",
      "leerReglasMotor",
      "fijarReglaMotor",
      "fijarAporte",
      "reglasHistorialVigentes",
      "aplicarReglaHistorial",
    ]) {
      expect(nombres, `falta exportar ${n} desde ./reglas`).toContain(n);
    }
  });

  it("exporta las tablas de drizzle de reglas desde ./schema/reglas", () => {
    const nombres = exportadosDe(/^\.\/schema\/reglas$/);
    for (const n of [
      "reglaAprendida",
      "estudioReglaMotor",
      "estudioReglasConfig",
      "reglaAplicacion",
      "reglaAceptacion",
      "reglaConfirmacion",
    ]) {
      expect(nombres, `falta exportar la tabla ${n}`).toContain(n);
    }
  });

  it("no hay nombres exportados repetidos en index.ts (ni pisa los de compras o ventas)", () => {
    const todos = [...indice().matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)].flatMap((m) =>
      m[1]!
        .split(",")
        .map((n) => n.replace(/\btype\b/, "").trim().split(/\s+as\s+/).pop()!)
        .filter(Boolean),
    );
    expect(todos.filter((n, i) => todos.indexOf(n) !== i)).toEqual([]);
  });
});

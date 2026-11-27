import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";

// Prueba normal (sin SUNAT, sin .env, sin esperas): la prueba de contrato del SIRE solo corre con
// `--mode contrato` y SIRE_CONTRATO=1, y nunca entra en `test` ni en `test:int`.
type Filtros = { include: string[]; exclude: string[] };
type ModuloConfig = {
  default: (env: { command: "serve"; mode: string }) => { test: Filtros };
  filtrosDeModo: (mode: string, env: Record<string, string | undefined>) => Filtros;
  patronContrato: string;
};

// La config vive fuera de src (rootDir de tsc): se carga en tiempo de ejecución, no con import estático.
const rutaConfig: string = "../vitest.config.mts";
const cargarConfig = (): Promise<ModuloConfig> => import(rutaConfig) as Promise<ModuloConfig>;

const contrato = "src/http/ejemplo.contrato.spec.ts";
const normal = "src/http/ejemplo.spec.ts";
const integracion = "src/http/ejemplo.int.spec.ts";

// Mismo criterio que vitest: un archivo corre si casa con algún include y con ningún exclude.
const corre = (filtros: Filtros, archivo: string): boolean =>
  filtros.include.some((patron) => matchesGlob(archivo, patron)) &&
  !filtros.exclude.some((patron) => matchesGlob(archivo, patron));

const scripts = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("exclusión de la prueba de contrato del SIRE", () => {
  it("test excluye *.contrato.spec.ts y sí corre las normales", async () => {
    const { filtrosDeModo, patronContrato } = await cargarConfig();
    const filtros = filtrosDeModo("test", {});
    expect(filtros.exclude).toContain(patronContrato);
    expect(corre(filtros, contrato)).toBe(false);
    expect(corre(filtros, normal)).toBe(true);
  });

  it("test:int excluye *.contrato.spec.ts y sí corre las de integración", async () => {
    const { filtrosDeModo, patronContrato } = await cargarConfig();
    const filtros = filtrosDeModo("int", {});
    expect(filtros.exclude).toContain(patronContrato);
    expect(corre(filtros, contrato)).toBe(false);
    expect(corre(filtros, integracion)).toBe(true);
  });

  it("contrato sin SIRE_CONTRATO=1 no corre ningún archivo", async () => {
    const { filtrosDeModo } = await cargarConfig();
    for (const valor of [undefined, "", "0", "true"]) {
      const filtros = filtrosDeModo("contrato", { SIRE_CONTRATO: valor });
      expect(corre(filtros, contrato)).toBe(false);
      expect(corre(filtros, normal)).toBe(false);
    }
  });

  it("contrato con SIRE_CONTRATO=1 corre solo *.contrato.spec.ts", async () => {
    const { filtrosDeModo } = await cargarConfig();
    const filtros = filtrosDeModo("contrato", { SIRE_CONTRATO: "1" });
    expect(corre(filtros, contrato)).toBe(true);
    expect(corre(filtros, normal)).toBe(false);
  });

  it("la configuración por defecto aplica la exclusión en modo test", async () => {
    const { default: configuracion } = await cargarConfig();
    const { test: opciones } = configuracion({ command: "serve", mode: "test" });
    expect(corre(opciones, contrato)).toBe(false);
    expect(corre(opciones, normal)).toBe(true);
  });

  it("los scripts test y test:int no mencionan contrato; test:contrato usa --mode contrato", () => {
    expect(scripts.test).not.toMatch(/contrato/);
    expect(scripts["test:int"]).not.toMatch(/contrato/);
    expect(scripts["test:contrato"]).toContain("--mode contrato");
  });
});

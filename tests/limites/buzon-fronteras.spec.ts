import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Spec 023 · T6 (rojo). CA-10 (D-10): el backend NO llama a SUNAT ni descifra credenciales, tampoco desde el módulo `buzon`.
// Contrato fijado por estas pruebas (módulo `apps/backend/src/modules/buzon/`, lo crea T13):
//  - El módulo existe, tiene un controlador bajo `…/buzon` y se registra en `app.module.ts` como `BuzonModule`.
//  - Ningún archivo de `apps/backend/src` (módulo `buzon` o cualquier otro) importa `@contapp/sunat`, `@contapp/crypto/descifrado` (ni sus
//    rutas relativas a `src`/`dist`), `@contapp/queue/worker`, `bullmq` ni nada de `apps/worker`; `apps/backend/package.json` no depende de
//    `@contapp/sunat`. Solo se miran las sentencias de importación, no los comentarios.
//  - El módulo `buzon` no abre archivos por su cuenta (`node:fs`, `fs`): el contenido y los adjuntos salen del puerto de storage. No usa
//    `console` ni nombra el puerto del portal (`SolPortal`, `obtenerMensaje`, `listarMensajes`, `SOL_PORTAL`) ni el descifrado.
//  - La regla de lint de 003 cubre también las rutas del módulo: importar `@contapp/sunat` o el descifrado desde `modules/buzon/` es una
//    violación, y el worker sí puede importar `@contapp/sunat` para su procesador de buzón.

const RAIZ = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BACKEND_SRC = path.join(RAIZ, "apps/backend/src");
const MODULO_BUZON = path.join(BACKEND_SRC, "modules/buzon");
const REGLAS_DE_LIMITE = new Set([
  "no-restricted-imports",
  "limites/imports-relativos",
]);

/** Archivos `.ts` de producción (sin `*.spec.ts`) bajo `dir`, recursivo. */
function fuentes(dir: string): string[] {
  const salida: string[] = [];
  const recorrer = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === "dist") continue;
      const ruta = path.join(d, n);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (
        /\.tsx?$/.test(n) &&
        !/\.spec\.tsx?$/.test(n) &&
        !/\.d\.ts$/.test(n)
      )
        salida.push(ruta);
    }
  };
  recorrer(dir);
  return salida.sort();
}

/** Especificadores de las sentencias `import … from`, `export … from`, `import("…")` y `require("…")` (sin comentarios). */
function importes(codigo: string): string[] {
  const sinComentarios = codigo
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const re =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const salida: string[] = [];
  for (const m of sinComentarios.matchAll(re)) salida.push(m[1]!);
  return salida;
}

const rel = (ruta: string): string => path.relative(RAIZ, ruta);

describe("CA-10: el módulo buzón del backend existe y está registrado", () => {
  it("apps/backend/src/modules/buzon/ tiene un controlador de rutas …/buzon", () => {
    expect(
      existsSync(MODULO_BUZON),
      "falta apps/backend/src/modules/buzon/ (T13)",
    ).toBe(true);
    const archivos = fuentes(MODULO_BUZON);
    expect(archivos.length).toBeGreaterThan(0);
    const controladores = archivos.filter((f) =>
      /@Controller\(/.test(readFileSync(f, "utf8")),
    );
    expect(
      controladores.length,
      "ningún @Controller en el módulo buzon",
    ).toBeGreaterThan(0);
    expect(
      controladores.some((f) =>
        /clientes\/:clienteId\/buzon/.test(readFileSync(f, "utf8")),
      ),
    ).toBe(true);
  });

  it("app.module.ts registra BuzonModule", () => {
    const app = readFileSync(path.join(BACKEND_SRC, "app.module.ts"), "utf8");
    expect(app).toMatch(/\bBuzonModule\b/);
  });
});

describe("CA-10: apps/backend no llama a SUNAT, no descifra y no toca la cola del worker", () => {
  const PROHIBIDOS: Array<[string, RegExp]> = [
    ["@contapp/sunat", /^@contapp\/sunat(\/|$)/],
    [
      "@contapp/crypto/descifrado",
      /^@contapp\/crypto\/(descifrado|src|dist)(\/|$)/,
    ],
    [
      "ruta relativa a packages/crypto/(src|dist)/descifrado",
      /packages\/crypto\/(src|dist)\/descifrado/,
    ],
    ["packages/sunat por ruta relativa", /packages\/sunat(\/|$)/],
    ["@contapp/queue/worker (BullMQ)", /^@contapp\/queue\/worker(\/|$)/],
    ["bullmq", /^bullmq(\/|$)/],
    ["apps/worker", /(^|\/)apps\/worker(\/|$)/],
  ];

  it.each(PROHIBIDOS)(
    "ningún archivo de apps/backend/src importa %s",
    (_nombre, patron) => {
      const infractores: string[] = [];
      for (const f of fuentes(BACKEND_SRC)) {
        for (const especificador of importes(readFileSync(f, "utf8"))) {
          if (patron.test(especificador))
            infractores.push(`${rel(f)} → ${especificador}`);
        }
      }
      expect(infractores).toEqual([]);
    },
  );

  it("apps/backend/package.json no depende de @contapp/sunat ni de bullmq", () => {
    const paquete = JSON.parse(
      readFileSync(path.join(RAIZ, "apps/backend/package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const deps = {
      ...paquete.dependencies,
      ...paquete.devDependencies,
      ...paquete.peerDependencies,
    };
    expect(Object.keys(deps)).not.toContain("@contapp/sunat");
    expect(Object.keys(deps)).not.toContain("bullmq");
  });
});

describe("CA-10: el módulo buzón solo encola y lee de BD y storage", () => {
  const delModulo = (): string[] => {
    expect(
      existsSync(MODULO_BUZON),
      "falta apps/backend/src/modules/buzon/ (T13)",
    ).toBe(true);
    const f = fuentes(MODULO_BUZON);
    expect(f.length).toBeGreaterThan(0);
    return f;
  };

  it("no abre archivos por su cuenta: nada de node:fs ni fs (los archivos salen del puerto de storage)", () => {
    const infractores = delModulo().flatMap((f) =>
      importes(readFileSync(f, "utf8"))
        .filter((e) => /^(node:)?fs(\/promises)?$/.test(e))
        .map((e) => `${rel(f)} → ${e}`),
    );
    expect(infractores).toEqual([]);
  });

  it("no usa console ni nombra el puerto del portal, la clave SOL ni el descifrado", () => {
    const infractores: string[] = [];
    for (const f of delModulo()) {
      const codigo = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const [nombre, patron] of [
        ["console.", /\bconsole\./],
        ["SolPortal", /\bSolPortal\b/],
        ["SOL_PORTAL", /\bSOL_PORTAL\b/],
        ["obtenerMensaje", /\bobtenerMensaje\b/],
        ["listarMensajes", /\blistarMensajes\b/],
        ["descifrar", /\bdescifr\w*/i],
        ["CredencialSol", /\bCredencialSol\b/],
      ] as const) {
        if (patron.test(codigo)) infractores.push(`${rel(f)} → ${nombre}`);
      }
    }
    expect(infractores).toEqual([]);
  });

  it("la cola se alimenta por el Encolador del backend (sin escribir job_registro a mano en el módulo)", () => {
    const infractores = delModulo()
      .filter((f) =>
        /insert\s+into\s+job_registro/i.test(readFileSync(f, "utf8")),
      )
      .map(rel);
    expect(infractores).toEqual([]);
  });
});

describe("CA-10: la regla de lint cubre las rutas del módulo buzón y respeta al worker", () => {
  let eslint: ESLint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: RAIZ });
  });

  async function violaciones(codigo: string, filePath: string) {
    const [resultado] = await eslint.lintText(codigo, {
      filePath: path.join(RAIZ, filePath),
    });
    return resultado.messages.filter(
      (m) => m.ruleId !== null && REGLAS_DE_LIMITE.has(m.ruleId),
    );
  }

  const BUZON = "apps/backend/src/modules/buzon/__prueba__.ts";

  it("importar @contapp/sunat desde modules/buzon es una violación", async () => {
    expect(
      (await violaciones(`import "@contapp/sunat";`, BUZON)).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    [`import "@contapp/crypto/descifrado";`],
    [`void import("@contapp/crypto/descifrado");`],
    [`import "../../../../../packages/crypto/src/descifrado/descifrar";`],
  ])("descifrar desde modules/buzon es una violación: %s", async (codigo) => {
    const v = await violaciones(codigo, BUZON);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((m) => /descifrad/i.test(m.message))).toBe(true);
  });

  it("el worker sí puede importar @contapp/sunat para el procesador de buzón", async () => {
    expect(
      await violaciones(
        `import "@contapp/sunat";`,
        "apps/worker/src/trabajos/revisar-buzon.ts",
      ),
    ).toEqual([]);
  });
});

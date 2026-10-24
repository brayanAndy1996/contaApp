import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

// Reglas de límites (docs/03-arquitectura.md §2; spec 001, decisión 6).
// Dos capas complementarias:
//  1. no-restricted-imports: bloquea por nombre (@contapp/<x>) y por ruta cuando
//     'packages/<x>' o 'apps/<x>' aparece en el specifier.
//  2. limites/imports-relativos (regla local): resuelve léxicamente los specifiers
//     relativos (../../storage) contra la raíz del repo y cierra el hueco de los
//     imports que no mencionan 'apps' ni 'packages'. No exige que el destino exista
//     ni que tenga index/main (eslint-plugin-boundaries lo requiere y no los detecta).
const RAIZ = path.dirname(fileURLToPath(import.meta.url));

const paquete = (nombre) => [
  `@contapp/${nombre}`,
  `@contapp/${nombre}/**`,
  `**/packages/${nombre}`,
  `**/packages/${nombre}/**`,
];

// Otra app, por nombre (@contapp/<app>) y por ruta (apps/<app>). Ninguna app importa de otra app.
const app = (nombre) => [
  `@contapp/${nombre}`,
  `@contapp/${nombre}/**`,
  `**/apps/${nombre}`,
  `**/apps/${nombre}/**`,
];

const limite = (grupo, mensaje) => ({
  "no-restricted-imports": [
    "error",
    { patterns: [{ group: grupo, message: mensaje }] },
  ],
});

// Elemento de una ruta relativa a la raíz: "apps/<x>" o "packages/<x>" (o null).
const elementoDe = (rel) => /^(?:apps|packages)\/[^/]+/.exec(rel)?.[0] ?? null;

// Elementos prohibidos para cada origen. Un destino es prohibido si coincide con
// `prohibidos` o, cuando hay `soloPermitidos`, si no está en esa lista ni es el propio origen.
const POLITICAS = {
  "apps/frontend": {
    soloPermitidos: ["packages/shared"],
    mensaje:
      "apps/frontend solo puede importar packages/shared (03-arquitectura §2).",
  },
  "apps/backend": {
    prohibidos: ["packages/sunat", "apps/worker", "apps/frontend"],
    mensaje:
      "apps/backend no puede importar packages/sunat ni otras apps (03-arquitectura §2).",
  },
  "apps/worker": {
    prohibidos: ["apps/backend", "apps/frontend"],
    mensaje: "apps/worker no puede importar otras apps (03-arquitectura §2).",
  },
  "packages/domain": {
    prohibidos: ["db", "sunat", "storage", "queue", "crypto"].map(
      (n) => `packages/${n}`,
    ),
    mensaje:
      "packages/domain no puede importar paquetes de IO (03-arquitectura §2).",
  },
};

const reglaImportsRelativos = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const archivo = path.resolve(context.filename);
    const origen = elementoDe(
      path.relative(RAIZ, archivo).split(path.sep).join("/"),
    );
    const politica = origen && POLITICAS[origen];
    if (!politica) return {};
    const revisar = (nodo, fuente) => {
      if (typeof fuente !== "string" || !fuente.startsWith(".")) return;
      const destino = path.resolve(path.dirname(archivo), fuente);
      const rel = path.relative(RAIZ, destino).split(path.sep).join("/");
      const elemento = elementoDe(rel);
      if (!elemento || elemento === origen) return;
      const prohibido = politica.soloPermitidos
        ? !politica.soloPermitidos.includes(elemento)
        : politica.prohibidos.includes(elemento);
      if (prohibido) context.report({ node: nodo, message: politica.mensaje });
    };
    return {
      ImportDeclaration: (n) => revisar(n, n.source.value),
      ExportAllDeclaration: (n) => revisar(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && revisar(n, n.source.value),
      ImportExpression: (n) => revisar(n, n.source.value),
    };
  },
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["apps/frontend/**"],
    rules: limite(
      [
        "@contapp/*",
        "!@contapp/shared",
        "**/packages/**",
        "!**/packages/shared",
        "!**/packages/shared/**",
        ...app("backend"),
        ...app("worker"),
      ],
      "apps/frontend solo puede importar @contapp/shared (03-arquitectura §2).",
    ),
  },
  {
    files: ["apps/backend/**"],
    rules: limite(
      [...paquete("sunat"), ...app("worker"), ...app("frontend")],
      "apps/backend no puede importar packages/sunat ni otras apps (03-arquitectura §2).",
    ),
  },
  {
    files: ["apps/worker/**"],
    rules: limite(
      [...app("backend"), ...app("frontend")],
      "apps/worker no puede importar otras apps (03-arquitectura §2).",
    ),
  },
  {
    files: ["packages/domain/**"],
    rules: limite(
      ["db", "sunat", "storage", "queue", "crypto"].flatMap(paquete),
      "packages/domain no puede importar paquetes de IO (03-arquitectura §2).",
    ),
  },
  {
    files: ["apps/**", "packages/**"],
    plugins: {
      limites: { rules: { "imports-relativos": reglaImportsRelativos } },
    },
    rules: { "limites/imports-relativos": "error" },
  },
);

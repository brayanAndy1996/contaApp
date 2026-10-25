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

// SQL crudo (spec 002, riesgo H3 aceptado: un set_config a mitad de transacción cambia de estudio;
// se compensa con consultas siempre parametrizadas y esta regla). Regla local `sql-crudo/sin-sql-crudo`:
//  - modo "fuera" (apps/** y packages/* salvo db): sin imports de pg/postgres ni de sus adaptadores
//    drizzle, sin `sql` de drizzle-orm ni `.raw(`/`.unsafe(`, sin `set_config`, y `.query(`/`.execute(`
//    solo con texto estático (ni plantillas con interpolación ni concatenación).
//  - modo "dentro" (packages/db): SQL permitido, pero `.query(` solo con texto estático
//    (parámetros $1; sin interpolación en plantillas ni concatenación).
// El argumento se sigue por identificador (const) y por la propiedad `text` de un objeto.
const MODULO_SQL =
  /^(?:pg|postgres|pg-[\w-]+|postgres-[\w-]+|drizzle-orm\/(?:node-postgres|postgres-js))(?:\/.*)?$/;
const METODOS_CONCAT = new Set(["concat", "replace", "replaceAll", "join"]);

const nombreMiembro = (callee) =>
  callee.type === "MemberExpression"
    ? callee.computed
      ? callee.property.type === "Literal"
        ? String(callee.property.value)
        : null
      : callee.property.name
    : null;

const reglaSqlCrudo = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { modo: { enum: ["fuera", "dentro"] } },
        required: ["modo"],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const fuera = context.options[0].modo === "fuera";
    const sourceCode = context.sourceCode;
    const reportar = (node, message) => context.report({ node, message });

    const resolverConst = (id) => {
      for (let s = sourceCode.getScope(id); s; s = s.upper) {
        const v = s.set.get(id.name);
        if (v) {
          const def = v.defs[0];
          return def?.node.type === "VariableDeclarator" &&
            def.node.id.type === "Identifier"
            ? def.node.init
            : null;
        }
      }
      return null;
    };

    const dinamica = (e, prof = 0) => {
      if (!e || prof > 4) return false;
      switch (e.type) {
        case "TemplateLiteral":
          return e.expressions.length > 0;
        case "BinaryExpression":
          return (
            e.operator === "+" &&
            (e.left.type !== "Literal" || e.right.type !== "Literal")
          );
        case "CallExpression":
          return METODOS_CONCAT.has(nombreMiembro(e.callee));
        case "ConditionalExpression":
          return (
            dinamica(e.consequent, prof + 1) || dinamica(e.alternate, prof + 1)
          );
        case "Identifier":
          return dinamica(resolverConst(e), prof + 1);
        case "ObjectExpression":
          return e.properties.some(
            (p) =>
              p.type === "Property" &&
              ((p.key.type === "Identifier" && p.key.name === "text") ||
                (p.key.type === "Literal" && p.key.value === "text")) &&
              dinamica(p.value, prof + 1),
          );
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
          return dinamica(e.expression, prof + 1);
        default:
          return false;
      }
    };

    const revisarModulo = (nodo, fuente) => {
      if (!fuera || typeof fuente !== "string") return;
      if (MODULO_SQL.test(fuente))
        reportar(
          nodo,
          `Import de '${fuente}' prohibido fuera de packages/db (SQL crudo; spec 002).`,
        );
    };

    const reglas = {
      ImportDeclaration(n) {
        revisarModulo(n, n.source.value);
        if (fuera && String(n.source.value).startsWith("drizzle-orm"))
          for (const sp of n.specifiers)
            if (sp.type === "ImportSpecifier" && sp.imported.name === "sql")
              reportar(
                sp,
                "`sql` de drizzle-orm (SQL crudo) solo se usa dentro de packages/db (spec 002).",
              );
      },
      ExportAllDeclaration: (n) => revisarModulo(n, n.source.value),
      ExportNamedDeclaration: (n) =>
        n.source && revisarModulo(n, n.source.value),
      ImportExpression: (n) => revisarModulo(n, n.source.value),
      CallExpression(n) {
        if (
          n.callee.type === "Identifier" &&
          n.callee.name === "require" &&
          n.arguments[0]?.type === "Literal"
        )
          revisarModulo(n, n.arguments[0].value);
        const metodo = nombreMiembro(n.callee);
        if (fuera && (metodo === "raw" || metodo === "unsafe"))
          reportar(
            n,
            `\`.${metodo}(\` (SQL crudo) prohibido fuera de packages/db (spec 002).`,
          );
        if (metodo === "query" || (fuera && metodo === "execute")) {
          if (dinamica(n.arguments[0]))
            reportar(
              n.arguments[0],
              `\`.${metodo}(\` con interpolación o concatenación: usa texto estático y parámetros $1 (spec 002, riesgo H3).`,
            );
        }
      },
    };
    if (fuera) {
      const buscarSetConfig = (n, texto) => {
        if (/set_config/i.test(texto))
          reportar(
            n,
            "`set_config` solo se invoca dentro de packages/db (spec 002, riesgo H3).",
          );
      };
      reglas.Literal = (n) =>
        typeof n.value === "string" && buscarSetConfig(n, n.value);
      reglas.TemplateElement = (n) =>
        buscarSetConfig(n, n.value.cooked ?? n.value.raw);
      reglas.Identifier = (n) => buscarSetConfig(n, n.name);
    }
    return reglas;
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
  {
    files: ["apps/**", "packages/**"],
    ignores: ["packages/db/**"],
    plugins: { "sql-crudo": { rules: { "sin-sql-crudo": reglaSqlCrudo } } },
    rules: { "sql-crudo/sin-sql-crudo": ["error", { modo: "fuera" }] },
  },
  {
    files: ["packages/db/**"],
    plugins: { "sql-crudo": { rules: { "sin-sql-crudo": reglaSqlCrudo } } },
    rules: { "sql-crudo/sin-sql-crudo": ["error", { modo: "dentro" }] },
  },
);

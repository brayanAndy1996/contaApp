import { builtinModules } from "node:module";
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

// Descifrado de @contapp/crypto (spec 003, CA-4b): solo el worker lo importa. Prohibiciones por
// subcarpeta, con rutas relativas a la raíz del repo y especificadores de paquete (regex):
//  - apps/backend: ni el subpath `@contapp/crypto/descifrado`, ni `dist/**` o `src/**` del paquete,
//    ni rutas relativas a packages/crypto/{src,dist}/descifrado[…].
//  - packages/crypto/src/cifrado: ni `../descifrado` ni `../descifrado/…` (cifrado/ nunca importa descifrado/).
const RUTAS_DESCIFRADO = [
  "packages/crypto/src/descifrado",
  "packages/crypto/dist/descifrado",
];
const POLITICAS_SUBCARPETA = [
  {
    desde: "apps/backend/",
    rutas: RUTAS_DESCIFRADO,
    paquetes: /^@contapp\/crypto\/(?:descifrado|dist|src)(?:[/.].*)?$/,
    sinEvasiones: true,
    mensaje:
      "apps/backend no puede importar el descifrado de @contapp/crypto (solo el worker; spec 003, CA-4b).",
  },
  // Autenticación (spec 004, CA-11): el hash de contraseñas (`@node-rs/argon2`) y la BD
  // (`@contapp/db`) viven en el backend; el frontend los importa por ninguna vía (estático,
  // dinámico, require, export … from, subruta). Complementa a no-restricted-imports, que no ve
  // `import()` ni `require()`.
  {
    desde: "apps/frontend/",
    rutas: [],
    paquetes: /^(?:@node-rs\/argon2|@contapp\/db)(?:\/.*)?$/,
    mensaje:
      "apps/frontend no puede importar @node-rs/argon2 (argon2) ni @contapp/db (spec 004, CA-11).",
  },
  {
    desde: "packages/crypto/src/cifrado/",
    rutas: ["packages/crypto/src/descifrado"],
    paquetes: null,
    mensaje:
      "packages/crypto/src/cifrado no puede importar el descifrado (spec 003, CA-4b).",
  },
];
// ¿`rel` es la ruta `base` o algo bajo ella (carpeta o archivo con extensión)?
const bajoRuta = (rel, base) =>
  rel === base || rel.startsWith(`${base}/`) || rel.startsWith(`${base}.`);

const reglaImportsRelativos = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const archivo = path.resolve(context.filename);
    const relArchivo = path.relative(RAIZ, archivo).split(path.sep).join("/");
    const origen = elementoDe(relArchivo);
    const politica = origen && POLITICAS[origen];
    const subpoliticas = POLITICAS_SUBCARPETA.filter((p) =>
      relArchivo.startsWith(p.desde),
    );
    if (!politica && subpoliticas.length === 0) return {};
    const revisarSubcarpeta = (nodo, fuente) => {
      for (const sp of subpoliticas) {
        let prohibido = false;
        if (fuente.startsWith(".")) {
          const destino = path.resolve(path.dirname(archivo), fuente);
          const rel = path.relative(RAIZ, destino).split(path.sep).join("/");
          prohibido = sp.rutas.some((r) => bajoRuta(rel, r));
        } else {
          prohibido = sp.paquetes?.test(fuente) ?? false;
        }
        if (prohibido) context.report({ node: nodo, message: sp.mensaje });
      }
    };
    const revisar = (nodo, fuente) => {
      if (typeof fuente !== "string") return;
      if (estricto && (fuente === "module" || fuente === "node:module"))
        context.report({ node: nodo, message: MSG_REQUIRE });
      revisarSubcarpeta(nodo, fuente);
      if (!politica || !fuente.startsWith(".")) return;
      const destino = path.resolve(path.dirname(archivo), fuente);
      const rel = path.relative(RAIZ, destino).split(path.sep).join("/");
      const elemento = elementoDe(rel);
      if (!elemento || elemento === origen) return;
      const prohibido = politica.soloPermitidos
        ? !politica.soloPermitidos.includes(elemento)
        : politica.prohibidos.includes(elemento);
      if (prohibido) context.report({ node: nodo, message: politica.mensaje });
    };
    // Evasiones del descifrado en apps/backend (spec 003, F4): solo se aceptan especificadores
    // estáticos (literal o plantilla sin expresiones); `createRequire` y `module.require` se prohíben.
    const estricto = subpoliticas.some((p) => p.sinEvasiones);
    const MSG_DINAMICO =
      "apps/backend: import()/require() solo con cadena estática; un especificador dinámico puede evadir la prohibición del descifrado (spec 003, CA-4b).";
    const MSG_REQUIRE =
      "apps/backend: createRequire/module.require prohibidos; pueden evadir la prohibición del descifrado (spec 003, CA-4b).";
    // Valor estático del argumento, o undefined si no es una cadena estática.
    const estatico = (e) => {
      if (!e) return undefined;
      if (e.type === "Literal") return typeof e.value === "string" ? e.value : undefined;
      if (e.type === "TemplateLiteral" && e.expressions.length === 0)
        return e.quasis[0]?.value.cooked ?? undefined;
      return undefined;
    };
    const revisarArgumento = (nodo, arg) => {
      const valor = estatico(arg);
      if (valor !== undefined) return revisar(nodo, valor);
      if (estricto) context.report({ node: nodo, message: MSG_DINAMICO });
    };
    const MSG_EVAL =
      "apps/backend: eval/Function, alias de require/module y mainModule prohibidos; pueden evadir la prohibición del descifrado (spec 003, CA-4b).";
    const RAICES_REQUIRE = ["module", "require", "process", "globalThis", "global"];
    const raizRequire = (e) => {
      while (e?.type === "MemberExpression" || e?.type === "ChainExpression")
        e = e.type === "ChainExpression" ? e.expression : e.object;
      return e?.type === "Identifier" && RAICES_REQUIRE.includes(e.name);
    };
    // Identificador sin declaración local (global del entorno): un `module` o `require` propio no cuenta.
    const esGlobal = (id) => {
      for (let s = context.sourceCode.getScope(id); s; s = s.upper) {
        const v = s.set.get(id.name);
        if (v && v.defs.length > 0) return false;
      }
      return true;
    };
    const esPropiedad = (n) => {
      const p = n.parent;
      if (p?.type === "MemberExpression" && p.property === n && !p.computed) return true;
      if (p?.type === "Property" && p.key === n && !p.computed && !p.shorthand) return true;
      return p?.type === "TSQualifiedName" || p?.type === "PropertyDefinition" && p.key === n;
    };
    // Usos legítimos: `typeof x`, `require.resolve`, `module.exports`/`module.hot`.
    const usoInocuo = (n) => {
      const p = n.parent;
      if (p?.type === "UnaryExpression" && p.operator === "typeof") return true;
      if (p?.type === "MemberExpression" && p.object === n) {
        const m = nombreMiembro(p);
        return n.name === "require" ? m === "resolve" : m === "exports" || m === "hot";
      }
      return false;
    };
    // Vías ESM para obtener `module`/`require`: process.getBuiltinModule (prohibido por completo,
    // con o sin alias de `process`, clave estática o calculada) y Module._load / new Module().require.
    const NOMBRES_CARGA = new Set(["getBuiltinModule", "_load"]);
    const esLlamado = (n) => n.parent?.type === "CallExpression" && n.parent.callee === n;
    // `process`, `globalThis`, `global` (globales) o `<x>.process` / `<x>.globalThis` / `<x>.global`.
    const NOMBRES_ENTORNO = ["process", "globalThis", "global"];
    const esRaizEntorno = (e) => {
      while (e?.type === "ChainExpression") e = e.expression;
      if (e?.type === "Identifier") return NOMBRES_ENTORNO.includes(e.name) && esGlobal(e);
      return (
        e?.type === "MemberExpression" &&
        !e.computed &&
        NOMBRES_ENTORNO.includes(e.property.name)
      );
    };
    // const { [k]: g } = process;  /  ({ [k]: g } = process);
    const desestructuraCalculado = (patron, init) => {
      if (patron?.type !== "ObjectPattern" || !esRaizEntorno(init)) return;
      for (const p of patron.properties)
        if (p.type === "Property" && p.computed && estatico(p.key) === undefined)
          context.report({ node: p, message: MSG_REQUIRE });
    };
    const handlers = {
      ImportDeclaration: (n) => revisar(n, n.source.value),
      ExportAllDeclaration: (n) => revisar(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && revisar(n, n.source.value),
      ImportExpression: (n) => revisarArgumento(n, n.source),
      CallExpression(n) {
        if (n.callee.type === "Identifier" && n.callee.name === "require")
          revisarArgumento(n, n.arguments[0]);
      },
    };
    if (estricto) {
      handlers.Identifier = (n) => {
        if (n.name === "createRequire" || NOMBRES_CARGA.has(n.name))
          context.report({ node: n, message: MSG_REQUIRE });
        if (esPropiedad(n) || !esGlobal(n)) return;
        // `require` solo como callee directo (ya revisado) o `require.resolve`; `module` solo exports/hot.
        if (n.name === "eval") context.report({ node: n, message: MSG_EVAL });
        else if (
          (n.name === "require" || n.name === "module") &&
          !(n.name === "require" && n.parent?.type === "CallExpression" && n.parent.callee === n) &&
          !usoInocuo(n)
        )
          context.report({ node: n, message: MSG_EVAL });
      };
      handlers.MemberExpression = (n) => {
        const nombre = nombreMiembro(n) ?? (n.computed ? estatico(n.property) : null);
        if (
          nombre === "createRequire" ||
          NOMBRES_CARGA.has(nombre) ||
          (nombre === "require" && (raizRequire(n.object) || esLlamado(n)))
        )
          context.report({ node: n, message: MSG_REQUIRE });
        // process[expr] / globalThis[expr] con clave calculada: puede resolver getBuiltinModule.
        if (n.computed && estatico(n.property) === undefined && esRaizEntorno(n.object))
          context.report({ node: n, message: MSG_REQUIRE });
        if (nombre === "mainModule" || ((nombre === "eval" || nombre === "Function") && raizRequire(n.object)))
          context.report({ node: n, message: MSG_EVAL });
      };
      const funcion = (n) => {
        if (n.callee.type === "Identifier" && n.callee.name === "Function" && esGlobal(n.callee))
          context.report({ node: n, message: MSG_EVAL });
      };
      handlers.NewExpression = funcion;
      const llamada = handlers.CallExpression;
      handlers.CallExpression = (n) => {
        llamada(n);
        funcion(n);
      };
      handlers.VariableDeclarator = (n) => desestructuraCalculado(n.id, n.init);
      handlers.AssignmentExpression = (n) => desestructuraCalculado(n.left, n.right);
      handlers.TSExternalModuleReference = (n) => revisarArgumento(n, n.expression);
    }
    return handlers;
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

// Esquema `auth` en un texto SQL (spec 004, CA-11): `auth.<x>` o `"auth"."<x>"`, sin distinguir
// mayúsculas ni espacios alrededor del punto; no confunde `authors` ni `author.x`.
const SQL_ESQUEMA_AUTH = /(?<![\w$])"?auth"?\s*\.\s*"?[a-z_]/i;

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

    // Texto estático (concatenado) de un argumento: literales, plantillas (sus partes fijas),
    // `+` entre cadenas, ramas de un condicional, constantes, propiedad `text` de un objeto.
    const textoEstatico = (e, prof = 0) => {
      if (!e || prof > 4) return "";
      switch (e.type) {
        case "Literal":
          return typeof e.value === "string" ? e.value : "";
        case "TemplateLiteral":
          return e.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
        case "BinaryExpression":
          return e.operator === "+"
            ? `${textoEstatico(e.left, prof + 1)} ${textoEstatico(e.right, prof + 1)}`
            : "";
        case "ConditionalExpression":
          return `${textoEstatico(e.consequent, prof + 1)} ${textoEstatico(e.alternate, prof + 1)}`;
        case "Identifier":
          return textoEstatico(resolverConst(e), prof + 1);
        case "ObjectExpression":
          return e.properties
            .filter(
              (p) =>
                p.type === "Property" &&
                ((p.key.type === "Identifier" && p.key.name === "text") ||
                  (p.key.type === "Literal" && p.key.value === "text")),
            )
            .map((p) => textoEstatico(p.value, prof + 1))
            .join(" ");
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
          return textoEstatico(e.expression, prof + 1);
        default:
          return "";
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
        if (fuera && (metodo === "query" || metodo === "execute")) {
          if (SQL_ESQUEMA_AUTH.test(textoEstatico(n.arguments[0])))
            reportar(
              n.arguments[0],
              `SQL sobre el esquema \`auth\` prohibido fuera de packages/db: usa AuthRepo (spec 004, CA-11).`,
            );
        }
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

// Lint de IO y dinero en packages/domain (spec 010, plan: "Lint de dinero" y "Lint de IO").
const MODULOS_BD_HTTP_DOMINIO = [
  "pg",
  "bullmq",
  "ioredis",
  "axios",
  "undici",
  "node-fetch",
];
const restriccionesImports = (conDecimal) => ({
  // `paths` (nombre exacto): módulos de Node sin prefijo y paquetes de BD/colas/HTTP.
  paths: [...new Set([...builtinModules, ...MODULOS_BD_HTTP_DOMINIO])].map(
    (name) => ({
      name,
      message: `packages/domain no hace IO: no puede importar '${name}' (spec 010, CA-12).`,
    }),
  ),
  patterns: [
    {
      group: ["node:*", "drizzle-orm", "drizzle-orm/**", "@nestjs/*"],
      message:
        "packages/domain no hace IO: sin node:*, drizzle-orm ni @nestjs/* (spec 010, CA-12).",
    },
    {
      group: ["db", "sunat", "storage", "queue", "crypto"].flatMap(paquete),
      message:
        "packages/domain no puede importar paquetes de IO (03-arquitectura §2).",
    },
    ...(conDecimal
      ? [
          {
            group: ["decimal.js", "decimal.js/**"],
            message:
              "packages/domain: decimal.js solo se importa en dinero/decimal.ts (spec 010, CA-1).",
          },
        ]
      : []),
  ],
});
const GLOBALES_IO_DOMINIO = [
  "process",
  "Buffer",
  "fetch",
  "require",
  "XMLHttpRequest",
  "WebSocket",
  "global",
  "self",
  "window",
].map((name) => ({
  name,
  message: `packages/domain no hace IO: '${name}' prohibido (spec 010, CA-12).`,
}));
// Cualquier referencia (alias, desestructurado, tipo, `globalThis.x`) a estos globales; solo se
// exime la propiedad `x` de `obj.x` (p. ej. `Money.Math`), no el objeto ni los alias.
// `global`/`self`/`window` son alias de `globalThis` (Node/web) y también dan `Number`/`Math`.
const GLOBALES_NUMBER_DOMINIO =
  "Number|parseFloat|parseInt|Math|globalThis|global|self|window";
const SINTAXIS_SIN_NUMBER_DOMINIO = [
  ["TSNumberKeyword", "el tipo `number` está prohibido; usa Money/decimal (dinero)"],
  // Alias de tipo que resuelven a `number` sin escribir la palabra (R2a-6): `string["length"]`,
  // `ReturnType<String["indexOf"]>`, `ReturnType<typeof s.indexOf>`, `T extends {length: infer N}`.
  [
    "TSIndexedAccessType",
    "los tipos indexados (T[\"k\"]) están prohibidos en dinero (pueden resolver a number)",
  ],
  [
    "TSTypeQuery",
    "`typeof x` en posición de tipo está prohibido en dinero (puede resolver a number)",
  ],
  ["TSInferType", "`infer` está prohibido en dinero (puede resolver a number)"],
  [
    `Identifier[name=/^(${GLOBALES_NUMBER_DOMINIO})$/]:not(MemberExpression[computed=false] > Identifier.property)`,
    "Number/parseFloat/parseInt/Math/globalThis (también como alias, desestructurado o tipo) prohibidos en dinero",
  ],
  [
    `MemberExpression[computed=true][property.value=/^(${GLOBALES_NUMBER_DOMINIO})$/]`,
    "acceso por índice a Number/parseFloat/parseInt/Math prohibido en dinero",
  ],
  [
    "CallExpression[callee.property.name=/^(toNumber|valueOf)$/]",
    "toNumber()/valueOf() prohibidos en dinero",
  ],
  ["UnaryExpression[operator='+']", "el `+x` unario (conversión a number) está prohibido en dinero"],
];
// `D` (clon de Decimal) y `Decimal` no se reconfiguran ni se renombran fuera de dinero/decimal.ts.
const SINTAXIS_DECIMAL_DOMINIO = [
  [
    "ImportSpecifier[imported.name='D'][local.name!='D']",
    "`D` no se importa con alias (spec 010, CA-1)",
  ],
  [
    "ImportDeclaration[source.value=/decimal$/] > ImportNamespaceSpecifier",
    "`import * as` de dinero/decimal prohibido: importa `D` por nombre (spec 010, CA-1)",
  ],
  [
    "MemberExpression[computed=true][object.name=/^(D|Decimal)$/][property.value=/^(set|config)$/]",
    "D/Decimal.set y .config solo en dinero/decimal.ts (spec 010, CA-1)",
  ],
  // R2a-6: D con índice de plantilla o dinámico (D[clave]), asignar a `D.x`/`D.prototype.x` y
  // tocar `D.prototype`.
  [
    "MemberExpression[computed=true][object.name=/^(D|Decimal)$/][property.type!='Literal']",
    "acceso a D/Decimal con índice no literal (D[`set`], D[clave]) prohibido (spec 010, CA-1)",
  ],
  [
    "AssignmentExpression[left.object.name=/^(D|Decimal)$/], AssignmentExpression[left.object.object.name=/^(D|Decimal)$/], UpdateExpression[argument.object.name=/^(D|Decimal)$/], UnaryExpression[operator='delete'][argument.object.name=/^(D|Decimal)$/]",
    "asignar/borrar propiedades de D/Decimal (D.precision = …) prohibido (spec 010, CA-1)",
  ],
  [
    "MemberExpression[object.name=/^(D|Decimal)$/][property.name='prototype']",
    "D/Decimal.prototype prohibido (spec 010, CA-1)",
  ],
  // `D` solo se usa como `new D(...)`, `D.miembro`, `x instanceof D` o al importarlo: pasarlo como
  // argumento, alias, valor de objeto o retorno (Object.assign(D, …), `const {set} = D`,
  // `Object.getOwnPropertyDescriptor(D, "set")`) lo deja escapar a vías no analizables.
  [
    "Identifier[name='D']:not(NewExpression > Identifier.callee, MemberExpression[computed=false] > Identifier.object, MemberExpression[computed=false] > Identifier.property, ImportSpecifier > Identifier, BinaryExpression[operator='instanceof'] > Identifier.right, Property[computed=false] > Identifier.key, TSTypeReference > Identifier.typeName, ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > Identifier.id)",
    "`D` solo se usa como `new D(...)`, `D.miembro` o `instanceof D`; no como argumento, alias ni valor (spec 010, CA-1)",
  ],
];
// Vías dinámicas hacia decimal.js, Number/Math/parseFloat o globalThis que una regla estática sí
// puede cerrar (R2a-6): `.constructor` ((0).constructor, `new D(0).constructor.set`), `__proto__`,
// getPrototypeOf/setPrototypeOf, Function/new Function/eval, Reflect.
const SINTAXIS_DINAMICA_DOMINIO = [
  [
    "MemberExpression[computed=false][property.name=/^(constructor|__proto__)$/], MemberExpression[computed=true][property.value=/^(constructor|__proto__)$/], MemberExpression[computed=true][property.type='TemplateLiteral']",
    "`.constructor`/`__proto__`/índices con plantilla prohibidos (dan Number, Function o el constructor de Decimal)",
  ],
  [
    "MemberExpression[computed=false][property.name=/^(getPrototypeOf|setPrototypeOf)$/]",
    "getPrototypeOf/setPrototypeOf prohibidos (dan el constructor de Decimal)",
  ],
  [
    "Identifier[name=/^(Function|eval|Reflect)$/]:not(MemberExpression[computed=false] > Identifier.property)",
    "Function/new Function/eval/Reflect prohibidos (ejecución o acceso dinámico a decimal.js/Number)",
  ],
];
// `import()` dinámico: en todo packages/domain (R2a-6; evade la restricción de imports estáticos).
const SINTAXIS_PAQUETE_DOMINIO = [
  [
    "ImportExpression",
    "`import()` dinámico prohibido en packages/domain (evade la restricción de imports)",
  ],
];
// RUTAS QUE EL LINT ESTÁTICO NO CIERRA (R2a-6; las demás de R2a-6 sí están cerradas arriba):
//  - Un `number` por inferencia pura, sin sintaxis de tipo ni de acceso prohibida (p. ej.
//    `const n = s.length`, o `keyof string[]` dentro de un tipo condicional sin `infer`):
//    riesgo aceptado del plan ("valores numéricos inferidos sin anotación").
//  - Una clase Decimal/Number obtenida sin nombrarla por un valor que la filtre (p. ej. un
//    método de Money que devolviera su constructor): se cierra por diseño de la API, no por lint.

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["apps/frontend/**"],
    rules: limite(
      [
        "@node-rs/argon2",
        "@node-rs/argon2/**",
        "@contapp/*",
        "!@contapp/shared",
        "**/packages/**",
        "!**/packages/shared",
        "!**/packages/shared/**",
        ...app("backend"),
        ...app("worker"),
      ],
      "apps/frontend solo puede importar @contapp/shared y no @node-rs/argon2 (03-arquitectura §2; spec 004, CA-11).",
    ),
  },
  {
    files: ["apps/backend/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...paquete("sunat"),
                ...app("worker"),
                ...app("frontend"),
              ],
              message:
                "apps/backend no puede importar packages/sunat ni otras apps (03-arquitectura §2).",
            },
            {
              group: [
                "@contapp/crypto/descifrado",
                "@contapp/crypto/descifrado/**",
                "@contapp/crypto/dist",
                "@contapp/crypto/dist/**",
                "@contapp/crypto/src",
                "@contapp/crypto/src/**",
                "**/packages/crypto/src/descifrado*",
                "**/packages/crypto/src/descifrado/**",
                "**/packages/crypto/dist/descifrado*",
                "**/packages/crypto/dist/descifrado/**",
              ],
              message:
                "apps/backend no puede importar el descifrado de @contapp/crypto (solo el worker; spec 003, CA-4b).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/crypto/src/cifrado/**"],
    rules: limite(
      ["../descifrado", "../descifrado/**"],
      "packages/crypto/src/cifrado no puede importar el descifrado (spec 003, CA-4b).",
    ),
  },
  {
    files: ["apps/worker/**"],
    rules: limite(
      [...app("backend"), ...app("frontend")],
      "apps/worker no puede importar otras apps (03-arquitectura §2).",
    ),
  },
  // packages/domain sin IO (spec 010, CA-12): imports (paquetes del monorepo, node:*, BD, HTTP,
  // frameworks) y globales de entorno prohibidos.
  {
    files: ["packages/domain/**"],
    rules: {
      "no-restricted-imports": ["error", restriccionesImports(false)],
      "no-restricted-globals": ["error", ...GLOBALES_IO_DOMINIO],
    },
  },
  // import() dinámico prohibido en todo el paquete salvo pruebas (que lo usan para recargar
  // módulos); en src/ lo repiten los bloques siguientes porque reemplazan no-restricted-syntax.
  {
    files: ["packages/domain/**"],
    ignores: ["**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SINTAXIS_PAQUETE_DOMINIO.map(([selector, message]) => ({
          selector,
          message: `packages/domain: ${message} (spec 010, CA-12).`,
        })),
      ],
    },
  },
  // Dinero (spec 010, CA-1): decimal.js solo en dinero/decimal.ts (y en pruebas); tampoco se
  // reconfigura `Decimal` fuera de ese archivo.
  {
    files: ["packages/domain/src/**"],
    ignores: ["packages/domain/src/dinero/decimal.ts", "**/*.spec.ts"],
    rules: {
      "no-restricted-imports": ["error", restriccionesImports(true)],
      "no-restricted-properties": [
        "error",
        ...["Decimal", "D"].flatMap((object) =>
          ["set", "config"].map((property) => ({
            object,
            property,
            message: `packages/domain: ${object}.${property} solo se usa en dinero/decimal.ts (spec 010, CA-1).`,
          })),
        ),
      ],
      "no-restricted-syntax": [
        "error",
        ...[
          ...SINTAXIS_PAQUETE_DOMINIO,
          ...SINTAXIS_DECIMAL_DOMINIO,
          ...SINTAXIS_DINAMICA_DOMINIO,
        ].map(([selector, message]) => ({
          selector,
          message: `packages/domain: ${message}`,
        })),
      ],
    },
  },
  // Dinero (spec 010/011, CA-1): sin `number` ni Math.* en dinero/, comprobante/ y reglas/ (salvo pruebas).
  {
    files: [
      "packages/domain/src/dinero/**",
      "packages/domain/src/comprobante/**",
      "packages/domain/src/reglas/**",
    ],
    ignores: ["**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SINTAXIS_SIN_NUMBER_DOMINIO.map(([selector, message]) => ({
          selector,
          message: `packages/domain: ${message} (spec 010/011, CA-1).`,
        })),
        ...[
          ...SINTAXIS_PAQUETE_DOMINIO,
          ...SINTAXIS_DECIMAL_DOMINIO,
          ...SINTAXIS_DINAMICA_DOMINIO,
        ].map(([selector, message]) => ({
          selector,
          message: `packages/domain: ${message}`,
        })),
      ],
    },
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

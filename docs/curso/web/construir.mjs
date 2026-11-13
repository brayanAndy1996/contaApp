// Construye la versión web del curso a partir de los .md de docs/curso/.
//
//   node docs/curso/web/construir.mjs                 → escribe docs/curso/web/contenido.js
//   node docs/curso/web/construir.mjs --publicar DIR  → además arma en DIR la versión para publicar como página
//
// Los .md siguen siendo la única fuente del texto. Este script solo los convierte a HTML (con `marked`,
// incluido en herramientas/ para que funcione sin internet) y genera el índice de búsqueda.
// Un marcador `<!-- simulador: nombre -->` en un .md se vuelve el simulador interactivo `nombre` (simuladores.js).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Marked } = require("./herramientas/marked.cjs");

const WEB = dirname(fileURLToPath(import.meta.url));
const CURSO = resolve(WEB, "..");
const RAIZ = resolve(CURSO, "../..");
const REPO = "https://github.com/brayanAndy1996/contaApp/blob/main/";

const archivos = readdirSync(CURSO)
  .filter((f) => /^\d\d-[\w-]+\.md$/.test(f))
  .sort();

// Descripciones de una línea, tomadas del mapa de módulos de 00-indice.md.
const descripciones = {};
for (const linea of readFileSync(join(CURSO, "00-indice.md"), "utf8").split("\n")) {
  const m = linea.match(/^\| (\d\d) \| \[[^\]]+\]\([^)]+\) \| (.+) \|$/);
  if (m) descripciones[m[1]] = m[2];
}

const escapar = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sinEtiquetas = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const slug = (texto) =>
  sinEtiquetas(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "seccion";

function convertir(id, md) {
  const usados = new Set();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(texto, nivel) {
        let base = `${id}-${slug(texto)}`;
        let ancla = base;
        for (let i = 2; usados.has(ancla); i++) ancla = `${base}-${i}`;
        usados.add(ancla);
        return `<h${nivel} id="${ancla}">${texto}</h${nivel}>\n`;
      },
      link(href, titulo, texto) {
        const t = titulo ? ` title="${escapar(titulo)}"` : "";
        const modulo = href.match(/^(\d\d)-[\w-]+\.md(#.*)?$/);
        if (modulo) return `<a href="#m${modulo[1]}"${t}>${texto}</a>`;
        if (/^(https?:|mailto:)/.test(href)) return `<a href="${escapar(href)}" target="_blank" rel="noopener"${t}>${texto}</a>`;
        if (href.startsWith("#")) return `<a href="#m${id}"${t}>${texto}</a>`;
        // Ruta relativa a un archivo del repo: se abre en GitHub.
        const [ruta, frag] = href.split("#");
        const enRepo = relative(RAIZ, resolve(CURSO, ruta)).split("\\").join(posix.sep);
        const url = REPO + enRepo + (frag ? `#${frag}` : "");
        return `<a href="${escapar(url)}" target="_blank" rel="noopener"${t}>${texto}</a>`;
      },
    },
  });
  const conMarcadores = md.replace(
    /<!--\s*simulador:\s*([a-z0-9-]+)\s*-->/g,
    (_, nombre) => `<div class="simulador" data-simulador="${nombre}"></div>`,
  );
  return marked.parse(conMarcadores);
}

const modulos = archivos.map((archivo) => {
  const id = archivo.slice(0, 2);
  const md = readFileSync(join(CURSO, archivo), "utf8");
  const titulo = (md.match(/^# (.+)$/m)?.[1] ?? archivo).replace(/^(Módulo\s+)?\d\d\s*·\s*/, "").replace(/`/g, "");
  const html = convertir(id, md);
  // Índice de búsqueda: el texto plano de cada sección h2 (y la introducción).
  const secciones = [];
  const partes = html.split(/(?=<h2 id=")/);
  for (const parte of partes) {
    const h = parte.match(/^<h2 id="([^"]+)">([\s\S]*?)<\/h2>/);
    secciones.push({
      ancla: h ? h[1] : null,
      titulo: h ? sinEtiquetas(h[2]) : titulo,
      texto: sinEtiquetas(parte.replace(/<h1[\s\S]*?<\/h1>/, "")),
    });
  }
  return {
    id,
    archivo,
    titulo,
    descripcion: descripciones[id] ?? "",
    simuladores: [...md.matchAll(/<!--\s*simulador:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1]),
    html,
    secciones,
  };
});

const salida =
  "// Generado por construir.mjs a partir de docs/curso/*.md. No editar a mano: edita el .md y vuelve a construir.\n" +
  `window.CURSO = ${JSON.stringify({ repo: REPO, modulos })};\n`;
writeFileSync(join(WEB, "contenido.js"), salida);
console.log(`contenido.js: ${modulos.length} módulos, ${(salida.length / 1024).toFixed(0)} KB`);

// --publicar DIR: la misma página sin <!doctype>, <html>, <head> ni <body> (la plataforma los agrega).
const i = process.argv.indexOf("--publicar");
if (i !== -1) {
  const destino = resolve(process.argv[i + 1] ?? "");
  mkdirSync(destino, { recursive: true });
  const pagina = readFileSync(join(WEB, "index.html"), "utf8");
  const cabeza = pagina
    .match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/\s*<meta charset[^>]*>/, "")
    .replace(/\s*<meta name="viewport"[^>]*>/, "");
  const cuerpo = pagina.match(/<body>([\s\S]*?)<\/body>/)[1];
  writeFileSync(join(destino, "index.html"), `${cabeza.trim()}\n${cuerpo.trim()}\n`);
  for (const f of ["curso.css", "curso.js", "simuladores.js", "contenido.js"]) copyFileSync(join(WEB, f), join(destino, f));
  console.log(`Versión para publicar en ${destino}`);
}

// Construye la versión web del curso a partir de los .md de docs/curso/.
//
//   node docs/curso/web/construir.mjs                         → curso: escribe docs/curso/web/contenido.js
//   node docs/curso/web/construir.mjs --libro guia            → guía de uso: escribe docs/guia/web/
//   node docs/curso/web/construir.mjs [--libro X] --publicar DIR → además arma en DIR la versión para publicar
//
// Dos libros comparten este motor (curso.css, curso.js, simuladores.js): el curso técnico (docs/curso)
// y la guía de uso (docs/guia).
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

const MOTOR = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(MOTOR, "../../..");
const LIBROS = {
  curso: { fuente: "docs/curso", titulo: "Curso ContApp", sello: "CA", clave: "curso-contapp", buscar: "RLS, IGV, huella, boleta 291…" },
  guia: { fuente: "docs/guia", titulo: "Guía de uso de ContApp", sello: "GU", clave: "guia-contapp", buscar: "credenciales, generar archivo, excluir…" },
};
const iLibro = process.argv.indexOf("--libro");
const nombreLibro = iLibro === -1 ? "curso" : process.argv[iLibro + 1];
const LIBRO = LIBROS[nombreLibro];
if (!LIBRO) throw new Error(`Libro desconocido: ${nombreLibro}. Usa: ${Object.keys(LIBROS).join(", ")}`);
const CURSO = resolve(RAIZ, LIBRO.fuente);
const WEB = join(CURSO, "web");
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
      image(href, titulo, texto) {
        // Las imágenes de un libro viven en <libro>/web/img; la página está en <libro>/web.
        const src = href.startsWith("web/") ? href.slice(4) : href;
        return `<img src="${escapar(src)}" alt="${escapar(texto)}">`;
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
  `window.CURSO = ${JSON.stringify({ repo: REPO, titulo: LIBRO.titulo, clave: LIBRO.clave, modulos })};\n`;
mkdirSync(WEB, { recursive: true });
writeFileSync(join(WEB, "contenido.js"), salida);
console.log(`${LIBRO.fuente}/web/contenido.js: ${modulos.length} módulos, ${(salida.length / 1024).toFixed(0)} KB`);

// La página de cada libro sale de la del motor, con su título y rutas hacia los archivos compartidos.
const paginaMotor = readFileSync(join(MOTOR, "index.html"), "utf8");
const rutaMotor = relative(WEB, MOTOR).split("\\").join(posix.sep);
const prefijo = rutaMotor ? rutaMotor + "/" : "";
function paginaDelLibro(prefijoArchivos) {
  return paginaMotor
    .replace(/<title>[^<]*<\/title>/, `<title>${LIBRO.titulo}</title>`)
    .replace(/<span class="marca-sello">[^<]*<\/span>[^<]*<\/a>/, `<span class="marca-sello">${LIBRO.sello}</span> <span class="marca-texto">${LIBRO.titulo}</span></a>`)
    .replace(/placeholder="[^"]*"/, `placeholder="${LIBRO.buscar}"`)
    .replace(/(href|src)="(curso\.css|curso\.js|simuladores\.js)"/g, (_, a, f) => `${a}="${prefijoArchivos}${f}"`);
}
if (WEB !== MOTOR) writeFileSync(join(WEB, "index.html"), paginaDelLibro(prefijo));

// --publicar DIR: la misma página sin <!doctype>, <html>, <head> ni <body> (la plataforma los agrega).
const i = process.argv.indexOf("--publicar");
if (i !== -1) {
  const destino = resolve(process.argv[i + 1] ?? "");
  mkdirSync(destino, { recursive: true });
  const pagina = paginaDelLibro("");
  const cabeza = pagina
    .match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/\s*<meta charset[^>]*>/, "")
    .replace(/\s*<meta name="viewport"[^>]*>/, "");
  const cuerpo = pagina.match(/<body>([\s\S]*?)<\/body>/)[1];
  writeFileSync(join(destino, "index.html"), `${cabeza.trim()}\n${cuerpo.trim()}\n`);
  for (const f of ["curso.css", "curso.js", "simuladores.js"]) copyFileSync(join(MOTOR, f), join(destino, f));
  copyFileSync(join(WEB, "contenido.js"), join(destino, "contenido.js"));
  try {
    const imgs = readdirSync(join(WEB, "img"));
    mkdirSync(join(destino, "img"), { recursive: true });
    for (const f of imgs) copyFileSync(join(WEB, "img", f), join(destino, "img", f));
  } catch {
    /* libro sin imágenes */
  }
  console.log(`Versión para publicar en ${destino}`);
}

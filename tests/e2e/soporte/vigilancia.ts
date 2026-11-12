// Vigilancia de canarios en cada prueba (spec 018, D-8; CA-6). Registra las respuestas `/api`, la consola y el
// DOM final de todo contexto vigilado, y hace fallar la prueba si aparece un valor de credencial de fixture
// (`USUPRUEBA`, `CLAVEPRUEBA`, `CIDPRUEBA`, `CSECPRUEBA`), si `window.__pwn` llega a definirse (aunque la
// página cambie después) o si hay errores de consola que la prueba no declaró con `permitirError`.
// Los mensajes nombran el lugar y el centinela de fixture, nunca el contenido de una respuesta.
import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Response,
} from "@playwright/test";

export const CENTINELAS = [
  "USUPRUEBA",
  "CLAVEPRUEBA",
  "CIDPRUEBA",
  "CSECPRUEBA",
] as const;

/** Nombre del enlace con el que la página avisa que `window.__pwn` se asignó. */
const ENLACE_PWN = "__contappReportarPwn";

/** `window.__pwn` queda como propiedad con captor: sigue valiendo `undefined` mientras nadie la asigne. */
const SCRIPT_PWN = `(() => {
  let guardado;
  Object.defineProperty(window, "__pwn", {
    configurable: true,
    enumerable: false,
    get() { return guardado; },
    set(v) {
      guardado = v;
      try { window.${ENLACE_PWN}(String(location.pathname)); } catch (e) { /* sin enlace */ }
    },
  });
})();`;

function centinelasEn(texto: string): string[] {
  return CENTINELAS.filter((c) => texto.includes(c));
}

export class Vigilancia {
  private readonly hallazgosEncontrados: string[] = [];
  private readonly permitidos: RegExp[] = [];
  private readonly pendientes: Promise<void>[] = [];
  private readonly contextos = new Set<BrowserContext>();

  /** Declara un error de consola esperado (p. ej. el 401 de una prueba de credenciales erróneas). */
  permitirError(patron: RegExp): void {
    this.permitidos.push(patron);
  }

  /** Revisa un texto cualquiera (cuerpo de una respuesta de `api.ts`, por ejemplo). */
  revisarTexto(lugar: string, texto: string): void {
    for (const c of centinelasEn(texto)) {
      this.hallazgosEncontrados.push(`${c} en ${lugar}`);
    }
  }

  /** Vigila un contexto: respuestas `/api`, consola, `pageerror` y `window.__pwn` de todas sus páginas. */
  async observarContexto(context: BrowserContext): Promise<void> {
    if (this.contextos.has(context)) return;
    this.contextos.add(context);
    // Antes de crear la primera página: el enlace y el script tienen que estar en todas.
    await context.exposeFunction(ENLACE_PWN, (ruta: string) => {
      this.hallazgosEncontrados.push(`window.__pwn asignado (${ruta})`);
    });
    await context.addInitScript(SCRIPT_PWN);
    context.on("response", (r) => this.alResponder(r));
    context.on("console", (m) => this.alConsola(m));
    context.on("page", (p) => {
      p.on("pageerror", (e) => this.alErrorDePagina(e));
    });
  }

  private alConsola(m: ConsoleMessage): void {
    const texto = m.text();
    this.revisarTexto("la consola", texto);
    if (m.type() !== "error") return;
    const url = m.location().url;
    const contexto = `${texto} ${url}`;
    if (this.permitidos.some((p) => p.test(contexto))) return;
    this.hallazgosEncontrados.push(
      `error de consola no declarado: ${texto.slice(0, 200)}`,
    );
  }

  private alErrorDePagina(e: Error): void {
    this.revisarTexto("un error de la página", e.message);
    if (this.permitidos.some((p) => p.test(e.message))) return;
    this.hallazgosEncontrados.push(
      `error de página no declarado: ${e.message.slice(0, 200)}`,
    );
  }

  private alResponder(r: Response): void {
    let ruta: string;
    try {
      ruta = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (!ruta.startsWith("/api/")) return;
    const tipo = r.headers()["content-type"] ?? "";
    // El stream SSE no termina nunca y los binarios (ZIP, Excel) no llevan credenciales como texto.
    if (!/json|text\/(plain|html)/.test(tipo)) return;
    this.pendientes.push(
      r
        .text()
        .then((texto) => this.revisarTexto(`la respuesta ${ruta}`, texto))
        .catch(() => undefined),
    );
  }

  /** Mira el DOM final y `window.__pwn` de cada página abierta del contexto. Llamar antes de cerrarlo. */
  async revisarContexto(context: BrowserContext): Promise<void> {
    for (const page of context.pages()) await this.revisarPagina(page);
  }

  async revisarPagina(page: Page): Promise<void> {
    if (page.isClosed()) return;
    try {
      this.revisarTexto("el DOM final", await page.content());
      const pwn = await page.evaluate<boolean>("window.__pwn !== undefined");
      if (pwn)
        this.hallazgosEncontrados.push("window.__pwn definido en el DOM final");
    } catch {
      // La página se cerró o navegaba: lo que pasó antes ya lo registraron los eventos.
    }
  }

  /** Espera las lecturas pendientes y lanza si hubo algún hallazgo. */
  async verificar(): Promise<void> {
    await Promise.allSettled(this.pendientes);
    if (this.hallazgosEncontrados.length === 0) return;
    const unicos = [...new Set(this.hallazgosEncontrados)];
    throw new Error(`Vigilancia (D-8, CA-6): ${unicos.join("; ")}`);
  }
}

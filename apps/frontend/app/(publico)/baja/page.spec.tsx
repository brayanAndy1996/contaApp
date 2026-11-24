import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { anchosFijosMayoresA390 } from "../../../pruebas/aprendizaje";
import {
  BAJA,
  MENSAJES_CORREO as M,
  RUTA_BAJA,
  TEXTOS_CRUDOS_CORREO,
  TOKEN_BAJA,
  alcanza44px,
  cargarComponente,
} from "../../../pruebas/correo";
import { crearRouterFalso, instalarFetchFalso, type Manejador } from "../../../pruebas/soporte";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
// `useSearchParams` lee la barra viva: vale tanto si la página usa el hook como si lee `window.location`.
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/baja",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// Spec 028 · T7 (rojo; R-7, R-8, D-4, U-12, U-18; CA-8, CA-13, CA-15). Página pública `/baja`.
// Contrato (T13), `app/(publico)/baja/page.tsx` (export por defecto), sin sesión:
//   - El enlace del correo es `/baja?t=<token>` (43 caracteres base64url). AL CARGAR la página lee `t` de la barra, lo guarda
//     en memoria, lo borra de la barra con `history.replaceState` y NO HACE NINGUNA PETICIÓN (ni `fetch` ni nada: ni la
//     sesión, ni la API de baja). Muestra M.bajaPregunta y el botón M.bajaBoton (44 px). Aunque se ejecute su JavaScript
//     (antivirus, previsualizadores), la preferencia no cambia: es un `GET` de página sin efectos (U-18).
//   - Solo el botón llama a la API: UN `POST /api/correo/baja` con `{token}` (JSON, `credentials: same-origin`, sin
//     `X-CSRF-Token` ni `X-Estudio`, URL sin consulta). Deshabilitado mientras envía: doble clic → un POST.
//   - Con `t` ausente o mal formado (no son 43 caracteres base64url) el botón NO hace ningún POST; igual muestra el mismo
//     resultado.
//   - Tras pulsar, SIEMPRE el mismo texto M.bajaListo (sin oráculo de token válido) y el enlace M.bajaEnlaceCuenta a
//     `/cuenta/correo`, sea 200, 400, 429, 500 o un error de red. Nunca el token en pantalla, URL, cabeceras ni consola.
//   - 390 px sin anchos fijos; nada de códigos crudos.

const RUTA = "./page";
const cargar = () => cargarComponente(() => import(/* @vite-ignore */ RUTA), "default");

const espiasConsola = () =>
  (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
const consola = (espias: ReturnType<typeof espiasConsola>) => JSON.stringify(espias.flatMap((e) => e.mock.calls));

async function pintar(url = `/baja?t=${TOKEN_BAJA}`, rutas: Record<string, Manejador> = { [BAJA]: { status: 200, cuerpo: {} } }) {
  window.history.replaceState(null, "", url);
  const Pagina = await cargar();
  const f = instalarFetchFalso(rutas);
  const r = render(<Pagina />);
  return { f, ...r };
}

const pulsar = async () => userEvent.setup().click(screen.getByRole("button", { name: M.bajaBoton }));
const asentar = () => new Promise<void>((r) => setTimeout(r, 40));

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/baja · al cargar (D-4, U-18, CA-8)", () => {
  it("no hace ninguna petición al cargar, ni siquiera después de esperar a que corran sus efectos", async () => {
    const { f } = await pintar();
    expect(await screen.findByRole("button", { name: M.bajaBoton })).toBeTruthy();
    await asentar();
    expect(f.llamadas).toHaveLength(0);
    const fetchEspiado = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
    expect(fetchEspiado.mock.calls).toHaveLength(0);
  });

  it("muestra la pregunta y el botón «Darme de baja» de 44 px, sin mostrar el resultado todavía", async () => {
    await pintar();
    expect(await screen.findByText(M.bajaPregunta)).toBeTruthy();
    expect(alcanza44px(screen.getByRole("button", { name: M.bajaBoton }))).toBe(true);
    expect(screen.queryByText(M.bajaListo)).toBeNull();
  });

  it("guarda el token en memoria y lo borra de la barra con history.replaceState (no queda en la URL ni en el DOM)", async () => {
    const espia = vi.spyOn(window.history, "replaceState");
    const { container } = await pintar();
    await vi.waitFor(() => expect(espia.mock.calls.some((c) => !String(c[2] ?? "").includes(TOKEN_BAJA))).toBe(true));
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(TOKEN_BAJA);
    expect(window.location.pathname).toBe("/baja");
    expect(container.innerHTML).not.toContain(TOKEN_BAJA);
  });

  it("390 px: sin anchos fijos ni scroll interior; sin códigos crudos", async () => {
    const { container } = await pintar();
    await screen.findByRole("button", { name: M.bajaBoton });
    expect(anchosFijosMayoresA390(container)).toEqual([]);
    for (const crudo of TEXTOS_CRUDOS_CORREO) expect(container.textContent, crudo).not.toContain(crudo);
  });
});

describe("/baja · «Darme de baja» (D-4, U-18)", () => {
  it("un único POST /api/correo/baja con {token}, sin sesión (sin CSRF ni estudio) y sin el token en la URL", async () => {
    const { f } = await pintar();
    await pulsar();
    expect(await screen.findByText(M.bajaListo)).toBeTruthy();
    const posts = f.de(BAJA);
    expect(posts).toHaveLength(1);
    expect(f.llamadas).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ token: TOKEN_BAJA });
    expect(posts[0]?.url).toBe(RUTA_BAJA);
    expect(posts[0]?.credentials).toBe("same-origin");
    expect(posts[0]?.headers["content-type"]).toBe("application/json");
    expect(posts[0]?.headers["x-csrf-token"]).toBeUndefined();
    expect(posts[0]?.headers["x-estudio"]).toBeUndefined();
    expect(JSON.stringify(posts[0]?.headers)).not.toContain(TOKEN_BAJA);
  });

  it("doble clic → un solo POST y el botón queda deshabilitado mientras envía", async () => {
    let liberar: (() => void) | undefined;
    const puerta = new Promise<void>((r) => {
      liberar = r;
    });
    const llamadas: string[] = [];
    window.history.replaceState(null, "", `/baja?t=${TOKEN_BAJA}`);
    const Pagina = await cargar();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
        llamadas.push(`${(init?.method ?? "GET").toUpperCase()} ${String(entrada)}`);
        await puerta;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(<Pagina />);
    const user = userEvent.setup();
    await user.dblClick(await screen.findByRole("button", { name: M.bajaBoton }));
    expect((screen.getByRole("button", { name: M.bajaBoton }) as HTMLButtonElement).disabled).toBe(true);
    liberar?.();
    expect(await screen.findByText(M.bajaListo)).toBeTruthy();
    expect(llamadas).toEqual([BAJA]);
  });

  it.each([
    ["200 (token válido)", { status: 200, cuerpo: {} }],
    ["400 (token inválido)", { status: 400, cuerpo: { codigo: "solicitud_invalida" } }],
    ["429 (límite por IP)", { status: 429, cuerpo: { codigo: "demasiados_intentos" } }],
    ["500", { status: 500, cuerpo: { codigo: "error_interno" } }],
  ])("%s → el mismo texto «Listo…» y el acceso a «Mi cuenta → Correo», sin códigos crudos", async (_c, respuesta) => {
    const { container } = await pintar(`/baja?t=${TOKEN_BAJA}`, { [BAJA]: respuesta });
    await pulsar();
    expect(await screen.findByText(M.bajaListo)).toBeTruthy();
    const enlace = screen.getByRole("link", { name: M.bajaEnlaceCuenta });
    expect(enlace.getAttribute("href")).toBe("/cuenta/correo");
    for (const crudo of TEXTOS_CRUDOS_CORREO) expect(container.textContent, crudo).not.toContain(crudo);
    expect(container.textContent).not.toContain(TOKEN_BAJA);
  });

  it("un error de red → el mismo texto «Listo…», sin romper la página", async () => {
    window.history.replaceState(null, "", `/baja?t=${TOKEN_BAJA}`);
    const Pagina = await cargar();
    const fallo = vi.fn(async () => {
      throw new TypeError("fallo de red");
    });
    vi.stubGlobal("fetch", fallo);
    render(<Pagina />);
    await pulsar();
    expect(await screen.findByText(M.bajaListo)).toBeTruthy();
    expect(fallo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: M.bajaEnlaceCuenta }).getAttribute("href")).toBe("/cuenta/correo");
  });

  it("el texto de resultado es idéntico en todos los casos (no es un oráculo del token)", async () => {
    const textos: string[] = [];
    for (const respuesta of [{ status: 200, cuerpo: {} }, { status: 400, cuerpo: {} }, { status: 429, cuerpo: {} }]) {
      cleanup();
      const { container } = await pintar(`/baja?t=${TOKEN_BAJA}`, { [BAJA]: respuesta });
      await pulsar();
      await screen.findByText(M.bajaListo);
      textos.push(container.textContent ?? "");
    }
    expect(new Set(textos).size).toBe(1);
  });

  it("el token no aparece en la URL de la petición, cabeceras, location, DOM ni consola", async () => {
    const espias = espiasConsola();
    const { f, container } = await pintar(`/baja?t=${TOKEN_BAJA}`, { [BAJA]: { status: 400, cuerpo: { codigo: "solicitud_invalida" } } });
    await pulsar();
    await screen.findByText(M.bajaListo);
    const [llamada] = f.de(BAJA);
    expect(llamada?.url).not.toContain(TOKEN_BAJA);
    expect(JSON.stringify(llamada?.headers)).not.toContain(TOKEN_BAJA);
    expect(window.location.href).not.toContain(TOKEN_BAJA);
    expect(container.innerHTML).not.toContain(TOKEN_BAJA);
    expect(consola(espias)).not.toContain(TOKEN_BAJA);
  });
});

describe("/baja · token ausente o mal formado (D-4)", () => {
  const MALOS: [string, string][] = [
    ["sin parámetro t", "/baja"],
    ["t vacío", "/baja?t="],
    ["42 caracteres", `/baja?t=${TOKEN_BAJA.slice(0, 42)}`],
    ["44 caracteres", `/baja?t=${TOKEN_BAJA}A`],
    ["con relleno =", `/baja?t=${TOKEN_BAJA.slice(0, 42)}=`],
    ["con + o /", `/baja?t=${TOKEN_BAJA.slice(0, 41)}+/`],
  ];

  it.each(MALOS)("%s → muestra el botón, el clic no hace ningún POST y el resultado es el mismo", async (_c, url) => {
    const { f } = await pintar(url, {});
    await pulsar();
    expect(await screen.findByText(M.bajaListo)).toBeTruthy();
    await asentar();
    expect(f.llamadas).toHaveLength(0);
    expect(screen.getByRole("link", { name: M.bajaEnlaceCuenta }).getAttribute("href")).toBe("/cuenta/correo");
  });

  it("parámetros ajenos en la barra no se envían: el POST lleva solo {token}", async () => {
    const { f } = await pintar(`/baja?t=${TOKEN_BAJA}&usuarioId=u-1&tipo=resumen&activo=true`);
    await pulsar();
    await screen.findByText(M.bajaListo);
    expect(f.de(BAJA)[0]?.body).toEqual({ token: TOKEN_BAJA });
  });
});

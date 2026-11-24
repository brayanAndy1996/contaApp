import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  CLIENTE_ID,
  ELEGIR_ESTUDIO,
  ESTUDIO_A,
  ESTUDIO_B,
  LEER_SESION,
  PANTALLAS_IR,
  cargarComponente,
} from "../../pruebas/correo";
import { crearRouterFalso, instalarFetchFalso, sesionDe, type FetchFalso, type Manejador } from "../../pruebas/soporte";

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
  usePathname: () => "/ir",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// Spec 028 · T7 (rojo; R-7, D-3; CA-13, CA-15). Entrada `/ir` de los enlaces de los correos.
// Contrato (T13), `app/ir/page.tsx` (export por defecto; fuera de `(app)`, valida ella misma):
//   - URL `/ir?estudio=<uuid>&pantalla=<clave>[&cliente=<uuid>]`. Valida ANTES de tocar nada: `estudio` es un uuid, `pantalla`
//     una de la lista cerrada PANTALLAS_IR (pruebas/correo.ts), `cliente` un uuid (obligatorio en las pantallas de cliente) y
//     cualquier otro parámetro se ignora. Si algo no vale → `/estudios` (elección de estudio), sin ningún POST.
//   - Sin sesión (GET /api/auth/sesion → 401) → `/login` (a un sitio propio), sin POST.
//   - Con sesión: si el estudio activo ya es el del enlace → ir al destino de la pantalla; si es otro → un
//     `POST /api/auth/estudio {tenantId}` (con CSRF) y, si responde bien, al destino; si falla (403, 404, 500, red) →
//     `/estudios`. Nunca navega fuera del sitio: todo destino empieza por una sola «/», sin esquema ni host.
//   - Navega con `router.replace` (o `router.push`) o `window.location.assign/replace`, todos a rutas del sitio.

const RUTA = "./page";
const cargar = () => cargarComponente(() => import(/* @vite-ignore */ RUTA), "default");

let asignar: ReturnType<typeof vi.fn>;
let reemplazar: ReturnType<typeof vi.fn>;

/** Todo lo que la página mandó navegar, en orden. */
function navegado(): string[] {
  return [
    ...router.push.mock.calls,
    ...router.replace.mock.calls,
    ...asignar.mock.calls,
    ...reemplazar.mock.calls,
  ].map((c) => String(c[0]));
}

const sesionDeA = sesionDe(ESTUDIO_A);

async function ir(
  consulta: string,
  rutas: Record<string, Manejador> = { [LEER_SESION]: { status: 200, cuerpo: sesionDeA } },
): Promise<FetchFalso> {
  window.history.replaceState(null, "", `/ir${consulta}`);
  const Pagina = await cargar();
  const f = instalarFetchFalso(rutas);
  render(<Pagina />);
  await vi.waitFor(() => expect(navegado().length).toBeGreaterThan(0));
  return f;
}

const enlace = (pantalla: string, extra: { estudio?: string; cliente?: string | null } = {}) => {
  const p = new URLSearchParams({ estudio: extra.estudio ?? ESTUDIO_A.id, pantalla });
  if (extra.cliente !== null) p.set("cliente", extra.cliente ?? CLIENTE_ID);
  return `?${p.toString()}`;
};

/** Un destino del sitio: una sola «/» al inicio, sin esquema, sin host, sin barra invertida ni saltos. */
const esDelSitio = (d: string) => /^\/(?![/\\])[^:\s\\]*$/.test(d.split("?")[0] ?? "") && !/[\r\n]/.test(d);

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
  asignar = vi.fn();
  reemplazar = vi.fn();
  // `location` simulado que sigue la barra viva (la prueba la fija con `history.replaceState`) y vigila `assign` y `replace`.
  const real = window.location;
  vi.stubGlobal("location", {
    get href() {
      return real.href;
    },
    get origin() {
      return real.origin;
    },
    get host() {
      return real.host;
    },
    get hostname() {
      return real.hostname;
    },
    get protocol() {
      return real.protocol;
    },
    get pathname() {
      return real.pathname;
    },
    get search() {
      return real.search;
    },
    get hash() {
      return real.hash;
    },
    assign: asignar,
    replace: reemplazar,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/ir · estudio activo (D-3, CA-13)", () => {
  it.each(PANTALLAS_IR)("pantalla $pantalla → su destino, sin cambiar de estudio", async (p) => {
    const f = await ir(enlace(p.pantalla, { cliente: p.cliente ? CLIENTE_ID : null }));
    expect(navegado()).toEqual([p.destino(CLIENTE_ID)]);
    expect(f.de(ELEGIR_ESTUDIO)).toHaveLength(0);
  });
});

describe("/ir · otro estudio del que el usuario es miembro (R-7)", () => {
  const rutasCambio = (cambio: Manejador): Record<string, Manejador> => ({
    [LEER_SESION]: { status: 200, cuerpo: sesionDeA },
    [ELEGIR_ESTUDIO]: cambio,
  });

  it("hace un POST /api/auth/estudio {tenantId} con CSRF y, si responde bien, va al destino", async () => {
    const f = await ir(enlace("buzon_cliente", { estudio: ESTUDIO_B.id }), rutasCambio({ status: 200, cuerpo: {} }));
    const posts = f.de(ELEGIR_ESTUDIO);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ tenantId: ESTUDIO_B.id });
    expect(posts[0]?.headers["x-csrf-token"]).toBe("csrf-canario-1");
    expect(posts[0]?.credentials).toBe("same-origin");
    expect(navegado()).toEqual([`/clientes/${CLIENTE_ID}/buzon`]);
  });

  it("sin estudio activo (null) también cambia al del enlace", async () => {
    const f = await ir(enlace("buzon_estudio", { cliente: null, estudio: ESTUDIO_B.id }), {
      [LEER_SESION]: { status: 200, cuerpo: sesionDe(null) },
      [ELEGIR_ESTUDIO]: { status: 200, cuerpo: {} },
    });
    expect(f.de(ELEGIR_ESTUDIO)[0]?.body).toEqual({ tenantId: ESTUDIO_B.id });
    expect(navegado()).toEqual(["/buzon"]);
  });

  it.each([
    ["403 (no es miembro activo: estudio ajeno)", { status: 403, cuerpo: { codigo: "permiso_denegado" } }],
    ["404", { status: 404, cuerpo: {} }],
    ["409", { status: 409, cuerpo: { codigo: "estudio_desfasado" } }],
    ["500", { status: 500, cuerpo: {} }],
  ])("el cambio responde %s → elección de estudio, nunca el destino", async (_c, respuesta) => {
    await ir(enlace("buzon_cliente", { estudio: ESTUDIO_B.id }), rutasCambio(respuesta));
    await vi.waitFor(() => expect(navegado()).toContain("/estudios"));
    expect(navegado()).toEqual(["/estudios"]);
  });

  it("un error de red en el cambio → elección de estudio", async () => {
    await ir(enlace("buzon_cliente", { estudio: ESTUDIO_B.id }), {
      [LEER_SESION]: { status: 200, cuerpo: sesionDeA },
      [ELEGIR_ESTUDIO]: () => {
        throw new TypeError("fallo de red");
      },
    });
    await vi.waitFor(() => expect(navegado()).toContain("/estudios"));
    expect(navegado()).toEqual(["/estudios"]);
  });
});

describe("/ir · sin sesión (R-7)", () => {
  it("lleva a /login, sin cambiar de estudio ni ir al destino", async () => {
    const f = await ir(enlace("buzon_cliente"), { [LEER_SESION]: { status: 401, cuerpo: { codigo: "no_autenticado" } } });
    expect(navegado().every((d) => d.split("?")[0] === "/login")).toBe(true);
    expect(f.de(ELEGIR_ESTUDIO)).toHaveLength(0);
    expect(navegado().some((d) => d.includes("/clientes"))).toBe(false);
  });
});

describe("/ir · enlaces inválidos u hostiles (R-7, CA-13)", () => {
  const MALOS: [string, string][] = [
    ["pantalla fuera de la lista", enlace("admin_global")],
    ["pantalla vacía", enlace("")],
    ["pantalla //evil.com", enlace("//evil.com")],
    ["pantalla https://evil.com", enlace("https://evil.com")],
    ["pantalla javascript:", enlace("javascript:alert(1)")],
    ["pantalla con barras y puntos", enlace("../../etc/passwd")],
    ["pantalla con mayúsculas", enlace("BUZON_CLIENTE")],
    ["pantalla con espacio", enlace("buzon_cliente ")],
    ["pantalla con salto de línea", enlace("buzon_cliente\nSet-Cookie: x=1")],
    ["estudio que no es uuid", enlace("buzon_cliente", { estudio: "e-a" })],
    ["estudio //evil.com", enlace("buzon_cliente", { estudio: "//evil.com" })],
    ["estudio javascript:", enlace("buzon_cliente", { estudio: "javascript:alert(1)" })],
    ["cliente que no es uuid", enlace("buzon_cliente", { cliente: "123" })],
    ["cliente con ../", enlace("buzon_cliente", { cliente: "../../admin" })],
    ["cliente //evil.com", enlace("buzon_cliente", { cliente: "//evil.com" })],
    ["cliente javascript:", enlace("buzon_cliente", { cliente: "javascript:alert(1)" })],
    ["pantalla de cliente sin cliente", enlace("buzon_cliente", { cliente: null })],
    ["cliente basura en una pantalla sin cliente", enlace("buzon_estudio", { cliente: "//evil.com" })],
    ["sin parámetros", ""],
    ["solo estudio", `?estudio=${ESTUDIO_A.id}`],
    ["destino externo en otro parámetro", `${enlace("buzon_estudio", { cliente: null })}&next=https://evil.com&redirect=//evil.com`],
  ];

  it.each(MALOS)("%s → /estudios, a un sitio propio y sin cambiar de estudio", async (caso, consulta) => {
    const permitido = caso === "destino externo en otro parámetro";
    const f = await ir(consulta, {
      [LEER_SESION]: { status: 200, cuerpo: sesionDeA },
      [ELEGIR_ESTUDIO]: { status: 200, cuerpo: {} },
    });
    const destinos = navegado();
    if (permitido) {
      // Los parámetros ajenos se ignoran: el enlace sigue siendo válido y va a su pantalla.
      expect(destinos).toEqual(["/buzon"]);
    } else {
      expect(destinos).toEqual(["/estudios"]);
      expect(f.de(ELEGIR_ESTUDIO)).toHaveLength(0);
    }
    for (const d of destinos) expect(esDelSitio(d), d).toBe(true);
    expect(destinos.join("|")).not.toMatch(/evil|javascript|etc\/passwd|Set-Cookie/i);
  });

  it("con estudio ajeno el destino de cliente jamás se visita antes de elegir estudio", async () => {
    await ir(enlace("buzon_cliente", { estudio: ESTUDIO_B.id }), {
      [LEER_SESION]: { status: 200, cuerpo: sesionDeA },
      [ELEGIR_ESTUDIO]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
    });
    await vi.waitFor(() => expect(navegado()).toContain("/estudios"));
    expect(navegado().some((d) => d.includes(CLIENTE_ID))).toBe(false);
  });
});

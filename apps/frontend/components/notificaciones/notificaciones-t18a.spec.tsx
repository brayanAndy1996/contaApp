import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Manejador,
} from "../../pruebas/soporte";
import { Campana } from "./campana";
import { ListaNotificaciones } from "./panel-notificaciones";
import { textoNotificacion } from "./texto-notificacion";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// El aviso en vivo se simula: la prueba dispara a mano los suscriptores (sin abrir el stream SSE).
const avisos = vi.hoisted(() => ({ suscriptores: new Set<() => void>() }));
vi.mock("../../lib/notificaciones", async (original) => {
  const real = await original<typeof import("../../lib/notificaciones")>();
  return {
    ...real,
    suscribirAvisos: (cb: () => void) => {
      avisos.suscriptores.add(cb);
      return () => avisos.suscriptores.delete(cb);
    },
  };
});
const avisar = () => act(async () => avisos.suscriptores.forEach((cb) => cb()));

// Spec 017 · T18a (P-5, P-6, P-8, hora de Lima y texto de plan): el panel de la campana se cierra con Esc y con un clic fuera y maneja
// el foco; «Cargar más» no pierde el foco; la página abierta se refresca con el aviso en vivo.

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const nota = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  tipo: "credencial_invalida",
  creadaEn: `2026-11-11T15:${String(59 - n).padStart(2, "0")}:00.000Z`,
  leidaEn: null,
  cliente: { id: CLIENTE, razonSocial: `Cliente ${n} SAC` },
  trabajoId: null,
  params: { credencial: "sol" },
  ...extra,
});
const textoDe = (n: number) =>
  `La clave SOL de Cliente ${n} SAC fue rechazada por SUNAT. Actualízala para seguir trabajando.`;

function rutas(extra: Record<string, Manejador> = {}): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 2 } },
    "GET /api/notificaciones": {
      status: 200,
      cuerpo: { items: [nota(1), nota(2)], siguiente: null },
    },
    ...extra,
  };
}

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  avisos.suscriptores.clear();
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("campana · panel con Esc, clic fuera y foco (P-5)", () => {
  async function abrir() {
    const user = userEvent.setup();
    render(
      <div>
        <Campana />
        <button type="button">Otro control</button>
        <p>Texto de la página</p>
      </div>,
    );
    const campana = await screen.findByRole("button", { name: /Notificaciones/ });
    await user.click(campana);
    const panel = await screen.findByRole("dialog", { name: "Panel de notificaciones" });
    return { user, campana, panel };
  }

  it("feliz: el foco entra al panel; Esc lo cierra y el foco vuelve a la campana", async () => {
    instalarFetchFalso(rutas());
    const { user, campana, panel } = await abrir();
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(campana.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(campana.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(campana);
  });

  it("un clic fuera lo cierra; en un espacio vacío el foco vuelve a la campana y en otro control se queda ahí", async () => {
    instalarFetchFalso(rutas());
    const { user, campana } = await abrir();
    await user.click(screen.getByText("Texto de la página"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(campana);

    await user.click(campana);
    await screen.findByRole("dialog");
    const otro = screen.getByRole("button", { name: "Otro control" });
    await user.click(otro);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(otro);
  });

  it("un clic dentro del panel no lo cierra, y la campana alterna abrir y cerrar", async () => {
    instalarFetchFalso(rutas());
    const { user, campana, panel } = await abrir();
    await user.click(within(panel).getByRole("heading", { name: "Notificaciones" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await user.click(campana);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(campana);
  });

  it("error: Esc con el panel cerrado no hace nada", async () => {
    instalarFetchFalso(rutas());
    render(<Campana />);
    const campana = await screen.findByRole("button", { name: /Notificaciones/ });
    campana.focus();
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(campana);
  });
});

describe("/notificaciones · «Cargar más» no pierde el foco (P-6)", () => {
  const PAGINA_1 = Array.from({ length: 3 }, (_, i) => nota(i + 1));
  const PAGINA_2 = [nota(4), nota(5)];

  it("feliz: con Enter en «Cargar más» el foco pasa a la primera fila nueva, también cuando el botón desaparece", async () => {
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": (llamada) =>
          llamada.url.includes("cursor=c2")
            ? { status: 200, cuerpo: { items: PAGINA_2, siguiente: null } }
            : { status: 200, cuerpo: { items: PAGINA_1, siguiente: "c2" } },
      }),
    );
    render(<ListaNotificaciones />);
    const user = userEvent.setup();
    const mas = await screen.findByRole("button", { name: "Cargar más" });
    mas.focus();
    await user.keyboard("{Enter}");

    const nueva = await screen.findByText(textoDe(4));
    await vi.waitFor(() => expect(document.activeElement).toBe(nueva.closest("button")));
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("error: si «Cargar más» falla, el foco se queda en el botón y se puede reintentar", async () => {
    let n = 0;
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": (llamada) => {
          if (!llamada.url.includes("cursor=c2")) {
            return { status: 200, cuerpo: { items: PAGINA_1, siguiente: "c2" } };
          }
          n += 1;
          return n === 1
            ? { status: 500, cuerpo: {} }
            : { status: 200, cuerpo: { items: PAGINA_2, siguiente: null } };
        },
      }),
    );
    render(<ListaNotificaciones />);
    const user = userEvent.setup();
    const mas = await screen.findByRole("button", { name: "Cargar más" });
    mas.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cargar más" }));

    await user.keyboard("{Enter}");
    await screen.findByText(textoDe(4));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("/notificaciones · se refresca con el aviso en vivo (P-8)", () => {
  it("feliz: un aviso trae la notificación nueva arriba, sin duplicar ni recargar la página", async () => {
    let items = [nota(2), nota(3)];
    instalarFetchFalso(
      rutas({ "GET /api/notificaciones": () => ({ status: 200, cuerpo: { items, siguiente: null } }) }),
    );
    render(<ListaNotificaciones />);
    await screen.findByText(textoDe(2));
    expect(screen.queryByText(textoDe(1))).toBeNull();

    items = [nota(1), nota(2), nota(3)];
    await avisar();
    await screen.findByText(textoDe(1));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("con más páginas cargadas, lo nuevo se antepone y lo ya cargado se conserva sin repetirse", async () => {
    let primera = [nota(3), nota(4)];
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": (llamada) =>
          llamada.url.includes("cursor=c2")
            ? { status: 200, cuerpo: { items: [nota(5), nota(6)], siguiente: null } }
            : { status: 200, cuerpo: { items: primera, siguiente: "c2" } },
      }),
    );
    render(<ListaNotificaciones />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cargar más" }));
    await screen.findByText(textoDe(6));

    primera = [nota(1), nota(3), nota(4)];
    await avisar();
    await screen.findByText(textoDe(1));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText(textoDe(6))).toBeTruthy();
  });

  it("error: si el refresco falla, la lista queda como estaba y sin mensaje de error", async () => {
    let falla = false;
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": () =>
          falla
            ? { status: 500, cuerpo: {} }
            : { status: 200, cuerpo: { items: [nota(1)], siguiente: null } },
      }),
    );
    render(<ListaNotificaciones />);
    await screen.findByText(textoDe(1));
    falla = true;
    await avisar();
    expect(screen.getByText(textoDe(1))).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("fechas en hora de Lima y texto del plan", () => {
  it("la fecha de una notificación se ve en hora de Lima (03:30 UTC es el día anterior a las 10:30 p. m.)", async () => {
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": {
          status: 200,
          cuerpo: { items: [nota(1, { creadaEn: "2026-11-12T03:30:00.000Z" })], siguiente: null },
        },
      }),
    );
    render(<ListaNotificaciones />);
    const fila = (await screen.findByText(textoDe(1))).closest("button")!;
    expect(fila.textContent).toMatch(/11\/11\/26,? 10:30\s?p\.\s?m\./);
  });

  it("90 % y 100 % a la vez (5 de 5 usuarios): el del 90 % no dice «estás por llegar» y la unidad va con la cifra", () => {
    const base = { id: id(1), creadaEn: "2026-11-11T15:00:00.000Z", leidaEn: null, cliente: null, trabajoId: null, tipo: "plan_limite" as const };
    const texto = (recurso: "rucs" | "usuarios", umbral: 90 | 100, usado: number, limite: number) =>
      textoNotificacion({ ...base, params: { recurso, umbral, usado, limite } });
    expect(texto("usuarios", 90, 5, 5)).toBe("Superaste el 90 % del límite de tu plan: usas 5 de 5 usuarios.");
    expect(texto("usuarios", 100, 5, 5)).toBe("Llegaste al límite de tu plan: usas 5 de 5 usuarios.");
    expect(texto("rucs", 90, 9, 10)).toBe("Estás por llegar al límite de tu plan: usas 9 de 10 RUC.");
    expect(texto("rucs", 100, 10, 10)).toBe("Llegaste al límite de tu plan: usas 10 de 10 RUC.");
  });
});

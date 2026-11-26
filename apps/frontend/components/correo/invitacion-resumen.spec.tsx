import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import {
  GUARDAR_CORREO,
  LEER_CORREO,
  MENSAJES_CORREO as M,
  TEXTOS_CRUDOS_CORREO,
  VISTA_DUENO,
  VISTA_INICIAL,
  alcanza44px,
  cargarComponente,
  cuerpoDe,
  instalarServidorCorreo,
  type VistaCorreoPrueba,
} from "../../pruebas/correo";
import { crearRouterFalso } from "../../pruebas/soporte";

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
  usePathname: () => "/notificaciones",
  useSearchParams: () => new URLSearchParams(),
}));

// Spec 028 · T7 (rojo; R-15, U-8; CA-13). Invitación única al resumen diario.
// Contrato (T13):
//   - `components/correo/invitacion-resumen.tsx` exporta `InvitacionResumen` (sin props): al montar hace GET /api/cuenta/correo
//     y, solo si `invitacionResumen` es true, muestra M.invitacion con los botones «Activar resumen» y «Ahora no» (44 px).
//     Sin invitación (o con el GET fallido) no pinta nada: ni texto ni botones ni error.
//   - «Activar resumen» → un PUT con las cinco claves de la vista y `resumen: true`; «Ahora no» → ídem con `resumen: false`.
//     Con el PUT 200 la invitación desaparece (y como el servidor ya la apagó, un montaje nuevo no la vuelve a mostrar).
//     Con un fallo (500 o red) la invitación sigue, muestra M.errorInvitacion y los botones se pueden volver a pulsar.
//     Doble clic → un solo PUT.
//   - La página `/notificaciones` (`app/(app)/notificaciones/page.tsx`) la muestra encima del historial.
// Lo que va dentro de `/cuenta/correo` se prueba en preferencias-correo.spec.tsx.

const RUTA = "./invitacion-resumen";
const RUTA_NOTIFICACIONES = "../../app/(app)/notificaciones/page";
const cargar = () => cargarComponente(() => import(/* @vite-ignore */ RUTA), "InvitacionResumen");

async function pintar(inicial: VistaCorreoPrueba = VISTA_INICIAL, opciones: Parameters<typeof instalarServidorCorreo>[1] = {}) {
  const Invitacion = await cargar();
  const srv = instalarServidorCorreo(inicial, opciones);
  const r = render(<Invitacion />);
  return { srv, Invitacion, ...r };
}

const activar = () => screen.getByRole("button", { name: M.activarResumen });
const ahoraNo = () => screen.getByRole("button", { name: M.ahoraNo });

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<InvitacionResumen /> (R-15, U-8)", () => {
  it("con `invitacionResumen` muestra el texto y los dos botones, sin llamar al PUT todavía", async () => {
    const { srv } = await pintar(VISTA_INICIAL);
    expect(await screen.findByText(M.invitacion)).toBeTruthy();
    expect(activar()).toBeTruthy();
    expect(ahoraNo()).toBeTruthy();
    expect(srv.de(LEER_CORREO)).toHaveLength(1);
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(0);
  });

  it("sin `invitacionResumen` no pinta nada (ni texto ni botones)", async () => {
    const { srv, container } = await pintar(VISTA_DUENO);
    await vi.waitFor(() => expect(srv.de(LEER_CORREO)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(M.invitacion)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("con el GET fallido no pinta nada ni muestra errores (es un aviso opcional)", async () => {
    const { srv, container } = await pintar(VISTA_INICIAL, { leer: { status: 500, cuerpo: {} } });
    await vi.waitFor(() => expect(srv.de(LEER_CORREO)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(M.invitacion)).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("«Activar resumen» → un PUT con las cinco claves de la vista y `resumen: true`; luego desaparece", async () => {
    const { srv } = await pintar(VISTA_INICIAL);
    await userEvent.setup().click(await screen.findByRole("button", { name: M.activarResumen }));
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    const puts = srv.de(GUARDAR_CORREO);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual(cuerpoDe(VISTA_INICIAL, { resumen: true }));
    expect(puts[0]?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    expect(puts[0]?.headers["x-estudio"]).toBe("e-a");
    expect(screen.queryByRole("button", { name: M.activarResumen })).toBeNull();
    expect(screen.queryByRole("button", { name: M.ahoraNo })).toBeNull();
  });

  it("«Ahora no» → un PUT con `resumen: false` y el resto como estaba; luego desaparece", async () => {
    const vista = { ...VISTA_INICIAL, planLimite: true, buzonCritico: false };
    const { srv } = await pintar(vista);
    await userEvent.setup().click(await screen.findByRole("button", { name: M.ahoraNo }));
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(1);
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(vista, { resumen: false }));
  });

  it("aparece una sola vez: tras «Ahora no» o «Activar resumen», un montaje nuevo ya no la muestra", async () => {
    for (const boton of [M.ahoraNo, M.activarResumen]) {
      cleanup();
      const { srv, Invitacion, unmount } = await pintar(VISTA_INICIAL);
      await userEvent.setup().click(await screen.findByRole("button", { name: boton }));
      await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
      unmount();
      render(<Invitacion />);
      await vi.waitFor(() => expect(srv.de(LEER_CORREO).length).toBeGreaterThanOrEqual(2));
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByText(M.invitacion), boton).toBeNull();
    }
  });

  it("doble clic en «Activar resumen» → un solo PUT", async () => {
    let liberar: (() => void) | undefined;
    const puerta = new Promise<void>((r) => {
      liberar = r;
    });
    const { srv } = await pintar(VISTA_INICIAL);
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "PUT") await puerta;
        return original(entrada, init);
      }),
    );
    await screen.findByText(M.invitacion);
    await userEvent.setup().dblClick(activar());
    liberar?.();
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(1);
  });

  it.each([
    ["Activar resumen", M.activarResumen],
    ["Ahora no", M.ahoraNo],
  ])("si el PUT de «%s» falla (500), la invitación sigue, avisa en español y se puede reintentar", async (_c, boton) => {
    const { srv, container } = await pintar(VISTA_INICIAL, {
      guardar: (_l, vez) =>
        vez === 1 ? { status: 500, cuerpo: { codigo: "error_interno" } } : { status: 200, cuerpo: { ...VISTA_INICIAL, invitacionResumen: false } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: boton }));
    expect(await screen.findByText(M.errorInvitacion)).toBeTruthy();
    expect(screen.getByText(M.invitacion)).toBeTruthy();
    expect((screen.getByRole("button", { name: boton }) as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).not.toContain("error_interno");
    await user.click(screen.getByRole("button", { name: boton }));
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(2);
  });

  it("390 px: sin anchos fijos, botones de 44 px y sin códigos crudos", async () => {
    const { container } = await pintar(VISTA_INICIAL);
    await screen.findByText(M.invitacion);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
    expect(alcanza44px(activar())).toBe(true);
    expect(alcanza44px(ahoraNo())).toBe(true);
    for (const crudo of TEXTOS_CRUDOS_CORREO) expect(container.textContent, crudo).not.toContain(crudo);
  });
});

describe("invitación en /notificaciones (R-15)", () => {
  const notificaciones = {
    "GET /api/notificaciones": { status: 200, cuerpo: { items: [], siguiente: null } },
    "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 0 } },
  };

  it("la página de notificaciones muestra la invitación mientras `invitacionResumen`", async () => {
    const Pagina = await cargarComponente(() => import(/* @vite-ignore */ RUTA_NOTIFICACIONES), "default");
    instalarServidorCorreo(VISTA_INICIAL, { extra: notificaciones });
    render(<Pagina />);
    expect(await screen.findByText(M.invitacion)).toBeTruthy();
    expect(screen.getByRole("button", { name: M.activarResumen })).toBeTruthy();
    expect(screen.getByRole("button", { name: M.ahoraNo })).toBeTruthy();
  });

  it("y no la muestra cuando ya no corresponde", async () => {
    const Pagina = await cargarComponente(() => import(/* @vite-ignore */ RUTA_NOTIFICACIONES), "default");
    const srv = instalarServidorCorreo(VISTA_DUENO, { extra: notificaciones });
    render(<Pagina />);
    await vi.waitFor(() => expect(srv.de(LEER_CORREO)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(M.invitacion)).toBeNull();
    expect(screen.queryByRole("button", { name: M.ahoraNo })).toBeNull();
  });
});

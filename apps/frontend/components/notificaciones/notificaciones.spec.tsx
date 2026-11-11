import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  avisoDeMarco,
  formatoConteo,
  notificacionDeFila,
} from "../../lib/notificaciones";
import { trabajoDeMarco } from "../../lib/trabajos";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Manejador,
} from "../../pruebas/soporte";
import { Campana } from "./campana";
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

// Spec 017 T12 (D-10, D-11; CA-16, nivel C): la campana muestra el conteo («99+» desde 100), el panel marca como
// leída y navega, el texto sale en español sin códigos crudos y un fallo de red no rompe la barra.

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";
const N1 = "00000000-0000-4000-8000-0000000000a1";
const N2 = "00000000-0000-4000-8000-0000000000a2";
const N3 = "00000000-0000-4000-8000-0000000000a3";
const TRABAJO = "00000000-0000-4000-8000-0000000000b1";

const credencial = {
  id: N1,
  tipo: "credencial_invalida",
  creadaEn: "2026-11-11T15:00:00.000Z",
  leidaEn: null,
  cliente: { id: CLIENTE, razonSocial: "Distribuidora Andina SAC" },
  trabajoId: null,
  params: { credencial: "sol" },
} as const;
const trabajo = {
  id: N2,
  tipo: "trabajo_terminado",
  creadaEn: "2026-11-11T14:00:00.000Z",
  leidaEn: "2026-11-11T14:30:00.000Z",
  cliente: null,
  trabajoId: TRABAJO,
  params: {
    tipoTrabajo: "sire.propuesta.descargar",
    estado: "error",
    motivo: "sunat_no_responde",
  },
} as const;

function rutas(extra: Record<string, Manejador> = {}): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 2 } },
    "GET /api/notificaciones": {
      status: 200,
      cuerpo: { items: [credencial, trabajo], siguiente: null },
    },
    ...extra,
  };
}

describe("campana y panel de notificaciones", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra el conteo de no leídas y «99+» desde 100", async () => {
    instalarFetchFalso(rutas());
    render(<Campana />);
    expect((await screen.findByTestId("conteo-notificaciones")).textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Notificaciones, 2 sin leer" })).toBeTruthy();
    cleanup();

    instalarFetchFalso(
      rutas({ "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 100 } } }),
    );
    render(<Campana />);
    expect((await screen.findByTestId("conteo-notificaciones")).textContent).toBe("99+");
    expect(formatoConteo(99)).toBe("99");
  });

  it("al abrir una notificación la marca como leída y navega a la ficha del cliente", async () => {
    const f = instalarFetchFalso(
      rutas({ [`POST /api/notificaciones/${N1}/leida`]: { status: 204 } }),
    );
    render(<Campana />);
    await screen.findByTestId("conteo-notificaciones");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Notificaciones, 2 sin leer/ }));
    const panel = await screen.findByRole("dialog", { name: "Panel de notificaciones" });
    const texto = await within(panel).findByText(
      "La clave SOL de Distribuidora Andina SAC fue rechazada por SUNAT. Actualízala para seguir trabajando.",
    );
    await user.click(texto);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(`/clientes/${CLIENTE}`));
    const llamada = f.de(`POST /api/notificaciones/${N1}/leida`);
    expect(llamada).toHaveLength(1);
    expect(llamada[0]?.headers["x-csrf-token"]).toBeTruthy();
  });

  it("«marcar todas» envía la fecha de la más nueva que se ve", async () => {
    const f = instalarFetchFalso(
      rutas({ "POST /api/notificaciones/leidas": { status: 200, cuerpo: { marcadas: 1 } } }),
    );
    render(<Campana />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    await screen.findByText(/terminó con error/);
    await user.click(screen.getByRole("button", { name: "Marcar todas como leídas" }));
    await vi.waitFor(() => expect(f.de("POST /api/notificaciones/leidas")).toHaveLength(1));
    expect(f.de("POST /api/notificaciones/leidas")[0]?.body).toEqual({
      hasta: "2026-11-11T15:00:00.000Z",
    });
  });

  it("error de red: la campana queda sin número y el panel ofrece reintentar", async () => {
    instalarFetchFalso({ "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) } });
    render(<Campana />);
    const user = userEvent.setup();
    const boton = await screen.findByRole("button", { name: "Notificaciones" });
    expect(screen.queryByTestId("conteo-notificaciones")).toBeNull();
    await user.click(boton);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudieron cargar las notificaciones");
    expect(within(alerta).getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});

describe("texto de la notificación", () => {
  it("arma el texto en español según el tipo", () => {
    const base = { id: N3, creadaEn: credencial.creadaEn, leidaEn: null, cliente: null, trabajoId: null };
    expect(
      textoNotificacion({
        ...base,
        tipo: "plan_limite",
        params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 },
      }),
    ).toBe("Estás por llegar al límite de RUC de tu plan (9 de 10).");
    expect(
      textoNotificacion({
        ...base,
        tipo: "plan_limite",
        params: { recurso: "usuarios", umbral: 100, usado: 5, limite: 5 },
      }),
    ).toBe("Llegaste al límite de usuarios de tu plan (5 de 5).");
    expect(textoNotificacion(notificacionDeFila(trabajo)!)).toBe(
      "La descarga de la propuesta del SIRE terminó con error: SUNAT no responde.",
    );
  });

  it("un tipo o código desconocido da un texto genérico, nunca el código crudo", () => {
    const desconocida = notificacionDeFila({
      ...credencial,
      tipo: "tipo_del_futuro",
      params: { x: 1 },
    });
    expect(desconocida?.tipo).toBe("desconocido");
    const texto = textoNotificacion(desconocida!);
    expect(texto).toBe("Tienes una notificación nueva.");
    expect(texto).not.toContain("tipo_del_futuro");

    const conCodigoNuevo = textoNotificacion({
      ...notificacionDeFila(trabajo)!,
      params: { tipoTrabajo: "tarea.nueva_x", estado: "error", motivo: "motivo_nuevo_x" },
    } as never);
    expect(conCodigoNuevo).not.toMatch(/tarea\.nueva_x|motivo_nuevo_x/);
  });

  it("una razón social con <script> se muestra como texto", async () => {
    const maliciosa = {
      ...credencial,
      cliente: { id: CLIENTE, razonSocial: "<script>alert(1)</script>" },
    };
    instalarFetchFalso(
      rutas({ "GET /api/notificaciones": { status: 200, cuerpo: { items: [maliciosa], siguiente: null } } }),
    );
    reiniciarSesion();
    const { container } = render(<Campana />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
  });
});

describe("aviso en vivo", () => {
  it("reconoce `event: notificacion` y `trabajoDeMarco` lo ignora", () => {
    const marco = 'event: notificacion\ndata: {}';
    expect(avisoDeMarco(marco)).toBe(true);
    expect(avisoDeMarco(": latido")).toBe(false);
    expect(avisoDeMarco('event: trabajo\ndata: {"id":"x"}')).toBe(false);
    expect(trabajoDeMarco(marco)).toBeNull();
  });
});

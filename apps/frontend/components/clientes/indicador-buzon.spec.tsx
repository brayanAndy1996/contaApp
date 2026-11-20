import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { esperarFila, fila, rutaSesion, yoDe } from "../../pruebas/acceso";
import { MENSAJES_BANDEJA as B, queryDe } from "../../pruebas/bandeja";
import { clienteDe } from "../../pruebas/clientes";
import { crearRouterFalso, instalarFetchFalso, type FetchFalso, type Manejador } from "../../pruebas/soporte";

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
  usePathname: () => "/clientes",
  useSearchParams: () => new URLSearchParams(),
}));

import Clientes from "../../app/(app)/clientes/page";
import { IndicadorBuzon } from "./indicador-buzon";

// Spec 024 · T5 (rojo; D-9, CA-3, CA-8). Indicador de mensajes nuevos en el listado de clientes.
// Contrato (T9), `components/clientes/indicador-buzon.tsx`:
//   <IndicadorBuzon clienteId="c-1" buzon?={{nuevos, criticosNuevos}} />   (`buzon` es `ClienteDto.buzon`)
//   - Sin `buzon` (el usuario no tiene `buzon.ver`: el campo no viaja) o con 0 nuevos: no pinta nada.
//   - Con nuevos: un enlace a `/clientes/:clienteId/buzon` con un `Badge` «N nuevos» y, aparte, otro «N críticos» (solo si
//     hay críticos nuevos) con el token de error y con texto, no solo color. Singular con 1: «1 nuevo», «1 crítico».
// Listado (`app/(app)/clientes/page.tsx`): cada fila muestra su indicador cuando el cliente trae `buzon`; con `buzon.ver`
// hay una casilla «Con mensajes nuevos» que pide `conMensajesNuevos=1` (sin ella, no existe: la API daría 403) y al
// desmarcarla quita el parámetro. Solo components/ui y tokens.

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<IndicadorBuzon />", () => {
  it("con nuevos y críticos: enlace a la bandeja fijada, «N nuevos» y «N críticos» en rojo con texto", () => {
    render(<IndicadorBuzon clienteId="c-1" buzon={{ nuevos: 5, criticosNuevos: 2 }} />);
    const enlace = screen.getByRole("link", { name: new RegExp(B.nuevos(5)) });
    expect(enlace.getAttribute("href")).toBe("/clientes/c-1/buzon");
    expect(within(enlace).getByText(B.nuevos(5))).toBeTruthy();
    const criticos = within(enlace).getByText(B.criticos(2));
    expect(criticos.className).toMatch(/(text|bg|border)-error/);
    expect(screen.getByText(B.nuevos(5)).className).not.toMatch(/-error/);
  });

  it("sin críticos solo dice los nuevos", () => {
    render(<IndicadorBuzon clienteId="c-1" buzon={{ nuevos: 3, criticosNuevos: 0 }} />);
    expect(screen.getByText(B.nuevos(3))).toBeTruthy();
    expect(screen.queryByText(/crítico/)).toBeNull();
  });

  it("singular con uno", () => {
    render(<IndicadorBuzon clienteId="c-1" buzon={{ nuevos: 1, criticosNuevos: 1 }} />);
    expect(screen.getByText(B.nuevos(1))).toBeTruthy();
    expect(screen.getByText(B.criticos(1))).toBeTruthy();
  });

  it("cero nuevos: no pinta nada, ni enlace", () => {
    const { container } = render(<IndicadorBuzon clienteId="c-1" buzon={{ nuevos: 0, criticosNuevos: 0 }} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("sin `buzon` (sin `buzon.ver`): no pinta nada", () => {
    const { container } = render(<IndicadorBuzon clienteId="c-1" />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("el id del cliente se codifica en el enlace", () => {
    render(<IndicadorBuzon clienteId="a/b" buzon={{ nuevos: 2, criticosNuevos: 0 }} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/clientes/a%2Fb/buzon");
  });

  it("el archivo no usa dangerouslySetInnerHTML ni innerHTML", () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(aqui, "indicador-buzon.tsx"), "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

const CON_BUZON = [
  clienteDe({ id: "c-1", ruc: "20100000009", razonSocial: "Alfa SAC", buzon: { nuevos: 4, criticosNuevos: 1 } }),
  clienteDe({ id: "c-2", ruc: "20600000005", razonSocial: "Beta SRL", buzon: { nuevos: 0, criticosNuevos: 0 } }),
];
const SIN_BUZON = CON_BUZON.map((c) => Object.fromEntries(Object.entries(c).filter(([clave]) => clave !== "buzon")));

function rutas(permisos: string[], clientes: unknown[], extra: Record<string, Manejador> = {}) {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", permisos) },
    "GET /api/clientes": { status: 200, cuerpo: clientes },
    "GET /api/usuarios": { status: 200, cuerpo: [] },
    ...extra,
  };
}
const consulta = (f: FetchFalso) => f.de("GET /api/clientes").map((l) => queryDe(l.url));

describe("/clientes · indicador de mensajes nuevos (CA-8)", () => {
  it("con `buzon.ver`: la fila muestra «N nuevos» y «N críticos» y enlaza a la bandeja fijada", async () => {
    instalarFetchFalso(rutas(["clientes.ver", "buzon.ver"], CON_BUZON));
    render(<Clientes />);
    const alfa = await esperarFila("Alfa SAC");
    expect(within(alfa).getByText(B.nuevos(4))).toBeTruthy();
    expect(within(alfa).getByText(B.criticos(1)).className).toMatch(/-error/);
    expect(within(alfa).getByRole("link", { name: new RegExp(B.nuevos(4)) }).getAttribute("href")).toBe("/clientes/c-1/buzon");
    expect(fila("Beta SRL").textContent).not.toMatch(/nuevo/);
  });

  it("sin `buzon.ver` el campo no viaja: ninguna fila lo muestra y no hay filtro", async () => {
    instalarFetchFalso(rutas(["clientes.ver"], SIN_BUZON));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    expect(screen.queryByText(/nuevo/)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: B.filtroConMensajesNuevos })).toBeNull();
  });

  it("«Con mensajes nuevos» pide conMensajesNuevos=1 y al desmarcarla lo quita", async () => {
    const f = instalarFetchFalso(
      rutas(["clientes.ver", "buzon.ver"], CON_BUZON, {
        "GET /api/clientes": (l) => ({
          status: 200,
          cuerpo: l.url.includes("conMensajesNuevos=1") ? [CON_BUZON[0]] : CON_BUZON,
        }),
      }),
    );
    render(<Clientes />);
    await esperarFila("Beta SRL");
    expect(consulta(f)[0]).toEqual({});
    const usuario = userEvent.setup();
    const casilla = await screen.findByRole("checkbox", { name: B.filtroConMensajesNuevos });
    await usuario.click(casilla);
    await vi.waitFor(() => expect(consulta(f).at(-1)).toEqual({ conMensajesNuevos: "1" }));
    await vi.waitFor(() => expect(screen.queryByText("Beta SRL")).toBeNull());
    await usuario.click(casilla);
    await vi.waitFor(() => expect(consulta(f).at(-1)).toEqual({}));
    await esperarFila("Beta SRL");
  });

  it("el filtro se combina con los demás (archivados)", async () => {
    const f = instalarFetchFalso(rutas(["clientes.ver", "buzon.ver"], CON_BUZON));
    render(<Clientes />);
    await esperarFila("Alfa SAC");
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("checkbox", { name: B.filtroConMensajesNuevos }));
    await usuario.click(screen.getByRole("checkbox", { name: "Mostrar archivados" }));
    await vi.waitFor(() => expect(consulta(f).at(-1)).toEqual({ conMensajesNuevos: "1", archivados: "1" }));
  });
});

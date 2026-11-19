import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { rutaSesion, yoDe } from "../../pruebas/acceso";
import {
  CLIENTE_BUZON,
  MENSAJES_BUZON as M,
  RUTA_MENSAJES,
  RUTA_REVISAR,
  paginaBuzon,
} from "../../pruebas/buzon";
import { clienteDe } from "../../pruebas/clientes";
import { estadoCredencialDe, trabajoDe } from "../../pruebas/credenciales";
import { usoDe } from "../../pruebas/planes";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
} from "../../pruebas/soporte";
import { RevisarBuzon } from "./revisar-buzon";

// Spec 023 · T23a (rojo; T23a-1 y T23a-3b de la prueba manual). «Revisar buzón ahora».
//  T23a-1: en la ficha del cliente, al guardar la clave SOL en la misma pantalla el botón se habilita SIN recargar la
//    página (antes se quedaba gris con M.sinCredencial / M.credencialInvalida). La prueba monta la ficha entera
//    (`app/(app)/clientes/[clienteId]/page.tsx`: `CredencialesCliente` y `RevisarBuzon` son hermanos) y no fija la señal:
//    sirve volver a leer el estado de la credencial o del cliente, o compartirlo; el servidor simulado responde con el
//    estado nuevo a cualquier lectura posterior al PUT.
//  T23a-3b: al pulsar Enter en el botón, el foco no cae a `body` mientras `ocupado` (usar `aria-disabled`, no `disabled`)
//    ni después; queda en el botón o pasa al mensaje de estado (`role=status`/`alert`, enfocable). Un segundo Enter
//    durante la espera no manda otro POST.

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
  usePathname: () => "/clientes/c-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Ficha from "../../app/(app)/clientes/[clienteId]/page";

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const habilitado = (b: HTMLElement): boolean =>
  !(b as HTMLButtonElement).disabled && b.getAttribute("aria-disabled") !== "true";

describe("T23a-1 · la ficha habilita «Revisar buzón ahora» al guardar la clave SOL, sin recargar", () => {
  it.each([
    ["inválida", "invalida", M.credencialInvalida],
    ["sin configurar", "no_configurada", M.sinCredencial],
  ] as const)("clave SOL %s: tras Guardar el botón se habilita y el motivo desaparece", async (_n, inicial, motivo) => {
    let sol: "invalida" | "no_configurada" | "configurada" = inicial;
    const credenciales = () => [
      estadoCredencialDe("sol", sol),
      estadoCredencialDe("sire_api", "no_configurada"),
    ];
    const f = instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": {
        status: 200,
        cuerpo: yoDe("dueno", ["clientes.ver", "credenciales.editar", "buzon.ver"]),
      },
      // El cliente y la credencial dicen siempre el estado vigente, para cualquier señal que use la ficha.
      "GET /api/clientes/c-1": () => ({
        status: 200,
        cuerpo: clienteDe({ credenciales: { sol, sire_api: "no_configurada" } }),
      }),
      "GET /api/clientes/c-1/asignaciones": { status: 200, cuerpo: [] },
      "GET /api/usuarios": { status: 200, cuerpo: [] },
      "GET /api/plan/uso": {
        status: 200,
        cuerpo: usoDe({ rucs: { usados: 1, limite: 100, libres: 99, extra: 0 } }),
      },
      "GET /api/clientes/c-1/credenciales": () => ({ status: 200, cuerpo: credenciales() }),
      "PUT /api/clientes/c-1/credenciales/sol": () => {
        sol = "configurada";
        return { status: 200, cuerpo: { tipo: "sol", estado: "configurada" } };
      },
      [RUTA_MENSAJES]: { status: 200, cuerpo: paginaBuzon() },
    });
    render(<Ficha />);
    const usuario = userEvent.setup();

    const boton = await screen.findByRole("button", { name: M.revisar });
    await vi.waitFor(() => expect(screen.queryByText(motivo)).not.toBeNull());
    expect(habilitado(boton)).toBe(false);

    const region = await screen.findByRole("region", { name: "Credenciales" });
    const grupo = within(region).getByRole("group", { name: "Credencial SOL" });
    await usuario.type(within(grupo).getByLabelText("Usuario SOL"), "USUARIO1");
    await usuario.type(within(grupo).getByLabelText("Clave SOL"), "clave-sol-1");
    await usuario.click(within(grupo).getByRole("button", { name: "Guardar" }));
    await vi.waitFor(() => expect(f.de("PUT /api/clientes/c-1/credenciales/sol")).toHaveLength(1));

    await vi.waitFor(() =>
      expect(habilitado(screen.getByRole("button", { name: M.revisar }))).toBe(true),
    );
    expect(screen.queryByText(motivo)).toBeNull();
  });
});

describe("T23a-3b · el foco no se pierde al pedir la revisión con Enter", () => {
  function instalar() {
    const f = instalarFetchFalso({
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }) },
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", ["clientes.ver", "buzon.ver"]) },
      [`GET /api/clientes/${CLIENTE_BUZON}/credenciales`]: {
        status: 200,
        cuerpo: [estadoCredencialDe("sol", "verificada"), estadoCredencialDe("sire_api", "no_configurada")],
      },
      [RUTA_MENSAJES]: { status: 200, cuerpo: paginaBuzon() },
      [RUTA_REVISAR]: { status: 202, cuerpo: { trabajo: trabajoDe({ tipo: "sol.buzon.revisar" }) } },
    });
    // El POST queda en el aire hasta `liberar()`: así se mira el foco mientras el botón está ocupado.
    const real = globalThis.fetch;
    let liberar!: () => void;
    const compuerta = new Promise<void>((r) => (liberar = r));
    let pedidos = 0;
    vi.stubGlobal("fetch", async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.pathname : entrada.url;
      if ((init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/buzon/revisar")) {
        pedidos += 1;
        await compuerta;
      }
      return real(entrada, init);
    });
    return { f, liberar, pedidos: () => pedidos };
  }

  const enEstado = (el: Element | null): boolean =>
    el !== null && el.closest('[role="status"], [role="alert"]') !== null;

  it("Enter: durante la espera el foco no cae a body y el botón no queda `disabled`; un segundo Enter no repite el POST", async () => {
    const { liberar, pedidos } = instalar();
    render(<RevisarBuzon clienteId={CLIENTE_BUZON} archivado={false} />);
    const usuario = userEvent.setup();
    const boton = await screen.findByRole("button", { name: M.revisar });
    await vi.waitFor(() => expect(habilitado(boton)).toBe(true));

    await usuario.tab();
    expect(document.activeElement).toBe(boton);
    await usuario.keyboard("{Enter}");
    await vi.waitFor(() => expect(pedidos()).toBe(1));

    const foco = document.activeElement;
    expect(foco, "el foco cayó a body mientras se revisa").not.toBe(document.body);
    if (foco === boton) {
      expect((boton as HTMLButtonElement).disabled).toBe(false);
      expect(boton.getAttribute("aria-disabled")).toBe("true");
    }
    await usuario.keyboard("{Enter}");
    expect(pedidos()).toBe(1);

    liberar();
    expect(await screen.findByText(M.encolada)).toBeTruthy();
    const despues = document.activeElement;
    expect(despues, "el foco cayó a body al terminar").not.toBe(document.body);
    expect(despues === boton || enEstado(despues)).toBe(true);
  });
});

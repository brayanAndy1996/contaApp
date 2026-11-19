import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { yoDe } from "../../pruebas/acceso";
import {
  CLIENTE_BUZON,
  MENSAJES_BUZON as M,
  MENSAJE_ID,
  detalleBuzon,
  rutaAbrir,
  rutaDetalle,
} from "../../pruebas/buzon";
import { trabajoDe } from "../../pruebas/credenciales";
import { instalarFetchFalso, sesionDe, type Manejador } from "../../pruebas/soporte";
import { DetalleMensaje } from "./detalle-mensaje";

// Spec 023 · T23a (rojo; T23a-3a, T23a-4 y T23a-5 de la prueba manual). Vista mínima de un mensaje.
//  T23a-3a: al cerrar el diálogo de «Abrir en SUNAT» con Esc o «Cancelar», el foco vuelve a «Abrir en SUNAT».
//  T23a-4: contrato nuevo `<DetalleMensaje clienteId mensajeId archivado? />` (la página del buzón ya conoce `archivado`,
//    igual que para `RevisarBuzon`). Con `archivado`, «Abrir en SUNAT» no se ofrece o sale deshabilitado con su motivo
//    (M.archivado) y no se llama a …/abrir.
//  T23a-5: tras «Apertura encolada.» la vista vuelve a pedir el detalle sola hasta que llega el contenido (sondeo acotado
//    que se detiene al llegar y no es infinito); y quien no tiene `buzon.marcar_leido` ve, sin contenido, que debe abrirlo
//    alguien con permiso.

const PERMISOS_LECTURA = ["clientes.ver", "buzon.ver"];
const PERMISOS_ABRIR = ["clientes.ver", "buzon.ver", "buzon.marcar_leido"];

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function instalar(
  detalle: Manejador,
  opciones: { permisos?: string[]; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }) },
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", opciones.permisos ?? PERMISOS_ABRIR) },
    [rutaDetalle()]: detalle,
    ...opciones.extra,
  });
}

type Props = ComponentProps<typeof DetalleMensaje>;
const montar = (extra: Record<string, unknown> = {}, avanzar?: (ms: number) => unknown) => {
  const props = { clienteId: CLIENTE_BUZON, mensajeId: MENSAJE_ID, ...extra } as Props;
  render(<DetalleMensaje {...props} />);
  return userEvent.setup(avanzar ? { advanceTimers: avanzar } : undefined);
};
const dialogo = (): HTMLElement | null => screen.queryByRole("alertdialog") ?? screen.queryByRole("dialog");
const esperarDialogo = (): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const d = dialogo();
    if (!d) throw new Error("no hay diálogo de confirmación");
    return d;
  });
const botonAbrir = () => screen.getByRole("button", { name: M.abrirEnSunat });

describe("T23a-3a · el foco vuelve a «Abrir en SUNAT» al cerrar el diálogo", () => {
  it("Esc", async () => {
    instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) });
    const usuario = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await esperarDialogo();
    await usuario.keyboard("{Escape}");
    await vi.waitFor(() => expect(dialogo()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(botonAbrir()));
  });

  it("«Cancelar»", async () => {
    const f = instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) });
    const usuario = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.cancelar }));
    await vi.waitFor(() => expect(dialogo()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(botonAbrir()));
    expect(f.de(rutaAbrir())).toHaveLength(0);
  });
});

describe("T23a-4 · cliente archivado", () => {
  it("«Abrir en SUNAT» no se ofrece o sale deshabilitado con su motivo, y no se puede confirmar", async () => {
    const f = instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) });
    const usuario = montar({ archivado: true });
    await screen.findByText(M.sinContenido);

    const boton = screen.queryByRole("button", { name: M.abrirEnSunat });
    if (boton !== null) {
      expect(
        (boton as HTMLButtonElement).disabled || boton.getAttribute("aria-disabled") === "true",
        "«Abrir en SUNAT» sigue habilitado en un cliente archivado",
      ).toBe(true);
      expect(screen.queryByText(M.archivado)).not.toBeNull();
      await usuario.click(boton);
    }
    expect(dialogo()).toBeNull();
    expect(f.de(rutaAbrir())).toHaveLength(0);
  });

  it("control: sin archivar, con permiso y sin contenido, sí se ofrece habilitado", async () => {
    instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) });
    montar({ archivado: false });
    const boton = await screen.findByRole("button", { name: M.abrirEnSunat });
    expect((boton as HTMLButtonElement).disabled).toBe(false);
    expect(boton.getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("T23a-5 · el detalle se refresca tras «Apertura encolada.»", () => {
  const CONTENIDO = "Texto obtenido por el worker.";
  const abrirYConfirmar = async (usuario: ReturnType<typeof userEvent.setup>) => {
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.confirmar }));
    expect(await screen.findByText(M.aperturaEncolada)).toBeTruthy();
  };
  const abrirEncolada: Record<string, Manejador> = {
    [rutaAbrir()]: { status: 202, cuerpo: { trabajo: trabajoDe({ tipo: "sol.buzon.abrir" }) } },
  };

  it("vuelve a consultar solo y muestra el contenido cuando llega; después deja de consultar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = instalar(
      // La primera lectura (al montar) viene sin contenido; el worker lo guarda y las siguientes ya lo traen.
      (_l, vez) => ({ status: 200, cuerpo: detalleBuzon({ contenido: vez >= 2 ? CONTENIDO : null }) }),
      { extra: abrirEncolada },
    );
    const usuario = montar({}, vi.advanceTimersByTime);
    await abrirYConfirmar(usuario);

    for (let s = 0; s < 30 && screen.queryByText(CONTENIDO) === null; s++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(screen.queryByText(CONTENIDO), "el contenido no apareció sin recargar").not.toBeNull();
    expect(screen.queryByText(M.sinContenido)).toBeNull();
    expect(screen.queryByRole("button", { name: M.abrirEnSunat })).toBeNull();

    const lecturas = f.de(rutaDetalle()).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.de(rutaDetalle()).length, "sigue consultando con el contenido ya a la vista").toBe(lecturas);
  });

  it("el sondeo es acotado: si el contenido no llega, consulta varias veces y se detiene", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) }, { extra: abrirEncolada });
    const usuario = montar({}, vi.advanceTimersByTime);
    await abrirYConfirmar(usuario);

    await vi.advanceTimersByTimeAsync(600_000);
    const diezMin = f.de(rutaDetalle()).length;
    expect(diezMin, "no volvió a consultar tras «Apertura encolada.»").toBeGreaterThanOrEqual(3);
    expect(diezMin, "sondeo sin freno").toBeLessThanOrEqual(300);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.de(rutaDetalle()).length, "el sondeo no tiene tope").toBe(diezMin);
  });
});

describe("T23a-5 · Lectura sin contenido", () => {
  it("explica que debe abrirlo alguien con permiso y no ofrece «Abrir en SUNAT»", async () => {
    instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) }, { permisos: PERMISOS_LECTURA });
    montar();
    await screen.findByText(M.sinContenido);
    expect(screen.queryByRole("button", { name: M.abrirEnSunat })).toBeNull();
    expect(
      screen.queryByText(/(permiso.*abrir|abrir.*permiso)/is),
      "falta la explicación de quién puede abrir el mensaje",
    ).not.toBeNull();
  });

  it("control: con permiso para abrir no se muestra esa explicación", async () => {
    instalar({ status: 200, cuerpo: detalleBuzon({ contenido: null }) });
    montar();
    await screen.findByRole("button", { name: M.abrirEnSunat });
    expect(screen.queryByText(/(permiso.*abrir|abrir.*permiso)/is)).toBeNull();
  });
});

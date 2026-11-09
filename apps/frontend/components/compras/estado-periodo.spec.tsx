import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextoCompras, PermisosCompras } from "../../lib/compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  CLIENTE_ID,
  MENSAJES_COMPRAS as M,
  PERIODO,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { MENSAJES_VENTAS } from "../../pruebas/ventas";
import { EstadoPeriodo, calcularSoloLectura } from "./estado-periodo";

// Estado del periodo (spec 015, T3; D-13; CA-13, CA-14): insignia, «Marcar como revisado» con confirmación,
// «Reabrir» con `estadoVisto`, 409 `estado_invalido` recarga, y el cálculo de `soloLectura`.

const TODOS: PermisosCompras = {
  ver: true,
  descargar: true,
  clasificar: true,
  aprobarGenerar: true,
};
const SIN_APROBAR: PermisosCompras = { ...TODOS, aprobarGenerar: false };
const LECTURA: PermisosCompras = {
  ver: true,
  descargar: false,
  clasificar: false,
  aprobarGenerar: false,
};

const POST_REVISAR = `POST ${BASE}/estado/revisar`;
const POST_REABRIR = `POST ${BASE}/estado/reabrir`;
const USUARIO = "00000000-0000-4000-8000-0000000000a1";
const EN = "2026-11-05T15:30:00.000Z";

function montar(
  estado: ContextoCompras["estado"],
  permisos: PermisosCompras,
  o: { archivado?: boolean; en?: string | null } = {},
) {
  const alCambiar = vi.fn();
  const alRecargar = vi.fn();
  const archivado = o.archivado ?? false;
  const contexto: ContextoCompras = {
    clienteId: CLIENTE_ID,
    periodo: PERIODO,
    permisos,
    estado,
    soloLectura: calcularSoloLectura({ archivado, permisos, estado }),
    recargarFila: async () => undefined,
    recargarFilas: async () => undefined,
    recargarResumen: async () => undefined,
  };
  render(
    <EstadoPeriodo
      contexto={contexto}
      archivado={archivado}
      en={o.en ?? null}
      alCambiar={alCambiar}
      alRecargar={alRecargar}
    />,
  );
  return { alCambiar, alRecargar };
}

const confirmar = async (user: ReturnType<typeof userEvent.setup>) => {
  const dialogo = await screen.findByRole("alertdialog");
  await user.click(within(dialogo).getByRole("button", { name: MENSAJES_VENTAS.confirmar }));
};

describe("calcularSoloLectura (spec 015 T3, D-13)", () => {
  it.each([
    ["abierto con clasificar", "abierto", TODOS, false, null],
    ["revisado con aprobar y generar", "revisado", TODOS, false, null],
    ["revisado sin aprobar y generar", "revisado", SIN_APROBAR, false, M.soloLectura.revisadoSinAprobar],
    ["generado, aunque pueda aprobar", "generado", TODOS, false, M.soloLectura.generado],
    ["sin sire.clasificar", "abierto", LECTURA, false, M.soloLectura.sinPermiso],
    ["cliente archivado manda sobre todo", "generado", TODOS, true, M.soloLectura.clienteArchivado],
  ] as const)("%s", (_nombre, estado, permisos, archivado, esperado) => {
    expect(calcularSoloLectura({ archivado, permisos, estado })).toBe(esperado);
  });
});

describe("EstadoPeriodo (spec 015 T3, D-13, CA-13)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: abierto → «Marcar como revisado» pide confirmación y cambia el estado", async () => {
    const f = instalarFetchCompras({
      extra: {
        [POST_REVISAR]: {
          status: 200,
          cuerpo: { estado: "revisado", por: USUARIO, en: EN },
        },
      },
    });
    const { alCambiar } = montar("abierto", TODOS);
    expect(screen.getByText(M.estado.abierto)).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.reabrir })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.marcarRevisado }));
    // Antes de confirmar no se llama al servidor, y la confirmación avisa del bloqueo.
    expect(f.de(POST_REVISAR)).toHaveLength(0);
    expect(screen.getByText(M.confirmarRevisado)).toBeTruthy();
    await confirmar(user);

    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalledTimes(1));
    expect(alCambiar).toHaveBeenCalledWith({ estado: "revisado", por: USUARIO, en: EN });
    expect(f.de(POST_REVISAR)).toHaveLength(1);
    expect(await screen.findByText(M.periodoRevisado)).toBeTruthy();
  });

  it("cancelar la confirmación no llama al servidor", async () => {
    const f = instalarFetchCompras();
    montar("abierto", TODOS);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.marcarRevisado }));
    const dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByRole("button", { name: MENSAJES_VENTAS.cancelar }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(POST_REVISAR)).toHaveLength(0);
  });

  it.each(["revisado", "generado"] as const)(
    "reabrir un periodo %s envía {estadoVisto: %s}",
    async (estado) => {
      const f = instalarFetchCompras({
        extra: {
          [POST_REABRIR]: {
            status: 200,
            cuerpo: { estado: "abierto", por: USUARIO, en: EN },
          },
        },
      });
      const { alCambiar } = montar(estado, TODOS, { en: EN });
      expect(screen.getByText(M.estado[estado])).toBeTruthy();
      expect(screen.getByText(/Marcado el /)).toBeTruthy();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: M.reabrir }));
      // En generado la confirmación avisa del reproceso.
      expect(
        screen.getByRole("alertdialog").textContent?.includes("generar el archivo de nuevo"),
      ).toBe(estado === "generado");
      await confirmar(user);

      await vi.waitFor(() => expect(f.de(POST_REABRIR)).toHaveLength(1));
      expect(f.de(POST_REABRIR)[0]!.body).toEqual({ estadoVisto: estado });
      await vi.waitFor(() => expect(alCambiar).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(M.periodoReabierto)).toBeTruthy();
    },
  );

  it("error: 409 estado_invalido muestra el aviso y pide recargar el estado", async () => {
    const f = instalarFetchCompras({
      extra: {
        [POST_REABRIR]: { status: 409, cuerpo: { codigo: "estado_invalido" } },
      },
    });
    const { alCambiar, alRecargar } = montar("revisado", TODOS);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.reabrir }));
    await confirmar(user);

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(M.errores.estado_invalido);
    expect(alRecargar).toHaveBeenCalledTimes(1);
    expect(alCambiar).not.toHaveBeenCalled();
    expect(f.de(POST_REABRIR)).toHaveLength(1);
  });

  it("error: un 403 del servidor se muestra con su mensaje y no cambia el estado", async () => {
    instalarFetchCompras({
      extra: {
        [POST_REVISAR]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
      },
    });
    const { alCambiar, alRecargar } = montar("abierto", TODOS);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: M.marcarRevisado }));
    await confirmar(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      M.errores.permiso_denegado,
    );
    expect(alCambiar).not.toHaveBeenCalled();
    expect(alRecargar).not.toHaveBeenCalled();
  });

  it.each([
    ["abierto sin sire.clasificar", "abierto", LECTURA, false, [], [M.marcarRevisado, M.reabrir]],
    ["revisado sin sire.aprobar_generar", "revisado", SIN_APROBAR, false, [], [M.marcarRevisado, M.reabrir]],
    ["generado con aprobar y generar", "generado", TODOS, false, [M.reabrir], [M.marcarRevisado]],
    ["cliente archivado", "abierto", TODOS, true, [], [M.marcarRevisado, M.reabrir]],
  ] as const)(
    "botones según permisos y estado: %s",
    (_nombre, estado, permisos, archivado, visibles, ocultos) => {
      instalarFetchCompras();
      montar(estado, permisos, { archivado });
      for (const nombre of visibles) {
        expect(screen.getByRole("button", { name: nombre })).toBeTruthy();
      }
      for (const nombre of ocultos) {
        expect(screen.queryByRole("button", { name: nombre })).toBeNull();
      }
    },
  );
});

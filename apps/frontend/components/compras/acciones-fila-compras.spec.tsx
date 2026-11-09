import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_1040_ISC,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { AccionesFilaCompras } from "./acciones-fila-compras";

// Spec 015 · T7 (CA-6, CA-9, D-10, D-11): el menú de una fila. Un caso feliz y uno de error por comportamiento.

const ruta = (id: string, sufijo: string) => `POST ${BASE}/${id}/${sufijo}`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function abrirMenu(usuario: ReturnType<typeof userEvent.setup>, comprobante: string) {
  await usuario.click(
    await screen.findByRole("button", { name: `${M.columnas.acciones} ${comprobante}` }),
  );
}

describe("AccionesFilaCompras · clasificar (CA-6)", () => {
  it("clasifica F001-3064 como DNG, espera al servidor y recarga la fila y el resumen", async () => {
    const nueva = filaDe({
      ...C_3064_BOLSAS,
      version: 2,
      clasificada: true,
      montos: montosDe({ biDng: "100.00", igvDng: "18.00", icbper: "1.50" }),
    });
    const f = instalarFetchCompras({
      extra: { [ruta(C_3064_BOLSAS.id, "clasificar")]: { status: 200, cuerpo: accionDe(nueva) } },
    });
    const contexto = contextoDe();
    const alAvisar = vi.fn();
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={C_3064_BOLSAS} alAvisar={alAvisar} />);

    await abrirMenu(usuario, "F001-3064");
    await usuario.click(screen.getByRole("menuitem", { name: M.clasificarComo("DNG") }));

    await vi.waitFor(() => expect(contexto.recargarFila).toHaveBeenCalledWith(C_3064_BOLSAS.id));
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(f.de(ruta(C_3064_BOLSAS.id, "clasificar"))).toHaveLength(1);
    expect(f.de(ruta(C_3064_BOLSAS.id, "clasificar"))[0]!.body).toEqual({
      versionBase: 1,
      destino: "DNG",
    });
    expect(alAvisar).toHaveBeenCalledWith(M.compraClasificada, "ok");
  });

  it("409 version_obsoleta: recarga la fila, no el resumen, y muestra el mensaje", async () => {
    instalarFetchCompras({
      extra: {
        [ruta(C_3064_BOLSAS.id, "clasificar")]: {
          status: 409,
          cuerpo: { codigo: "version_obsoleta", versionVigente: 3 },
        },
      },
    });
    const contexto = contextoDe();
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={C_3064_BOLSAS} />);

    await abrirMenu(usuario, "F001-3064");
    await usuario.click(screen.getByRole("menuitem", { name: M.clasificarComo("DGNG") }));

    expect((await screen.findByRole("alert")).textContent).toBe(M.versionObsoleta);
    expect(contexto.recargarFila).toHaveBeenCalledWith(C_3064_BOLSAS.id);
    expect(contexto.recargarResumen).not.toHaveBeenCalled();
  });
});

describe("AccionesFilaCompras · excluir y restaurar (CA-9)", () => {
  it("una fila excluida ofrece Restaurar (no clasificar ni excluir) y envía la versión", async () => {
    const excluida = filaDe({ id: C_1040_ISC.id, serie: "F001", numero: "1040", version: 4, excluida: true, motivo: "Gasto personal" });
    const f = instalarFetchCompras({
      extra: {
        [ruta(excluida.id, "restaurar")]: {
          status: 200,
          cuerpo: accionDe({ ...excluida, version: 5, excluida: false, motivo: null }),
        },
      },
    });
    const contexto = contextoDe();
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={excluida} />);

    await abrirMenu(usuario, "F001-1040");
    expect(screen.queryByRole("menuitem", { name: M.excluir })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: M.clasificarComo("DNG") })).toBeNull();
    await usuario.click(screen.getByRole("menuitem", { name: M.restaurar }));

    await vi.waitFor(() => expect(contexto.recargarFila).toHaveBeenCalledWith(excluida.id));
    expect(f.de(ruta(excluida.id, "restaurar"))[0]!.body).toEqual({ versionBase: 4 });
  });

  it("en un periodo generado (solo lectura) el menú queda deshabilitado con el motivo y no hay excluir ni restaurar", async () => {
    instalarFetchCompras();
    const contexto = contextoDe({ estado: "generado", soloLectura: M.soloLectura.generado });
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={C_3064_BOLSAS} />);

    const boton = screen.getByRole("button", { name: `${M.columnas.acciones} F001-3064` });
    expect((boton as HTMLButtonElement).disabled).toBe(true);
    expect(boton.getAttribute("title")).toBe(M.soloLectura.generado);
    await usuario.click(boton);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("sin sire.clasificar no se muestra ninguna acción de escritura (CA-14)", () => {
    instalarFetchCompras();
    const contexto = contextoDe({ permisos: { clasificar: false } });
    const { container } = render(<AccionesFilaCompras contexto={contexto} fila={C_3064_BOLSAS} />);
    expect(container.childElementCount).toBe(0);
  });
});

describe("AccionesFilaCompras · descartar (D-11)", () => {
  it("Descartar solo aparece en filas agregadas, pide confirmar y envía la versión", async () => {
    const agregada = filaDe({ id: C_3064_BOLSAS.id, origen: "agregada", numero: "9001", version: 2 });
    const f = instalarFetchCompras({
      extra: { [ruta(agregada.id, "descartar")]: { status: 200, cuerpo: accionDe(agregada) } },
    });
    const contexto = contextoDe();
    const usuario = userEvent.setup();
    const { unmount } = render(<AccionesFilaCompras contexto={contexto} fila={agregada} />);

    await abrirMenu(usuario, "F001-9001");
    await usuario.click(screen.getByRole("menuitem", { name: M.descartar }));
    expect(screen.getByRole("alertdialog").textContent).toContain(M.confirmarDescartar("F001-9001"));
    expect(f.de(ruta(agregada.id, "descartar"))).toHaveLength(0);
    await usuario.click(screen.getByRole("button", { name: M.confirmar }));
    await vi.waitFor(() => expect(f.de(ruta(agregada.id, "descartar"))).toHaveLength(1));
    expect(f.de(ruta(agregada.id, "descartar"))[0]!.body).toEqual({ versionBase: 2 });
    unmount();

    // Una fila del SIRE no ofrece descartar.
    render(<AccionesFilaCompras contexto={contexto} fila={C_1040_ISC} />);
    await abrirMenu(usuario, "F001-1040");
    expect(screen.queryByRole("menuitem", { name: M.descartar })).toBeNull();
    expect(screen.getByRole("menuitem", { name: M.excluir })).toBeTruthy();
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_5070_ZAPATILLAS,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { ExcluirCompra } from "./excluir-compra";

// Spec 015 · T7 (CA-9, D-10): excluir con motivo opcional (hasta 200, una línea) y aviso si la compra es agregada.

const ruta = (id: string) => `POST ${BASE}/${id}/excluir`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExcluirCompra", () => {
  it("excluye F001-5070 (glosa «zapatillas») con motivo: una petición con la versión y recarga fila y resumen", async () => {
    const excluida = filaDe({ ...C_5070_ZAPATILLAS, version: 2, excluida: true, motivo: "Gasto personal" });
    const f = instalarFetchCompras({
      extra: { [ruta(C_5070_ZAPATILLAS.id)]: { status: 200, cuerpo: accionDe(excluida) } },
    });
    const contexto = contextoDe();
    const alTerminar = vi.fn();
    const alAvisar = vi.fn();
    const usuario = userEvent.setup();
    render(
      <ExcluirCompra contexto={contexto} fila={C_5070_ZAPATILLAS} alTerminar={alTerminar} alCancelar={vi.fn()} alAvisar={alAvisar} />,
    );

    await usuario.type(screen.getByLabelText(M.motivoExclusion), "Gasto personal");
    await usuario.click(screen.getByRole("button", { name: M.excluir }));

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(f.de(ruta(C_5070_ZAPATILLAS.id))[0]!.body).toEqual({ versionBase: 1, motivo: "Gasto personal" });
    expect(contexto.recargarFila).toHaveBeenCalledWith(C_5070_ZAPATILLAS.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(M.compraExcluida, "ok");
  });

  it("sin motivo no envía la clave; con más de 200 caracteres no envía nada y lo explica", async () => {
    const f = instalarFetchCompras({
      extra: {
        [ruta(C_5070_ZAPATILLAS.id)]: { status: 200, cuerpo: accionDe({ ...C_5070_ZAPATILLAS, excluida: true }) },
      },
    });
    const usuario = userEvent.setup();
    render(
      <ExcluirCompra contexto={contextoDe()} fila={C_5070_ZAPATILLAS} alTerminar={vi.fn()} alCancelar={vi.fn()} />,
    );

    await usuario.click(screen.getByLabelText(M.motivoExclusion));
    await usuario.paste("x".repeat(201));
    await usuario.click(screen.getByRole("button", { name: M.excluir }));
    expect((await screen.findByRole("alert")).textContent).toBe(M.motivoMaximo);
    expect(f.de(ruta(C_5070_ZAPATILLAS.id))).toHaveLength(0);

    await usuario.clear(screen.getByLabelText(M.motivoExclusion));
    await usuario.click(screen.getByRole("button", { name: M.excluir }));
    await vi.waitFor(() => expect(f.de(ruta(C_5070_ZAPATILLAS.id))).toHaveLength(1));
    expect(f.de(ruta(C_5070_ZAPATILLAS.id))[0]!.body).toEqual({ versionBase: 1 });
  });

  it("error del servidor (409 periodo_generado): muestra su mensaje y no cierra", async () => {
    instalarFetchCompras({
      extra: { [ruta(C_5070_ZAPATILLAS.id)]: { status: 409, cuerpo: { codigo: "periodo_generado" } } },
    });
    const alTerminar = vi.fn();
    const usuario = userEvent.setup();
    render(
      <ExcluirCompra contexto={contextoDe()} fila={C_5070_ZAPATILLAS} alTerminar={alTerminar} alCancelar={vi.fn()} />,
    );
    await usuario.click(screen.getByRole("button", { name: M.excluir }));
    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.periodo_generado);
    expect(alTerminar).not.toHaveBeenCalled();
  });

  it("avisa antes de excluir una compra agregada a mano (equivale a descartarla)", () => {
    instalarFetchCompras();
    render(
      <ExcluirCompra
        contexto={contextoDe()}
        fila={filaDe({ origen: "agregada", numero: "9001" })}
        alTerminar={vi.fn()}
        alCancelar={vi.fn()}
      />,
    );
    expect(screen.getByText(M.confirmarExcluirAgregada)).toBeTruthy();
  });
});

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_VENTAS as M } from "../../lib/ventas";
import { ConfirmarAccion } from "./confirmar-accion";
import { ExcluirVenta } from "./excluir-venta";

// Spec 012b, T23a (P-2; RF-096): al cerrar «Excluir venta» o la confirmación de restaurar con Cancelar o Esc,
// el foco vuelve al botón que abrió el diálogo (antes quedaba en BODY).

let quitarOrigen: () => void = () => undefined;

function Excluir() {
  const [abierto, setAbierto] = useState(false);
  const [hayOrigen, setHayOrigen] = useState(true);
  quitarOrigen = () => setHayOrigen(false);
  return (
    <>
      {hayOrigen && (
        <button type="button" onClick={() => setAbierto(true)}>
          Abrir excluir
        </button>
      )}
      {abierto && (
        <ExcluirVenta
          clienteId="c-1"
          periodo="202610"
          ventaId="v-1"
          clave="F003-20"
          alTerminar={vi.fn()}
          alCancelar={() => setAbierto(false)}
        />
      )}
    </>
  );
}

function Restaurar() {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAbierto(true)}>
        Abrir restaurar
      </button>
      {abierto && (
        <ConfirmarAccion
          mensaje="¿Restaurar la venta F003-20?"
          ocupado={false}
          alConfirmar={vi.fn()}
          alCancelar={() => setAbierto(false)}
        />
      )}
    </>
  );
}

afterEach(cleanup);

describe("devolver el foco al cerrar los diálogos de ventas (T23a, P-2)", () => {
  it("feliz: Cancelar y Esc de «Excluir venta» devuelven el foco al botón que lo abrió", async () => {
    render(<Excluir />);
    const user = userEvent.setup();
    const abrir = screen.getByRole("button", { name: "Abrir excluir" });

    abrir.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);

    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);
  });

  it("feliz: Cancelar y Esc de «Restaurar» devuelven el foco al botón que lo abrió", async () => {
    render(<Restaurar />);
    const user = userEvent.setup();
    const abrir = screen.getByRole("button", { name: "Abrir restaurar" });

    abrir.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: M.cancelar }));
    await user.click(screen.getByRole("button", { name: M.cancelar }));
    expect(document.activeElement).toBe(abrir);

    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);
  });

  it("error: si el botón de origen ya no está en la página (la fila se excluyó), cerrar no falla ni roba el foco a otro", async () => {
    render(<Excluir />);
    const user = userEvent.setup();
    const abrir = screen.getByRole("button", { name: "Abrir excluir" });
    abrir.focus();
    await user.keyboard("{Enter}");
    // El previo se recargó y el botón de origen desapareció mientras el diálogo seguía abierto.
    act(() => quitarOrigen());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement === abrir).toBe(false);
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  C_1040_ISC,
  MENSAJES_COMPRAS as M,
  uuidDe,
} from "../../pruebas/compras";
import { MENSAJES } from "../../lib/acceso";
import { InformeMasivo } from "./informe-masivo";

// Spec 015 · T8 (CA-7, D-8): el informe de una masiva.

afterEach(() => cleanup());

describe("InformeMasivo", () => {
  it("muestra las aplicadas y cada rechazada con su comprobante y un motivo legible", () => {
    render(
      <InformeMasivo
        informe={{
          operacionId: uuidDe(9, 1),
          aplicadas: 3,
          rechazadas: [{ compraId: C_1040_ISC.id, codigo: "requiere_dato" }],
        }}
        filas={[C_1040_ISC]}
        alCerrar={vi.fn()}
      />,
    );
    expect(screen.getByText(M.aplicadas(3))).toBeTruthy();
    expect(screen.getByText(M.rechazadas(1))).toBeTruthy();
    const fila = within(screen.getByRole("table", { name: M.tablaRechazadas })).getAllByRole("row")[1]!;
    expect(fila.textContent).toBe(`F001-1040${M.rechazoMasiva.requiere_dato}`);
  });

  it("una sola aplicada se dice «1 aplicada», no «1 aplicadas»", () => {
    render(
      <InformeMasivo
        informe={{ operacionId: uuidDe(9, 1), aplicadas: 1, rechazadas: [] }}
        filas={[C_1040_ISC]}
        alCerrar={vi.fn()}
      />,
    );
    expect(screen.getByText(/^1 aplicadas?$/).textContent).toBe("1 aplicada");
  });

  it("un código desconocido da el mensaje genérico, una fila no cargada se muestra por id corto y Cerrar funciona", async () => {
    const alCerrar = vi.fn();
    render(
      <InformeMasivo
        informe={{
          operacionId: null,
          aplicadas: 0,
          rechazadas: [{ compraId: uuidDe(7, 5), codigo: "codigo_nuevo" as never }],
        }}
        filas={[]}
        alCerrar={alCerrar}
      />,
    );
    const fila = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(fila.textContent).toBe(`${uuidDe(7, 5).slice(0, 8)}${MENSAJES.errorGeneral}`);
    await userEvent.setup().click(screen.getByRole("button", { name: M.cerrar }));
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  // Spec 038 · T-final: el informe declara `aria-modal`, así que el foco queda atrapado dentro (como la lupa).
  function Montaje({ rechazadas }: { rechazadas: number }) {
    const [abierto, setAbierto] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setAbierto(true)}>
          Abrir informe
        </button>
        {abierto && (
          <InformeMasivo
            informe={{
              operacionId: null,
              aplicadas: 1,
              rechazadas: Array.from({ length: rechazadas }, (_, i) => ({
                compraId: uuidDe(7, i + 1),
                codigo: "requiere_dato" as const,
              })),
            }}
            filas={[]}
            alCerrar={() => setAbierto(false)}
          />
        )}
        <button type="button">Fuera del informe</button>
      </>
    );
  }

  it("el foco entra en el informe y Tab y Shift+Tab ciclan sin salir", async () => {
    const usuario = userEvent.setup();
    render(<Montaje rechazadas={1} />);
    await usuario.click(screen.getByRole("button", { name: "Abrir informe" }));
    const dialogo = screen.getByRole("dialog");
    const cerrar = within(dialogo).getByRole("button", { name: M.cerrar });
    expect(dialogo.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(cerrar);
    await usuario.tab();
    expect(dialogo.contains(document.activeElement)).toBe(true);
    await usuario.tab({ shift: true });
    expect(dialogo.contains(document.activeElement)).toBe(true);
    await usuario.tab({ shift: true });
    expect(dialogo.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Fuera del informe" }));
  });

  it("Esc cierra el informe y el foco vuelve al botón que lo abrió", async () => {
    const usuario = userEvent.setup();
    render(<Montaje rechazadas={0} />);
    const abrir = screen.getByRole("button", { name: "Abrir informe" });
    await usuario.click(abrir);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await usuario.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);
  });
});

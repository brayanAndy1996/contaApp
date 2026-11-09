import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});

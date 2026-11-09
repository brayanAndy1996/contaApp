import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_1040_ISC,
  C_2056_MIXTA,
  MENSAJES_COMPRAS as M,
  TEXTO_HOSTIL,
  detalleDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
  versionOriginalDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { HistorialCompra } from "./historial-compra";

// Spec 015 · T9 (P-6): panel «Historial» de solo lectura.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HistorialCompra", () => {
  it("muestra el original del SIRE frente al vigente, las versiones con autor y fecha y los hallazgos", async () => {
    // F001-1040 después de aceptar R-ISC: la versión 2 mueve 770.00 de la base DG al ISC.
    const original = versionOriginalDe(C_1040_ISC);
    const vigente = filaDe({ ...C_1040_ISC, version: 2, hallazgos: [], montos: montosDe({ isc: "770.00" }) });
    const autor = uuidDe(5, 1);
    instalarFetchCompras({
      extra: {
        [`GET ${BASE}/${C_1040_ISC.id}`]: {
          status: 200,
          cuerpo: {
            original,
            vigente,
            versiones: [
              original,
              {
                n: 2,
                accion: "sugerencia",
                operacionId: uuidDe(9, 1),
                usuarioId: autor,
                creadaEn: "2026-10-21T10:30:00.000Z",
                excluida: false,
                motivo: null,
                clasificada: true,
                montos: vigente.montos,
              },
            ],
            hallazgos: C_1040_ISC.hallazgos,
          },
        },
      },
    });
    render(<HistorialCompra contexto={contextoDe()} compraId={C_1040_ISC.id} alCerrar={vi.fn()} />);

    const tabla = await screen.findByRole("table");
    const filaDg = within(tabla).getByText(M.casilleros.biDg).closest("tr")!;
    expect(filaDg.textContent).toContain("770.00");
    expect(filaDg.textContent).toContain("0.00");
    expect(filaDg.textContent).toContain("(cambió)");
    const filaIsc = within(tabla).getByText(M.casilleros.isc).closest("tr")!;
    expect(filaIsc.textContent).toBe(`${M.casilleros.isc}0.00770.00(cambió)`);

    const versiones = screen.getByRole("region", { name: M.versiones });
    expect(versiones.textContent).toContain(M.versionPor(1, "SIRE", "2026-10-20 15:00 UTC"));
    expect(versiones.textContent).toContain(M.versionPor(2, autor.slice(0, 8), "2026-10-21 10:30 UTC"));
    expect(versiones.textContent).toContain(M.accionesVersion.sugerencia);
    // El detalle trae los hallazgos de la compra tal como llegaron.
    expect(screen.getByText(C_1040_ISC.hallazgos[0]!.explicacion)).toBeTruthy();
  });

  it("escapa la razón social hostil del SIRE y muestra el error del servidor si no hay detalle", async () => {
    const hostil = filaDe({
      id: uuidDe(4, 1),
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: TEXTO_HOSTIL },
    });
    instalarFetchCompras({ estado: { filas: [hostil, C_2056_MIXTA] } });
    const { container, unmount } = render(
      <HistorialCompra contexto={contextoDe()} compraId={hostil.id} alCerrar={vi.fn()} />,
    );
    expect((await screen.findByText(TEXTO_HOSTIL)).tagName).toBe("P");
    expect(container.querySelector("img")).toBeNull();
    expect(detalleDe(hostil).vigente.proveedor.razonSocial).toBe(TEXTO_HOSTIL);
    unmount();

    render(<HistorialCompra contexto={contextoDe()} compraId={uuidDe(4, 99)} alCerrar={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.no_encontrada);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("Cerrar llama a alCerrar", async () => {
    instalarFetchCompras();
    const alCerrar = vi.fn();
    render(<HistorialCompra contexto={contextoDe()} compraId={C_1040_ISC.id} alCerrar={alCerrar} />);
    await screen.findByRole("table");
    await userEvent.setup().click(screen.getByRole("button", { name: M.cerrar }));
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });
});

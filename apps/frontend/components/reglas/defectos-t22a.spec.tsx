import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { uuidDe } from "../../pruebas/compras";
import {
  CAND_A,
  CAND_B,
  MENSAJES_APRENDIZAJE as M,
  RUTA_ACTIVAR,
  importacionDe,
  instalarFetchAprendizaje,
} from "../../pruebas/aprendizaje";
import { CandidatasImportadas } from "./candidatas-importadas";

// Spec 025 · T22a (defectos de pantalla de la prueba manual T22; CA-3, CA-4, D-6, U-6).
//   D1: el diálogo de «Activar todas» no afirma un número de omitidas que no conoce: dice cuántas están «sin criterio claro»
//       (dato del resumen de la importación) y que las que tengan conflicto con una regla vigente también quedan fuera.
//   D2: lo que el servidor omite al activar se explica por motivo (también con 0 activadas) y la página vuelve a leer la tabla
//       de reglas aunque se hayan activado 0 (otra pestaña pudo crear la regla).

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const filaDe = async (id: string): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-candidata="${id}"]`);
    if (!el) throw new Error(`no hay candidata ${id}`);
    return el;
  });

function montar(alCrearReglas = vi.fn()) {
  render(
    <CandidatasImportadas clienteId="c-1" alCrearReglas={alCrearReglas} />,
  );
  return { alCrearReglas, usuario: userEvent.setup() };
}

describe("<CandidatasImportadas /> · diálogo «Activar todas» (T22a · D1)", () => {
  it("no dice «Se omitirán N con conflicto o sin criterio claro» con el N de las sin criterio: separa lo que sabe de lo que no", async () => {
    // Resumen: 3 sin criterio claro. Hay además candidatas con conflicto que el resumen no cuenta.
    instalarFetchAprendizaje({
      importacion: importacionDe({
        resumen: {
          periodosLeidos: 5,
          periodosSinDatos: [],
          candidatas: 14,
          sinCriterio: 3,
        },
      }),
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(
      await screen.findByRole("button", { name: M.activarTodas }),
    );
    const dialogo = await screen.findByRole("dialog");
    const texto = within(dialogo).getByText(/Se activar/).textContent ?? "";

    expect(texto).not.toMatch(/omitir[aá]n\s+3/i);
    expect(texto).toMatch(/3 sin criterio claro/);
    expect(texto).toMatch(/conflicto con una regla vigente/);
    expect(texto).toMatch(/^Se activar[aá]n 2 reglas\./);
  });

  it("sin candidatas sin criterio claro solo menciona el conflicto", async () => {
    instalarFetchAprendizaje({
      importacion: importacionDe({
        resumen: {
          periodosLeidos: 5,
          periodosSinDatos: [],
          candidatas: 11,
          sinCriterio: 0,
        },
      }),
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(
      await screen.findByRole("button", { name: M.activarTodas }),
    );
    const texto =
      within(await screen.findByRole("dialog")).getByText(/Se activar/)
        .textContent ?? "";

    expect(texto).not.toMatch(/sin criterio claro/);
    expect(texto).toMatch(/conflicto con una regla vigente/);
  });
});

describe("<CandidatasImportadas /> · omitidas al activar (T22a · D2)", () => {
  it("activar una candidata que ya no estaba pendiente: dice el motivo y vuelve a leer la tabla de reglas (0 activadas)", async () => {
    const f = instalarFetchAprendizaje({
      extra: {
        [RUTA_ACTIVAR]: {
          status: 200,
          cuerpo: {
            activadas: [],
            omitidas: [{ id: CAND_A.id, motivo: "no_pendiente" }],
          },
        },
      },
    });
    const { alCrearReglas, usuario } = montar();
    const a = await filaDe(CAND_A.id);

    await usuario.click(
      within(a).getByRole("checkbox", { name: M.seleccionar("20100070970") }),
    );
    await usuario.click(
      screen.getByRole("button", { name: M.activarSeleccionadas }),
    );

    await vi.waitFor(() => expect(f.de(RUTA_ACTIVAR)).toHaveLength(1));
    expect(await screen.findByText(M.reglasActivadas(0))).toBeTruthy();
    expect(screen.getByText(M.omitidas(1, "no_pendiente"))).toBeTruthy();
    expect(alCrearReglas).toHaveBeenCalledTimes(1);
    // Con 0 activadas no hay reglas nuevas que rijan desde la próxima descarga: sin aviso de U-6.
    expect(screen.queryByText(M.avisoPeriodoCargado)).toBeNull();
  });

  it("activar varias con algunas omitidas: una línea por motivo y la tabla se relee", async () => {
    instalarFetchAprendizaje({
      extra: {
        [RUTA_ACTIVAR]: {
          status: 200,
          cuerpo: {
            activadas: [CAND_B.id],
            omitidas: [
              { id: CAND_A.id, motivo: "no_pendiente" },
              { id: uuidDe(29, 1), motivo: "conflicto" },
              { id: uuidDe(29, 2), motivo: "conflicto" },
            ],
          },
        },
      },
    });
    const { alCrearReglas, usuario } = montar();
    const a = await filaDe(CAND_A.id);
    const b = await filaDe(CAND_B.id);
    await usuario.click(
      within(a).getByRole("checkbox", { name: M.seleccionar("20100070970") }),
    );
    await usuario.click(
      within(b).getByRole("checkbox", { name: M.seleccionar("20700000011") }),
    );
    await usuario.click(
      screen.getByRole("button", { name: M.activarSeleccionadas }),
    );

    expect(await screen.findByText(M.reglasActivadas(1))).toBeTruthy();
    expect(screen.getByText(M.omitidas(1, "no_pendiente"))).toBeTruthy();
    expect(screen.getByText(M.omitidas(2, "conflicto"))).toBeTruthy();
    expect(alCrearReglas).toHaveBeenCalledTimes(1);
  });

  it("«Activar todas» con 0 activadas también vuelve a leer la tabla de reglas", async () => {
    instalarFetchAprendizaje({
      extra: {
        [RUTA_ACTIVAR]: {
          status: 200,
          cuerpo: {
            activadas: [],
            omitidas: [{ id: CAND_A.id, motivo: "no_pendiente" }],
          },
        },
      },
    });
    const { alCrearReglas, usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(
      await screen.findByRole("button", { name: M.activarTodas }),
    );
    await usuario.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: M.confirmar,
      }),
    );

    expect(await screen.findByText(M.omitidas(1, "no_pendiente"))).toBeTruthy();
    expect(alCrearReglas).toHaveBeenCalledTimes(1);
  });
});

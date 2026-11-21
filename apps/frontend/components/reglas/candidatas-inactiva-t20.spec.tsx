import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_APRENDIZAJE as MA } from "../../lib/aprendizaje";
import { reiniciarSesion } from "../../lib/sesion";
import {
  CAND_A,
  CAND_DISTINTO,
  CAND_YA,
  MENSAJES_APRENDIZAJE as M,
  type CandidataPrueba,
  instalarFetchAprendizaje,
} from "../../pruebas/aprendizaje";
import { CandidatasImportadas } from "./candidatas-importadas";

// Spec 025 · T20 (mejora anotada por T18, D-6): en «Con conflicto», si la regla viva del proveedor está desactivada
// (`regla.activa === false`), la candidata lo dice y remite a la página de reglas; sin `activa` o con `true`, nada cambia.

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

const conActiva = (c: CandidataPrueba, activa: boolean): CandidataPrueba =>
  ({ ...c, regla: { ...c.regla!, activa } }) as CandidataPrueba;

describe("<CandidatasImportadas /> · regla desactivada en conflicto (T20, D-6)", () => {
  it("ya aprendida con la regla desactivada: avisa que está inactiva y que se reactiva desde la página de reglas", async () => {
    instalarFetchAprendizaje({ candidatas: [CAND_A, conActiva(CAND_YA, false)] });
    const usuario = userEvent.setup();
    render(<CandidatasImportadas clienteId="c-1" />);
    await filaDe(CAND_A.id);
    await usuario.click(await screen.findByRole("tab", { name: new RegExp(`^${M.pestanas.conflicto}`) }));
    const ya = await filaDe(CAND_YA.id);
    expect(within(ya).getByText(M.yaAprendida, { exact: false })).toBeTruthy();
    expect(within(ya).getByText(MA.reglaInactiva)).toBeTruthy();
  });

  it("control: con la regla activa o sin el dato no aparece el aviso", async () => {
    instalarFetchAprendizaje({ candidatas: [CAND_A, conActiva(CAND_YA, true), CAND_DISTINTO] });
    const usuario = userEvent.setup();
    render(<CandidatasImportadas clienteId="c-1" />);
    await filaDe(CAND_A.id);
    await usuario.click(await screen.findByRole("tab", { name: new RegExp(`^${M.pestanas.conflicto}`) }));
    await filaDe(CAND_YA.id);
    await filaDe(CAND_DISTINTO.id);
    expect(screen.queryByText(MA.reglaInactiva)).toBeNull();
  });
});

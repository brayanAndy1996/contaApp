import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { FILA_STD, MENSAJES_APRENDIZAJE as A } from "../../pruebas/aprendizaje";
import {
  BASE,
  C_1040_ISC,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { MENSAJES_REGLAS as R, RUTA_RECORDAR, contextoConReglas, reglaDe } from "../../pruebas/reglas";
import { AccionesFilaCompras } from "./acciones-fila-compras";
import { AceptarSugerencias } from "./aceptar-sugerencia";

// Spec 025 · T7 (rojo; CA-9, CA-10, D-8, U-3). Aceptar la sugerencia R-STD de una compra.
// Contrato (T13): `HallazgoVista.regla` admite «R-STD» (shared) y `MENSAJES_COMPRAS.hallazgos["R-STD"]` da el nombre del chip.
//   - `AceptarSugerencias`: el chip dice «R-STD · …» (nunca «undefined»), el texto de la sugerencia es «DNG por perfil del
//     cliente» y «Aceptar R-STD» manda {versionBase, regla: "R-STD"} SIN confirmar ni dato (no pide confirmación: U-3).
//   - `AccionesFilaCompras`: tras aceptar R-STD se ofrece «Recordar» con el destino DNG (como 021 CA-1: aviso no modal,
//     POST …/reglas/recordar {compraIds, destino: "DNG", versionBase: null}); solo con `reglas.gestionar`. Aceptar otra regla
//     (R-ISC) no lo ofrece. 025 no registra confirmación al aceptar: lo único que se manda es «Recordar» si el contador quiere.

const ruta = (id: string) => `POST ${BASE}/${id}/sugerencias/aceptar`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AceptarSugerencias · R-STD (CA-9)", () => {
  it("muestra el hallazgo «DNG por perfil del cliente» y lo acepta sin pedir confirmación", async () => {
    const aceptada = filaDe({ ...FILA_STD, version: 2, clasificada: true, hallazgos: [], montos: montosDe({ biDng: "100.00", igvDng: "18.00" }) });
    const f = instalarFetchCompras({
      extra: { [ruta(FILA_STD.id)]: { status: 200, cuerpo: accionDe(aceptada) } },
    });
    const contexto = contextoDe();
    const alTerminar = vi.fn();
    const alAvisar = vi.fn();
    const usuario = userEvent.setup();
    render(<AceptarSugerencias contexto={contexto} fila={FILA_STD} alTerminar={alTerminar} alCancelar={vi.fn()} alAvisar={alAvisar} />);

    const dialogo = screen.getByRole("dialog");
    expect(within(dialogo).getByText(A.std)).toBeTruthy();
    expect(within(dialogo).getByText(/R-STD · /).textContent).not.toContain("undefined");

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-STD` }));

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(ruta(FILA_STD.id))).toHaveLength(1);
    expect(f.de(ruta(FILA_STD.id))[0]!.body).toEqual({ versionBase: 1, regla: "R-STD" });
    expect(contexto.recargarFila).toHaveBeenCalledWith(FILA_STD.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(M.sugerenciaAceptada, "ok");
  });

  it("409 revisar_de_nuevo: recarga la fila, avisa y no cierra", async () => {
    instalarFetchCompras({
      extra: { [ruta(FILA_STD.id)]: { status: 409, cuerpo: { codigo: "revisar_de_nuevo" } } },
    });
    const contexto = contextoDe();
    const alTerminar = vi.fn();
    const usuario = userEvent.setup();
    render(<AceptarSugerencias contexto={contexto} fila={FILA_STD} alTerminar={alTerminar} alCancelar={vi.fn()} alAvisar={vi.fn()} />);

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-STD` }));

    expect(await screen.findByText(M.errores.revisar_de_nuevo)).toBeTruthy();
    expect(contexto.recargarFila).toHaveBeenCalledWith(FILA_STD.id);
    expect(alTerminar).not.toHaveBeenCalled();
  });
});

describe("AccionesFilaCompras · «Recordar» tras aceptar R-STD (CA-10)", () => {
  async function aceptarDesdeElMenu(
    usuario: ReturnType<typeof userEvent.setup>,
    fila: typeof FILA_STD,
    regla: string,
  ) {
    await usuario.click(await screen.findByRole("button", { name: `${M.columnas.acciones} F001-${fila.numero}` }));
    await usuario.click(screen.getByRole("menuitem", { name: M.aceptarSugerencias }));
    await usuario.click(await screen.findByRole("button", { name: `${M.aceptar} ${regla}` }));
  }

  it("aceptar R-STD ofrece «Recordar» con DNG; al aceptarlo manda compraIds, destino DNG y versionBase null", async () => {
    const aceptada = filaDe({ ...FILA_STD, version: 2, clasificada: true, hallazgos: [], montos: montosDe({ biDng: "100.00", igvDng: "18.00" }) });
    const f = instalarFetchCompras({
      extra: {
        [ruta(FILA_STD.id)]: { status: 200, cuerpo: accionDe(aceptada) },
        [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ destino: "DNG" }) },
      },
    });
    const contexto = contextoConReglas([], { gestionar: true });
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={FILA_STD} alAvisar={vi.fn()} />);

    await aceptarDesdeElMenu(usuario, FILA_STD, "R-STD");

    const aviso = await screen.findByRole("status");
    expect(aviso.textContent).toContain(R.pregunta);
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);
    await usuario.click(screen.getByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [FILA_STD.id], destino: "DNG", versionBase: null });
  });

  it("sin reglas.gestionar no se ofrece «Recordar»", async () => {
    const aceptada = filaDe({ ...FILA_STD, version: 2, clasificada: true, hallazgos: [] });
    instalarFetchCompras({ extra: { [ruta(FILA_STD.id)]: { status: 200, cuerpo: accionDe(aceptada) } } });
    const contexto = contextoConReglas([], { gestionar: false });
    const alAvisar = vi.fn();
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={FILA_STD} alAvisar={alAvisar} />);

    await aceptarDesdeElMenu(usuario, FILA_STD, "R-STD");

    await vi.waitFor(() => expect(alAvisar).toHaveBeenCalledWith(M.sugerenciaAceptada, "ok"));
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
  });

  it("aceptar R-ISC no ofrece «Recordar» (solo R-STD lo hace al aceptar)", async () => {
    const aceptada = filaDe({ ...C_1040_ISC, version: 2, hallazgos: [], montos: montosDe({ isc: "770.00" }) });
    instalarFetchCompras({ extra: { [ruta(C_1040_ISC.id)]: { status: 200, cuerpo: accionDe(aceptada) } } });
    const contexto = contextoConReglas([], { gestionar: true });
    const alAvisar = vi.fn();
    const usuario = userEvent.setup();
    render(<AccionesFilaCompras contexto={contexto} fila={C_1040_ISC} alAvisar={alAvisar} />);

    await usuario.click(await screen.findByRole("button", { name: `${M.columnas.acciones} F001-1040` }));
    await usuario.click(screen.getByRole("menuitem", { name: M.aceptarSugerencias }));
    await usuario.click(await screen.findByRole("button", { name: `${M.aceptar} R-ISC` }));
    await usuario.click(await screen.findByRole("button", { name: M.confirmar }));

    await vi.waitFor(() => expect(alAvisar).toHaveBeenCalledWith(M.sugerenciaAceptada, "ok"));
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
  });
});

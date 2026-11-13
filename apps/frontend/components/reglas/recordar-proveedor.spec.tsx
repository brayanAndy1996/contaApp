import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES } from "../../lib/acceso";
import { reiniciarSesion } from "../../lib/sesion";
import { rutaSesion } from "../../pruebas/acceso";
import { uuidDe } from "../../pruebas/compras";
import { MENSAJES_REGLAS as R, RUTA_RECORDAR, mencionaDestino, reglaDe } from "../../pruebas/reglas";
import { instalarFetchFalso } from "../../pruebas/soporte";
import { RecordarProveedor, type PropsRecordarProveedor } from "./recordar-proveedor";

// Spec 021 · T6 (rojo; CA-1, P-2, P-3; plan, Contratos: Frontend). Aviso «Recordar para este proveedor en este
// cliente»: no modal, anunciado con role="status" y aria-live="polite", NO toma el foco, se acepta con el botón o con
// el atajo Alt+R (la grilla ignora Alt: `grilla-compras.tsx`, así que no choca con `foco-grilla.ts`), se oculta a los
// 10 s, no se ofrece sin `reglas.gestionar` ni si ya hay una regla activa del proveedor con ese destino.
// Contrato (T13), `components/reglas/recordar-proveedor.tsx`:
//   <RecordarProveedor clienteId compraIds proveedor destino reglas puedeGestionar alTerminar alAvisar? />
//   - compraIds: las compras recién clasificadas (un solo proveedor y periodo). reglas: las del cliente ya leídas.
//   - Acepta → POST /clientes/:id/reglas/recordar {compraIds, destino, versionBase}; versionBase = `version` de la
//     regla (viva) del proveedor si existe con otro destino, `null` si no hay regla.
//   - alTerminar("recordada" | "expirada"); alAvisar(texto, tipo) como las acciones de 015 (con él, el error se
//     entrega a la pantalla y no pinta role="alert"; sin él, pinta role="alert").

const COMPRA = uuidDe(9, 11);
const PROVEEDOR = { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR PRUEBA S.A.C." };

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function montar(parcial: Partial<PropsRecordarProveedor> = {}) {
  const props: PropsRecordarProveedor = {
    clienteId: "c-1",
    compraIds: [COMPRA],
    proveedor: PROVEEDOR,
    destino: "DNG",
    reglas: [],
    puedeGestionar: true,
    alTerminar: vi.fn(),
    ...parcial,
  };
  // La «celda» tiene el foco al montar (autoFocus): si el aviso lo pidiera, se lo quitaría.
  const resultado = render(
    <>
      <button type="button" autoFocus data-testid="celda">
        celda
      </button>
      <RecordarProveedor {...props} />
    </>,
  );
  return { props, ...resultado, usuario: userEvent.setup() };
}

const aceptar = () => screen.getByRole("button", { name: R.recordar });
const celda = () => screen.getByTestId("celda");

describe("<RecordarProveedor /> · aviso (CA-1)", () => {
  it("feliz: aviso no modal anunciado, sin tomar el foco; «Recordar» crea la regla con versionBase null", async () => {
    const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe() } });
    const alAvisar = vi.fn();
    const { props, usuario } = montar({ alAvisar });

    const aviso = screen.getByRole("status");
    expect(aviso.getAttribute("aria-live")).toBe("polite");
    expect(aviso.textContent).toContain(R.pregunta);
    expect(mencionaDestino(aviso.textContent, "DNG")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(aviso.closest('[aria-modal="true"]')).toBeNull();
    // No toma el foco: sigue donde estaba.
    expect(document.activeElement).toBe(celda());
    expect(aviso.contains(document.activeElement)).toBe(false);
    expect(aceptar().getAttribute("aria-keyshortcuts")).toBe(R.atajo);

    await usuario.click(aceptar());

    await vi.waitFor(() => expect(props.alTerminar).toHaveBeenCalledWith("recordada"));
    const llamadas = f.de(RUTA_RECORDAR);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.body).toEqual({ compraIds: [COMPRA], destino: "DNG", versionBase: null });
    expect(llamadas[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(alAvisar).toHaveBeenCalledWith(R.recordada, "ok");
  });

  it("el atajo Alt+R acepta y el foco sigue en la celda; la «r» sola no acepta", async () => {
    const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe() } });
    const { props, usuario } = montar();
    expect(document.activeElement).toBe(celda());

    await usuario.keyboard("r");
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);

    await usuario.keyboard("{Alt>}r{/Alt}");

    await vi.waitFor(() => expect(props.alTerminar).toHaveBeenCalledWith("recordada"));
    expect(f.de(RUTA_RECORDAR)).toHaveLength(1);
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [COMPRA], destino: "DNG", versionBase: null });
    expect(document.activeElement).toBe(celda());
  });

  it("con una regla viva del proveedor en otro destino (P-3) manda su versión como versionBase y el destino nuevo", async () => {
    const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ destino: "DGNG", version: 5 }) } });
    const { usuario } = montar({
      destino: "DGNG",
      compraIds: [COMPRA, uuidDe(9, 12)],
      reglas: [reglaDe({ destino: "DNG", version: 4 })],
    });
    expect(mencionaDestino(screen.getByRole("status").textContent, "DGNG")).toBe(true);

    await usuario.click(aceptar());

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({
      compraIds: [COMPRA, uuidDe(9, 12)],
      destino: "DGNG",
      versionBase: 4,
    });
  });

  it("una regla de OTRO proveedor con el mismo destino no impide el aviso", () => {
    instalarFetchFalso({ ...rutaSesion() });
    montar({ reglas: [reglaDe({ proveedor: { tipo: "6", numero: "20999999999", razonSocial: null } })] });
    expect(screen.getByRole("status").textContent).toContain(R.pregunta);
  });
});

describe("<RecordarProveedor /> · cuándo no aparece", () => {
  it("sin reglas.gestionar no se ofrece: ni aviso ni botón ni atajo", async () => {
    const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe() } });
    const { usuario } = montar({ puedeGestionar: false });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
    await usuario.keyboard("{Alt>}r{/Alt}");
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);
  });

  it("si ya hay una regla activa del proveedor con ese destino no se ofrece", async () => {
    const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe() } });
    const { usuario } = montar({ reglas: [reglaDe({ destino: "DNG", activa: true })] });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
    await usuario.keyboard("{Alt>}r{/Alt}");
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);
  });
});

describe("<RecordarProveedor /> · errores y tiempo", () => {
  it.each([
    [409, { codigo: "regla_cambiada" }, R.reglaCambiada],
    [422, { codigo: "proveedores_distintos" }, R.proveedoresDistintos],
    [403, { codigo: "sin_permiso" }, MENSAJES.sinPermiso],
  ])("%i: muestra el mensaje en español (role alert) sin código ni cuerpo crudo y no da la regla por guardada", async (status, cuerpo, mensaje) => {
    instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status, cuerpo } });
    const { props, usuario } = montar({ reglas: [reglaDe({ destino: "DG", version: 2 })] });

    await usuario.click(aceptar());

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(mensaje);
    expect(alerta.textContent).not.toContain(cuerpo.codigo);
    expect(props.alTerminar).not.toHaveBeenCalledWith("recordada");
  });

  it("con alAvisar el error se entrega a la pantalla y no se pinta otro role alert (un solo anunciador)", async () => {
    instalarFetchFalso({ ...rutaSesion(), [RUTA_RECORDAR]: { status: 409, cuerpo: { codigo: "regla_cambiada" } } });
    const alAvisar = vi.fn();
    const { usuario } = montar({ alAvisar });

    await usuario.click(aceptar());

    await vi.waitFor(() => expect(alAvisar).toHaveBeenCalledWith(R.reglaCambiada, "error"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("se oculta a los 10 s: alTerminar('expirada') ni un instante antes", () => {
    vi.useFakeTimers();
    instalarFetchFalso({ ...rutaSesion() });
    const { props } = montar();

    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(props.alTerminar).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(props.alTerminar).toHaveBeenCalledTimes(1);
    expect(props.alTerminar).toHaveBeenCalledWith("expirada");
  });
});

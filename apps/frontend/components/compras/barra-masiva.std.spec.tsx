import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { FILA_STD, MENSAJES_APRENDIZAJE as A } from "../../pruebas/aprendizaje";
import { BASE, filaDe, instalarFetchCompras, uuidDe } from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { MENSAJES_REGLAS as R, RUTA_RECORDAR, contextoConReglas, reglaDe } from "../../pruebas/reglas";
import { BarraMasiva } from "./barra-masiva";

// Spec 025 · T7 (rojo; CA-9, CA-10, U-3). Aceptar R-STD en masa (la selección «de N del filtro» de 015).
// Contrato (T13), `components/compras/barra-masiva.tsx`: botón «Aceptar R-STD» (como «Aceptar R-RED»): habilitado si alguna
// fila seleccionada tiene un hallazgo R-STD; manda POST …/masivas/aceptar {items: [{compraId, versionBase}], regla: "R-STD"}
// con las filas seleccionadas, sin dato ni confirmar. Tras aplicarse y si todas las filas son de un solo proveedor, ofrece
// «Recordar» con DNG (CA-10); no registra confirmación.

const OP = uuidDe(9, 1);
const rutaAceptar = `POST ${BASE}/masivas/aceptar`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BarraMasiva · aceptar R-STD (CA-9)", () => {
  it("se habilita solo con una fila R-STD seleccionada y manda regla R-STD sin dato ni confirmar", async () => {
    const f = instalarFetchCompras({
      extra: { [rutaAceptar]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 1, rechazadas: [] } } },
    });
    const sinStd = filaDe({ id: uuidDe(1, 6002), numero: "6002" });
    const usuario = userEvent.setup();
    const primero = render(<BarraMasiva contexto={contextoDe()} filas={[sinStd]} seleccion={new Set([sinStd.id])} />);
    expect((screen.getByRole("button", { name: A.aceptarStd }) as HTMLButtonElement).disabled).toBe(true);
    primero.unmount();

    render(<BarraMasiva contexto={contextoDe()} filas={[FILA_STD]} seleccion={new Set([FILA_STD.id])} />);
    await usuario.click(screen.getByRole("button", { name: A.aceptarStd }));

    await vi.waitFor(() => expect(f.de(rutaAceptar)).toHaveLength(1));
    expect(f.de(rutaAceptar)[0]!.body).toEqual({
      items: [{ compraId: FILA_STD.id, versionBase: FILA_STD.version }],
      regla: "R-STD",
    });
  });
});

describe("BarraMasiva · «Recordar» tras aceptar R-STD (CA-10)", () => {
  it("con un solo proveedor ofrece «Recordar» con DNG y manda las filas aplicadas", async () => {
    const otra = filaDe({ ...FILA_STD, id: uuidDe(1, 6003), numero: "6003", version: 2 });
    const f = instalarFetchCompras({
      extra: {
        [rutaAceptar]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 2, rechazadas: [] } },
        [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ destino: "DNG" }) },
      },
    });
    const contexto = contextoConReglas([], { gestionar: true });
    const usuario = userEvent.setup();
    render(
      <BarraMasiva contexto={contexto} filas={[FILA_STD, otra]} seleccion={new Set([FILA_STD.id, otra.id])} />,
    );

    await usuario.click(screen.getByRole("button", { name: A.aceptarStd }));
    await usuario.click(await screen.findByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    const cuerpo = f.de(RUTA_RECORDAR)[0]!.body as { compraIds: string[]; destino: string; versionBase: unknown };
    expect([...cuerpo.compraIds].sort()).toEqual([FILA_STD.id, otra.id].sort());
    expect(cuerpo.destino).toBe("DNG");
    expect(cuerpo.versionBase).toBeNull();
  });

  it("sin reglas.gestionar no hay «Recordar»", async () => {
    const f = instalarFetchCompras({
      extra: { [rutaAceptar]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 1, rechazadas: [] } } },
    });
    const contexto = contextoConReglas([], { gestionar: false });
    const usuario = userEvent.setup();
    render(<BarraMasiva contexto={contexto} filas={[FILA_STD]} seleccion={new Set([FILA_STD.id])} />);

    await usuario.click(screen.getByRole("button", { name: A.aceptarStd }));

    await vi.waitFor(() => expect(f.de(rutaAceptar)).toHaveLength(1));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
  });
});

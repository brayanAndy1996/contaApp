import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_1040_ISC,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { AceptarSugerencias } from "./aceptar-sugerencia";

// Spec 015 · T7 (CA-10, D-7): hallazgos como chips, R-ISC con confirmación, R-MIX con 422 `requiere_dato`
// (gravado 8.97) y 409 `revisar_de_nuevo`.

const ruta = (id: string) => `POST ${BASE}/${id}/sugerencias/aceptar`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(fila = C_1040_ISC, contexto = contextoDe()) {
  const alTerminar = vi.fn();
  const alAvisar = vi.fn();
  render(
    <AceptarSugerencias contexto={contexto} fila={fila} alTerminar={alTerminar} alCancelar={vi.fn()} alAvisar={alAvisar} />,
  );
  return { contexto, alTerminar, alAvisar, usuario: userEvent.setup() };
}

describe("AceptarSugerencias · R-ISC (San Juan)", () => {
  it("muestra el hallazgo con su explicación, pide confirmar y envía confirmar:true", async () => {
    const aceptada = filaDe({ ...C_1040_ISC, version: 2, hallazgos: [], montos: montosDe({ isc: "770.00" }) });
    const f = instalarFetchCompras({
      extra: { [ruta(C_1040_ISC.id)]: { status: 200, cuerpo: accionDe(aceptada) } },
    });
    const { contexto, alTerminar, alAvisar, usuario } = montar();

    expect(screen.getByText(C_1040_ISC.hallazgos[0]!.explicacion)).toBeTruthy();
    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-ISC` }));
    // Aún no se envió nada: primero la confirmación.
    expect(f.de(ruta(C_1040_ISC.id))).toHaveLength(0);
    expect(screen.getByRole("alertdialog").textContent).toContain(M.confirmarSugerencia);
    await usuario.click(screen.getByRole("button", { name: M.confirmar }));

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(f.de(ruta(C_1040_ISC.id))[0]!.body).toEqual({ versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(contexto.recargarFila).toHaveBeenCalledWith(C_1040_ISC.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(M.sugerenciaAceptada, "ok");
  });
});

describe("AceptarSugerencias · R-MIX (mixta, 422 requiere_dato)", () => {
  it("el servidor pide el gravado: se abre el campo y se reenvía con 8.97", async () => {
    const aceptada = filaDe({ ...C_2056_MIXTA, version: 2, hallazgos: [], montos: montosDe({ biDg: "8.97", noGravado: "12.51" }) });
    const f = instalarFetchCompras({
      extra: {
        [ruta(C_2056_MIXTA.id)]: (_llamada, vez) =>
          vez === 1
            ? { status: 422, cuerpo: { codigo: "requiere_dato", dato: "gravado" } }
            : { status: 200, cuerpo: accionDe(aceptada) },
      },
    });
    const { alTerminar, usuario } = montar(C_2056_MIXTA);

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-MIX` }));
    const campo = await screen.findByLabelText(M.pedirGravado);
    await usuario.type(campo, "8.97");
    await usuario.click(screen.getByRole("button", { name: M.aceptarSugerencia }));

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    const llamadas = f.de(ruta(C_2056_MIXTA.id));
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]!.body).toEqual({ versionBase: 1, regla: "R-MIX" });
    expect(llamadas[1]!.body).toEqual({
      versionBase: 1,
      regla: "R-MIX",
      confirmar: true,
      dato: { gravado: "8.97" },
    });
  });

  it("un gravado con 3 decimales no se envía y se explica", async () => {
    const f = instalarFetchCompras({
      extra: {
        [ruta(C_2056_MIXTA.id)]: { status: 422, cuerpo: { codigo: "requiere_dato", dato: "gravado" } },
      },
    });
    const { usuario } = montar(C_2056_MIXTA);

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-MIX` }));
    await usuario.type(await screen.findByLabelText(M.pedirGravado), "8.971");
    await usuario.click(screen.getByRole("button", { name: M.aceptarSugerencia }));

    expect((await screen.findByRole("alert")).textContent).toContain("2 decimales");
    expect(f.de(ruta(C_2056_MIXTA.id))).toHaveLength(1);
  });
});

describe("AceptarSugerencias · R-NEW pide el destino", () => {
  it("422 requiere_dato destino: se elige DNG y se reenvía", async () => {
    const f = instalarFetchCompras({
      extra: {
        [ruta(C_3064_BOLSAS.id)]: (_l, vez) =>
          vez === 1
            ? { status: 422, cuerpo: { codigo: "requiere_dato", dato: "destino" } }
            : { status: 200, cuerpo: accionDe({ ...C_3064_BOLSAS, version: 2, hallazgos: [], clasificada: true }) },
      },
    });
    const { alTerminar, usuario } = montar(C_3064_BOLSAS);

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-NEW` }));
    await usuario.selectOptions(await screen.findByLabelText(M.pedirDestino), "DNG");
    await usuario.click(screen.getByRole("button", { name: M.aceptarSugerencia }));

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(f.de(ruta(C_3064_BOLSAS.id))[1]!.body).toEqual({
      versionBase: 1,
      regla: "R-NEW",
      confirmar: true,
      dato: { destino: "DNG" },
    });
  });
});

describe("AceptarSugerencias · 409", () => {
  it("revisar_de_nuevo: recarga la fila, avisa y no cierra", async () => {
    instalarFetchCompras({
      extra: { [ruta(C_2056_MIXTA.id)]: { status: 409, cuerpo: { codigo: "revisar_de_nuevo" } } },
    });
    const { contexto, alTerminar, alAvisar, usuario } = montar(C_2056_MIXTA);

    await usuario.click(screen.getByRole("button", { name: `${M.aceptar} R-MIX` }));

    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.revisar_de_nuevo);
    expect(contexto.recargarFila).toHaveBeenCalledWith(C_2056_MIXTA.id);
    expect(contexto.recargarResumen).not.toHaveBeenCalled();
    expect(alTerminar).not.toHaveBeenCalled();
    expect(alAvisar).toHaveBeenCalledWith(M.errores.revisar_de_nuevo, "error");
  });

  it("una fila sin hallazgos lo dice y no ofrece aceptar", () => {
    instalarFetchCompras();
    montar(filaDe());
    expect(screen.getByText(M.sinHallazgos)).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(M.aceptar) })).toBeNull();
  });
});

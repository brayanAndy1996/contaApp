import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_1040_ISC,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  instalarFetchCompras,
  uuidDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { DeshacerCompras, useDeshacerCompras } from "./deshacer-compras";

// Spec 015 · T8 (CA-8, D-9, P-4): deshacer y rehacer. Un caso feliz y uno de error por comportamiento.

const DESHACER = `POST ${BASE}/deshacer`;
const REHACER = `POST ${BASE}/rehacer`;
const OP = uuidDe(9, 2);

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Arnes({
  contexto,
  alResaltar,
}: {
  contexto: ReturnType<typeof contextoDe>;
  alResaltar: (ids: string[]) => void;
}) {
  const control = useDeshacerCompras({
    contexto,
    filas: [C_1040_ISC, C_3064_BOLSAS],
    alResaltar,
  });
  return (
    <div data-testid="grilla" tabIndex={0} onKeyDown={(e) => void control.alTeclear(e)}>
      <button type="button" onClick={control.registrarOperacion}>
        hice-una-operacion
      </button>
      <input aria-label="celda" />
      <DeshacerCompras control={control} />
    </div>
  );
}

function montar() {
  const contexto = contextoDe();
  const alResaltar = vi.fn();
  render(<Arnes contexto={contexto} alResaltar={alResaltar} />);
  return { contexto, alResaltar, usuario: userEvent.setup() };
}

describe("DeshacerCompras · deshacer y rehacer (CA-8)", () => {
  it("tras una operación propia, un solo Deshacer recarga solo las filas afectadas y las resalta; luego Rehacer repone", async () => {
    const f = instalarFetchCompras({
      extra: {
        [DESHACER]: { status: 200, cuerpo: { operacionId: OP, filas: [C_3064_BOLSAS.id] } },
        [REHACER]: { status: 200, cuerpo: { operacionId: OP, filas: [C_3064_BOLSAS.id] } },
      },
    });
    const { contexto, alResaltar, usuario } = montar();

    await usuario.click(screen.getByRole("button", { name: "hice-una-operacion" }));
    await usuario.click(screen.getByRole("button", { name: M.deshacer }));

    await vi.waitFor(() => expect(alResaltar).toHaveBeenCalledWith([C_3064_BOLSAS.id]));
    expect(f.de(DESHACER)).toHaveLength(1);
    expect(contexto.recargarFilas).toHaveBeenCalledWith([C_3064_BOLSAS.id]);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("status")).textContent).toBe(M.deshecho(1));

    // Sin confirmar: deshacer una operación propia dejó una por rehacer.
    await usuario.click(screen.getByRole("button", { name: M.rehacer }));
    await vi.waitFor(() => expect(f.de(REHACER)).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("409 fila_cambiada: lista los comprobantes (y el id corto de los no cargados), no reintenta y «Ver filas» los resalta", async () => {
    const desconocida = uuidDe(8, 77);
    const f = instalarFetchCompras({
      extra: {
        [DESHACER]: {
          status: 409,
          cuerpo: { codigo: "fila_cambiada", ids: [C_1040_ISC.id, desconocida] },
        },
      },
    });
    const { contexto, alResaltar, usuario } = montar();

    await usuario.click(screen.getByRole("button", { name: "hice-una-operacion" }));
    await usuario.click(screen.getByRole("button", { name: M.deshacer }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.filaCambiada);
    expect(alerta.textContent).toContain("F001-1040");
    expect(alerta.textContent).toContain(desconocida.slice(0, 8));
    expect(f.de(DESHACER)).toHaveLength(1);
    expect(contexto.recargarFilas).not.toHaveBeenCalled();

    await usuario.click(screen.getByRole("button", { name: M.verFilas }));
    expect(alResaltar).toHaveBeenCalledWith([C_1040_ISC.id, desconocida]);
    expect(f.de(DESHACER)).toHaveLength(1);
  });

  it("409 nada_que_deshacer es un aviso (status), no un error (alert)", async () => {
    instalarFetchCompras({
      extra: { [DESHACER]: { status: 409, cuerpo: { codigo: "nada_que_deshacer" } } },
    });
    const { usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: "hice-una-operacion" }));
    await usuario.click(screen.getByRole("button", { name: M.deshacer }));
    expect((await screen.findByRole("status")).textContent).toBe(M.nadaQueDeshacer);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DeshacerCompras · alcance del atajo y del botón (P-4)", () => {
  it("Ctrl+Z sin operación propia no llama al servidor; con operación propia sí", async () => {
    const f = instalarFetchCompras({
      extra: { [DESHACER]: { status: 200, cuerpo: { operacionId: OP, filas: [C_1040_ISC.id] } } },
    });
    const { usuario } = montar();
    const grilla = screen.getByTestId("grilla");

    fireEvent.keyDown(grilla, { key: "z", ctrlKey: true });
    expect(f.de(DESHACER)).toHaveLength(0);

    await usuario.click(screen.getByRole("button", { name: "hice-una-operacion" }));
    fireEvent.keyDown(grilla, { key: "z", ctrlKey: true });
    await vi.waitFor(() => expect(f.de(DESHACER)).toHaveLength(1));
  });

  it("dentro de un campo de texto Ctrl+Z es del campo: no llama al servidor aunque haya operación propia", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: "hice-una-operacion" }));
    fireEvent.keyDown(screen.getByLabelText("celda"), { key: "z", ctrlKey: true });
    expect(f.de(DESHACER)).toHaveLength(0);
  });

  it("el botón sin operación de esta pantalla pide confirmar con el texto de P-4 y solo entonces llama", async () => {
    const f = instalarFetchCompras({
      extra: { [DESHACER]: { status: 200, cuerpo: { operacionId: OP, filas: [C_1040_ISC.id] } } },
    });
    const { usuario } = montar();

    await usuario.click(screen.getByRole("button", { name: M.deshacer }));
    expect(screen.getByRole("alertdialog").textContent).toContain(M.confirmarDeshacerAjeno);
    expect(f.de(DESHACER)).toHaveLength(0);

    await usuario.click(screen.getByRole("button", { name: M.confirmar }));
    await vi.waitFor(() => expect(f.de(DESHACER)).toHaveLength(1));
  });

  it("cancelar la confirmación no llama al servidor", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: M.rehacer }));
    expect(screen.getByRole("alertdialog").textContent).toContain(M.confirmarRehacerAjeno);
    await usuario.click(screen.getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(REHACER)).toHaveLength(0);
  });
});

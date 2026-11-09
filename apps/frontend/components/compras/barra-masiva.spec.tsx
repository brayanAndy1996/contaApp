import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  MENSAJES_COMPRAS as M,
  filaDe,
  generarFilas,
  instalarFetchCompras,
  uuidDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { BarraMasiva } from "./barra-masiva";

// Spec 015 · T8 (CA-7, D-8): 12 filas seleccionadas con 2 obsoletas, 1 excluida y 1 con R-ISC sin XML; una sola
// petición con el versionBase de cada una; informe con aplicadas y rechazadas y las obsoletas recargadas.

const OP = uuidDe(9, 1);
const ruta = (sufijo: string) => `POST ${BASE}/masivas/${sufijo}`;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 12 filas con versiones distintas (la 12 es la de R-ISC, la 11 está excluida). */
function docefilas() {
  return generarFilas(12).map((f, i) =>
    filaDe({
      ...f,
      excluida: i === 10,
      version: i + 1,
      serie: "F001",
      numero: String(100 + i),
    }),
  );
}

function montar(opciones: { filas?: ReturnType<typeof docefilas>; contexto?: ReturnType<typeof contextoDe> } = {}) {
  const filas = opciones.filas ?? docefilas();
  const contexto = opciones.contexto ?? contextoDe();
  const alOperacion = vi.fn();
  const alAvisar = vi.fn();
  const alLimpiarSeleccion = vi.fn();
  const resultado = render(
    <BarraMasiva
      contexto={contexto}
      filas={filas}
      seleccion={new Set(filas.map((f) => f.id))}
      alAvisar={alAvisar}
      alOperacion={alOperacion}
      alLimpiarSeleccion={alLimpiarSeleccion}
    />,
  );
  return { filas, contexto, alOperacion, alAvisar, alLimpiarSeleccion, resultado, usuario: userEvent.setup() };
}

describe("BarraMasiva · clasificar en masa (CA-7)", () => {
  it("una sola petición con el versionBase de las 12; informe con 8 aplicadas y 4 rechazadas con su motivo; las obsoletas se recargan", async () => {
    const filas = docefilas();
    const [a, b, k, l] = [filas[0], filas[1], filas[10], filas[11]];
    const rechazadas = [
      { compraId: a!.id, codigo: "version_obsoleta" },
      { compraId: b!.id, codigo: "version_obsoleta" },
      { compraId: k!.id, codigo: "fila_excluida" },
      { compraId: l!.id, codigo: "no_masiva" },
    ];
    const f = instalarFetchCompras({
      extra: { [ruta("clasificar")]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 8, rechazadas } } },
    });
    const { contexto, alOperacion, alAvisar, alLimpiarSeleccion, usuario } = montar({ filas });

    await usuario.click(screen.getByRole("button", { name: M.clasificarComo("DNG") }));

    const dialogo = await screen.findByRole("dialog", { name: M.informeMasivo });
    expect(f.de(ruta("clasificar"))).toHaveLength(1);
    const cuerpo = f.de(ruta("clasificar"))[0]!.body as { items: { compraId: string; versionBase: number }[]; destino: string };
    expect(cuerpo.destino).toBe("DNG");
    expect(cuerpo.items).toHaveLength(12);
    expect(cuerpo.items.map((x) => x.versionBase)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    expect(within(dialogo).getByText(M.aplicadas(8))).toBeTruthy();
    const tabla = within(dialogo).getByRole("table", { name: M.tablaRechazadas });
    const textos = within(tabla).getAllByRole("row").map((r) => r.textContent);
    expect(textos).toContain(`F001-100${M.rechazoMasiva.version_obsoleta}`);
    expect(textos).toContain(`F001-110${M.rechazoMasiva.fila_excluida}`);
    expect(textos).toContain(`F001-111${M.rechazoMasiva.no_masiva}`);

    // Se recargan las 8 aplicadas y las 2 obsoletas (nada más), y el resumen.
    const ids = contexto.recargarFilas.mock.calls[0]![0];
    expect([...ids].sort()).toEqual([...filas.filter((x) => x.id !== k!.id && x.id !== l!.id).map((x) => x.id)].sort());
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alOperacion).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalled();
    // Hubo rechazadas: la selección se conserva.
    expect(alLimpiarSeleccion).not.toHaveBeenCalled();
  });

  it("409 periodo_generado: muestra el mensaje, no hay informe ni operación registrada", async () => {
    instalarFetchCompras({
      extra: { [ruta("clasificar")]: { status: 409, cuerpo: { codigo: "periodo_generado" } } },
    });
    const { contexto, alOperacion, usuario } = montar();

    await usuario.click(screen.getByRole("button", { name: M.clasificarComo("DG") }));

    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.periodo_generado);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(contexto.recargarFilas).not.toHaveBeenCalled();
    expect(alOperacion).not.toHaveBeenCalled();
  });
});

describe("BarraMasiva · excluir, restaurar y R-RED", () => {
  it("excluir con motivo manda items y motivo en una petición; sin rechazadas limpia la selección", async () => {
    const f = instalarFetchCompras({
      extra: { [ruta("excluir")]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 12, rechazadas: [] } } },
    });
    const { alLimpiarSeleccion, usuario } = montar();

    await usuario.click(screen.getByRole("button", { name: M.excluir }));
    await usuario.type(screen.getByLabelText(M.motivoExclusion), "Gasto personal");
    await usuario.click(within(screen.getByRole("form")).getByRole("button", { name: M.excluir }));

    await screen.findByRole("dialog", { name: M.informeMasivo });
    expect((f.de(ruta("excluir"))[0]!.body as { motivo: string }).motivo).toBe("Gasto personal");
    expect(alLimpiarSeleccion).toHaveBeenCalledTimes(1);
  });

  it("«Aceptar R-RED» solo se habilita si alguna seleccionada tiene R-RED y manda regla R-RED sin dato ni confirmar", async () => {
    const filas = docefilas();
    const conRed = filaDe({
      ...filas[0]!,
      hallazgos: [
        {
          regla: "R-RED",
          destino: "DG",
          explicacion: "Diferencia de redondeo de 0.01.",
          sugerencia: { tipo: "ajustar", valores: { igvDg: "18.00" } },
          requiereConfirmacion: false,
          dato: null,
          masiva: true,
        },
      ],
    });
    const f = instalarFetchCompras({
      extra: { [ruta("aceptar")]: { status: 200, cuerpo: { operacionId: OP, aplicadas: 1, rechazadas: [] } } },
    });
    const usuario = userEvent.setup();
    const sin = render(
      <BarraMasiva contexto={contextoDe()} filas={filas} seleccion={new Set([filas[0]!.id])} />,
    );
    expect((screen.getByRole("button", { name: M.aceptarRed }) as HTMLButtonElement).disabled).toBe(true);
    sin.unmount();

    render(<BarraMasiva contexto={contextoDe()} filas={[conRed]} seleccion={new Set([conRed.id])} />);
    await usuario.click(screen.getByRole("button", { name: M.aceptarRed }));
    await screen.findByRole("dialog", { name: M.informeMasivo });
    expect(f.de(ruta("aceptar"))[0]!.body).toEqual({
      items: [{ compraId: conRed.id, versionBase: conRed.version }],
      regla: "R-RED",
    });
  });
});

describe("BarraMasiva · permisos y solo lectura", () => {
  it("sin sire.clasificar no se pinta; en solo lectura los botones quedan deshabilitados con el motivo", () => {
    instalarFetchCompras();
    const filas = docefilas();
    const a = render(
      <BarraMasiva contexto={contextoDe({ permisos: { clasificar: false } })} filas={filas} seleccion={new Set([filas[0]!.id])} />,
    );
    expect(a.container.childElementCount).toBe(0);
    a.unmount();

    render(
      <BarraMasiva
        contexto={contextoDe({ soloLectura: M.soloLectura.generado })}
        filas={filas}
        seleccion={new Set([filas[0]!.id])}
      />,
    );
    const boton = screen.getByRole("button", { name: M.clasificarComo("DG") }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(boton.title).toBe(M.soloLectura.generado);
  });
});

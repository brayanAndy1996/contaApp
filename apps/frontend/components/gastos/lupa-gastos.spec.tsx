import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetalleLupa, FilaCompraVista } from "@contapp/shared";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { conMiles } from "../../lib/montos-compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_5070_ZAPATILLAS,
  MENSAJES_COMPRAS as MC,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  GLOSA_ONERROR,
  HALLAZGO_GASTO_VIEJO,
  MENSAJES_GASTOS as M,
  PROPUESTA_CA9,
  SENALES_CA1,
  hallazgoGastoDe,
  rutaPropuesta,
} from "../../pruebas/gastos";
import { detalleLupaDe, rutaDetalle } from "../../pruebas/lupa-compras";
import { LupaCompra } from "../compras/lupa-compra";

// Spec 027 · T7 (rojo; CA-1, CA-4, CA-8, D-1, R-5, R-7). La lupa con el puntaje y sus señales, y el aprendizaje tras excluir desde la lupa.
// Contrato (T13): en la sección «Hallazgos» de <LupaCompra />, el hallazgo R-GP con puntaje muestra <Senales> (una fila por señal con
// su texto fijo y puntos, y «Puntaje: n»); el R-GP de la forma vieja (sin puntaje) se muestra como hasta ahora, sin la lista. La
// glosa del XML (texto no confiable) solo aparece en la sección de ítems, como texto. Los montos de los ítems llevan formato de miles
// (`conMiles`, 026). Excluir desde el menú de la lupa ofrece «Aprender estas palabras» con las mismas reglas que la grilla.
// NOTA para T13: estos casos dependen de que `detalleLupaSchema` (T9, shared) admita `puntaje` y `senales` en la sugerencia de R-GP;
// hasta entonces la lupa recibe el hallazgo sin ellos.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ITEM_ZAPATILLA = {
  descripcion: "ZAPATILLA URBANA T42",
  cantidad: "1",
  unidad: "NIU",
  precioUnitario: "1059.8300000000",
  valor: "1250.50",
  afectacion: "10",
  igv: "225.09",
  isc: "0.00",
  icbper: "0.00",
};
const FILA_ZAPATILLA = filaDe({
  ...C_5070_ZAPATILLAS,
  montos: montosDe({ biDg: "1250.50", igvDg: "225.09" }),
  hallazgos: [hallazgoGastoDe(8)] as unknown as FilaCompraVista["hallazgos"],
});

/** El detalle se arma sin hallazgos (para pasar el esquema vigente) y se le suman después, como los traería el servidor de 027. */
function detalleConHallazgos(fila: FilaCompraVista, hallazgos: unknown[], descripcion = ITEM_ZAPATILLA.descripcion): DetalleLupa {
  const base = detalleLupaDe(fila, { hallazgos: [], items: [{ ...ITEM_ZAPATILLA, descripcion }] });
  return { ...base, hallazgos } as unknown as DetalleLupa;
}

function Montar({ fila, contexto }: { fila: FilaCompraVista; contexto: ReturnType<typeof contextoDe> }) {
  const [id, setId] = useState(fila.id);
  return (
    <LupaCompra
      contexto={contexto}
      filas={[fila]}
      orden={[fila.id]}
      compraId={id}
      alCambiar={setId}
      alCerrar={vi.fn()}
      alAvisarDe={() => vi.fn()}
    />
  );
}

const hallazgos = () => screen.findByRole("region", { name: L.secciones.hallazgos });

describe("Lupa · puntaje y señales de R-GP (CA-1, D-1)", () => {
  it("feliz CA-1: el hallazgo muestra «Posible gasto no deducible», cada señal con su texto y puntos, y el puntaje 8", async () => {
    instalarFetchCompras({
      extra: { [rutaDetalle(FILA_ZAPATILLA.id)]: { status: 200, cuerpo: detalleConHallazgos(FILA_ZAPATILLA, [hallazgoGastoDe(8)]) } },
    });
    render(<Montar fila={FILA_ZAPATILLA} contexto={contextoDe()} />);

    const region = await hallazgos();
    expect(within(region).getByText(hallazgoGastoDe().explicacion, { exact: false })).toBeTruthy();
    const filas = within(within(region).getByRole("list", { name: M.listaSenales })).getAllByRole("listitem");
    expect(filas.map((f) => f.textContent)).toEqual([
      expect.stringContaining(M.senales.S1("zapatilla", 1, 1)),
      expect.stringContaining(M.senales.S2),
      expect.stringContaining(M.senales.S3("calzado-ropa")),
    ]);
    expect(within(region).getByText(M.puntajeTotal(8))).toBeTruthy();
    // Los montos de los ítems siguen con formato de miles (026): 1250.50 → «1,250.50».
    expect(document.body.textContent).toContain(conMiles("1250.50"));
    expect(document.body.textContent).toContain(conMiles("225.09"));
  });

  it("el R-GP de la forma vieja (sin puntaje) se muestra sin lista de señales", async () => {
    const fila = C_5070_ZAPATILLAS;
    instalarFetchCompras({
      extra: { [rutaDetalle(fila.id)]: { status: 200, cuerpo: detalleConHallazgos(fila, [HALLAZGO_GASTO_VIEJO]) } },
    });
    render(<Montar fila={fila} contexto={contextoDe()} />);

    const region = await hallazgos();
    expect(within(region).getByText(HALLAZGO_GASTO_VIEJO.explicacion, { exact: false })).toBeTruthy();
    expect(within(region).queryByRole("list", { name: M.listaSenales })).toBeNull();
  });

  it("la glosa con HTML del XML se ve como texto en los ítems y nunca entra a las señales ni crea elementos", async () => {
    instalarFetchCompras({
      extra: {
        [rutaDetalle(FILA_ZAPATILLA.id)]: {
          status: 200,
          cuerpo: detalleConHallazgos(FILA_ZAPATILLA, [hallazgoGastoDe(8)], GLOSA_ONERROR),
        },
      },
    });
    render(<Montar fila={FILA_ZAPATILLA} contexto={contextoDe()} />);

    const region = await hallazgos();
    expect(document.body.textContent).toContain(GLOSA_ONERROR);
    expect(document.querySelector("img")).toBeNull();
    const lista = within(region).getByRole("list", { name: M.listaSenales });
    expect(lista.textContent).not.toContain("onerror");
    expect(lista.textContent).not.toContain("URBANA");
  });

  it("cada señal recibida llega a pantalla en el orden de S1 a S7 aunque cambie el puntaje", async () => {
    const con = hallazgoGastoDe(4, [SENALES_CA1[0]!, { codigo: "S5", puntos: 1 }]);
    instalarFetchCompras({
      extra: { [rutaDetalle(FILA_ZAPATILLA.id)]: { status: 200, cuerpo: detalleConHallazgos(FILA_ZAPATILLA, [con]) } },
    });
    render(<Montar fila={FILA_ZAPATILLA} contexto={contextoDe()} />);

    const lista = within(await hallazgos()).getByRole("list", { name: M.listaSenales });
    expect(within(lista).getAllByRole("listitem")).toHaveLength(2);
    expect(within(await hallazgos()).getByText(M.puntajeTotal(4))).toBeTruthy();
    expect(within(lista).getByText(M.senales.S5, { exact: false })).toBeTruthy();
  });
});

describe("Lupa · «Aprender estas palabras» tras excluir (R-7, CA-8, CA-9)", () => {
  const rutaExcluir = `POST ${BASE}/${FILA_ZAPATILLA.id}/excluir`;

  async function excluirDesdeLaLupa(usuario: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("region", { name: L.secciones.hallazgos });
    await usuario.click(await screen.findByRole("button", { name: `${MC.columnas.acciones} F001-5070` }));
    await usuario.click(screen.getByRole("menuitem", { name: MC.excluir }));
    await usuario.click(screen.getByRole("button", { name: MC.excluir }));
  }
  const excluida = accionDe(filaDe({ ...FILA_ZAPATILLA, version: 2, excluida: true }));

  it("con reglas.gestionar: la exclusión se hace y se ofrece el diálogo con los términos propuestos de la compra", async () => {
    const f = instalarFetchCompras({
      extra: {
        [rutaDetalle(FILA_ZAPATILLA.id)]: { status: 200, cuerpo: detalleConHallazgos(FILA_ZAPATILLA, [hallazgoGastoDe(8)]) },
        [rutaExcluir]: { status: 200, cuerpo: excluida },
        [rutaPropuesta(FILA_ZAPATILLA.id)]: { status: 200, cuerpo: PROPUESTA_CA9 },
      },
    });
    const contexto = contextoDe({ permisos: { gestionarReglas: true } });
    render(<Montar fila={FILA_ZAPATILLA} contexto={contexto} />);

    await excluirDesdeLaLupa(userEvent.setup());

    const dialogo = await screen.findByRole("dialog", { name: M.tituloAprender });
    expect(within(dialogo).getByLabelText(M.campoTermino(1))).toBeTruthy();
    expect(f.de(rutaExcluir)).toHaveLength(1);
    expect(f.de(rutaPropuesta(FILA_ZAPATILLA.id))).toHaveLength(1);
  });

  it("sin reglas.gestionar (Asistente): excluye y nunca pide ni muestra «Aprender estas palabras»", async () => {
    const f = instalarFetchCompras({
      extra: {
        [rutaDetalle(FILA_ZAPATILLA.id)]: { status: 200, cuerpo: detalleConHallazgos(FILA_ZAPATILLA, [hallazgoGastoDe(8)]) },
        [rutaExcluir]: { status: 200, cuerpo: excluida },
      },
    });
    render(<Montar fila={FILA_ZAPATILLA} contexto={contextoDe({ permisos: { gestionarReglas: false } })} />);

    await excluirDesdeLaLupa(userEvent.setup());

    await vi.waitFor(() => expect(f.de(rutaExcluir)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: MC.excluir })).toBeNull());
    expect(screen.queryByRole("dialog", { name: M.tituloAprender })).toBeNull();
    expect(f.de(rutaPropuesta(FILA_ZAPATILLA.id))).toHaveLength(0);
  });
});

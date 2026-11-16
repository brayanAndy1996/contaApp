import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FILA_ID, MENSAJES_ARCHIVO as M, previoDe } from "../../pruebas/archivos";
import { PrevioArchivo } from "./previo-archivo";

// Spec 022, T8 (RP-4, CA-11): el servidor corta los avisos del previo y dice cuántos quedaron fuera
// (`avisosOmitidos`); el panel lo muestra como «Y N avisos más» sin perder la nota de que los avisos no
// impiden generar el archivo.

const aviso = { filaId: FILA_ID, comprobante: "F001-2056", codigo: "R-NEW" as const, explicacion: "Proveedor nuevo" };

afterEach(cleanup);

describe("<PrevioArchivo /> · avisos omitidos (022, T8)", () => {
  it("feliz: con avisosOmitidos > 0 muestra «Y N avisos más» y conserva la nota de los avisos", () => {
    render(<PrevioArchivo previo={previoDe({ avisos: [aviso], avisosOmitidos: 4850 })} />);

    const avisos = screen.getByRole("region", { name: M.tituloAvisos });
    expect(within(avisos).getByText("Y 4850 avisos más que no se muestran.")).toBeTruthy();
    expect(within(avisos).getByText("Los avisos no impiden generar el archivo.")).toBeTruthy();
  });

  it("usa el singular con un solo aviso omitido", () => {
    render(<PrevioArchivo previo={previoDe({ avisos: [aviso], avisosOmitidos: 1 })} />);

    expect(screen.getByText("Y 1 aviso más que no se muestra.")).toBeTruthy();
  });

  it("error: con avisosOmitidos = 0 no muestra «avisos más», pero sí la nota de los avisos", () => {
    render(<PrevioArchivo previo={previoDe({ avisos: [aviso], avisosOmitidos: 0 })} />);

    expect(screen.queryByText(/avisos? más/)).toBeNull();
    expect(screen.getByText("Los avisos no impiden generar el archivo.")).toBeTruthy();
  });
});

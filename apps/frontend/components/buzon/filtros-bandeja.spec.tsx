import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENTE_A, CLIENTE_B, MENSAJES_BANDEJA as B, NOMBRE_A, NOMBRE_B, simularPantalla } from "../../pruebas/bandeja";
import { FiltrosBandeja } from "./filtros-bandeja";

// Spec 024 · T5 (rojo; D-2, D-3, CA-2, CA-11). Filtros de la bandeja.
// Contrato (T9), `components/buzon/filtros-bandeja.tsx` (controlado; la URL la guarda `Bandeja`):
//   <FiltrosBandeja valores={ValoresFiltros} clientes={{id, razonSocial}[]} clienteId?={string}
//                   alCambiar={(v: ValoresFiltros) => void} alElegirCliente={(id: string | null) => void} />
//   ValoresFiltros = {atencion: "pendientes"|"atendidos"|"historicos"|"todos", categoria: ""|CategoriaBuzon|"criticos",
//                     leido: ""|"si"|"no", desde: "", hasta: "" (AAAA-MM-DD, días de Lima), responsable: boolean, archivados: boolean}
//   - Escritorio (sin `matchMedia` o con `min-width` verdadero): controles en línea con etiqueta accesible: Atención,
//     Categoría, Leído en SUNAT, Desde, Hasta, Cliente, «Solo donde soy responsable» e «Incluir archivados». Cada cambio
//     llama a `alCambiar` con TODOS los valores (el cambiado y los demás).
//   - «Cliente»: «Todos los clientes» + una opción por cliente; elegir uno llama a `alElegirCliente(id)` (la bandeja navega
//     a la del cliente) y «Todos los clientes» a `alElegirCliente(null)`. Con `clienteId` (bandeja fijada) ese cliente
//     aparece elegido y no hay «Solo donde soy responsable» ni «Incluir archivados» (la ruta del cliente no los usa).
//   - «Desde» posterior a «Hasta»: aviso en español y no se llama a `alCambiar` con ese par (la API daría 400).
//   - 390 px (`matchMedia` con `max-width`): ningún control en línea; un botón «Filtros» abre un `Dialog` con los mismos
//     controles, sin aplicar nada hasta «Aplicar» (una sola llamada a `alCambiar` con todo); «Limpiar» llama a
//     `alCambiar` con los valores iniciales y cierra.

interface ValoresPrueba {
  atencion: "pendientes" | "atendidos" | "historicos" | "todos";
  categoria: string;
  leido: "" | "si" | "no";
  desde: string;
  hasta: string;
  responsable: boolean;
  archivados: boolean;
}
const INICIALES: ValoresPrueba = { atencion: "pendientes", categoria: "", leido: "", desde: "", hasta: "", responsable: false, archivados: false };
const CLIENTES = [
  { id: CLIENTE_A, razonSocial: NOMBRE_A },
  { id: CLIENTE_B, razonSocial: NOMBRE_B },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(valores: Partial<ValoresPrueba> = {}, clienteId?: string) {
  const alCambiar = vi.fn();
  const alElegirCliente = vi.fn();
  render(
    <FiltrosBandeja
      valores={{ ...INICIALES, ...valores }}
      clientes={CLIENTES}
      clienteId={clienteId}
      alCambiar={alCambiar}
      alElegirCliente={alElegirCliente}
    />,
  );
  return { alCambiar, alElegirCliente, usuario: userEvent.setup() };
}

const valoresDe = (s: HTMLElement) => within(s).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);

describe("<FiltrosBandeja /> · escritorio (D-3)", () => {
  it("los controles tienen etiqueta y las opciones del contrato", () => {
    simularPantalla("escritorio");
    montar();
    expect(valoresDe(screen.getByLabelText(B.filtroAtencion))).toEqual(["pendientes", "atendidos", "historicos", "todos"]);
    expect([...valoresDe(screen.getByLabelText(B.filtroCategoria))].sort()).toEqual(
      ["", "coactiva", "criticos", "otro", "requerimiento_fiscalizacion", "resolucion_determinacion", "resolucion_multa"].sort(),
    );
    expect(valoresDe(screen.getByLabelText(B.filtroLeido))).toEqual(["", "si", "no"]);
    expect(valoresDe(screen.getByLabelText(B.filtroCliente))).toEqual(["", CLIENTE_A, CLIENTE_B]);
    expect(within(screen.getByLabelText(B.filtroCliente)).getByRole("option", { name: B.todosLosClientes })).toBeTruthy();
    expect(screen.getByLabelText(B.filtroDesde)).toBeTruthy();
    expect(screen.getByLabelText(B.filtroHasta)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: B.filtroResponsable })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: B.filtroArchivados })).toBeTruthy();
    expect(screen.queryByRole("button", { name: B.abrirFiltros })).toBeNull();
  });

  it("refleja los valores recibidos", () => {
    montar({ atencion: "atendidos", categoria: "criticos", leido: "no", desde: "2026-11-01", hasta: "2026-11-15", responsable: true, archivados: true });
    expect((screen.getByLabelText(B.filtroAtencion) as HTMLSelectElement).value).toBe("atendidos");
    expect((screen.getByLabelText(B.filtroCategoria) as HTMLSelectElement).value).toBe("criticos");
    expect((screen.getByLabelText(B.filtroLeido) as HTMLSelectElement).value).toBe("no");
    expect((screen.getByLabelText(B.filtroDesde) as HTMLInputElement).value).toBe("2026-11-01");
    expect((screen.getByLabelText(B.filtroHasta) as HTMLInputElement).value).toBe("2026-11-15");
    expect((screen.getByRole("checkbox", { name: B.filtroResponsable }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: B.filtroArchivados }) as HTMLInputElement).checked).toBe(true);
  });

  it.each([
    [B.filtroAtencion, "todos", { atencion: "todos" }],
    [B.filtroCategoria, "coactiva", { categoria: "coactiva" }],
    [B.filtroLeido, "si", { leido: "si" }],
  ])("cambiar «%s» llama a alCambiar con todos los valores y el nuevo", async (etiqueta, valor, cambio) => {
    const { alCambiar, usuario } = montar({ desde: "2026-11-01" });
    await usuario.selectOptions(screen.getByLabelText(etiqueta), valor);
    expect(alCambiar).toHaveBeenCalledTimes(1);
    expect(alCambiar).toHaveBeenCalledWith({ ...INICIALES, desde: "2026-11-01", ...cambio });
  });

  it("las casillas y las fechas también cambian un solo valor", async () => {
    const { alCambiar, usuario } = montar();
    await usuario.click(screen.getByRole("checkbox", { name: B.filtroResponsable }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...INICIALES, responsable: true });
    await usuario.click(screen.getByRole("checkbox", { name: B.filtroArchivados }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...INICIALES, archivados: true });
    fireEvent.change(screen.getByLabelText(B.filtroDesde), { target: { value: "2026-11-05" } });
    expect(alCambiar).toHaveBeenLastCalledWith({ ...INICIALES, desde: "2026-11-05" });
    fireEvent.change(screen.getByLabelText(B.filtroHasta), { target: { value: "2026-11-09" } });
    expect(alCambiar).toHaveBeenLastCalledWith({ ...INICIALES, hasta: "2026-11-09" });
  });

  it("«Desde» posterior a «Hasta»: avisa y no entrega ese par", () => {
    const { alCambiar } = montar({ hasta: "2026-11-10" });
    fireEvent.change(screen.getByLabelText(B.filtroDesde), { target: { value: "2026-11-20" } });
    expect(screen.getByText(/desde.*no puede ser posterior.*hasta/i)).toBeTruthy();
    expect(alCambiar).not.toHaveBeenCalledWith(expect.objectContaining({ desde: "2026-11-20", hasta: "2026-11-10" }));
  });

  it("elegir un cliente avisa con su id y no cambia los demás filtros", async () => {
    const { alElegirCliente, alCambiar, usuario } = montar();
    await usuario.selectOptions(screen.getByLabelText(B.filtroCliente), CLIENTE_B);
    expect(alElegirCliente).toHaveBeenLastCalledWith(CLIENTE_B);
    expect(alCambiar).not.toHaveBeenCalled();
  });

  it("con la bandeja fijada en un cliente: ese cliente está elegido, «Todos los clientes» sale a null y no hay filtros de alcance", async () => {
    const { alElegirCliente, usuario } = montar({}, CLIENTE_A);
    const select = screen.getByLabelText(B.filtroCliente) as HTMLSelectElement;
    expect(select.value).toBe(CLIENTE_A);
    expect(screen.queryByRole("checkbox", { name: B.filtroResponsable })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: B.filtroArchivados })).toBeNull();
    await usuario.selectOptions(select, "");
    expect(alElegirCliente).toHaveBeenLastCalledWith(null);
  });
});

describe("<FiltrosBandeja /> · 390 px, en un Dialog (CA-11)", () => {
  it("sin controles en línea: solo el botón «Filtros»", () => {
    simularPantalla("movil");
    montar();
    expect(screen.getByRole("button", { name: B.abrirFiltros })).toBeTruthy();
    expect(screen.queryByLabelText(B.filtroAtencion)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abre el Dialog con los mismos controles y no aplica nada hasta «Aplicar»", async () => {
    simularPantalla("movil");
    const { alCambiar, usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: B.abrirFiltros }));
    const dialogo = await screen.findByRole("dialog");
    await usuario.selectOptions(within(dialogo).getByLabelText(B.filtroCategoria), "criticos");
    await usuario.selectOptions(within(dialogo).getByLabelText(B.filtroAtencion), "todos");
    await usuario.click(within(dialogo).getByRole("checkbox", { name: B.filtroArchivados }));
    expect(alCambiar).not.toHaveBeenCalled();
    await usuario.click(within(dialogo).getByRole("button", { name: B.aplicar }));
    expect(alCambiar).toHaveBeenCalledTimes(1);
    expect(alCambiar).toHaveBeenCalledWith({ ...INICIALES, atencion: "todos", categoria: "criticos", archivados: true });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("«Limpiar» devuelve los valores iniciales y cierra", async () => {
    simularPantalla("movil");
    const { alCambiar, usuario } = montar({ atencion: "atendidos", categoria: "coactiva", responsable: true });
    await usuario.click(screen.getByRole("button", { name: B.abrirFiltros }));
    await usuario.click(within(await screen.findByRole("dialog")).getByRole("button", { name: B.limpiar }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...INICIALES });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cerrar sin aplicar (Escape) descarta los cambios del Dialog", async () => {
    simularPantalla("movil");
    const { alCambiar, usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: B.abrirFiltros }));
    const dialogo = await screen.findByRole("dialog");
    await usuario.selectOptions(within(dialogo).getByLabelText(B.filtroLeido), "si");
    await usuario.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(alCambiar).not.toHaveBeenCalled();
    await usuario.click(screen.getByRole("button", { name: B.abrirFiltros }));
    expect((within(await screen.findByRole("dialog")).getByLabelText(B.filtroLeido) as HTMLSelectElement).value).toBe("");
  });
});

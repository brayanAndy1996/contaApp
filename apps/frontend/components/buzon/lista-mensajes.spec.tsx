import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fechaHoraLima } from "../../lib/fechas";
import { celdas } from "../../pruebas/acceso";
import {
  CLIENTE_BUZON,
  ETIQUETA_CATEGORIA as C,
  FECHA_NOCHE_LIMA,
  MENSAJES_BUZON as M,
  filaBuzon,
} from "../../pruebas/buzon";
import {
  CLIENTE_ARCHIVADO,
  CLIENTE_B,
  MENSAJES_BANDEJA as BA,
  NOMBRE_ARCHIVADO,
  NOMBRE_B,
  USUARIO_ANA,
  atendidaPor,
  filaBandeja,
} from "../../pruebas/bandeja";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import { ListaMensajes } from "./lista-mensajes";

// Spec 023 · T7 (rojo; CA-6, P-9, D-4). Lista mínima de mensajes del buzón de un cliente.
// Contrato (T14, ajustado por 024 T5, P-9), `components/buzon/lista-mensajes.tsx`:
//   <ListaMensajes mensajes={FilaBandeja[]} mostrarCliente? seleccion? />  (ya no recibe `clienteId`: cada fila trae su
//   `cliente`, y el enlace del asunto sale de `fila.cliente.id`).
//   Presentacional: no llama a la red (la bandeja lee y pagina).
//   - `Table` de components/ui (role=table) con una fila por mensaje, en el orden recibido, con las columnas
//     Asunto, Categoría, Fecha y Lectura en SUNAT.
//   - Asunto: enlace a `/clientes/:clienteId/buzon?mensaje=<id>` con el asunto como TEXTO (nunca HTML).
//   - Categoría: `Badge` con texto «Crítico · <categoría>» si `critico` (no solo color); sin crítico, solo la
//     categoría (ETIQUETA_CATEGORIA de pruebas/buzon.ts).
//   - Fecha en hora de Lima (`fechaHoraLima`), no la de UTC ni la del navegador.
//   - Lectura: «Leído en SUNAT» / «No leído en SUNAT» según `leidoEnSunat`.
//   - Sin mensajes: M.listaVacia y ninguna tabla con filas.
//   - Solo componentes de components/ui y tokens de color (diseno.estatico.spec.ts).

afterEach(() => cleanup());

const A = filaBuzon({ id: uuidDe(23, 11) });
const B = filaBuzon({
  id: uuidDe(23, 12),
  asunto: "Comunicado general de SUNAT",
  categoria: "otro",
  critico: false,
  motivoCritico: null,
  leidoEnSunat: true,
  fecha: "2026-11-15T15:00:00.000Z",
});

const fila = (texto: string): HTMLElement => {
  const f = screen
    .getAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
};

describe("<ListaMensajes /> · filas", () => {
  it("una fila por mensaje, con encabezados y en el orden recibido", () => {
    render(<ListaMensajes mensajes={[A, B]} />);
    expect(screen.getByRole("table")).toBeTruthy();
    for (const encabezado of ["Asunto", "Categoría", "Fecha", "Lectura en SUNAT"]) {
      expect(screen.getByRole("columnheader", { name: encabezado })).toBeTruthy();
    }
    const cuerpo = screen.getAllByRole("row").slice(1); // sin la fila de encabezados
    expect(cuerpo).toHaveLength(2);
    expect(cuerpo[0]!.textContent).toContain(A.asunto);
    expect(cuerpo[1]!.textContent).toContain(B.asunto);
  });

  it("el crítico dice «Crítico · Coactiva» como texto, no solo como color", () => {
    render(<ListaMensajes mensajes={[A, B]} />);
    expect(within(fila(A.asunto)).getByText(`Crítico · ${C.coactiva}`)).toBeTruthy();
    expect(celdas(fila(A.asunto)).join("|")).toContain("Crítico · Coactiva");
  });

  it.each([
    ["resolucion_determinacion", "Crítico · Resolución de determinación"],
    ["resolucion_multa", "Crítico · Resolución de multa"],
    ["requerimiento_fiscalizacion", "Crítico · Requerimiento de fiscalización"],
  ] as const)("la categoría %s se rotula «%s»", (categoria, texto) => {
    render(
      <ListaMensajes mensajes={[filaBuzon({ id: uuidDe(23, 13), categoria })]} />,
    );
    expect(screen.getByText(texto)).toBeTruthy();
  });

  it("un mensaje común muestra su categoría sin «Crítico»", () => {
    render(<ListaMensajes mensajes={[A, B]} />);
    const comun = fila(B.asunto);
    expect(within(comun).getByText(C.otro)).toBeTruthy();
    expect(comun.textContent).not.toContain("Crítico");
  });

  it("la fecha sale en hora de Lima (el 11/11 de noche, no el 12/11 de UTC)", () => {
    render(<ListaMensajes mensajes={[A]} />);
    const esperada = fechaHoraLima(FECHA_NOCHE_LIMA);
    expect(esperada).toMatch(/^11\/11/);
    expect(fila(A.asunto).textContent).toContain(esperada);
    expect(fila(A.asunto).textContent).not.toContain("12/11");
  });

  it("indica si SUNAT lo tiene leído o no", () => {
    render(<ListaMensajes mensajes={[A, B]} />);
    expect(within(fila(A.asunto)).getByText(M.noLeidoEnSunat)).toBeTruthy();
    expect(within(fila(B.asunto)).getByText(M.leidoEnSunat)).toBeTruthy();
    expect(within(fila(A.asunto)).queryByText(M.leidoEnSunat)).toBeNull();
  });

  it("el asunto enlaza a la vista del mensaje con ?mensaje=<id>", () => {
    render(<ListaMensajes mensajes={[A, B]} />);
    const enlace = within(fila(A.asunto)).getByRole("link", { name: A.asunto });
    expect(enlace.getAttribute("href")).toBe(`/clientes/${CLIENTE_BUZON}/buzon?mensaje=${A.id}`);
  });
});

describe("<ListaMensajes /> · texto hostil y vacío", () => {
  it("un asunto con HTML se ve como texto: ni imagen ni atributos on*", () => {
    const hostil = filaBuzon({ id: uuidDe(23, 14), asunto: TEXTO_HOSTIL });
    const { container } = render(<ListaMensajes mensajes={[hostil]} />);
    expect(screen.getByText(TEXTO_HOSTIL)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const conOn = [...container.querySelectorAll("*")].some((el) =>
      [...el.attributes].some((a) => /^on/i.test(a.name)),
    );
    expect(conOn).toBe(false);
  });

  it("sin mensajes: dice que no hay y no pinta filas de datos", () => {
    render(<ListaMensajes mensajes={[]} />);
    expect(screen.getByText(M.listaVacia)).toBeTruthy();
    expect(screen.queryAllByRole("row").filter((r) => r.querySelector("td"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Spec 024 · T5 (rojo; D-4, D-10, CA-3, CA-4, CA-7, CA-11). Lo que cambia por P-9: la lista lleva cliente y atención,
// el crítico usa el token de error y las filas se pueden seleccionar para el lote.
//   - Columnas: Cliente (solo con `mostrarCliente`, por omisión sí), Asunto, Categoría, Fecha, Lectura en SUNAT y
//     Atención. La atención se dice con texto: «Pendiente», «Atendido» (+ quién) o «Histórico».
//   - `seleccion={{ids: Set<string>, alCambiar(ids)}}` pinta una casilla por fila con el nombre «Seleccionar <asunto>»;
//     la de un cliente archivado está inactiva (U-1: archivado = solo lectura). Sin `seleccion`, no hay casillas.
// ---------------------------------------------------------------------------------------------------------------

describe("<ListaMensajes /> · cliente y atención (024)", () => {
  it("con cliente: columna «Cliente» con la razón social y el enlace del asunto al cliente de la fila", () => {
    const deB = filaBandeja({ id: uuidDe(24, 11), asunto: "Otro asunto", cliente: { id: CLIENTE_B, razonSocial: NOMBRE_B, archivado: false } });
    render(<ListaMensajes mensajes={[A, deB]} />);
    expect(screen.getByRole("columnheader", { name: BA.columnaCliente })).toBeTruthy();
    expect(celdas(fila(A.asunto)).join("|")).toContain("Alfa SAC");
    const enlaceB = within(fila("Otro asunto")).getByRole("link", { name: "Otro asunto" });
    expect(enlaceB.getAttribute("href")).toBe(`/clientes/${CLIENTE_B}/buzon?mensaje=${uuidDe(24, 11)}`);
  });

  it("con mostrarCliente={false} (bandeja fijada) no hay columna «Cliente»", () => {
    render(<ListaMensajes mensajes={[A]} mostrarCliente={false} />);
    expect(screen.queryByRole("columnheader", { name: BA.columnaCliente })).toBeNull();
    expect(screen.getByRole("columnheader", { name: BA.columnaAtencion })).toBeTruthy();
  });

  it("la atención sale como texto: Pendiente, Atendido por <nombre> e Histórico", () => {
    const atendido = filaBuzon({ id: uuidDe(24, 12), asunto: "Ya visto", critico: false, motivoCritico: null, atencion: atendidaPor() });
    const historico = filaBuzon({
      id: uuidDe(24, 13),
      asunto: "De hace meses",
      critico: false,
      motivoCritico: null,
      atencion: { estado: "historico", por: null, en: null },
    });
    render(<ListaMensajes mensajes={[A, atendido, historico]} />);
    expect(within(fila(A.asunto)).getByText(BA.estado.pendiente)).toBeTruthy();
    expect(within(fila("Ya visto")).getByText(BA.estado.atendido)).toBeTruthy();
    expect(fila("Ya visto").textContent).toContain(USUARIO_ANA.nombre);
    expect(within(fila("De hace meses")).getByText(BA.estado.historico)).toBeTruthy();
  });

  it("el crítico usa el token de error y dice «Crítico · Coactiva» con texto (CA-3)", () => {
    const comun = filaBuzon({ id: uuidDe(24, 14), asunto: "Comunicado", categoria: "otro", critico: false, motivoCritico: null });
    render(<ListaMensajes mensajes={[A, comun]} />);
    const rojo = screen.getByText(`Crítico · ${C.coactiva}`);
    expect(rojo.className).toMatch(/(text|bg|border)-error/);
    expect(screen.getByText(C.otro).className).not.toMatch(/-error/);
  });
});

describe("<ListaMensajes /> · selección para el lote (024)", () => {
  it("sin `seleccion` no hay casillas", () => {
    render(<ListaMensajes mensajes={[A]} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("una casilla por fila con nombre accesible; marcarla avisa con el conjunto nuevo", async () => {
    const alCambiar = vi.fn();
    const otra = filaBuzon({ id: uuidDe(24, 15), asunto: "Segundo", critico: false, motivoCritico: null });
    render(<ListaMensajes mensajes={[A, otra]} seleccion={{ ids: new Set([otra.id]), alCambiar }} />);
    const primera = screen.getByRole("checkbox", { name: BA.seleccionar(A.asunto) }) as HTMLInputElement;
    const segunda = screen.getByRole("checkbox", { name: BA.seleccionar("Segundo") }) as HTMLInputElement;
    expect(primera.checked).toBe(false);
    expect(segunda.checked).toBe(true);
    await userEvent.setup().click(primera);
    expect(alCambiar).toHaveBeenCalledTimes(1);
    expect([...alCambiar.mock.calls[0]![0]].sort()).toEqual([A.id, otra.id].sort());
  });

  it("la casilla de un mensaje de cliente archivado está inactiva (U-1)", () => {
    const deArchivado = filaBuzon({
      id: uuidDe(24, 16),
      asunto: "De un archivado",
      cliente: { id: CLIENTE_ARCHIVADO, razonSocial: NOMBRE_ARCHIVADO, archivado: true },
    });
    render(<ListaMensajes mensajes={[A, deArchivado]} seleccion={{ ids: new Set(), alCambiar: vi.fn() }} />);
    expect((screen.getByRole("checkbox", { name: BA.seleccionar("De un archivado") }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: BA.seleccionar(A.asunto) }) as HTMLInputElement).disabled).toBe(false);
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fechaHoraLima } from "../../lib/fechas";
import { celdas } from "../../pruebas/acceso";
import {
  CLIENTE_BUZON,
  ETIQUETA_CATEGORIA as C,
  FECHA_NOCHE_LIMA,
  MENSAJES_BUZON as M,
  filaBuzon,
} from "../../pruebas/buzon";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import { ListaMensajes } from "./lista-mensajes";

// Spec 023 · T7 (rojo; CA-6, P-9, D-4). Lista mínima de mensajes del buzón de un cliente.
// Contrato (T14), `components/buzon/lista-mensajes.tsx`: <ListaMensajes clienteId="c-1" mensajes={MensajeBuzonFila[]} />.
//   Presentacional: no llama a la red (la página `buzon/page.tsx` lee GET …/buzon/mensajes y pagina).
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
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A, B]} />);
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
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A, B]} />);
    expect(within(fila(A.asunto)).getByText(`Crítico · ${C.coactiva}`)).toBeTruthy();
    expect(celdas(fila(A.asunto)).join("|")).toContain("Crítico · Coactiva");
  });

  it.each([
    ["resolucion_determinacion", "Crítico · Resolución de determinación"],
    ["resolucion_multa", "Crítico · Resolución de multa"],
    ["requerimiento_fiscalizacion", "Crítico · Requerimiento de fiscalización"],
  ] as const)("la categoría %s se rotula «%s»", (categoria, texto) => {
    render(
      <ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[filaBuzon({ id: uuidDe(23, 13), categoria })]} />,
    );
    expect(screen.getByText(texto)).toBeTruthy();
  });

  it("un mensaje común muestra su categoría sin «Crítico»", () => {
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A, B]} />);
    const comun = fila(B.asunto);
    expect(within(comun).getByText(C.otro)).toBeTruthy();
    expect(comun.textContent).not.toContain("Crítico");
  });

  it("la fecha sale en hora de Lima (el 11/11 de noche, no el 12/11 de UTC)", () => {
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A]} />);
    const esperada = fechaHoraLima(FECHA_NOCHE_LIMA);
    expect(esperada).toMatch(/^11\/11/);
    expect(fila(A.asunto).textContent).toContain(esperada);
    expect(fila(A.asunto).textContent).not.toContain("12/11");
  });

  it("indica si SUNAT lo tiene leído o no", () => {
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A, B]} />);
    expect(within(fila(A.asunto)).getByText(M.noLeidoEnSunat)).toBeTruthy();
    expect(within(fila(B.asunto)).getByText(M.leidoEnSunat)).toBeTruthy();
    expect(within(fila(A.asunto)).queryByText(M.leidoEnSunat)).toBeNull();
  });

  it("el asunto enlaza a la vista del mensaje con ?mensaje=<id>", () => {
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[A, B]} />);
    const enlace = within(fila(A.asunto)).getByRole("link", { name: A.asunto });
    expect(enlace.getAttribute("href")).toBe(`/clientes/${CLIENTE_BUZON}/buzon?mensaje=${A.id}`);
  });
});

describe("<ListaMensajes /> · texto hostil y vacío", () => {
  it("un asunto con HTML se ve como texto: ni imagen ni atributos on*", () => {
    const hostil = filaBuzon({ id: uuidDe(23, 14), asunto: TEXTO_HOSTIL });
    const { container } = render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[hostil]} />);
    expect(screen.getByText(TEXTO_HOSTIL)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const conOn = [...container.querySelectorAll("*")].some((el) =>
      [...el.attributes].some((a) => /^on/i.test(a.name)),
    );
    expect(conOn).toBe(false);
  });

  it("sin mensajes: dice que no hay y no pinta filas de datos", () => {
    render(<ListaMensajes clienteId={CLIENTE_BUZON} mensajes={[]} />);
    expect(screen.getByText(M.listaVacia)).toBeTruthy();
    expect(screen.queryAllByRole("row").filter((r) => r.querySelector("td"))).toHaveLength(0);
  });
});

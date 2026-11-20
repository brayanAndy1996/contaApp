import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_BUZON as ML } from "../../lib/buzon";
import { MENSAJES_BANDEJA as B, simularPantalla } from "../../pruebas/bandeja";
import { filaBuzon } from "../../pruebas/buzon";
import { uuidDe } from "../../pruebas/compras";
import { ListaMensajes } from "./lista-mensajes";

// Spec 023 · T23a-2 (rojo; prueba manual de T23). A 390 px la tabla cortaba «Crítico · Coactiva» y escondía Fecha y
// Lectura tras un desplazamiento interno sin pista. Se adopta el diseño apilado que el proyecto ya usa para este
// defecto (`TablaReglasCliente`, 021 T23a-5): sin contenedor `overflow-x-auto` y con la etiqueta de su columna en cada
// celda (`data-etiqueta`, que el CSS muestra como prefijo en móvil), de modo que nada queda fuera de la vista.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<ListaMensajes /> · 390 px (T23a-2)", () => {
  it("cada celda lleva la etiqueta de su columna y la tabla no esconde nada tras un desplazamiento interior", () => {
    const { container } = render(
      <ListaMensajes
        mostrarCliente={false}
        mensajes={[filaBuzon({ id: uuidDe(23, 31) }), filaBuzon({ id: uuidDe(23, 32), critico: false, motivoCritico: null })]}
      />,
    );
    const filas = screen.getAllByRole("row").slice(1);
    expect(filas).toHaveLength(2);
    for (const fila of filas) {
      const etiquetas = [...fila.querySelectorAll("td")].map((td) => td.getAttribute("data-etiqueta"));
      expect(etiquetas).toEqual([
        ML.columnas.asunto,
        ML.columnas.categoria,
        ML.columnas.fecha,
        ML.columnas.lectura,
        B.columnaAtencion,
      ]);
    }
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
    expect(screen.getByRole("table").className).not.toContain("min-w-[");
  });
});

describe("<ListaMensajes /> · 390 px con cliente (024 T5)", () => {
  it("la columna «Cliente» también lleva su etiqueta y va primero", () => {
    render(<ListaMensajes mensajes={[filaBuzon({ id: uuidDe(23, 33) })]} />);
    const fila = screen.getAllByRole("row")[1]!;
    const etiquetas = [...fila.querySelectorAll("td")].map((td) => td.getAttribute("data-etiqueta"));
    expect(etiquetas).toEqual([
      B.columnaCliente,
      ML.columnas.asunto,
      ML.columnas.categoria,
      ML.columnas.fecha,
      ML.columnas.lectura,
      B.columnaAtencion,
    ]);
    expect(fila.className).toContain("max-md:flex-col");
  });
});

describe("<ListaMensajes /> · insignia crítica a 390 px (024 CA-3, RNF-071)", () => {
  it("la insignia «Crítico · <categoría>» puede partir línea: sin nowrap y sin ancho que ensanche la tarjeta", () => {
    render(<ListaMensajes mensajes={[filaBuzon({ id: uuidDe(23, 34), critico: true })]} />);
    const insignia = screen.getByText(/^Crítico · /);
    expect(insignia.getAttribute("data-slot")).toBe("badge");
    const clases = insignia.className.split(/\s+/);
    expect(clases).toContain("whitespace-normal");
    expect(clases).not.toContain("whitespace-nowrap");
    expect(clases).toContain("max-w-full");
    expect(clases).toContain("h-auto");
    expect(clases).not.toContain("h-6");
  });
});

describe("<ListaMensajes /> · detalle abierto en dos columnas (T15a-1)", () => {
  it("a partir de 768 px la tabla se desplaza dentro de su contenedor (no se corta la columna «Atención») y se alcanza con teclado", () => {
    const { container } = render(<ListaMensajes mensajes={[filaBuzon({ id: uuidDe(23, 35) })]} />);
    const contenedor = container.querySelector("table")!.parentElement!;
    const clases = contenedor.className.split(/\s+/);
    expect(clases).toContain("md:overflow-x-auto");
    expect(clases).not.toContain("md:overflow-x-clip");
    expect(clases).toContain("min-w-0");
    expect(contenedor.getAttribute("tabindex")).toBe("0");
    expect(contenedor.getAttribute("role")).toBe("region");
    expect(contenedor.getAttribute("aria-label")).toBe(ML.tablaMensajes);
  });

  it("a 390 px el contenedor no recibe foco (la tabla va apilada y no se desplaza)", () => {
    simularPantalla("movil");
    const { container } = render(<ListaMensajes mensajes={[filaBuzon({ id: uuidDe(23, 36) })]} />);
    expect(container.querySelector("table")!.parentElement!.hasAttribute("tabindex")).toBe(false);
  });
});

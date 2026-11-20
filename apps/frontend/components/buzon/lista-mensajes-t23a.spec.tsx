import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_BUZON as ML } from "../../lib/buzon";
import { MENSAJES_BANDEJA as B } from "../../pruebas/bandeja";
import { filaBuzon } from "../../pruebas/buzon";
import { uuidDe } from "../../pruebas/compras";
import { ListaMensajes } from "./lista-mensajes";

// Spec 023 · T23a-2 (rojo; prueba manual de T23). A 390 px la tabla cortaba «Crítico · Coactiva» y escondía Fecha y
// Lectura tras un desplazamiento interno sin pista. Se adopta el diseño apilado que el proyecto ya usa para este
// defecto (`TablaReglasCliente`, 021 T23a-5): sin contenedor `overflow-x-auto` y con la etiqueta de su columna en cada
// celda (`data-etiqueta`, que el CSS muestra como prefijo en móvil), de modo que nada queda fuera de la vista.

afterEach(() => cleanup());

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

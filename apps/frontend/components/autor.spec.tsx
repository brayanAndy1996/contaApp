import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Autor } from "./autor";

// Spec 017 T13 (D-12; CA-13, nivel C): autor activo, inactivo y desconocido; nunca el id.

const ID = "00000000-0000-4000-8000-0000000000a1";

describe("Autor con nombre", () => {
  afterEach(cleanup);

  it("activo: muestra solo el nombre", () => {
    render(<Autor autor={{ id: ID, nombre: "Rosa Quispe", activo: true }} />);
    expect(screen.getByText("Rosa Quispe")).toBeTruthy();
  });

  it("inactivo: agrega «(inactivo)»", () => {
    render(<Autor autor={{ id: ID, nombre: "Rosa Quispe", activo: false }} />);
    expect(screen.getByText("Rosa Quispe (inactivo)")).toBeTruthy();
  });

  it("desconocido (id ajeno al estudio o sin autor): «Usuario desconocido», sin id ni nombre", () => {
    const { container, rerender } = render(
      <Autor autor={{ id: ID, nombre: null, activo: false }} />,
    );
    expect(screen.getByText("Usuario desconocido")).toBeTruthy();
    expect(container.textContent).not.toContain(ID.slice(0, 8));
    rerender(<Autor autor={null} />);
    expect(screen.getByText("Usuario desconocido")).toBeTruthy();
  });

  it("un nombre con <script> sale como texto", () => {
    const { container } = render(
      <Autor autor={{ id: ID, nombre: "<script>alert(1)</script>", activo: true }} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe("<script>alert(1)</script>");
  });
});

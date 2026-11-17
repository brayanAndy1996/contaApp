import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { rutaSesion, yoDe } from "../../pruebas/acceso";
import { RUTA_MOTOR, motorDe } from "../../pruebas/reglas";
import { instalarFetchFalso } from "../../pruebas/soporte";
import { ReglasMotor } from "./reglas-motor";

// Spec 038 · T-final-f: los interruptores de las reglas dan 44 × 44 px de área táctil bajo 1024 px.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<ReglasMotor /> · área táctil", () => {
  it("cada interruptor de regla va dentro de una etiqueta de 44 px bajo 1024 px y conserva su nombre", async () => {
    instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", ["clientes.ver", "reglas.ver", "reglas.gestionar"]) },
      [RUTA_MOTOR]: { status: 200, cuerpo: motorDe() },
    });
    render(<ReglasMotor />);
    const interruptor = await screen.findByRole("switch", { name: /R-ISC/ });
    expect(interruptor.closest("label")!.className).toContain("max-lg:size-11");
  });
});

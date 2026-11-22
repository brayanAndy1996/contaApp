import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import { rutaSesion, yoDe } from "../../../../pruebas/acceso";
import { MENSAJES_GASTOS as M, RUTA_GASTOS, gastosEstudioDe } from "../../../../pruebas/gastos";
import { RUTA_MOTOR, motorDe } from "../../../../pruebas/reglas";
import { instalarFetchFalso } from "../../../../pruebas/soporte";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/configuracion/reglas",
  useSearchParams: () => new URLSearchParams(),
}));

import PaginaReglasMotor from "./page";

// Spec 027 · T7 (rojo; CA-8, R-4, R-11). La página «Reglas del motor» suma la sección «Gastos no deducibles» (<GastosEstudio />)
// debajo de los interruptores de 021, que no cambian (siguen siendo ocho `switch`: siete reglas y el aporte).

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("página «Reglas del motor» · sección de gastos no deducibles", () => {
  it("muestra los interruptores de 021 y, debajo, la sección con el umbral y las palabras del estudio", async () => {
    const f = instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", ["clientes.ver", "reglas.ver", "reglas.gestionar"]) },
      [RUTA_MOTOR]: { status: 200, cuerpo: motorDe() },
      [RUTA_GASTOS]: { status: 200, cuerpo: gastosEstudioDe() },
    });
    render(<PaginaReglasMotor />);

    expect(await screen.findByRole("heading", { name: M.tituloSeccion })).toBeTruthy();
    expect((await screen.findByRole("spinbutton", { name: M.campoUmbral }) as HTMLInputElement).value).toBe("3");
    expect(screen.getAllByRole("switch")).toHaveLength(8);
    expect(f.de(RUTA_GASTOS)).toHaveLength(1);
  });
});

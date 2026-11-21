import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { rutaSesion, yoDe } from "../../pruebas/acceso";
import { MENSAJES_APRENDIZAJE as M } from "../../pruebas/aprendizaje";
import { RUTA_MOTOR, rutaFijarMotor } from "../../pruebas/reglas";
import { instalarFetchFalso } from "../../pruebas/soporte";
import { ReglasMotor } from "./reglas-motor";

// Spec 025 · T7 (rojo; CA-10, D-8, RF-089). R-STD entra a las reglas del motor del estudio.
// Contrato (T13), `components/reglas/reglas-motor.tsx`: la lista que da GET /api/estudio/reglas-motor ahora trae siete
// códigos (…, R-HIS, R-STD) más el aporte; R-STD se ve con su descripción, se apaga y se enciende como las demás
// (PUT /api/estudio/reglas-motor/R-STD {activa}) y el anuncio dice «Regla R-STD desactivada.». Apagarla no borra nada.

const DESCRIPCION_STD = "Sugiere DNG en clientes de la Amazonía con ventas exoneradas y sin ventas mixtas.";
const CODIGOS = ["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS", "R-STD"];
const descripciones: Record<string, string> = {
  "R-ISC": "Sugiere pasar a ISC la base gravada sin IGV de proveedores con ISC.",
  "R-MIX": "Separa lo gravado de lo no gravado cuando el IGV no cuadra.",
  "R-RED": "Sugiere el redondeo de los montos en dólares.",
  "R-NEW": "Avisa de un proveedor nuevo para que elijas su destino.",
  "R-GP": "Marca posibles gastos personales según la glosa.",
  "R-HIS": "Aplica el destino que ya aprendiste para el proveedor.",
  "R-STD": DESCRIPCION_STD,
};
const motor = (apagadas: string[] = []) => ({
  reglas: CODIGOS.map((codigo) => ({ codigo, descripcion: descripciones[codigo]!, activa: !apagadas.includes(codigo) })),
  aportarCatalogo: true,
});

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const marcado = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

describe("<ReglasMotor /> · R-STD (D-8)", () => {
  it("feliz: R-STD sale con su descripción entre los interruptores (siete reglas y el aporte)", async () => {
    instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", ["clientes.ver", "reglas.ver", "reglas.gestionar"]) },
      [RUTA_MOTOR]: { status: 200, cuerpo: motor() },
    });
    render(<ReglasMotor />);

    const std = await screen.findByRole("switch", { name: /R-STD/ });
    expect(marcado(std)).toBe(true);
    expect(screen.getByText(DESCRIPCION_STD, { exact: false })).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(8);
    // El texto de la sugerencia de la grilla no se confunde con la descripción de la regla del motor.
    expect(M.std).toBe("DNG por perfil del cliente");
  });

  it("apagar R-STD manda PUT {activa: false}, el interruptor cambia al responder y se anuncia", async () => {
    const f = instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", ["clientes.ver", "reglas.ver", "reglas.gestionar"]) },
      [RUTA_MOTOR]: { status: 200, cuerpo: motor() },
      [rutaFijarMotor("R-STD")]: { status: 200, cuerpo: { codigo: "R-STD", activa: false } },
    });
    render(<ReglasMotor />);
    const std = await screen.findByRole("switch", { name: /R-STD/ });
    const usuario = userEvent.setup();

    await usuario.click(std);

    await vi.waitFor(() => expect(marcado(std)).toBe(false));
    expect(f.de(rutaFijarMotor("R-STD"))[0]!.body).toEqual({ activa: false });
    expect(f.de(rutaFijarMotor("R-STD"))[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Regla R-STD desactivada.");
    // Las demás reglas no se tocan.
    expect(marcado(await screen.findByRole("switch", { name: /R-HIS/ }))).toBe(true);
    expect(f.llamadas.filter((l) => l.method === "PUT")).toHaveLength(1);
  });

  it("un asistente (sin alcance global) ve R-STD pero no puede cambiarla", async () => {
    instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("asistente", ["clientes.ver", "reglas.ver"]) },
      [RUTA_MOTOR]: { status: 200, cuerpo: motor(["R-STD"]) },
    });
    render(<ReglasMotor />);

    const std = (await screen.findByRole("switch", { name: /R-STD/ })) as HTMLInputElement;
    expect(marcado(std)).toBe(false);
    expect(std.disabled).toBe(true);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODIGOS_REGLA_MOTOR } from "@contapp/shared";
import { MENSAJES } from "../../lib/acceso";
import { reiniciarSesion } from "../../lib/sesion";
import { rutaSesion, yoDe, type RolPrueba } from "../../pruebas/acceso";
import {
  MENSAJES_REGLAS as R,
  RUTA_APORTE,
  RUTA_MOTOR,
  descripcionDe,
  motorDe,
  rutaFijarMotor,
} from "../../pruebas/reglas";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { ReglasMotor } from "./reglas-motor";

// Spec 021 · T6 (rojo; CA-8, P-8, P-10). Reglas del motor del estudio.
// Contrato (T13), `components/reglas/reglas-motor.tsx`: <ReglasMotor />, sin props.
//   - Lee GET /api/estudio/reglas-motor y GET /api/acceso/yo.
//   - Seis interruptores role="switch" (aria-checked = activa), nombrados con el código (R-ISC … R-HIS) y con su
//     descripción simple visible; NINGUNO para la prevalidación de 012. Un séptimo interruptor (P-10) con nombre
//     `MENSAJES_REGLAS.aporte` para el aporte de RUC 20 al catálogo.
//   - Apagar/encender → PUT /api/estudio/reglas-motor/:codigo {activa}; el aporte → PUT …/aporte {aportar}.
//   - Todos quedan deshabilitados, con `MENSAJES_REGLAS.soloAlcanceGlobal`, si falta `reglas.gestionar` o el alcance
//     no es global (solo Dueño y Administrador). El servidor valida: esto solo oculta.
//   - Sin actualización optimista: el interruptor cambia cuando el servidor responde 200; con error muestra el
//     mensaje (role alert) y el interruptor conserva su valor.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function instalar(
  motor = motorDe(),
  opciones: { rol?: RolPrueba; permisos?: string[]; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe(opciones.rol ?? "dueno", opciones.permisos ?? ["clientes.ver", "reglas.ver", "reglas.gestionar"]),
    },
    [RUTA_MOTOR]: { status: 200, cuerpo: motor },
    ...opciones.extra,
  });
}

const interruptor = (codigo: string) => screen.findByRole("switch", { name: new RegExp(codigo) }) as Promise<HTMLInputElement>;
const aporte = () => screen.findByRole("switch", { name: R.aporte }) as Promise<HTMLInputElement>;
const marcado = (el: HTMLElement) => el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true;

describe("<ReglasMotor /> · lista (CA-8, P-8)", () => {
  it("feliz: los seis códigos con su descripción y estado; sin prevalidación; interruptor del aporte", async () => {
    instalar(motorDe(["R-NEW"], false));
    render(<ReglasMotor />);

    for (const codigo of CODIGOS_REGLA_MOTOR) {
      const el = await interruptor(codigo);
      expect(marcado(el)).toBe(codigo !== "R-NEW");
      expect(screen.getAllByText(descripcionDe(codigo), { exact: false }).length).toBeGreaterThan(0);
    }
    expect((await aporte()).getAttribute("aria-checked")).toBe("false");
    // Seis reglas + el aporte; ningún interruptor de la prevalidación.
    expect(screen.getAllByRole("switch")).toHaveLength(7);
    expect(document.body.textContent).not.toMatch(/prevalidaci[oó]n/i);
    expect(screen.queryByText(R.soloAlcanceGlobal)).toBeNull();
  });
});

describe("<ReglasMotor /> · apagar y encender", () => {
  it("apagar R-MIX manda PUT {activa:false} y el interruptor cambia al responder; volver a encender manda {activa:true}", async () => {
    const f = instalar(motorDe(), {
      extra: { [rutaFijarMotor("R-MIX")]: (llamada) => ({ status: 200, cuerpo: { codigo: "R-MIX", activa: (llamada.body as { activa: boolean }).activa } }) },
    });
    render(<ReglasMotor />);
    const usuario = userEvent.setup();
    const mix = await interruptor("R-MIX");

    await usuario.click(mix);
    await vi.waitFor(() => expect(marcado(mix)).toBe(false));
    expect(f.de(rutaFijarMotor("R-MIX"))[0]!.body).toEqual({ activa: false });
    expect(f.de(rutaFijarMotor("R-MIX"))[0]!.headers["x-csrf-token"]).toBeTruthy();
    // Las demás siguen encendidas y no se tocaron.
    expect(marcado(await interruptor("R-ISC"))).toBe(true);
    expect(f.llamadas.filter((l) => l.method === "PUT")).toHaveLength(1);

    await usuario.click(mix);
    await vi.waitFor(() => expect(marcado(mix)).toBe(true));
    expect(f.de(rutaFijarMotor("R-MIX"))[1]!.body).toEqual({ activa: true });
  });

  it("R-HIS se apaga igual que las demás reglas", async () => {
    const f = instalar(motorDe(), { extra: { [rutaFijarMotor("R-HIS")]: { status: 200, cuerpo: {} } } });
    render(<ReglasMotor />);
    await userEvent.setup().click(await interruptor("R-HIS"));
    await vi.waitFor(() => expect(f.de(rutaFijarMotor("R-HIS"))).toHaveLength(1));
    expect(f.de(rutaFijarMotor("R-HIS"))[0]!.body).toEqual({ activa: false });
  });

  it("el interruptor del aporte (P-10) manda PUT …/aporte {aportar} y no toca el de ninguna regla", async () => {
    const f = instalar(motorDe(), { extra: { [RUTA_APORTE]: { status: 200, cuerpo: {} } } });
    render(<ReglasMotor />);
    const usuario = userEvent.setup();
    const el = await aporte();
    expect(marcado(el)).toBe(true);

    await usuario.click(el);

    await vi.waitFor(() => expect(marcado(el)).toBe(false));
    expect(f.de(RUTA_APORTE)).toHaveLength(1);
    expect(f.de(RUTA_APORTE)[0]!.body).toEqual({ aportar: false });
    expect(f.llamadas.filter((l) => l.method === "PUT")).toHaveLength(1);
  });

  it("error: un 403 muestra el mensaje genérico y el interruptor conserva su valor", async () => {
    instalar(motorDe(), { extra: { [rutaFijarMotor("R-GP")]: { status: 403, cuerpo: { codigo: "sin_permiso" } } } });
    render(<ReglasMotor />);
    const gp = await interruptor("R-GP");

    await userEvent.setup().click(gp);

    expect((await screen.findByRole("alert")).textContent).toBe(MENSAJES.sinPermiso);
    expect(marcado(gp)).toBe(true);
  });
});

describe("<ReglasMotor /> · sin rol global (P-8, RF-089)", () => {
  it.each([
    ["contador con alcance asignado, aunque tenga reglas.gestionar", "contador", ["clientes.ver", "reglas.ver", "reglas.gestionar"]],
    ["administrador sin reglas.gestionar", "admin", ["clientes.ver", "reglas.ver"]],
  ] as const)("%s: todos los interruptores deshabilitados con el motivo y ningún PUT", async (_caso, rol, permisos) => {
    const f = instalar(motorDe(), { rol, permisos: [...permisos] });
    render(<ReglasMotor />);

    await interruptor("R-ISC");
    const todos = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(todos).toHaveLength(7);
    expect(todos.every((el) => el.disabled || el.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getByText(R.soloAlcanceGlobal)).toBeTruthy();

    await userEvent.setup().click(todos[0]!);
    expect(f.llamadas.filter((l) => l.method === "PUT")).toHaveLength(0);
  });

  it("dueño con reglas.gestionar y alcance global: ningún interruptor deshabilitado", async () => {
    instalar(motorDe(), { rol: "dueno" });
    render(<ReglasMotor />);
    await interruptor("R-ISC");
    const todos = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(todos.some((el) => el.disabled || el.getAttribute("aria-disabled") === "true")).toBe(false);
  });
});

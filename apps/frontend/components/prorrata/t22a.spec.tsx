import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  CLIENTE_PRORRATA,
  MENSAJES_PRORRATA as M,
  OBTENIDA_EN,
  RUTA_VISTA,
  conMes,
  historialDe,
  igvDe,
  instalarFetchProrrata,
  mesDe,
  mesManualDe,
  rutaHistorial,
  rutaMes,
  rutaUsada,
  valorDe,
  ventanaMixta,
  vistaDe,
  type ProrrataVistaPrueba,
} from "../../pruebas/prorrata";
import { ProrrataCliente } from "./prorrata-cliente";

// Spec 026 · T22a (defectos de pantalla de la prueba manual T22): D-1, D-2, O-2 y O-3.
//  - D-1: tras un 409 en el diálogo de mes manual, al cerrarlo la pantalla relee y muestra los montos vigentes.
//  - D-2: un 409 de versión en la tarjeta de prorrata usada da un aviso propio de la tarjeta (no el del diálogo de meses) y relee.
//  - O-2: al cerrar un diálogo el foco vuelve al botón que lo abrió.
//  - O-3: los montos se formatean con separador de miles, como en compras/ventas (`conMiles`).

vi.mock("../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../lib/trabajos")>();
  return { ...real, seguirTrabajos: vi.fn(async () => new Promise<void>(() => undefined)) };
});

beforeEach(() => {
  reiniciarSesion();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OBTENIDA_EN));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const conflicto = { status: 409, cuerpo: { codigo: "mes_cambiado" } };
const vistaConFalta = (): ProrrataVistaPrueba =>
  vistaDe({ ventana: ventanaMixta(), coeficiente: { estado: "faltan_meses", faltantes: ["202511"] }, igvEstimado: { estado: "no_estimable", motivo: "coeficiente" } });
const vistaVigente = (): ProrrataVistaPrueba =>
  conMes(vistaDe({ ventana: ventanaMixta() }), mesManualDe("202511", { gravadas: "777.00", total: "777.00" }));

async function llenarYGuardar(usuario: ReturnType<typeof userEvent.setup>, d: HTMLElement) {
  await usuario.type(within(d).getByLabelText(M.campos.gravadas), "1");
  await usuario.type(within(d).getByLabelText(M.campos.exportaciones), "0");
  await usuario.type(within(d).getByLabelText(M.campos.noGravadas), "0");
  await usuario.type(within(d).getByLabelText(M.campos.motivo), "Motivo");
  await usuario.click(within(d).getByRole("button", { name: M.guardar }));
}

describe("D-1: 409 en el diálogo de mes manual", () => {
  it("al cancelar tras el 409 la pantalla relee y muestra los montos vigentes", async () => {
    let lecturas = 0;
    const f = instalarFetchProrrata({
      vista: () => (++lecturas === 1 ? vistaConFalta() : vistaVigente()),
      extra: { [rutaMes("202511")]: conflicto },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.ingresarAMano("202511") }));
    const d = await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    await llenarYGuardar(usuario, d);
    expect((await within(d).findByRole("alert")).textContent).toContain(M.errores.mes_cambiado);
    const antes = f.de(RUTA_VISTA).length;

    await usuario.click(within(d).getByRole("button", { name: M.cancelar }));

    await vi.waitFor(() => expect(f.de(RUTA_VISTA).length).toBeGreaterThan(antes));
    expect(screen.queryByRole("dialog")).toBeNull();
    const tabla = await screen.findByRole("table", { name: M.tablaMeses });
    expect((await within(tabla).findAllByText("777.00")).length).toBeGreaterThan(0);
  });

  it("también al cerrar con Escape", async () => {
    const f = instalarFetchProrrata({ vista: vistaConFalta(), extra: { [rutaMes("202511")]: conflicto } });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.ingresarAMano("202511") }));
    const d = await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    await llenarYGuardar(usuario, d);
    await within(d).findByRole("alert");
    const antes = f.de(RUTA_VISTA).length;
    await usuario.keyboard("{Escape}");
    await vi.waitFor(() => expect(f.de(RUTA_VISTA).length).toBeGreaterThan(antes));
  });

  it("cancelar sin haber chocado no vuelve a leer", async () => {
    const f = instalarFetchProrrata({ vista: vistaConFalta() });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.ingresarAMano("202511") }));
    const d = await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    const antes = f.de(RUTA_VISTA).length;
    await usuario.click(within(d).getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.de(RUTA_VISTA).length).toBe(antes);
  });
});

describe("D-2: 409 en la tarjeta de prorrata usada", () => {
  it("aviso propio de la tarjeta (no el del diálogo de meses) y relee el valor vigente", async () => {
    let lecturas = 0;
    const f = instalarFetchProrrata({
      vista: () =>
        ++lecturas === 1
          ? vistaDe({ prorrataUsada: { valor: "72.00", origen: "ingresada" }, versionUsada: 1 })
          : vistaDe({ prorrataUsada: { valor: "70.00", origen: "ingresada" }, versionUsada: 2 }),
      extra: { [rutaUsada("202610")]: conflicto },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    const campo = (await screen.findByLabelText(M.campoUsada)) as HTMLInputElement;
    await usuario.clear(campo);
    await usuario.type(campo, "71");
    const antes = f.de(RUTA_VISTA).length;
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.usadaCambiada);
    expect(alerta.textContent).not.toContain("Cierra el diálogo");
    expect(alerta.textContent).not.toContain(M.errores.mes_cambiado);
    await vi.waitFor(() => expect(f.de(RUTA_VISTA).length).toBeGreaterThan(antes));
    expect(await screen.findByText("70,00 %")).toBeTruthy();
    await vi.waitFor(() => expect((screen.getByLabelText(M.campoUsada) as HTMLInputElement).value).toBe("70.00"));
    expect(screen.getByRole("alert").textContent).toContain(M.usadaCambiada);
  });
});

describe("O-2: el foco vuelve al botón que abrió el diálogo", () => {
  it("mes manual: Cancelar y Escape", async () => {
    instalarFetchProrrata({ vista: vistaConFalta() });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    const abrir = await screen.findByRole("button", { name: M.ingresarAMano("202511") });
    await usuario.click(abrir);
    const d = await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    await usuario.click(within(d).getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);

    await usuario.click(abrir);
    await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    await usuario.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);
  });

  it("historial: Cerrar y Escape", async () => {
    instalarFetchProrrata({ extra: { [rutaHistorial("202602")]: { status: 200, cuerpo: historialDe() } } });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    const abrir = await screen.findByRole("button", { name: M.historial("202602") });
    await usuario.click(abrir);
    const d = await screen.findByRole("dialog", { name: M.tituloHistorial("202602") });
    await usuario.click(within(d).getByRole("button", { name: M.cerrar }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(abrir);

    await usuario.click(abrir);
    await screen.findByRole("dialog", { name: M.tituloHistorial("202602") });
    await usuario.keyboard("{Escape}");
    expect(document.activeElement).toBe(abrir);
  });
});

describe("O-3: montos con separador de miles (igual que compras/ventas)", () => {
  it("tabla de meses, IGV estimado y tabla del gráfico", async () => {
    instalarFetchProrrata({
      vista: vistaDe({
        ventana: [mesDe("202511", { gravadas: "1234567.80", total: "1254567.80", noGravadas: "20000.00" }), ...vistaDe().ventana.slice(1)],
        igvEstimado: igvDe({ resultado: "-1234.50", situacion: "saldo_a_favor", igvVentas: "18000.00" }),
      }),
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const tabla = await screen.findByRole("table", { name: M.tablaMeses });
    expect(within(tabla).getAllByText("1,234,567.80").length).toBeGreaterThan(0);
    expect(within(tabla).getAllByText("1,254,567.80").length).toBeGreaterThan(0);
    expect(within(tabla).queryByText("1234567.80")).toBeNull();
    expect(valorDe(M.componentes.igvVentas)).toBe("18,000.00");
    expect(valorDe(M.situacion.saldo_a_favor)).toBe("1,234.50");
    const grafico = screen.getByRole("table", { name: M.tablaGrafico, hidden: true });
    expect(within(grafico).getAllByText("1,234,567.80", { exact: true }).length).toBeGreaterThan(0);
  });

  it("historial del mes: declaraciones y versiones manuales", async () => {
    instalarFetchProrrata({
      extra: {
        [rutaHistorial("202602")]: {
          status: 200,
          cuerpo: historialDe({
            declaraciones: [{ numeroOrden: "7654321", fechaPresentacion: "2026-03-12", tipo: "original", gravadas: "1234567.00", exportaciones: "0.00", noGravadas: "20000.00", prorrataUsada: null, obtenidaEn: OBTENIDA_EN }],
            manual: [],
          }),
        },
      },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.historial("202602") }));
    const d = await screen.findByRole("dialog", { name: M.tituloHistorial("202602") });
    expect(await within(d).findByText("1,234,567.00")).toBeTruthy();
    expect(within(d).getByText("20,000.00")).toBeTruthy();
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import {
  MENSAJES_PRORRATA as M,
  MOTIVO_MANUAL,
  anchosFijosMayoresA390,
  instalarFetchProrrata,
  mesFaltaDe,
  mesManualDe,
  mesSireDe,
  rutaEliminarMes,
  rutaMes,
} from "../../pruebas/prorrata";
import { MesManual } from "./mes-manual";

// Spec 026 · T7 (rojo; CA-4, CA-9, R-5, R-6, U-4, U-5, D-5, D-8). Diálogo para ingresar o corregir un mes a mano.
// Contrato (T13), `components/prorrata/mes-manual.tsx`:
//   <MesManual clienteId="c-1" mes={MesVista} alGuardar={() => void} alCerrar={() => void} />   (se monta abierto)
//   - `Dialog` (role dialog, nombre M.tituloManual(periodo)) con campos M.campos.{gravadas, exportaciones, noGravadas} (campos de texto, type="text":
//     montos con signo y hasta 2 decimales), M.campos.motivo (obligatorio, hasta 500 caracteres), y botones M.guardar y M.cancelar.
//     Un mes que ya es manual llega con los tres montos rellenos (los suyos) y el motivo vacío (cada versión lleva el suyo);
//     un mes SIRE o en falta llega con los campos vacíos (el contador escribe «0» para «sin operaciones», U-5).
//   - M.guardar → PUT /api/clientes/:id/prorrata/meses/:periodo con {gravadas, exportaciones, noGravadas, motivo, version} donde
//     `version` = `mes.versionManual` y los montos van tal como se teclearon (recortados). Éxito (200 {version}) → `alGuardar()`.
//   - Validación local, sin llamar a la API: monto vacío o inválido (más de 2 decimales, notación científica, letras, coma de miles)
//     → M.montoInvalido junto al campo; motivo vacío o de espacios → M.motivoObligatorio; motivo de 501 caracteres → M.motivoLargo.
//   - Solo si el mes es manual: botón M.eliminarManual → pide motivo y confirma con M.confirmarEliminar →
//     POST …/meses/:periodo/eliminar con {motivo, version}; éxito → `alGuardar()`.
//   - 409 mes_cambiado | mes_declarado | cliente_archivado, 403 y 400 solicitud_invalida → role alert en español, nunca el código.
//   - «Cancelar» → `alCerrar()` sin llamar a la API.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERIODO = "202511";
const OK = { status: 200, cuerpo: { version: 1 } };

function montar(mes = mesFaltaDe(PERIODO), extra: Parameters<typeof instalarFetchProrrata>[0] = {}) {
  const f = instalarFetchProrrata(extra);
  const alGuardar = vi.fn();
  const alCerrar = vi.fn();
  render(<MesManual clienteId="c-1" mes={mes} alGuardar={alGuardar} alCerrar={alCerrar} />);
  return { f, alGuardar, alCerrar, usuario: userEvent.setup() };
}

const dialogo = () => screen.findByRole("dialog", { name: M.tituloManual(PERIODO) });
const campo = (d: HTMLElement, nombre: string) => within(d).getByLabelText(nombre) as HTMLInputElement;

async function llenar(usuario: ReturnType<typeof userEvent.setup>, d: HTMLElement, v: { g?: string; e?: string; n?: string; m?: string }) {
  for (const [nombre, valor] of [
    [M.campos.gravadas, v.g],
    [M.campos.exportaciones, v.e],
    [M.campos.noGravadas, v.n],
    [M.campos.motivo, v.m],
  ] as const) {
    if (valor === undefined) continue;
    const c = campo(d, nombre);
    await usuario.clear(c);
    if (valor !== "") await usuario.type(c, valor);
  }
}

describe("<MesManual /> · guardar (CA-4)", () => {
  it("mes en falta: campos vacíos; guardar manda los montos tecleados, el motivo y version 0", async () => {
    const { f, alGuardar, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    for (const n of [M.campos.gravadas, M.campos.exportaciones, M.campos.noGravadas, M.campos.motivo]) {
      expect(campo(d, n).value).toBe("");
    }

    await llenar(usuario, d, { g: "100000.00", e: "0", n: "20000.50", m: "Libro físico" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));

    await vi.waitFor(() => expect(f.de(rutaMes(PERIODO))).toHaveLength(1));
    const llamada = f.de(rutaMes(PERIODO))[0]!;
    expect(llamada.body).toEqual({ gravadas: "100000.00", exportaciones: "0", noGravadas: "20000.50", motivo: "Libro físico", version: 0 });
    expect(llamada.headers["x-csrf-token"]).toBeTruthy();
    await vi.waitFor(() => expect(alGuardar).toHaveBeenCalledTimes(1));
  });

  it("montos en cero («sin operaciones») son válidos", async () => {
    const { f, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "0", e: "0", n: "0.00", m: "Antes del inicio de actividades" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    await vi.waitFor(() => expect(f.de(rutaMes(PERIODO))).toHaveLength(1));
  });

  it("montos con signo (notas de crédito) y espacios alrededor: se aceptan y se mandan recortados", async () => {
    const { f, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await llenar(usuario, d, { g: " -5000.50 ", e: "0", n: "100", m: "Más notas que ventas" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    await vi.waitFor(() => expect(f.de(rutaMes(PERIODO))).toHaveLength(1));
    expect((f.de(rutaMes(PERIODO))[0]!.body as Record<string, unknown>).gravadas).toBe("-5000.50");
  });

  it("un mes SIRE llega con los campos vacíos (no se copian los montos del SIRE)", async () => {
    montar(mesSireDe(PERIODO));
    const d = await dialogo();
    expect(campo(d, M.campos.gravadas).value).toBe("");
    expect(campo(d, M.campos.motivo).value).toBe("");
  });

  it("un mes manual llega con sus montos y manda su versión vigente; el motivo parte vacío", async () => {
    const mes = mesManualDe(PERIODO, { gravadas: "100000.00", exportaciones: "5.00", noGravadas: "20000.00", versionManual: 2 });
    const { f, usuario } = montar(mes, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    expect(campo(d, M.campos.gravadas).value).toBe("100000.00");
    expect(campo(d, M.campos.exportaciones).value).toBe("5.00");
    expect(campo(d, M.campos.noGravadas).value).toBe("20000.00");
    expect(campo(d, M.campos.motivo).value).toBe("");
    expect(d.textContent).not.toContain(MOTIVO_MANUAL);

    await llenar(usuario, d, { g: "110000.00", m: "Corrección de la factura F001-10" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    await vi.waitFor(() => expect(f.de(rutaMes(PERIODO))).toHaveLength(1));
    expect((f.de(rutaMes(PERIODO))[0]!.body as Record<string, unknown>).version).toBe(2);
  });
});

describe("<MesManual /> · validación local (D-8)", () => {
  it.each(["12.345", "1e3", "abc", "1.000,50", "--5", "5-", ""])("monto %j: mensaje junto al campo y nada se manda", async (malo) => {
    const { f, alGuardar, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await llenar(usuario, d, { g: malo, e: "0", n: "0", m: "Motivo" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    expect(await within(d).findByText(M.montoInvalido)).toBeTruthy();
    await asentar();
    expect(f.de(rutaMes(PERIODO))).toHaveLength(0);
    expect(alGuardar).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("motivo %j: obligatorio y nada se manda", async (vacio) => {
    const { f, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "1", e: "0", n: "0" });
    if (vacio) await usuario.type(campo(d, M.campos.motivo), vacio);
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    expect(await within(d).findByText(M.motivoObligatorio)).toBeTruthy();
    await asentar();
    expect(f.de(rutaMes(PERIODO))).toHaveLength(0);
  });

  it("motivo de 501 caracteres: mensaje y nada se manda; con 500 sí", async () => {
    const { f, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "1", e: "0", n: "0" });
    const m = campo(d, M.campos.motivo);
    await usuario.click(m);
    await usuario.paste("x".repeat(501));
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    expect(await within(d).findByText(M.motivoLargo)).toBeTruthy();
    expect(f.de(rutaMes(PERIODO))).toHaveLength(0);

    await usuario.clear(m);
    await usuario.click(m);
    await usuario.paste("x".repeat(500));
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    await vi.waitFor(() => expect(f.de(rutaMes(PERIODO))).toHaveLength(1));
  });
});

describe("<MesManual /> · errores del servidor (CA-4, CA-9)", () => {
  it.each([
    ["mes_cambiado", M.errores.mes_cambiado],
    ["mes_declarado", M.errores.mes_declarado],
    ["cliente_archivado", M.errores.cliente_archivado],
  ])("409 %s: alerta en español, sin el código; el diálogo sigue abierto", async (codigo, texto) => {
    const { alGuardar, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: { status: 409, cuerpo: { codigo } } } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "1", e: "0", n: "0", m: "Motivo" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));

    const alerta = await within(d).findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(alGuardar).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("403: el mensaje genérico de permiso", async () => {
    const { usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "1", e: "0", n: "0", m: "Motivo" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    expect((await within(d).findByRole("alert")).textContent).toContain(M.sinPermiso);
  });

  it("no revela montos ni motivo en ningún texto de error", async () => {
    const { usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: { status: 409, cuerpo: { codigo: "mes_cambiado" } } } });
    const d = await dialogo();
    await llenar(usuario, d, { g: "123456.78", e: "0", n: "0", m: "CANARIO-MOTIVO" });
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));
    const alerta = await within(d).findByRole("alert");
    expect(alerta.textContent).not.toContain("123456.78");
    expect(alerta.textContent).not.toContain("CANARIO-MOTIVO");
  });
});

describe("<MesManual /> · eliminar el mes manual (CA-4)", () => {
  it("un mes que no es manual no ofrece eliminar", async () => {
    montar(mesFaltaDe(PERIODO));
    const d = await dialogo();
    expect(within(d).queryByRole("button", { name: M.eliminarManual })).toBeNull();
  });

  it("pide motivo, confirma y manda {motivo, version}", async () => {
    const { f, alGuardar, usuario } = montar(mesManualDe(PERIODO, { versionManual: 3 }), {
      extra: { [rutaEliminarMes(PERIODO)]: { status: 200, cuerpo: { version: 4 } } },
    });
    const d = await dialogo();
    await usuario.click(within(d).getByRole("button", { name: M.eliminarManual }));
    await llenar(usuario, d, { m: "Ya llegó el PDT" });
    await usuario.click(within(d).getByRole("button", { name: M.confirmarEliminar }));

    await vi.waitFor(() => expect(f.de(rutaEliminarMes(PERIODO))).toHaveLength(1));
    expect(f.de(rutaEliminarMes(PERIODO))[0]!.body).toEqual({ motivo: "Ya llegó el PDT", version: 3 });
    expect(f.de(rutaMes(PERIODO))).toHaveLength(0);
    await vi.waitFor(() => expect(alGuardar).toHaveBeenCalledTimes(1));
  });

  it("sin motivo no elimina", async () => {
    const { f, usuario } = montar(mesManualDe(PERIODO), {
      extra: { [rutaEliminarMes(PERIODO)]: { status: 200, cuerpo: { version: 4 } } },
    });
    const d = await dialogo();
    await usuario.click(within(d).getByRole("button", { name: M.eliminarManual }));
    await usuario.click(within(d).getByRole("button", { name: M.confirmarEliminar }));
    expect(await within(d).findByText(M.motivoObligatorio)).toBeTruthy();
    expect(f.de(rutaEliminarMes(PERIODO))).toHaveLength(0);
  });

  it("409 mes_cambiado al eliminar: alerta en español", async () => {
    const { usuario } = montar(mesManualDe(PERIODO), {
      extra: { [rutaEliminarMes(PERIODO)]: { status: 409, cuerpo: { codigo: "mes_cambiado" } } },
    });
    const d = await dialogo();
    await usuario.click(within(d).getByRole("button", { name: M.eliminarManual }));
    await llenar(usuario, d, { m: "Ya llegó el PDT" });
    await usuario.click(within(d).getByRole("button", { name: M.confirmarEliminar }));
    expect((await within(d).findByRole("alert")).textContent).toContain(M.errores.mes_cambiado);
  });
});

describe("<MesManual /> · cancelar y 390 px", () => {
  it("«Cancelar» cierra sin llamar a la API", async () => {
    const { f, alCerrar, usuario } = montar(undefined, { extra: { [rutaMes(PERIODO)]: OK } });
    const d = await dialogo();
    await usuario.click(within(d).getByRole("button", { name: M.cancelar }));
    expect(alCerrar).toHaveBeenCalledTimes(1);
    expect(f.de(rutaMes(PERIODO))).toHaveLength(0);
  });

  it("el diálogo no fija anchos mayores a la pantalla ni scroll interior", async () => {
    montar(mesManualDe(PERIODO));
    const d = await dialogo();
    expect(anchosFijosMayoresA390(d)).toEqual([]);
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fechaHoraLima } from "../../lib/fechas";
import { reiniciarSesion } from "../../lib/sesion";
import { TEXTO_HOSTIL } from "../../pruebas/compras";
import {
  AUTOR_MANUAL,
  MENSAJES_PRORRATA as M,
  anchosFijosMayoresA390,
  historialDe,
  instalarFetchProrrata,
  rutaHistorial,
} from "../../pruebas/prorrata";
import { HistorialMes } from "./historial-mes";

// Spec 026 · T7 (rojo; CA-3, CA-4, D-4, R-5). Historial de un mes: presentaciones del PDT 621 y versiones del manual.
// Contrato (T13), `components/prorrata/historial-mes.tsx`: <HistorialMes clienteId="c-1" periodo="202511" alCerrar={() => void} />
//   - Lee GET /api/clientes/:id/prorrata/meses/:periodo/historial ({declaraciones, manual}) y lo muestra en un `Dialog`
//     (role dialog, nombre M.tituloHistorial(periodo)) con botón M.cerrar.
//   - Tabla M.tablaDeclaraciones: una fila por presentación en el orden recibido, con número de orden, tipo
//     (M.tipoDeclaracion) y los tres montos tal como llegan, fecha de presentación y prorrata usada si trae.
//   - Tabla M.tablaVersiones: una fila por versión del manual en el orden recibido, con versión, acción
//     (M.accionManual), motivo (como texto), autor y fecha-hora de Lima; las versiones «eliminado» muestran «—» en los montos.
//   - Sin nada: M.sinHistorial. 404 → M.noEncontrado (role alert). Otro error → M.errorCarga.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERIODO = "202602";
const dec = (o: Partial<ReturnType<typeof historialDe>["declaraciones"][number]> = {}) => ({
  numeroOrden: "7654321",
  fechaPresentacion: "2026-03-12",
  tipo: "original" as const,
  gravadas: "100000.00",
  exportaciones: "0.00",
  noGravadas: "20000.00",
  prorrataUsada: null,
  obtenidaEn: "2026-11-22T15:00:00.000Z",
  ...o,
});
const ver = (o: Partial<ReturnType<typeof historialDe>["manual"][number]> = {}) => ({
  version: 1,
  accion: "guardado" as const,
  montos: { gravadas: "90000.00", exportaciones: "0.00", noGravadas: "10000.00" },
  motivo: "Libro físico",
  autor: AUTOR_MANUAL,
  en: "2026-11-20T15:30:00.000Z",
  ...o,
});

function montar(historial: unknown, status = 200) {
  const f = instalarFetchProrrata({ extra: { [rutaHistorial(PERIODO)]: { status, cuerpo: historial } } });
  const alCerrar = vi.fn();
  const r = render(<HistorialMes clienteId="c-1" periodo={PERIODO} alCerrar={alCerrar} />);
  return { f, alCerrar, r, usuario: userEvent.setup() };
}
const dialogo = () => screen.findByRole("dialog", { name: M.tituloHistorial(PERIODO) });
const filasDe = async (d: HTMLElement, tabla: string) =>
  within(await within(d).findByRole("table", { name: tabla }))
    .getAllByRole("row")
    .filter((f) => f.querySelector("td, [role=cell]"));

describe("<HistorialMes /> · presentaciones del PDT 621 (CA-3)", () => {
  it("lista la original y la rectificatoria sin borrar la original, en el orden recibido", async () => {
    const { f } = montar(
      historialDe({
        declaraciones: [
          dec({ numeroOrden: "7654399", tipo: "rectificatoria", gravadas: "105000.00", fechaPresentacion: "2026-03-20", prorrataUsada: "83.34" }),
          dec(),
        ],
      }),
    );
    const d = await dialogo();
    const filas = await filasDe(d, M.tablaDeclaraciones);
    expect(f.de(rutaHistorial(PERIODO))).toHaveLength(1);
    expect(filas).toHaveLength(2);
    expect(filas[0]!.textContent).toContain("7654399");
    expect(filas[0]!.textContent).toContain(M.tipoDeclaracion.rectificatoria);
    expect(filas[0]!.textContent).toContain("105000.00");
    expect(filas[0]!.textContent).toContain("83,34 %");
    expect(filas[1]!.textContent).toContain("7654321");
    expect(filas[1]!.textContent).toContain(M.tipoDeclaracion.original);
    expect(filas[1]!.textContent).toContain("20000.00");
  });
});

describe("<HistorialMes /> · versiones del manual (CA-4)", () => {
  it("muestra todas las versiones con acción, motivo, autor y fecha de Lima; las eliminadas sin montos", async () => {
    montar(
      historialDe({
        manual: [
          ver({ version: 3, accion: "eliminado", montos: null, motivo: "Ya llegó el PDT", en: "2026-11-22T02:30:00.000Z" }),
          ver({ version: 2, motivo: "Corrección de la factura", montos: { gravadas: "95000.00", exportaciones: "1.00", noGravadas: "10000.00" } }),
          ver({ version: 1 }),
        ],
      }),
    );
    const d = await dialogo();
    const filas = await filasDe(d, M.tablaVersiones);
    expect(filas).toHaveLength(3);
    expect(filas[0]!.textContent).toContain(M.accionManual.eliminado);
    expect(filas[0]!.textContent).toContain("Ya llegó el PDT");
    expect(filas[0]!.textContent).toContain("—");
    expect(filas[0]!.textContent).not.toContain("0.00");
    // 02:30 UTC es la noche anterior en Lima.
    expect(filas[0]!.textContent).toContain(fechaHoraLima("2026-11-22T02:30:00.000Z"));
    expect(filas[0]!.textContent).toContain(AUTOR_MANUAL.nombre);
    expect(filas[1]!.textContent).toContain(M.accionManual.guardado);
    expect(filas[1]!.textContent).toContain("95000.00");
    expect(filas[1]!.textContent).toContain("Corrección de la factura");
    expect(filas[2]!.textContent).toContain("90000.00");
  });

  it("un motivo hostil se ve como texto: no se crea ningún elemento", async () => {
    const { r } = montar(historialDe({ manual: [ver({ motivo: TEXTO_HOSTIL })] }));
    const d = await dialogo();
    expect((await filasDe(d, M.tablaVersiones))[0]!.textContent).toContain(TEXTO_HOSTIL);
    expect(document.body.querySelector("img")).toBeNull();
    expect(r.container.querySelector("img")).toBeNull();
  });
});

describe("<HistorialMes /> · vacío, errores y cerrar", () => {
  it("sin presentaciones ni versiones: el mensaje de vacío", async () => {
    montar(historialDe());
    const d = await dialogo();
    expect(await within(d).findByText(M.sinHistorial)).toBeTruthy();
  });

  it("404: no se encontró, en una alerta y sin código", async () => {
    montar({ codigo: "no_encontrado" }, 404);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.noEncontrado);
    expect(alerta.textContent).not.toContain("no_encontrado");
  });

  it("500: mensaje de error de carga", async () => {
    montar({}, 500);
    expect((await screen.findByRole("alert")).textContent).toContain(M.errorCarga);
  });

  it("«Cerrar» llama a alCerrar", async () => {
    const { alCerrar, usuario } = montar(historialDe());
    const d = await dialogo();
    await usuario.click(within(d).getByRole("button", { name: M.cerrar }));
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("390 px: sin anchos fijos mayores a la pantalla", async () => {
    montar(historialDe({ declaraciones: [dec()], manual: [ver()] }));
    const d = await dialogo();
    await filasDe(d, M.tablaVersiones);
    expect(anchosFijosMayoresA390(d)).toEqual([]);
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

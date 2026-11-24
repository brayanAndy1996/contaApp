import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEXTO_HOSTIL } from "../../pruebas/compras";
import { celdas, fila } from "../../pruebas/acceso";
import {
  AUTOR_MANUAL,
  MENSAJES_PRORRATA as M,
  anchosFijosMayoresA390,
  mesDe,
  mesFaltaDe,
  mesManualDe,
  mesSireDe,
  ventanaDe,
  ventanaMixta,
} from "../../pruebas/prorrata";
import { TablaMeses } from "./tabla-meses";

// Spec 026 · T7 (rojo; CA-3, CA-4, CA-9, R-2b, R-5, D-8). Tabla mes a mes de la ventana de prorrata.
// Contrato (T13), `components/prorrata/tabla-meses.tsx`:
//   <TablaMeses meses={MesVista[12]} puedeGestionar={boolean} alIngresar={(periodo) => void} alHistorial={(periodo) => void} />
//   - <table> con nombre accesible M.tablaMeses y columnas M.columnas (Mes, Ventas gravadas, Exportaciones, Ventas no gravadas,
//     Total, Origen). Una fila por mes, con el periodo «AAAA-MM» y los montos tal como llegan (cadenas, con signo).
//   - Cada fila tiene `id="mes-AAAAMM"` (destino del enlace de los meses que faltan en <Coeficiente>).
//   - Origen por mes: M.origen.{declarado|rectificatoria|manual|sire|falta}; «Rectificatoria» cuando la declaración vigente lo es.
//   - Los avisos del mes (M.avisosMes) se escriben en texto dentro de la fila. Un mes manual muestra autor y motivo (como texto).
//   - Botón «Ingresar a mano AAAA-MM» (M.ingresarAMano) solo con `puedeGestionar` y solo en meses sin declaración (manual, SIRE,
//     falta); botón «Historial AAAA-MM» (M.historial) en las 12 filas, también sin permiso de gestión.
//   - A 390 px: tarjetas; sin anchos fijos ≥ 390 px ni `overflow-x-auto`.

afterEach(() => cleanup());

const mixta = () => ventanaMixta();
const montar = (meses = mixta(), puedeGestionar = true) => {
  const alIngresar = vi.fn();
  const alHistorial = vi.fn();
  const r = render(
    <TablaMeses meses={meses} puedeGestionar={puedeGestionar} alIngresar={alIngresar} alHistorial={alHistorial} />,
  );
  return { alIngresar, alHistorial, r, usuario: userEvent.setup() };
};

describe("<TablaMeses /> · estructura (R-1, R-2)", () => {
  it("tabla con nombre, columnas de M.columnas y una fila por mes en orden", () => {
    montar();
    const tabla = screen.getByRole("table", { name: M.tablaMeses });
    const encabezados = within(tabla).getAllByRole("columnheader").map((c) => c.textContent?.trim());
    for (const titulo of Object.values(M.columnas)) expect(encabezados).toContain(titulo);
    const periodos = ventanaDe("202610").map((p) => `${p.slice(0, 4)}-${p.slice(4)}`);
    const filas = within(tabla)
      .getAllByRole("row")
      .filter((f) => /\d{4}-\d{2}/.test(f.textContent ?? ""));
    expect(filas).toHaveLength(12);
    const orden = filas.map((f) => periodos.findIndex((p) => f.textContent?.includes(p)));
    expect(orden).toEqual([...orden].sort((a, b) => a - b));
  });

  it("muestra los montos del mes como llegan, con el signo", () => {
    const meses = ventanaDe("202610").map((p) => mesDe(p));
    meses[3] = mesDe("202602", {
      gravadas: "-5000.00",
      exportaciones: "250.50",
      noGravadas: "1000.00",
      total: "-3749.50",
    });
    montar(meses);
    const texto = celdas(fila("2026-02")).join("|");
    for (const monto of ["-5,000.00", "250.50", "1,000.00", "-3,749.50"]) expect(texto).toContain(monto);
    expect(celdas(fila("2025-11")).join("|")).toContain("100,000.00");
  });

  it("cada fila lleva id mes-AAAAMM (ancla de los meses que faltan)", () => {
    montar();
    for (const p of ventanaDe("202610")) expect(document.getElementById(`mes-${p}`)).not.toBeNull();
  });
});

describe("<TablaMeses /> · origen y avisos (CA-3, R-2b, R-5)", () => {
  it("cada mes sale con su origen: falta, manual, SIRE, rectificatoria y declarado", () => {
    montar();
    expect(fila("2025-11").textContent).toContain(M.origen.falta);
    expect(fila("2025-12").textContent).toContain(M.origen.manual);
    expect(fila("2026-01").textContent).toContain(M.origen.sire);
    expect(fila("2026-02").textContent).toContain(M.origen.rectificatoria);
    expect(fila("2026-03").textContent).toContain(M.origen.declarado);
  });

  it("un mes SIRE muestra el aviso de que el SIRE no separa exportaciones", () => {
    montar();
    expect(within(fila("2026-01")).getByText(M.avisosMes.sire_sin_exportaciones)).toBeTruthy();
  });

  it("un mes declarado con manual vivo debajo muestra «Reemplazado por la declaración»", () => {
    const meses = ventanaDe("202610").map((p) => mesDe(p));
    meses[1] = mesDe("202512", { avisos: ["manual_reemplazado"] });
    montar(meses);
    expect(within(fila("2025-12")).getByText(M.avisosMes.manual_reemplazado)).toBeTruthy();
  });

  it("USD sin tipo de cambio: aviso en el mes afectado y solo en ese", () => {
    const meses = ventanaDe("202610").map((p) => mesDe(p));
    meses[5] = mesSireDe("202604", { avisos: ["sire_sin_exportaciones", "usd_sin_tipo_cambio"] });
    montar(meses);
    expect(within(fila("2026-04")).getByText(M.avisosMes.usd_sin_tipo_cambio)).toBeTruthy();
    expect(screen.getAllByText(M.avisosMes.usd_sin_tipo_cambio)).toHaveLength(1);
  });

  it("un mes manual muestra autor y motivo", () => {
    montar();
    const f = fila("2025-12");
    expect(f.textContent).toContain(AUTOR_MANUAL.nombre);
    expect(f.textContent).toContain("Libro de ventas físico, mes sin PDT");
  });

  it("un motivo hostil se ve como texto: no se crea ningún elemento", () => {
    const meses = ventanaDe("202610").map((p) => mesDe(p));
    meses[1] = mesManualDe("202512", {
      manual: { motivo: TEXTO_HOSTIL, autor: AUTOR_MANUAL, guardadoEn: "2026-11-20T15:30:00.000Z" },
    });
    const { r } = montar(meses);
    expect(fila("2025-12").textContent).toContain(TEXTO_HOSTIL);
    expect(r.container.querySelector("img")).toBeNull();
  });
});

describe("<TablaMeses /> · acciones (CA-4, CA-9)", () => {
  it("«Ingresar a mano» solo en los meses sin declaración (manual, SIRE y falta) y con permiso", async () => {
    const { alIngresar, usuario } = montar();
    for (const p of ["202511", "202512", "202601"]) {
      expect(screen.getByRole("button", { name: M.ingresarAMano(p) })).toBeTruthy();
    }
    for (const p of ventanaDe("202610").filter((x) => !["202511", "202512", "202601"].includes(x))) {
      expect(screen.queryByRole("button", { name: M.ingresarAMano(p) })).toBeNull();
    }
    expect(screen.getAllByRole("button", { name: /^Ingresar a mano / })).toHaveLength(3);

    await usuario.click(screen.getByRole("button", { name: M.ingresarAMano("202511") }));
    expect(alIngresar).toHaveBeenCalledTimes(1);
    expect(alIngresar).toHaveBeenCalledWith("202511");
  });

  it("sin permiso de gestión no hay «Ingresar a mano» en ningún mes", () => {
    montar(mixta(), false);
    expect(screen.queryAllByRole("button", { name: /^Ingresar a mano / })).toHaveLength(0);
  });

  it("«Historial» está en los 12 meses, también sin permiso de gestión", async () => {
    const { alHistorial, usuario } = montar(mixta(), false);
    expect(screen.getAllByRole("button", { name: /^Historial / })).toHaveLength(12);
    await usuario.click(screen.getByRole("button", { name: M.historial("202602") }));
    expect(alHistorial).toHaveBeenCalledWith("202602");
  });

  it("todos los meses faltantes ofrecen ingresar a mano", () => {
    const meses = ventanaDe("202610").map((p) => mesFaltaDe(p));
    montar(meses);
    expect(screen.getAllByRole("button", { name: /^Ingresar a mano / })).toHaveLength(12);
  });
});

describe("<TablaMeses /> · 390 px", () => {
  it("sin anchos fijos mayores a la pantalla ni scroll horizontal interior", () => {
    const { r } = montar();
    expect(anchosFijosMayoresA390(r.container)).toEqual([]);
  });
});

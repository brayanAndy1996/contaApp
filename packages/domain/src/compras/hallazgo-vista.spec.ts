// Spec 014 · T15. Reconstrucción de destino, explicación y dato de un hallazgo guardado (D-4, D-15).
import { describe, expect, it } from "vitest";
import { detallarHallazgo, EXPLICACION_GENERICA } from "./index";

describe("detallarHallazgo", () => {
  it("R-ISC sin XML (San Juan): destino DG, explicación con la base, pide confirmación y no es masiva", () => {
    const d = detallarHallazgo({
      regla: "R-ISC",
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
      lecturas: { biDg: "770.00", igvDg: "0.00" },
      requiereConfirmacion: true,
    });
    expect(d).toEqual({ destino: "DG", explicacion: "Base gravada 770.00 con IGV 0: posible ISC", dato: null, masiva: false });
  });

  it("R-ISC respaldada por el XML: es masiva", () => {
    const d = detallarHallazgo({
      regla: "R-ISC",
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
      lecturas: { biDg: "770.00", igvDg: "0.00" },
      requiereConfirmacion: false,
    });
    expect(d.masiva).toBe(true);
    expect(d.dato).toBeNull();
  });

  it("R-MIX sin monto exacto pide el gravado; con exacto no pide nada y es masiva", () => {
    const sinExacto = detallarHallazgo({
      regla: "R-MIX",
      sugerencia: { tipo: "separar", columnaBi: "biDg", min: "8.97", max: "8.98", estimado: "8.97", exacto: null },
      lecturas: { biDg: "21.48", igvDg: "1.61" },
      requiereConfirmacion: true,
    });
    expect(sinExacto).toMatchObject({ destino: "DG", dato: "gravado", masiva: false });
    expect(sinExacto.explicacion).toContain("1.61");
    const conExacto = detallarHallazgo({
      regla: "R-MIX",
      sugerencia: { tipo: "separar", columnaBi: "biDg", min: "8.97", max: "8.98", estimado: "8.97", exacto: "8.97" },
      lecturas: { biDg: "21.48", igvDg: "1.61" },
      requiereConfirmacion: false,
    });
    expect(conExacto).toMatchObject({ dato: null, masiva: true });
  });

  it("R-MIX sin rango (sugerencia null) toma el destino de las lecturas", () => {
    const d = detallarHallazgo({ regla: "R-MIX", sugerencia: null, lecturas: { biDng: "10.00", igvDng: "5.00" }, requiereConfirmacion: true });
    expect(d).toMatchObject({ destino: "DNG", dato: null, masiva: false });
  });

  it("R-RED suma las columnas leídas y R-NEW pide el destino", () => {
    const red = detallarHallazgo({
      regla: "R-RED",
      sugerencia: { tipo: "ajustar", valores: { total: "119.00" } },
      lecturas: { biDg: "100.00", igvDg: "18.00", total: "120.00" },
      requiereConfirmacion: true,
    });
    expect(red.explicacion).toBe("La suma de componentes (118.00) no es igual al total (120.00): diferencia 2.00");
    expect(detallarHallazgo({ regla: "R-NEW", sugerencia: { tipo: "clasificar" }, lecturas: {}, requiereConfirmacion: true })).toMatchObject({
      dato: "destino",
      masiva: false,
    });
  });

  it("una regla desconocida o unas lecturas ilegibles dan la explicación genérica sin lanzar", () => {
    expect(detallarHallazgo({ regla: "R-XX", sugerencia: null, lecturas: {}, requiereConfirmacion: true }).explicacion).toBe(EXPLICACION_GENERICA);
    const d = detallarHallazgo({
      regla: "R-ISC",
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "1.00" },
      lecturas: { biDg: "no-es-monto" },
      requiereConfirmacion: true,
    });
    expect(d.explicacion).toBe(EXPLICACION_GENERICA);
  });
});

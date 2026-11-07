// Spec 013 · T20a (rojo), defecto D-1 de T20 (D24 del usuario, 2026-11-07): la vista pública de un trabajo
// (`vistaDeFila`, también el evento SSE que publica el despachador) lleva `periodo` (AAAAMM) SOLO para el tipo
// `sire.propuesta.descargar`, tomado de sus `parametros` ya validados. Ningún otro parámetro sale (ni `libro`, ni el RUC, ni
// el resultado), un parámetro ilegible no rompe la vista y los demás tipos siguen sin la clave. La fila puede traer
// `parametros` además de las columnas de hoy (`FilaEvento` los admite).
import { describe, expect, it } from "vitest";
import { eventoTrabajoSchema } from "@contapp/shared";
import { vistaDeFila } from "./eventos.js";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  clienteId: "00000000-0000-4000-8000-0000000000c1",
  intentos: 0,
  creadoPor: "00000000-0000-4000-8000-0000000000a1",
  creadoEn: new Date("2026-11-07T15:00:00.000Z"),
};
const cambio = { estado: "en_cola", motivo: null } as const;
const vista = (tipo: string, parametros: unknown) =>
  vistaDeFila({ ...base, tipo, parametros } as never, cambio) as unknown as Record<string, unknown>;

describe("vistaDeFila · periodo de la descarga (T20a, D24)", () => {
  it("la descarga lleva el periodo de sus parámetros y la vista cumple el esquema público", () => {
    const v = vista("sire.propuesta.descargar", { periodo: "202610", libro: "ventas" });
    expect(v["periodo"]).toBe("202610");
    expect(eventoTrabajoSchema.safeParse(v).success).toBe(true);
    expect(eventoTrabajoSchema.parse(v)).toHaveProperty("periodo", "202610");
  });

  it("también en compras (el tipo es el mismo): el periodo sale, el libro no", () => {
    const v = vista("sire.propuesta.descargar", { periodo: "202609", libro: "compras" });
    expect(v["periodo"]).toBe("202609");
    expect(JSON.stringify(v)).not.toMatch(/compras|libro/);
  });

  it("no expone ningún otro parámetro del trabajo", () => {
    const v = vista("sire.propuesta.descargar", { periodo: "202610", libro: "ventas", ruc: "20700000002", resultado: { x: 1 } });
    expect(Object.keys(v).sort()).toEqual(
      [
        "clienteId",
        "creadoEn",
        "creadoPor",
        "estado",
        "id",
        "intentos",
        "iniciadoEn",
        "motivo",
        "periodo",
        "posicion",
        "terminadoEn",
        "tipo",
      ].sort(),
    );
    expect(JSON.stringify(v)).not.toMatch(/20700000002|ventas|resultado/);
  });

  it.each([
    ["sin parámetros", undefined],
    ["parámetros nulos", null],
    ["periodo mal formado", { periodo: "2026-10", libro: "ventas" }],
    ["periodo con mes 13", { periodo: "202613", libro: "ventas" }],
    ["periodo numérico", { periodo: 202610, libro: "ventas" }],
    ["parámetros que no son un objeto", "202610"],
  ])("%s: la vista sigue siendo válida y no inventa un periodo", (_c, parametros) => {
    const v = vista("sire.propuesta.descargar", parametros);
    expect(v).not.toHaveProperty("periodo");
    expect(eventoTrabajoSchema.safeParse(v).success).toBe(true);
  });

  it.each(["credencial.verificar_sol", "cliente.consultar_ruc", "prueba.eco"])(
    "%s: nunca lleva periodo, aunque sus parámetros traigan uno",
    (tipo) => {
      expect(vista(tipo, { periodo: "202610" })).not.toHaveProperty("periodo");
    },
  );
});

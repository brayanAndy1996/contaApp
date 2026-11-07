import { describe, expect, it } from "vitest";
import { eventoTrabajoSchema, trabajoVistaSchema } from "./index.js";

// Spec 013 · T20a (rojo), defecto D-1 de T20 (D24 del usuario, 2026-11-07): para que el panel de trabajos muestre el
// periodo de una descarga de la propuesta del SIRE, la vista pública de un trabajo admite `periodo` (AAAAMM, mes 01 a 12)
// OPCIONAL: los demás tipos no lo traen y los trabajos anteriores tampoco. Sigue sin salir ningún otro parámetro del
// trabajo (RUC, `libro`, resultado, tenantId): `z.object` descarta las claves desconocidas.
const uuid = (n: number): string => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const vista = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid(1),
  tipo: "sire.propuesta.descargar",
  clienteId: uuid(2),
  estado: "en_cola",
  posicion: 1,
  intentos: 0,
  motivo: null,
  creadoEn: "2026-11-07T15:00:00.000Z",
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: { usuarioId: uuid(3) },
  ...extra,
});

describe("trabajoVistaSchema · periodo (T20a, D24)", () => {
  it.each(["202601", "202610", "202612", "199912"])("acepta el periodo %s y lo conserva", (periodo) => {
    const r = trabajoVistaSchema.safeParse(vista({ periodo }));
    expect(r.success).toBe(true);
    expect(r.data?.periodo).toBe(periodo);
  });

  it("el periodo es opcional: un trabajo sin él sigue siendo válido y no lo inventa", () => {
    const r = trabajoVistaSchema.safeParse(vista());
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("periodo");
  });

  it("acepta `periodo: null` (trabajo de otro tipo)", () => {
    expect(trabajoVistaSchema.safeParse(vista({ periodo: null })).success).toBe(true);
  });

  it.each(["2026-10", "20261", "2026100", "202600", "202613", "abcdef", "", " 202610", "202610\n", 202610, {}])(
    "rechaza el periodo %j",
    (periodo) => {
      expect(trabajoVistaSchema.safeParse(vista({ periodo })).success).toBe(false);
    },
  );

  it("el evento SSE (misma forma) también lo lleva", () => {
    const r = eventoTrabajoSchema.safeParse(vista({ periodo: "202610", estado: "completado" }));
    expect(r.success).toBe(true);
    expect(r.data?.periodo).toBe("202610");
  });

  it("sigue descartando los demás parámetros del trabajo", () => {
    const r = trabajoVistaSchema.safeParse(
      vista({ periodo: "202610", libro: "ventas", parametros: { periodo: "202610" }, ruc: "20700000002", resultado: {} }),
    );
    expect(r.success).toBe(true);
    expect(Object.keys(r.data ?? {}).sort()).toEqual(
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
  });
});

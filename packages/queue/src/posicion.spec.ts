import { describe, expect, it } from "vitest";
import { calcularPosicion } from "./posicion.js";

// Contrato (plan 008, Decisiones: "Posicion"; packages/queue/src/posicion.ts, exportada tambien desde
// el indice): calcularPosicion(objetivo, trabajos) -> number | null.
//  - posicion = 1 + cantidad de trabajos `en_cola` del MISMO estudio y MISMA cola que salen antes:
//    prioridad mayor (interactivo > programado) o, con la misma prioridad, `creadoEn` menor.
//  - `trabajos` puede incluir al propio objetivo (no se cuenta). Los de otro estudio, otra cola o
//    que no estan `en_cola` se ignoran (no se expone ni cuenta informacion de otros estudios).
//  - Si el objetivo no esta `en_cola` devuelve null (la vista solo muestra posicion en cola).
interface T {
  id: string;
  tenantId: string;
  cola: string;
  estado: string;
  prioridad: "interactivo" | "programado";
  creadoEn: Date;
}
const A = "0190a000-0000-7000-8000-0000000000a1";
const B = "0190a000-0000-7000-8000-0000000000a2";
let n = 0;
const t = (extra: Partial<T> = {}): T => {
  n++;
  return {
    id: `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
    tenantId: A,
    cola: "sire",
    estado: "en_cola",
    prioridad: "interactivo",
    creadoEn: new Date(Date.parse("2026-10-27T15:00:00.000Z") + n * 1000),
    ...extra,
  };
};

describe("calcularPosicion", () => {
  it("el unico trabajo en cola es el 1", () => {
    const x = t();
    expect(calcularPosicion(x, [x])).toBe(1);
  });

  it("cuenta los mas antiguos de la misma prioridad", () => {
    const [p1, p2, p3] = [t(), t(), t()] as [T, T, T];
    const todos = [p3, p1, p2]; // el orden del arreglo no importa
    expect(calcularPosicion(p1, todos)).toBe(1);
    expect(calcularPosicion(p2, todos)).toBe(2);
    expect(calcularPosicion(p3, todos)).toBe(3);
  });

  it("un interactivo posterior pasa delante de los programados mas antiguos", () => {
    const prog1 = t({ prioridad: "programado" });
    const prog2 = t({ prioridad: "programado" });
    const inter = t({ prioridad: "interactivo" }); // creado despues
    const todos = [prog1, prog2, inter];
    expect(calcularPosicion(inter, todos)).toBe(1);
    expect(calcularPosicion(prog1, todos)).toBe(2);
    expect(calcularPosicion(prog2, todos)).toBe(3);
  });

  it("un programado queda detras de todos los interactivos, aunque sea mas antiguo", () => {
    const prog = t({
      prioridad: "programado",
      creadoEn: new Date("2026-01-01T00:00:00Z"),
    });
    const inters = [t(), t(), t()];
    expect(calcularPosicion(prog, [prog, ...inters])).toBe(4);
  });

  it("ignora otros estudios y otras colas", () => {
    const x = t();
    const ruido = [
      t({ tenantId: B, creadoEn: new Date("2026-01-01T00:00:00Z") }),
      t({ tenantId: B, creadoEn: new Date("2026-01-02T00:00:00Z") }),
      t({ cola: "sol", creadoEn: new Date("2026-01-03T00:00:00Z") }),
    ];
    expect(calcularPosicion(x, [...ruido, x])).toBe(1);
  });

  it("ignora los que no estan en_cola", () => {
    const x = t();
    const otros = ["ejecutando", "completado", "error", "cancelado"].map(
      (estado) => t({ estado, creadoEn: new Date("2026-01-01T00:00:00Z") }),
    );
    expect(calcularPosicion(x, [...otros, x])).toBe(1);
  });

  it("si el objetivo no esta en cola devuelve null", () => {
    for (const estado of ["ejecutando", "completado", "error", "cancelado"]) {
      const x = t({ estado });
      expect(calcularPosicion(x, [x, t()])).toBeNull();
    }
  });

  it("no depende de que el objetivo venga en la lista", () => {
    const x = t();
    const y = t();
    expect(calcularPosicion(y, [x])).toBe(2);
  });
});

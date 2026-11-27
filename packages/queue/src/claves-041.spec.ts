// Spec 041 · T4 (rojo): clave Redis del ticket pendiente del SIRE (plan, «Decisiones»: Ticket P-4 c).
//
// CONTRATO que fija (T7), en packages/queue/src/claves.ts:
// - `crearClaves(prefijo).ticketSire(tenantId, clienteId, libro, periodo, operacion)` =
//   `${prefijo}sire:ticket:${tenantId}:${clienteId}:${libro}:${periodo}:${operacion}` (misma convención que `tokenSire`).
// - `operacion` es `"propuesta"` (descarga de propuesta, 013) o `"registro"` (registro presentado, 025).
// - La clave incluye estudio Y cliente: dos estudios con el mismo cliente RUC nunca comparten ticket (plan, Riesgos).
import { describe, expect, it } from "vitest";
import { crearClaves, type ClavesCola } from "./index.js";
import { PREFIJO_POR_DEFECTO } from "./tipos.js";

type LibroSire = "compras" | "ventas";
type OperacionSire = "propuesta" | "registro";
type ClavesConTicket = ClavesCola & {
  ticketSire(
    tenantId: string,
    clienteId: string,
    libro: LibroSire,
    periodo: string,
    operacion: OperacionSire,
  ): string;
};

const T1 = "0190a000-0000-7000-8000-0000000000a1";
const T2 = "0190a000-0000-7000-8000-0000000000a2";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const C2 = "0190a000-0000-7000-8000-0000000000c2";

const claves = (prefijo?: string) => crearClaves(prefijo) as ClavesConTicket;

describe("claves.ticketSire (041, CA-8)", () => {
  it("formato fijo: prefijo + sire:ticket + estudio, cliente, libro, periodo y operación", () => {
    expect(claves("x:").ticketSire(T1, C1, "compras", "202610", "propuesta")).toBe(
      `x:sire:ticket:${T1}:${C1}:compras:202610:propuesta`,
    );
    expect(claves("x:").ticketSire(T1, C1, "ventas", "202610", "registro")).toBe(
      `x:sire:ticket:${T1}:${C1}:ventas:202610:registro`,
    );
  });

  it("sin prefijo usa el prefijo por defecto", () => {
    expect(claves().ticketSire(T1, C1, "ventas", "202610", "propuesta")).toBe(
      `${PREFIJO_POR_DEFECTO}sire:ticket:${T1}:${C1}:ventas:202610:propuesta`,
    );
  });

  it("estudio distinto con el mismo cliente → clave distinta (nunca se comparte un ticket entre estudios)", () => {
    const k = claves("p:");
    expect(k.ticketSire(T1, C1, "ventas", "202610", "propuesta")).not.toBe(
      k.ticketSire(T2, C1, "ventas", "202610", "propuesta"),
    );
  });

  it("cliente, libro, periodo y operación distintos → claves distintas", () => {
    const k = claves("p:");
    const base = k.ticketSire(T1, C1, "ventas", "202610", "propuesta");
    const otras = [
      k.ticketSire(T1, C2, "ventas", "202610", "propuesta"),
      k.ticketSire(T1, C1, "compras", "202610", "propuesta"),
      k.ticketSire(T1, C1, "ventas", "202611", "propuesta"),
      k.ticketSire(T1, C1, "ventas", "202610", "registro"),
    ];
    expect(new Set([base, ...otras]).size).toBe(5);
  });

  it("prefijos distintos no se pisan y no choca con la clave del token", () => {
    const a = claves("a:");
    const b = claves("b:");
    expect(a.ticketSire(T1, C1, "ventas", "202610", "propuesta")).not.toBe(
      b.ticketSire(T1, C1, "ventas", "202610", "propuesta"),
    );
    expect(a.ticketSire(T1, C1, "ventas", "202610", "propuesta")).not.toBe(
      a.tokenSire("p1", T1, C1),
    );
  });

  it("es pura: la misma entrada da la misma clave", () => {
    const k = claves("p:");
    expect(k.ticketSire(T1, C1, "compras", "202610", "registro")).toBe(
      k.ticketSire(T1, C1, "compras", "202610", "registro"),
    );
  });
});

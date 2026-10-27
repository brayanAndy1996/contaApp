import type { KeyWrapper } from "@contapp/crypto";
import {
  RotacionConMockError,
  crearKeyUnwrapper,
  type KeyUnwrapper,
} from "@contapp/crypto/descifrado";
import { describe, expect, it } from "vitest";
import { dbProhibido, rechazo, uuid } from "../../test/soporte.js";
import { rotarKekTenant } from "./rotar-kek.js";

// Validaciones de `rotarKekTenant` que deben ocurrir ANTES de tocar la BD (spec 003, CA-6; plan: Rotacion).
// Contrato para T12: ante argumentos invalidos la funcion rechaza sin abrir `withTenant`; nunca devuelve
// un conteo parcial. La rotacion con BD real esta en rotar-kek.int.spec.ts.

type Activa = KeyUnwrapper & KeyWrapper;

const anterior = (kekId = "k1"): KeyUnwrapper => ({
  kekId,
  unwrap: () => Promise.reject(new Error("no debia usarse")),
  verificar: () => Promise.resolve(),
});
const activa = (kekId = "k2"): Activa => ({
  kekId,
  unwrap: () => Promise.reject(new Error("no debia usarse")),
  wrap: () => Promise.reject(new Error("no debia usarse")),
  verificar: () => Promise.resolve(),
});

function llamar(o: Partial<Parameters<typeof rotarKekTenant>[0]>) {
  const prohibido = dbProhibido();
  const args = {
    db: prohibido.db as never,
    anterior: anterior(),
    activa: activa(),
    tenantId: uuid(),
    desde: "k1",
    lote: 10,
    ...o,
  } as Parameters<typeof rotarKekTenant>[0];
  return { promesa: () => rotarKekTenant(args), usos: prohibido.usos };
}

describe("rotarKekTenant: argumentos invalidos (sin tocar la BD)", () => {
  it("rechaza `desde` igual a la KEK activa", async () => {
    const t = llamar({ desde: "k2", anterior: anterior("k2") });
    await rechazo(t.promesa);
    expect(t.usos()).toBe(0);
  });

  it("rechaza `desde` distinto del kekId del unwrapper anterior (no se re-envuelve con la llave equivocada)", async () => {
    const t = llamar({ desde: "k9", anterior: anterior("k1") });
    await rechazo(t.promesa);
    expect(t.usos()).toBe(0);
  });

  it.each([
    ["vacio", ""],
    ["con mayusculas", "K1"],
    ["con ruta", "../k1"],
    ["con espacios", "k 1"],
    ["de 64 caracteres", "a".repeat(64)],
  ])("rechaza `desde` mal formado (%s)", async (_n, desde) => {
    const t = llamar({ desde, anterior: anterior(desde) });
    await rechazo(t.promesa);
    expect(t.usos()).toBe(0);
  });

  it.each([
    ["no es UUID", "no-es-uuid"],
    ["vacio", ""],
    ["con comillas", `${uuid()}' or '1'='1`],
  ])("rechaza tenantId invalido (%s)", async (_n, tenantId) => {
    const t = llamar({ tenantId });
    await rechazo(t.promesa);
    expect(t.usos()).toBe(0);
  });

  it.each([
    ["cero", 0],
    ["negativo", -1],
    ["fraccion", 1.5],
    ["NaN", Number.NaN],
    ["infinito", Number.POSITIVE_INFINITY],
    ["cadena", "10" as unknown as number],
  ])("rechaza lote invalido (%s)", async (_n, lote) => {
    const t = llamar({ lote });
    await rechazo(t.promesa);
    expect(t.usos()).toBe(0);
  });

  // T15 · F1: la llave mock (privada en el repo) nunca participa en una rotación.
  it("rechaza la KEK activa mock con RotacionConMockError", async () => {
    const t = llamar({ activa: crearKeyUnwrapper({ KEY_PROVIDER: "mock", NODE_ENV: "test" }) });
    await expect(t.promesa()).rejects.toBeInstanceOf(RotacionConMockError);
    expect(t.usos()).toBe(0);
  });

  it("rechaza una llave anterior que dice ser mock", async () => {
    const t = llamar({ desde: "mock", anterior: anterior("mock") });
    await expect(t.promesa()).rejects.toBeInstanceOf(RotacionConMockError);
    expect(t.usos()).toBe(0);
  });
});

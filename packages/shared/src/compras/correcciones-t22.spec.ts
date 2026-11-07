// Spec 014 T22a · M-1 (rojo hasta T22b): la lista cerrada de códigos de rechazo de una masiva (`CODIGOS_RECHAZO_MASIVA`) debe
// incluir `solicitud_invalida` (D-15, T22: un cambio de destino cuya suma no cabe en NUMERIC(14,2)). Hoy `transformar.ts` lo
// devuelve y el informe incumple su esquema, así que 015 rechazaría la respuesta al validarla.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CODIGOS_RECHAZO_MASIVA, informeMasivaSchema } from "./index.js";

/** Los códigos que escribe D-15 de la spec, en su orden. */
const CODIGOS_D15 = [
  "version_obsoleta",
  "requiere_dato",
  "revisar_de_nuevo",
  "fila_excluida",
  "no_excluida",
  "no_masiva",
  "solicitud_invalida",
  "no_encontrada",
];

describe("M-1 · códigos de rechazo de una masiva (D-15)", () => {
  it("la lista cerrada contiene solicitud_invalida", () => {
    expect([...CODIGOS_RECHAZO_MASIVA]).toContain("solicitud_invalida");
  });

  it("la lista cerrada es exactamente la de D-15", () => {
    expect([...CODIGOS_RECHAZO_MASIVA].sort()).toEqual([...CODIGOS_D15].sort());
  });

  it("un informe con una fila rechazada por solicitud_invalida pasa informeMasivaSchema", () => {
    const informe = {
      operacionId: randomUUID(),
      aplicadas: 1,
      rechazadas: [{ compraId: randomUUID(), codigo: "solicitud_invalida" }],
    };
    expect(informeMasivaSchema.safeParse(informe).success).toBe(true);
  });

  it("cada código de D-15 pasa el esquema y uno fuera de la lista sigue rechazado", () => {
    for (const codigo of CODIGOS_D15) {
      const r = informeMasivaSchema.safeParse({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: randomUUID(), codigo }] });
      expect(r.success, codigo).toBe(true);
    }
    const ajeno = informeMasivaSchema.safeParse({ operacionId: null, aplicadas: 0, rechazadas: [{ compraId: randomUUID(), codigo: "otro_codigo" }] });
    expect(ajeno.success).toBe(false);
  });
});

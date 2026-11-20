// Spec 023 (T11, decisión del orquestador sobre el punto 2 de T4): «Revisar ahora» antes del primer ciclo. El backend no tiene
// INSERT en buzon_estado_cliente: `bloquearEstadoBuzon` llama a la función acotada buzon_estado_bloquear (0055), que crea la fila
// si falta y la bloquea FOR UPDATE antes de tocar el trabajo (orden estado -> trabajo). Sin BD; la prueba con BD real está en
// tests/aislamiento/buzon-estado-bloquear.spec.ts.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import { bloquearEstadoBuzon } from "./lectura";

const C = "0190a000-0000-7000-8000-0000000000c1";

describe("bloquearEstadoBuzon", () => {
  it("llama a buzon_estado_bloquear($1::uuid) y devuelve el estado (recién creado: todo null)", async () => {
    const { tx, llamadas } = txFalso({
      rows: [
        {
          ultima_programada_en: null,
          ultima_solicitud_en: null,
          ultima_captura_en: null,
          sincronizado_en: null,
          cursor_pendiente: null,
        },
      ],
    });
    expect(await bloquearEstadoBuzon(tx, C)).toEqual({
      ultimaProgramadaEn: null,
      ultimaSolicitudEn: null,
      ultimaCapturaEn: null,
      sincronizadoEn: null,
      cursorPendiente: null,
    });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/buzon_estado_bloquear\(\$1::uuid\)/);
    expect(llamadas[0]!.valores).toEqual([C]);
  });

  it("devuelve las fechas del estado existente", async () => {
    const f = new Date("2026-11-17T06:00:00Z");
    const { tx } = txFalso({
      rows: [
        {
          ultima_programada_en: f,
          ultima_solicitud_en: f,
          ultima_captura_en: null,
          sincronizado_en: null,
          cursor_pendiente: "c-2",
        },
      ],
    });
    expect(await bloquearEstadoBuzon(tx, C)).toMatchObject({
      ultimaProgramadaEn: f,
      ultimaSolicitudEn: f,
      cursorPendiente: "c-2",
    });
  });

  it("cliente de otro estudio o inexistente (23503) y sin fila sale como BuzonRepoError sin filtrar el error de pg", async () => {
    const e = await bloquearEstadoBuzon(txFalso(errorPg("23503")).tx, C).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("23503");
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("CANARIO");
    const vacio = await bloquearEstadoBuzon(txFalso({ rows: [] }).tx, C).catch(
      (x: unknown) => x,
    );
    expect((vacio as BuzonRepoError).codigo).toBe("P0002");
  });
});

// Spec 023 (P-6): «Revisar ahora» fija ultima_solicitud_en en el estado del cliente. Sin BD (tx falso). El backend solo tiene
// UPDATE de esa columna (0054); la fila ya existe porque bloquearEstadoBuzon la crea y la bloquea antes en la misma transacción.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import { fallaPorCredencialBuzon, marcarSolicitudBuzon } from "./solicitud";

const C = "0190a000-0000-7000-8000-0000000000c1";

describe("marcarSolicitudBuzon", () => {
  it("actualiza solo ultima_solicitud_en del cliente, con el id como parámetro", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await marcarSolicitudBuzon(tx, C);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(
      /update buzon_estado_cliente set ultima_solicitud_en = now\(\) where cliente_id = \$1::uuid/,
    );
    expect(llamadas[0]!.valores).toEqual([C]);
  });

  it("sin fila de estado (0 filas actualizadas) falla con BuzonRepoError P0002", async () => {
    const { tx } = txFalso({ rowCount: 0 });
    await expect(marcarSolicitudBuzon(tx, C)).rejects.toMatchObject({
      name: "BuzonRepoError",
      codigo: "P0002",
    });
  });

  it("un fallo de pg sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const { tx } = txFalso(errorPg("42501"));
    const e = await marcarSolicitudBuzon(tx, C).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect(JSON.stringify(e)).not.toContain("CANARIO");
    expect((e as Error).message).not.toContain("CANARIO");
  });
});

describe("fallaPorCredencialBuzon", () => {
  it("devuelve cuándo terminó la última captura si fue error por credencial inválida; el cliente va como parámetro", async () => {
    const fin = new Date("2026-11-17T15:00:00Z");
    const { tx, llamadas } = txFalso({
      rows: [{ estado: "error", motivo: "credencial_invalida", terminado_en: fin }],
    });
    expect(await fallaPorCredencialBuzon(tx, C)).toEqual(fin);
    expect(llamadas[0]!.texto).toMatch(/tipo = 'sol\.buzon\.revisar'/);
    expect(llamadas[0]!.valores).toEqual([C]);
  });

  it("si terminado_en no llega como Date (string ISO), lo devuelve como Date con el mismo instante", async () => {
    const { tx } = txFalso({
      rows: [
        { estado: "error", motivo: "credencial_invalida", terminado_en: "2026-11-17T15:00:00.000Z" },
      ],
    });
    const r = await fallaPorCredencialBuzon(tx, C);
    expect(r).toBeInstanceOf(Date);
    expect(r).toEqual(new Date("2026-11-17T15:00:00Z"));
  });

  it("un string con desfase horario (formato texto de pg) se convierte al mismo instante", async () => {
    const { tx } = txFalso({
      rows: [
        { estado: "error", motivo: "credencial_invalida", terminado_en: "2026-11-17 10:00:00-05" },
      ],
    });
    const r = await fallaPorCredencialBuzon(tx, C);
    expect(r).toBeInstanceOf(Date);
    expect(r!.getTime()).toBe(Date.parse("2026-11-17T15:00:00Z"));
  });

  it.each([
    [[]],
    [[{ estado: "completado", motivo: null, terminado_en: new Date() }]],
    [[{ estado: "error", motivo: "sunat_no_responde", terminado_en: new Date() }]],
  ])("sin capturas terminadas o terminada de otro modo: null", async (rows) => {
    const { tx } = txFalso({ rows });
    expect(await fallaPorCredencialBuzon(tx, C)).toBeNull();
  });

  it("un fallo de pg sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const { tx } = txFalso(errorPg("42501"));
    const e = await fallaPorCredencialBuzon(tx, C).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as Error).message).not.toContain("CANARIO");
  });
});

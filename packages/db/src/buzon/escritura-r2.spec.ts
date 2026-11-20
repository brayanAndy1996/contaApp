// Spec 023 (T21, sin BD): repos que agrega la corrección de la ronda 2. La prueba con BD real está en las suites del worker
// (buzon-r2.int.spec.ts): marca de relleno antes del primer nuevo (H-023-2-1) y reloj de la BD para el aviso (H-023-2-4).
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import { marcarRellenoBuzon, relojBdBuzon } from "./escritura";

const C = "0190a000-0000-7000-8000-0000000000c1";

describe("marcarRellenoBuzon", () => {
  it("crea o completa el estado sin pisar un cursor ya guardado; los valores viajan como parámetros", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await marcarRellenoBuzon(tx, C, "relleno");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/insert into buzon_estado_cliente/i);
    expect(llamadas[0]!.texto).toMatch(
      /coalesce\(buzon_estado_cliente\.cursor_pendiente, excluded\.cursor_pendiente\)/,
    );
    expect(llamadas[0]!.valores).toEqual([C, "relleno"]);
  });

  it("un error de pg sale como BuzonRepoError con solo el SQLSTATE", async () => {
    const e = await marcarRellenoBuzon(txFalso(errorPg("42501")).tx, C, "x").catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
  });
});

describe("relojBdBuzon", () => {
  it("devuelve clock_timestamp() de la BD, como Date o como texto", async () => {
    const f = new Date("2026-11-18T05:00:00Z");
    const a = txFalso({ rows: [{ ahora: f }] });
    expect(await relojBdBuzon(a.tx)).toEqual(f);
    expect(a.llamadas[0]!.texto).toMatch(/clock_timestamp\(\)/);
    const b = txFalso({ rows: [{ ahora: "2026-11-18T05:00:00Z" }] });
    expect(await relojBdBuzon(b.tx)).toEqual(f);
  });

  it("sin fila o con un valor ilegible, BuzonRepoError (nunca el reloj del proceso)", async () => {
    for (const rows of [[], [{ ahora: "no es fecha" }]]) {
      const e = await relojBdBuzon(txFalso({ rows }).tx).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(BuzonRepoError);
    }
    const pg = await relojBdBuzon(txFalso(errorPg("57P01")).tx).catch(
      (x: unknown) => x,
    );
    expect((pg as BuzonRepoError).codigo).toBe("57P01");
  });
});

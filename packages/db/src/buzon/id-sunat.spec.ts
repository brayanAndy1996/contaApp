// Spec 023: lectura del id de SUNAT del mensaje (solo worker; el backend no la expone), sin BD.
import { describe, expect, it } from "vitest";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { BuzonRepoError } from "./errores";
import { leerIdSunatBuzon } from "./id-sunat";

const C = "0190a000-0000-7000-8000-0000000000c1";
const M = "0190a000-0000-7000-8000-0000000000b1";

describe("leerIdSunatBuzon", () => {
  it("devuelve el id de SUNAT filtrando por cliente y mensaje a la vez", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ id_sunat: "MSG-9001" }] });
    expect(await leerIdSunatBuzon(tx, C, M)).toBe("MSG-9001");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.texto).toMatch(/cliente_id\s*=\s*\$1/);
    expect(llamadas[0]!.valores).toEqual([C, M]);
  });

  it("devuelve null si el mensaje es de otro cliente o no existe", async () => {
    expect(await leerIdSunatBuzon(txFalso({ rows: [] }).tx, C, M)).toBeNull();
  });

  it("un error de pg sale como BuzonRepoError solo con el SQLSTATE", async () => {
    const e = await leerIdSunatBuzon(
      txFalso(errorPg("42501")).tx,
      C,
      M,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuzonRepoError);
    expect((e as BuzonRepoError).codigo).toBe("42501");
    expect(String((e as Error).message)).not.toContain("CANARIO");
  });
});

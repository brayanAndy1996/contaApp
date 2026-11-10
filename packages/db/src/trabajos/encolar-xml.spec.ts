// Spec 016 (T12b): `encolarLoteXml` sin BD. Llama a la función acotada de 0037 con los parámetros tipados y relee la vista.
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "./errores";
import { encolarLoteXml } from "./registro";
import { errorPg, FILA, txFalso } from "./soporte-prueba";

const LOTE = {
  clienteId: FILA.cliente_id,
  periodo: "202406",
  compraIds: ["00000000-0000-4000-8000-000000000001"],
  creadoPor: null,
};

describe("encolarLoteXml", () => {
  it("llama a encolar_xml_obtener con $1..$4 y devuelve la vista del trabajo y si es nuevo", async () => {
    const { tx, llamadas } = txFalso(
      { rows: [{ id: FILA.id, nuevo: true }] },
      { rows: [{ ...FILA, tipo: "xml.obtener" }] },
    );
    const r = await encolarLoteXml(tx, LOTE);
    expect(r.nuevo).toBe(true);
    expect(r.trabajo).toMatchObject({
      id: FILA.id,
      tipo: "xml.obtener",
      estado: "en_cola",
    });
    expect(llamadas[0]!.texto).toMatch(
      /public\.encolar_xml_obtener\(\$1::uuid, \$2::text, \$3::uuid\[\], \$4::uuid\)/,
    );
    expect(llamadas[0]!.valores).toEqual([
      LOTE.clienteId,
      "202406",
      LOTE.compraIds,
      null,
    ]);
    expect(llamadas[1]!.valores).toEqual([FILA.id]);
  });

  it("el vivo con la misma clave sale con nuevo = false", async () => {
    const { tx } = txFalso(
      { rows: [{ id: FILA.id, nuevo: false }] },
      { rows: [FILA] },
    );
    expect((await encolarLoteXml(tx, LOTE)).nuevo).toBe(false);
  });

  it("un rechazo de la función (53400) sale como TrabajosRepoError con el SQLSTATE y sin el mensaje de pg", async () => {
    const e = await encolarLoteXml(txFalso(errorPg("53400")).tx, LOTE).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("53400");
    expect((e as Error).message).not.toContain("CANARIO");
  });

  it("sin fila de la función o sin la vista del trabajo: TrabajosRepoError desconocido", async () => {
    const sinFila = await encolarLoteXml(txFalso({ rows: [] }).tx, LOTE).catch(
      (x: unknown) => x,
    );
    expect((sinFila as TrabajosRepoError).codigo).toBe("desconocido");
    const sinVista = await encolarLoteXml(
      txFalso({ rows: [{ id: FILA.id, nuevo: true }] }, { rows: [] }).tx,
      LOTE,
    ).catch((x: unknown) => x);
    expect((sinVista as TrabajosRepoError).codigo).toBe("desconocido");
  });
});

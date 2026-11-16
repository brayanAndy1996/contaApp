// Spec 021 (T15): guardas de entrada y rutas defensivas de packages/db/src/reglas/ (lectura.ts, escritura.ts, aplicar.ts) con una tx
// falsa, sin Postgres. Lo que importa: una entrada inválida se resuelve con el mismo código que una regla ajena (CA-5) y SIN tocar la
// BD, y la versión inválida nunca llega a un UPDATE. El comportamiento contra la BD real está en tests/aislamiento/reglas-*.spec.ts.
import { describe, expect, it } from "vitest";
import type { TxConsulta } from "../compras/errores";
import { reglasHistorialVigentes } from "./aplicar";
import { editarRegla, eliminarRegla, recordarRegla } from "./escritura";
import { leerRegla, listarReglas } from "./lectura";

const CLIENTE = "01990000-0000-7000-8000-000000000001";
const REGLA = "01990000-0000-7000-8000-000000000002";
const COMPRA = "01990000-0000-7000-8000-000000000003";
const USUARIO = "01990000-0000-7000-8000-000000000004";

type Respuesta = { rows: Record<string, unknown>[]; rowCount: number };
interface Llamada {
  readonly texto: string;
  readonly valores: unknown[];
}

/** Tx falsa: responde por orden con `respuestas` (una por consulta) y registra cada llamada. */
function txFalsa(respuestas: Respuesta[] = []) {
  const llamadas: Llamada[] = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      const r = respuestas[llamadas.length - 1];
      if (!r) throw new Error(`consulta inesperada #${llamadas.length}`);
      return r;
    },
  } as unknown as TxConsulta;
  return { tx, llamadas };
}
const filas = (...rows: Record<string, unknown>[]): Respuesta => ({ rows, rowCount: rows.length });
const vacio = (): Respuesta => ({ rows: [], rowCount: 0 });
const escritas = (n = 1): Respuesta => ({ rows: [], rowCount: n });
const sinTocar = (llamadas: Llamada[]) => expect(llamadas.filter((l) => /^\s*(update|insert)/i.test(l.texto))).toEqual([]);

const IDS_INVALIDOS: unknown[] = ["", "no-es-uuid", "01990000-0000-7000-8000-00000000000", 42, null, undefined, {}];
const VERSIONES_INVALIDAS: unknown[] = [0, -1, 1.5, Number.NaN, Infinity, "2", null, undefined];

describe("lectura: ids inválidos no consultan la BD (CA-5)", () => {
  it.each(IDS_INVALIDOS)("listarReglas con cliente %j devuelve [] sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await listarReglas(tx, id as string)).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it.each(IDS_INVALIDOS)("leerRegla con cliente %j devuelve null sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await leerRegla(tx, id as string, REGLA)).toBeNull();
    expect(llamadas).toEqual([]);
  });

  it.each(IDS_INVALIDOS)("leerRegla con regla %j devuelve null sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await leerRegla(tx, CLIENTE, id as string)).toBeNull();
    expect(llamadas).toEqual([]);
  });

  it("leerRegla de una regla que la BD no devuelve (ajena, de otro estudio o eliminada): null, con ambos ids como parámetros", async () => {
    const { tx, llamadas } = txFalsa([vacio()]);
    expect(await leerRegla(tx, CLIENTE, REGLA)).toBeNull();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([CLIENTE, REGLA]);
  });

  it("los ids con mayúsculas son válidos (UUID insensible a caja)", async () => {
    const { tx, llamadas } = txFalsa([vacio()]);
    expect(await leerRegla(tx, CLIENTE.toUpperCase(), REGLA.toUpperCase())).toBeNull();
    expect(llamadas).toHaveLength(1);
  });
});

describe("recordarRegla: entrada inválida (sin tocar la BD)", () => {
  const entrada = (o: Record<string, unknown> = {}) =>
    ({ clienteId: CLIENTE, compraIds: [COMPRA], destino: "DNG", versionBase: null, usuarioId: USUARIO, ...o }) as Parameters<
      typeof recordarRegla
    >[1];

  it.each(IDS_INVALIDOS)("cliente %j: no_encontrada", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await recordarRegla(tx, entrada({ clienteId: id }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it("sin compras: no_encontrada", async () => {
    const { tx, llamadas } = txFalsa();
    expect(await recordarRegla(tx, entrada({ compraIds: [] }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it.each(IDS_INVALIDOS)("una compra %j entre las válidas: no_encontrada", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await recordarRegla(tx, entrada({ compraIds: [COMPRA, id] }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  // `null` es válido en «Recordar»: significa «crear la regla».
  it.each(VERSIONES_INVALIDAS.filter((v) => v !== null))("versionBase %j: regla_cambiada y no consulta ni escribe", async (v) => {
    const { tx, llamadas } = txFalsa();
    expect(await recordarRegla(tx, entrada({ versionBase: v }))).toBe("regla_cambiada");
    expect(llamadas).toEqual([]);
  });
});

describe("editarRegla: entrada inválida", () => {
  const entrada = (o: Record<string, unknown> = {}) =>
    ({ clienteId: CLIENTE, reglaId: REGLA, versionBase: 1, destino: "DG", usuarioId: USUARIO, ...o }) as Parameters<
      typeof editarRegla
    >[1];

  it.each(IDS_INVALIDOS)("cliente %j: no_encontrada sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await editarRegla(tx, entrada({ clienteId: id }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it.each(IDS_INVALIDOS)("regla %j: no_encontrada sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await editarRegla(tx, entrada({ reglaId: id }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it.each(VERSIONES_INVALIDAS)("versión %j sobre una regla viva: regla_cambiada, solo se consulta si existe", async (v) => {
    const { tx, llamadas } = txFalsa([filas({ "?column?": 1 })]);
    expect(await editarRegla(tx, entrada({ versionBase: v }))).toBe("regla_cambiada");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([REGLA, CLIENTE]);
    sinTocar(llamadas);
  });

  it.each(VERSIONES_INVALIDAS)("versión %j sobre una regla inexistente o eliminada: no_encontrada", async (v) => {
    const { tx, llamadas } = txFalsa([vacio()]);
    expect(await editarRegla(tx, entrada({ versionBase: v }))).toBe("no_encontrada");
    sinTocar(llamadas);
  });

  it("versión vieja (el UPDATE no toca nada) sobre una regla viva: regla_cambiada; sobre una muerta: no_encontrada", async () => {
    const a = txFalsa([escritas(0), filas({ "?column?": 1 })]);
    expect(await editarRegla(a.tx, entrada())).toBe("regla_cambiada");
    const b = txFalsa([escritas(0), vacio()]);
    expect(await editarRegla(b.tx, entrada())).toBe("no_encontrada");
  });

  it("si la regla escrita no se puede releer, falla en vez de devolver un éxito falso", async () => {
    const { tx } = txFalsa([escritas(1), vacio()]);
    await expect(editarRegla(tx, entrada())).rejects.toThrow("no se pudo releer");
  });
});

describe("eliminarRegla: entrada inválida", () => {
  const entrada = (o: Record<string, unknown> = {}) =>
    ({ clienteId: CLIENTE, reglaId: REGLA, versionBase: 1, usuarioId: USUARIO, ...o }) as Parameters<typeof eliminarRegla>[1];

  it.each(IDS_INVALIDOS)("cliente %j: no_encontrada sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await eliminarRegla(tx, entrada({ clienteId: id }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it.each(IDS_INVALIDOS)("regla %j: no_encontrada sin consultar", async (id) => {
    const { tx, llamadas } = txFalsa();
    expect(await eliminarRegla(tx, entrada({ reglaId: id }))).toBe("no_encontrada");
    expect(llamadas).toEqual([]);
  });

  it.each(VERSIONES_INVALIDAS)("versión %j sobre una regla viva: regla_cambiada y no se da de baja", async (v) => {
    const { tx, llamadas } = txFalsa([filas({ "?column?": 1 })]);
    expect(await eliminarRegla(tx, entrada({ versionBase: v }))).toBe("regla_cambiada");
    expect(llamadas).toHaveLength(1);
    sinTocar(llamadas);
  });

  it.each(VERSIONES_INVALIDAS)("versión %j sobre una regla inexistente: no_encontrada", async (v) => {
    const { tx, llamadas } = txFalsa([vacio()]);
    expect(await eliminarRegla(tx, entrada({ versionBase: v }))).toBe("no_encontrada");
    sinTocar(llamadas);
  });
});

describe("recordarRegla: la regla escrita se relee en la misma transacción", () => {
  it("si la relectura no la encuentra, falla (no devuelve una regla inventada)", async () => {
    const compra = filas({ id: COMPRA, periodo: "202610", doc_tipo: "6", doc_numero: "20100070970" });
    const { tx, llamadas } = txFalsa([compra, filas({ id: REGLA }), escritas(0), vacio()]);
    await expect(
      recordarRegla(tx, { clienteId: CLIENTE, compraIds: [COMPRA], destino: "DNG", versionBase: null, usuarioId: USUARIO }),
    ).rejects.toThrow("no se pudo releer");
    expect(llamadas).toHaveLength(4);
  });
});

describe("reglasHistorialVigentes (aplicar.ts)", () => {
  it("pasa cliente y periodo como parámetros y traduce las columnas a la forma pública", async () => {
    const { tx, llamadas } = txFalsa([
      filas(
        { regla_id: REGLA, doc_tipo: "6", doc_numero: "20100070970", destino: "DNG", version: 3 },
        { regla_id: COMPRA, doc_tipo: "1", doc_numero: "AB-123", destino: "DGNG", version: 1 },
      ),
    ]);
    expect(await reglasHistorialVigentes(tx, CLIENTE, "202610")).toEqual([
      { reglaId: REGLA, docTipo: "6", docNumero: "20100070970", destino: "DNG", version: 3 },
      { reglaId: COMPRA, docTipo: "1", docNumero: "AB-123", destino: "DGNG", version: 1 },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([CLIENTE, "202610"]);
    expect(llamadas[0]!.texto).toContain("reglas_historial_vigentes($1, $2)");
  });

  it("sin reglas vigentes (o R-HIS apagado): lista vacía", async () => {
    const { tx } = txFalsa([vacio()]);
    expect(await reglasHistorialVigentes(tx, CLIENTE, "202610")).toEqual([]);
  });
});

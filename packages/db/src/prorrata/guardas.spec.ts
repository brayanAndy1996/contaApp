// Spec 026 (T14a): guardas de entrada de los repositorios de la prorrata. Un id que no es uuid no existe y la lectura devuelve vacío SIN
// ir a la BD; las entradas mal formadas se rechazan con 22023 antes de la BD. Con una `tx` espía: no necesita base de datos.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TxConsulta } from "../compras/errores";
import {
  leerDeclaraciones,
  leerHistorialMes,
  leerManuales,
  leerTotalesVentasProrrata,
  leerUltimaObtencion,
  leerUsada,
  ProrrataRepoError,
  registrarDeclaraciones,
} from "./index";

const espia = () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { tx: { query } as unknown as TxConsulta, query };
};

const IDS_INVALIDOS = ["", "no-es-uuid", "1234", `${randomUUID()}x`];

describe("clienteId que no es uuid: lectura vacía sin tocar la BD", () => {
  it.each(IDS_INVALIDOS)("leerUltimaObtencion(%j) devuelve null", async (id) => {
    const { tx, query } = espia();
    expect(await leerUltimaObtencion(tx, id, "202610")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(IDS_INVALIDOS)("leerUsada(%j) devuelve null", async (id) => {
    const { tx, query } = espia();
    expect(await leerUsada(tx, id, "202610")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(IDS_INVALIDOS)("leerHistorialMes(%j) devuelve declaraciones y manual vacíos", async (id) => {
    const { tx, query } = espia();
    expect(await leerHistorialMes(tx, id, "202610")).toEqual({ declaraciones: [], manual: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(IDS_INVALIDOS)("leerDeclaraciones y leerManuales(%j) devuelven []", async (id) => {
    const { tx, query } = espia();
    expect(await leerDeclaraciones(tx, id, ["202610"])).toEqual([]);
    expect(await leerManuales(tx, id, ["202610"])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("periodo que no es cadena: lectura vacía sin tocar la BD", () => {
  const cliente = randomUUID();

  it("leerUltimaObtencion con periodoHasta no cadena devuelve null", async () => {
    const { tx, query } = espia();
    expect(await leerUltimaObtencion(tx, cliente, 202610 as unknown as string)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("leerUsada con periodo no cadena devuelve null", async () => {
    const { tx, query } = espia();
    expect(await leerUsada(tx, cliente, undefined as unknown as string)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("leerHistorialMes con periodo no cadena devuelve vacío", async () => {
    const { tx, query } = espia();
    expect(await leerHistorialMes(tx, cliente, null as unknown as string)).toEqual({ declaraciones: [], manual: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("con uuid y periodo válidos la lectura sí consulta, y sin fila devuelve null (control del espía)", async () => {
    const { tx, query } = espia();
    expect(await leerUsada(tx, cliente, "202610")).toBeNull();
    expect(await leerUltimaObtencion(tx, cliente, "202610")).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("registrarDeclaraciones: la entrada mal formada es 22023 y no llega a la BD", () => {
  const base = { clienteId: randomUUID(), trabajoId: randomUUID(), periodoHasta: "202610", leidos: [], sinDeclaracion: [] };

  it.each([[null], [undefined], ["[]"], [{}]])("declaraciones = %j", async (valor) => {
    const { tx, query } = espia();
    const error = await registrarDeclaraciones(tx, { ...base, declaraciones: valor as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProrrataRepoError);
    expect((error as ProrrataRepoError).codigo).toBe("22023");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("leerTotalesVentasProrrata sin cliente válido (R-5: nada que sumar)", () => {
  it("lista vacía de periodos: [] sin consultar", async () => {
    const { tx, query } = espia();
    expect(await leerTotalesVentasProrrata(tx, randomUUID(), [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(IDS_INVALIDOS)("clienteId %j: una entrada por periodo, en su orden, no cargada y en cero, sin consultar", async (id) => {
    const { tx, query } = espia();
    const r = await leerTotalesVentasProrrata(tx, id, ["202610", "202601"]);
    expect(r).toEqual([
      { periodo: "202610", cargado: false, pen: { baseGravada: "0.00", igv: "0.00", exonerada: "0.00", inafecta: "0.00" }, usd: [] },
      { periodo: "202601", cargado: false, pen: { baseGravada: "0.00", igv: "0.00", exonerada: "0.00", inafecta: "0.00" }, usd: [] },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it("periodos que no son lista de cadenas: 22023", async () => {
    const { tx } = espia();
    const error = await leerTotalesVentasProrrata(tx, randomUUID(), [202610] as never).catch((e: unknown) => e);
    expect((error as ProrrataRepoError).codigo).toBe("22023");
  });

  it("periodo pedido que la consulta no devuelve: sale en cero con su periodo; con fila, usa sus valores", async () => {
    const cliente = randomUUID();
    const query = vi.fn(async () => ({
      rows: [{ periodo: "202601", cargado: true, base_gravada: "10.00", igv: "1.80", exonerada: "2.00", inafecta: "3.00", usd: [] }],
      rowCount: 1,
    }));
    const r = await leerTotalesVentasProrrata({ query } as unknown as TxConsulta, cliente, ["202601", "202602"]);
    expect(r[0]).toEqual({ periodo: "202601", cargado: true, pen: { baseGravada: "10.00", igv: "1.80", exonerada: "2.00", inafecta: "3.00" }, usd: [] });
    expect(r[1]).toEqual({ periodo: "202602", cargado: false, pen: { baseGravada: "0.00", igv: "0.00", exonerada: "0.00", inafecta: "0.00" }, usd: [] });
  });
});

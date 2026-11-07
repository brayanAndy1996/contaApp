// Unitarias del procesador `sire.propuesta.descargar` (spec 013, T12): lo que la integración no recorre (parámetros,
// libro sin persistidor, usuario ausente, respuesta inconsistente, tope de filas recibidas, hash) con la BD y el puerto falsos.
import { ErrorDatos, type SireApiClient } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";

// `aplicarComplemento` (packages/db) es el real; la transacción es falsa y registra las sentencias que recibe.
const h = vi.hoisted(() => ({
  crear: vi.fn<(valores: unknown[]) => void>(),
  difs: vi.fn<(valores: unknown[]) => void>(),
}));

import { ErrorPropuesta } from "../persistidores/errores.js";
import type {
  FilaPreparada,
  PersistidorLibro,
} from "../persistidores/tipos.js";
import {
  TOPE_FILAS,
  descargarPropuesta,
  hashContenido,
} from "./descargar-propuesta.js";

const trabajo = (parametros: unknown, creadoPor: string | null = "u-1") => ({
  id: "j-1",
  tenantId: "t-1",
  clienteId: "c-1",
  ruc: "20700000002",
  tipo: "sire.propuesta.descargar",
  parametros,
  intentos: 0,
  creadoPor,
});
const conToken = <T>(usar: (t: string) => Promise<T>) => usar("tok");
const tx = {
  query: async (texto: string, valores: unknown[]) => {
    if (texto.includes("insert into propuesta_diferencia")) {
      h.difs(valores);
      return { rows: [], rowCount: 0 };
    }
    if (texto.includes("insert into propuesta ")) {
      h.crear(valores);
      return { rows: [{ id: "p-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
const db = {
  withTenant: async (_c: unknown, f: (tx: unknown) => unknown) => f(tx),
} as never;

const prep = (clave: string, total = "1.00"): FilaPreparada => ({
  clave,
  tipo: "03",
  serie: "B001",
  numero: clave.split("|")[2]!,
  campos: { total },
  datos: { clave },
});

function persistidor(
  existentes: Array<{ clave: string; total: string }> = [],
): PersistidorLibro & { insertadas: FilaPreparada[][] } {
  const insertadas: FilaPreparada[][] = [];
  return {
    insertadas,
    preparar: (filas) => filas.map((f) => prep(String(f))),
    leerExistentes: async () =>
      existentes.map((e) => ({
        clave: e.clave,
        origen: "sire" as const,
        campos: { total: e.total },
      })),
    insertar: async (_tx, _ctx, _id, nuevas) => {
      insertadas.push([...nuevas]);
    },
  };
}

const api = (r: unknown): SireApiClient & { llamadas: number } => {
  const a = {
    llamadas: 0,
    descargarPropuesta: async () => {
      a.llamadas += 1;
      return r as never;
    },
  };
  return a;
};
const propuestaDe = (filas: unknown[], libro = "ventas") => ({
  libro,
  periodo: "202610",
  filas,
});
const PARAMS = { periodo: "202610", libro: "ventas" };

async function correr(
  p: Parameters<typeof descargarPropuesta>[0],
  t = trabajo(PARAMS),
) {
  return descargarPropuesta(p)({ trabajo: t, conToken });
}

describe("descargarPropuesta: errores sin tocar la BD", () => {
  it.each([
    ["periodo mal formado", { periodo: "2026-10", libro: "ventas" }],
    ["libro desconocido", { periodo: "202610", libro: "otro" }],
    ["parámetros ajenos", { periodo: "202610", libro: "ventas", x: 1 }],
    ["sin parámetros", undefined],
  ])("%s: ErrorDatos parametros_invalidos y sin llamar al SIRE", async (_n, p) => {
    const a = api(propuestaDe([]));
    const e = await correr(
      { db, sireApi: a, persistidores: { ventas: persistidor() } },
      trabajo(p),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(e).toMatchObject({ detalle: "parametros_invalidos" });
    expect(a.llamadas).toBe(0);
  });

  it("libro sin persistidor: libro_no_soportado, antes de llamar al SIRE", async () => {
    const a = api(propuestaDe([]));
    const e = await correr(
      { db, sireApi: a, persistidores: {} },
      trabajo({ periodo: "202610", libro: "compras" }),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorDatos);
    expect(e).toMatchObject({
      detalle: "libro_no_soportado",
      codigo: "datos_invalidos",
    });
    expect(a.llamadas).toBe(0);
  });

  it("trabajo sin usuario: usuario_requerido", async () => {
    const e = await correr(
      {
        db,
        sireApi: api(propuestaDe([])),
        persistidores: { ventas: persistidor() },
      },
      trabajo(PARAMS, null),
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({ detalle: "usuario_requerido" });
  });

  it.each([
    ["otro libro", propuestaDe([], "compras")],
    ["filas que no son una lista", { libro: "ventas", periodo: "202610" }],
  ])("respuesta inconsistente (%s)", async (_n, r) => {
    const e = await correr({
      db,
      sireApi: api(r),
      persistidores: { ventas: persistidor() },
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ detalle: "respuesta_inconsistente" });
  });

  it("más de 20.000 filas: propuesta_demasiado_grande sin validar ninguna", async () => {
    const p = persistidor();
    const preparar = vi.spyOn(p, "preparar");
    const e = await correr({
      db,
      sireApi: api(propuestaDe(new Array(TOPE_FILAS + 1).fill("x"))),
      persistidores: { ventas: p },
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ detalle: "propuesta_demasiado_grande" });
    expect(preparar).not.toHaveBeenCalled();
    expect(h.crear).not.toHaveBeenCalled();
  });

  it("una fila ilegible sube tal cual (fila_invalida) y no se guarda nada", async () => {
    const p = persistidor();
    p.preparar = () => {
      throw new ErrorPropuesta("fila_invalida");
    };
    const e = await correr({
      db,
      sireApi: api(propuestaDe(["a"])),
      persistidores: { ventas: p },
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ detalle: "fila_invalida" });
    expect(h.crear).not.toHaveBeenCalled();
  });
});

describe("descargarPropuesta: guardado", () => {
  // T18 (D19, usuario 2026-11-07): antes decía «existentes + nuevas > 20.000 no guarda el encabezado»; el tope es de las filas
  // que llegan en la descarga (ver la prueba de `TOPE_FILAS`), no del total vivo del periodo.
  it("el tope no cuenta lo ya guardado (D19): 19.999 existentes + 2 nuevas se guardan y dejan su encabezado", async () => {
    const existentes = Array.from({ length: TOPE_FILAS - 1 }, (_v, i) => ({
      clave: `03|S001|${i}`,
      total: "1.00",
    }));
    const p = persistidor(existentes);
    h.crear.mockClear();
    const r = await correr({
      db,
      sireApi: api(propuestaDe(["03|N001|1", "03|N001|2"])),
      persistidores: { ventas: p },
    });
    expect(r).toMatchObject({ recibidas: 2, nuevas: 2, iguales: 0, distintas: 0 });
    expect(h.crear).toHaveBeenCalledTimes(1);
    expect(p.insertadas[0]!.map((f) => f.clave)).toEqual(["03|N001|1", "03|N001|2"]);
  });

  it("cuenta nuevas, iguales y distintas; inserta la primera aparición y arma el resultado sin montos", async () => {
    h.crear.mockClear();
    h.difs.mockClear();
    const p = persistidor([
      { clave: "03|B001|1", total: "1.00" },
      { clave: "03|B001|2", total: "9.00" },
    ]);
    // 1 igual; 2 distinta; 3 nueva y repetida distinta (D18); 4 nueva.
    const r = await correr({
      db,
      sireApi: api(
        propuestaDe(["03|B001|1", "03|B001|2", "03|B001|3", "03|B001|4"]),
      ),
      persistidores: { ventas: p },
    });
    expect(r).toEqual({
      propuestaId: "p-1",
      recibidas: 4,
      nuevas: 2,
      iguales: 1,
      distintas: 1,
      claves: ["03|B001|2"],
      truncado: false,
    });
    expect(p.insertadas[0]!.map((f) => f.clave)).toEqual([
      "03|B001|3",
      "03|B001|4",
    ]);
    // Orden de SQL_CREAR: cliente, periodo, libro, fuente, hash, recibidas, nuevas, iguales, distintas, usuario, trabajo.
    expect(h.crear).toHaveBeenCalledWith([
      "c-1",
      "202610",
      "ventas",
      "api",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      4,
      2,
      1,
      1,
      "u-1",
      "j-1",
    ]);
    expect(h.difs).toHaveBeenCalledTimes(1);
    const [propuestaId, lote] = h.difs.mock.calls[0]![0] as [string, string];
    expect(propuestaId).toBe("p-1");
    expect(JSON.parse(lote)).toEqual([
      expect.objectContaining({
        clave: "03|B001|2",
        tipo: "03",
        serie: "B001",
        numero: "2",
        origen_existente: "sire",
        campos: ["total"],
        valores_sire: { total: "1.00" },
      }),
    ]);
  });

  it("más de 40 claves que difieren: lista 40 y avisa que se truncó", async () => {
    const existentes = Array.from({ length: 45 }, (_v, i) => ({
      clave: `03|B001|${i}`,
      total: "9.00",
    }));
    const r = (await correr({
      db,
      sireApi: api(propuestaDe(existentes.map((e) => e.clave))),
      persistidores: { ventas: persistidor(existentes) },
    })) as { claves: string[]; truncado: boolean; distintas: number };
    expect(r.distintas).toBe(45);
    expect(r.claves).toHaveLength(40);
    expect(r.truncado).toBe(true);
  });
});

describe("hashContenido", () => {
  const a = prep("03|B001|1");
  const b = prep("03|B001|2", "2.00");

  it("no depende del orden de las filas", () => {
    expect(hashContenido("ventas", "202610", [a, b])).toBe(
      hashContenido("ventas", "202610", [b, a]),
    );
  });

  it("cambia con el contenido, el periodo o el libro", () => {
    const base = hashContenido("ventas", "202610", [a]);
    expect(hashContenido("ventas", "202610", [prep("03|B001|1", "3.00")])).not.toBe(base);
    expect(hashContenido("ventas", "202611", [a])).not.toBe(base);
    expect(hashContenido("compras", "202610", [a])).not.toBe(base);
  });
});

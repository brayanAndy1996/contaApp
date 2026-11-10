// Unitarias del gancho `trasConfirmar` de `PersistidorLibro` (spec 016, T6; plan: Cola y worker, D-7). La descarga lo llama
// DESPUÉS del commit, con el contexto del periodo y el id de la propuesta; si falla solo se registra un código: ni la
// descarga falla ni su `resultado` (el de 013) cambia. Compras lo implementa; ventas no.
import type { SireApiClient } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { canario } from "../../../test/soporte.js";
import { PERSISTIDORES } from "../persistidores/index.js";
import { ErrorPropuesta } from "../persistidores/errores.js";
import type { FilaPreparada, PersistidorLibro } from "../persistidores/tipos.js";
import { descargarPropuesta } from "./descargar-propuesta.js";

const eventos: string[] = [];

const trabajo = {
  id: "j-1",
  tenantId: "t-1",
  clienteId: "c-1",
  ruc: "20700000002",
  tipo: "sire.propuesta.descargar",
  parametros: { periodo: "202610", libro: "compras" },
  intentos: 0,
  creadoPor: "u-1",
};
const conToken = <T>(usar: (t: string) => Promise<T>) => usar("tok");

// Transacción falsa (como la de descargar-propuesta.spec.ts): registra el commit y devuelve el id de la propuesta.
const tx = {
  query: async (texto: string) => {
    if (texto.includes("insert into propuesta "))
      return { rows: [{ id: "p-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
};
const db = {
  withTenant: async (_c: unknown, f: (t: unknown) => unknown) => {
    const r = await f(tx);
    eventos.push("commit");
    return r;
  },
} as never;

const prep = (clave: string): FilaPreparada => ({
  clave,
  tipo: "01",
  serie: "F001",
  numero: clave.split("|")[2]!,
  campos: { total: "1.00" },
  datos: { clave },
});

function persistidor(
  tras?: PersistidorLibro["trasConfirmar"],
): PersistidorLibro {
  return {
    preparar: (filas) => filas.map((f) => prep(String(f))),
    leerExistentes: async () => [],
    insertar: async () => undefined,
    ...(tras === undefined ? {} : { trasConfirmar: tras }),
  };
}

const api = (): SireApiClient =>
  ({
    descargarPropuesta: async () => ({
      libro: "compras",
      periodo: "202610",
      filas: ["01|F001|1", "01|F001|2"],
    }),
  }) as never;

async function correr(p: PersistidorLibro, t = trabajo) {
  return descargarPropuesta({
    db,
    sireApi: api(),
    persistidores: { compras: p },
  })({ trabajo: t, conToken } as never);
}

describe("descargarPropuesta: trasConfirmar (016)", () => {
  it("lo llama una vez, después del commit, con el periodo del trabajo y la propuesta creada", async () => {
    eventos.length = 0;
    const tras = vi.fn(async () => {
      eventos.push("tras");
    });
    const r = await correr(persistidor(tras));
    expect(tras).toHaveBeenCalledTimes(1);
    expect(tras).toHaveBeenCalledWith(
      expect.objectContaining({ clienteId: "c-1", periodo: "202610" }),
      "p-1",
    );
    expect(eventos).toEqual(["commit", "tras"]);
    expect(r).toMatchObject({ propuestaId: "p-1", recibidas: 2, nuevas: 2 });
  });

  it("el resultado es el de 013 (sin claves nuevas), llame o no al gancho", async () => {
    const con = await correr(persistidor(async () => undefined));
    const sin = await correr(persistidor());
    expect(con).toEqual(sin);
    expect(Object.keys(con).sort()).toEqual(
      ["claves", "distintas", "iguales", "nuevas", "propuestaId", "recibidas", "truncado"],
    );
  });

  it("un fallo del gancho no falla la descarga ni cambia su resultado, y no se repite lo que dijo", async () => {
    const c = canario("gancho");
    const sin = await correr(persistidor());
    const r = await correr(
      persistidor(async () => {
        throw new Error(`cola llena ${c}`);
      }),
    );
    expect(r).toEqual(sin);
    expect(JSON.stringify(r)).not.toContain(c);
  });

  it("no se llama si la descarga falla antes de confirmar", async () => {
    const tras = vi.fn(async () => undefined);
    const p = persistidor(tras);
    p.preparar = () => {
      throw new ErrorPropuesta("fila_invalida");
    };
    await expect(correr(p)).rejects.toMatchObject({ detalle: "fila_invalida" });
    expect(tras).not.toHaveBeenCalled();
  });

  it("no se llama si la transacción falla (nada quedó confirmado)", async () => {
    const tras = vi.fn(async () => undefined);
    const p = persistidor(tras);
    p.insertar = async () => {
      throw new Error("caída de la BD");
    };
    await expect(correr(p)).rejects.toThrow();
    expect(tras).not.toHaveBeenCalled();
  });

  it("es opcional: un persistidor sin gancho descarga igual", async () => {
    await expect(correr(persistidor())).resolves.toMatchObject({ nuevas: 2 });
  });
});

describe("descargarPropuesta: registro del fallo del gancho (T17a)", () => {
  /** Corre la descarga con un logger espía y devuelve lo que se registró. */
  async function conLogger(error: unknown) {
    const warn = vi.fn();
    const otros = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const r = await descargarPropuesta({
      db,
      sireApi: api(),
      persistidores: {
        compras: persistidor(async () => {
          throw error;
        }),
      },
      logger: { ...otros, warn },
    })({ trabajo, conToken } as never);
    return { r, warn, otros };
  }

  it("registra un aviso con el código del error cuando es una cadena, y nada más", async () => {
    const c = canario("registro");
    const { r, warn, otros } = await conLogger(
      Object.assign(new Error(`cola llena ${c}`), { codigo: "cola_llena" }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      evento: "tras_confirmar_fallo",
      tenant_id: "t-1",
      job_id: "j-1",
      tipo: "sire.propuesta.descargar",
      codigo: "cola_llena",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(c);
    expect(otros.error).not.toHaveBeenCalled();
    expect(r).toMatchObject({ propuestaId: "p-1", nuevas: 2 });
  });

  it.each([
    ["un error sin código", new Error("x")],
    ["un código que no es cadena", Object.assign(new Error("x"), { codigo: 42 })],
    ["un valor lanzado nulo", null],
    ["un valor lanzado que no es objeto", "texto"],
  ])("%s: registra el código «desconocido» y la descarga no falla", async (_n, error) => {
    const { r, warn } = await conLogger(error);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evento: "tras_confirmar_fallo", codigo: "desconocido" }),
    );
    expect(r).toMatchObject({ propuestaId: "p-1" });
  });

  it("un logger que falla tampoco tumba la descarga", async () => {
    const r = await descargarPropuesta({
      db,
      sireApi: api(),
      persistidores: {
        compras: persistidor(async () => {
          throw new Error("x");
        }),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: () => {
          throw new Error("logger caído");
        },
      },
    })({ trabajo, conToken } as never);
    expect(r).toMatchObject({ propuestaId: "p-1" });
  });

  it("con el gancho en orden no se registra nada", async () => {
    const warn = vi.fn();
    await descargarPropuesta({
      db,
      sireApi: api(),
      persistidores: { compras: persistidor(async () => undefined) },
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn },
    })({ trabajo, conToken } as never);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("registro de persistidores: quién implementa trasConfirmar", () => {
  it("compras lo implementa (lotes de XML)", () => {
    expect(typeof PERSISTIDORES.compras?.trasConfirmar).toBe("function");
  });
  it("ventas no lo implementa (016 es solo compras, P-3)", () => {
    expect(PERSISTIDORES.ventas).toBeDefined();
    expect(PERSISTIDORES.ventas?.trasConfirmar).toBeUndefined();
  });
});

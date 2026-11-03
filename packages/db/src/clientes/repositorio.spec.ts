// Spec 007a (D1, D4, D5; CA-1, CA-2, CA-5): repositorios de clientes sin BD (tx falsa). Contrato fijado
// (plan: Contratos packages/db; todos con la `tx` de withTenant; el servicio toma antes bloquearMiembros y
// CupoRucs.reservar, así que los repositorios NO bloquean miembros ni cupo):
//  - crearCliente(tx, tenantId, { ruc, razonSocial?, perfil? }): un INSERT en cliente; sin razón social guarda
//    «RUC <número>» (D1); 23505 sobre la unique (tenant_id, ruc) -> RucDuplicadoError.
//  - editarCliente(tx, clienteId, { razonSocial?, perfil? }): UPDATE de cliente por id; el RUC no se toca.
//  - archivarCliente(tx, clienteId): UPDATE por id, idempotente; no toca cupo ni miembros.
//  - reactivarCliente(tx, clienteId): pone archivado_at en null.
//  - leerClienteDto(tx, clienteId): null si no hay fila.
//  - errores.ts: RucDuplicadoError, ClienteArchivadoError (sin datos de entrada).
// El comportamiento contra la BD real está en tests/aislamiento/clientes*.spec.ts.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ClienteArchivadoError, RucDuplicadoError } from "./errores";
import {
  archivarCliente,
  crearCliente,
  editarCliente,
  leerClienteDto,
  reactivarCliente,
} from "./repositorio";

const T = "01920000-0000-7000-8000-0000000000a1";
const C = "01920000-0000-7000-8000-0000000000c1";
const RUC = "20100070970";
type Tx = Parameters<typeof crearCliente>[0];
type Llamada = { texto: string; valores: unknown[] };

function txFalso(rows: unknown[] = [{ id: C }], rowCount = rows.length) {
  const llamadas: Llamada[] = [];
  const tx = {
    query: async (texto: string, valores: unknown[] = []) => {
      llamadas.push({ texto, valores });
      return { rows, rowCount };
    },
  } as unknown as Tx;
  return { tx, llamadas };
}
const txQueFalla = (error: unknown) =>
  ({
    query: async () => {
      throw error;
    },
  }) as unknown as Tx;
const perfil = {
  regimen: "rmt",
  zona: "amazonia",
  ventasExoneradas: true,
  ventasMixtas: true,
  monedaHabitual: "USD",
} as const;
const sinCupoNiMiembros = (llamadas: Llamada[]) => {
  for (const l of llamadas) {
    expect(l.texto).not.toMatch(/advisory|plan\.cupo|for\s+update/i);
    expect(l.texto).not.toMatch(/\bmiembro\b/i);
  }
};

describe("errores de clientes", () => {
  it("RucDuplicadoError y ClienteArchivadoError son Error, con nombre y sin datos de entrada", () => {
    const a = new RucDuplicadoError();
    const b = new ClienteArchivadoError();
    expect(a).toBeInstanceOf(Error);
    expect(b).toBeInstanceOf(Error);
    expect(a.name).toBe("RucDuplicadoError");
    expect(b.name).toBe("ClienteArchivadoError");
    expect(a).not.toBeInstanceOf(ClienteArchivadoError);
    expect(Object.keys(a)).toEqual([]);
    expect(Object.keys(b)).toEqual([]);
  });
});

describe("crearCliente", () => {
  it("inserta una sola fila en cliente con el RUC y el estudio como parámetros", async () => {
    const { tx, llamadas } = txFalso();
    await crearCliente(tx, T, { ruc: RUC, razonSocial: "Mi Estudio SAC" });
    expect(llamadas).toHaveLength(1);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/insert\s+into\s+"?cliente"?/i);
    expect(valores).toEqual(expect.arrayContaining([T, RUC, "Mi Estudio SAC"]));
    expect(texto).not.toContain(RUC);
    expect(texto).not.toContain("Mi Estudio SAC");
    sinCupoNiMiembros(llamadas);
  });

  it("sin razón social guarda «RUC <número>» (D1)", async () => {
    const { tx, llamadas } = txFalso();
    await crearCliente(tx, T, { ruc: RUC });
    expect(llamadas[0]!.valores).toContain(`RUC ${RUC}`);
  });

  it("razón social vacía o solo espacios también cae en «RUC <número>»", async () => {
    const { tx, llamadas } = txFalso();
    await crearCliente(tx, T, { ruc: RUC, razonSocial: "   " });
    expect(llamadas[0]!.valores).toContain(`RUC ${RUC}`);
  });

  it("el perfil fiscal viaja como parámetros", async () => {
    const { tx, llamadas } = txFalso();
    await crearCliente(tx, T, { ruc: RUC, perfil });
    const { texto, valores } = llamadas[0]!;
    expect(valores).toEqual(expect.arrayContaining(["rmt", "amazonia", "USD"]));
    expect(texto).not.toContain("amazonia");
    expect(texto).toMatch(/regimen/i);
    expect(texto).toMatch(/zona/i);
    expect(texto).toMatch(/moneda_habitual/i);
  });

  it("23505 sobre (tenant_id, ruc) -> RucDuplicadoError, sin conservar el error de pg", async () => {
    const pg = {
      code: "23505",
      constraint: "cliente_tenant_ruc_unique",
      detail: `Key (tenant_id, ruc)=(${T}, ${RUC}) already exists. CANARIO-007A`,
      message: "duplicate key CANARIO-007A",
    };
    const e = await crearCliente(txQueFalla(pg), T, { ruc: RUC }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(RucDuplicadoError);
    expect((e as Error).message).not.toContain("CANARIO-007A");
    expect(inspect(e)).not.toContain("CANARIO-007A");
  });

  it("otro error de pg no es RucDuplicadoError y no filtra su mensaje", async () => {
    let intentos = 0;
    const tx = {
      query: async () => {
        intentos += 1;
        throw { code: "40P01", message: "deadlock con CANARIO-007A" };
      },
    } as unknown as Tx;
    const e = await crearCliente(tx, T, { ruc: RUC }).catch((x: unknown) => x);
    expect(intentos).toBe(1);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RucDuplicadoError);
    expect((e as Error).message).not.toContain("CANARIO-007A");
  });
});

describe("editarCliente", () => {
  it("actualiza cliente por id con los valores como parámetros y nunca el RUC", async () => {
    const { tx, llamadas } = txFalso();
    await editarCliente(tx, C, { razonSocial: "Nueva SAC", perfil });
    expect(llamadas.length).toBeGreaterThanOrEqual(1);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/update\s+"?cliente"?/i);
    expect(valores).toEqual(
      expect.arrayContaining([C, "Nueva SAC", "rmt", "amazonia", "USD"]),
    );
    expect(texto).not.toContain("Nueva SAC");
    const set = texto.split(/\bset\b/i)[1]!.split(/\bwhere\b/i)[0]!;
    expect(set).not.toMatch(/\bruc\b\s*=/i);
    expect(set).not.toMatch(/tenant_id\s*=/i);
    sinCupoNiMiembros(llamadas);
  });
});

describe("archivarCliente", () => {
  it("una sola UPDATE de cliente por id que pone archivado_at; sin cupo ni miembros (D4)", async () => {
    const { tx, llamadas } = txFalso([{ id: C }]);
    await archivarCliente(tx, C);
    expect(llamadas).toHaveLength(1);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/update\s+"?cliente"?/i);
    expect(texto).toMatch(/archivado_at/i);
    expect(valores).toContain(C);
    sinCupoNiMiembros(llamadas);
  });

  it("es idempotente: archivar un cliente ya archivado (0 filas) no lanza", async () => {
    const { tx } = txFalso([], 0);
    await expect(archivarCliente(tx, C)).resolves.not.toThrow();
  });

  it("archivar dos veces no vuelve a mover la marca: la UPDATE conserva la fecha previa", async () => {
    const { tx, llamadas } = txFalso([], 0);
    await archivarCliente(tx, C);
    expect(llamadas[0]!.texto).toMatch(
      /archivado_at\s+is\s+null|coalesce\s*\(\s*(\w+\.)?archivado_at/i,
    );
  });
});

describe("reactivarCliente", () => {
  it("pone archivado_at en null por id y no toca cupo ni miembros (los toma el servicio antes)", async () => {
    const { tx, llamadas } = txFalso([{ id: C }]);
    await reactivarCliente(tx, C);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/update\s+"?cliente"?/i);
    expect(texto).toMatch(/archivado_at\s*=\s*null/i);
    expect(valores).toContain(C);
    sinCupoNiMiembros(llamadas);
  });
});

describe("leerClienteDto", () => {
  it("sin fila devuelve null", async () => {
    const { tx, llamadas } = txFalso([], 0);
    expect(await leerClienteDto(tx, C)).toBeNull();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toContain(C);
    expect(llamadas[0]!.texto).not.toContain(C);
  });

  it("la consulta no pide columnas de secretos (solo estado de credencial)", async () => {
    const { tx, llamadas } = txFalso([], 0);
    await leerClienteDto(tx, C);
    expect(llamadas[0]!.texto).not.toMatch(
      /sobre|dek_envuelta|ciphertext|client_secret|clave_sol/i,
    );
  });
});

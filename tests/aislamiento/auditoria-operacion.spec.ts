// Spec 017 (T2, rojo): CA-5 (una operacion = una fila, antes -> despues desde compra_version), listarAuditoria (orden, cursor, <= 50,
// descifrados de 003 como `credencial.descifrada`), CA-7 en SQL con dos estudios y CA-6 (sin secretos) a nivel de BD.
// Fallan por tabla `auditoria` o export (`listarAuditoria`, `leerCambiosDeOperacion`) ausentes.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAuditoria, abrirAdmin, exportado } from "./auditoria-soporte";
import { PERIODO, sinHallazgos, transformarFalso } from "./compras-soporte";
import type { Tx } from "./soporte";
import type { ClientePrueba } from "./trabajos-soporte";

interface VersionCompra {
  n: number;
  excluida: boolean;
  clasificada: boolean;
  biDg: string;
  igvDg: string;
  biDng: string;
  igvDng: string;
  total: string;
}
interface Cambio {
  compraId: string;
  antes: VersionCompra | null;
  despues: VersionCompra;
}
interface FilaAuditoria {
  id: string;
  ocurridaEn: Date;
  accion: string;
  actorTipo: string;
  usuarioId: string | null;
  trabajoId: string | null;
  clienteId: string | null;
  entidad: string;
  entidadId: string | null;
  datos: Record<string, unknown>;
}

const leerCambiosDeOperacion = (tx: Tx, op: string) =>
  exportado<(tx: Tx, op: string) => Promise<Cambio[]>>("leerCambiosDeOperacion")(tx, op);
const listarAuditoria = (tx: Tx, o: { antes?: { en: Date; id: string }; limite: number }) =>
  exportado<(tx: Tx, o: unknown) => Promise<FilaAuditoria[]>>("listarAuditoria")(tx, o);
const aplicarMasiva = (tx: Tx, e: unknown, f: unknown) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<{ operacionId: string | null; aplicadas: number }>>("aplicarMasiva")(tx, e, f);
const deshacer = (tx: Tx, e: unknown, f: unknown) =>
  exportado<(tx: Tx, e: unknown, f: unknown) => Promise<{ operacionId: string; filas: number }>>("deshacer")(tx, e, f);
const guardarSobre = (tx: Tx, a: unknown) => exportado<(tx: Tx, a: unknown) => Promise<{ id: string }>>("guardarSobre")(tx, a);
const registrarDescifrado = (tx: Tx, a: unknown) => exportado<(tx: Tx, a: unknown) => Promise<void>>("registrarDescifrado")(tx, a);
const marcarCredencialInvalida = (tx: Tx, c: string, t: string) =>
  exportado<(tx: Tx, c: string, t: string) => Promise<boolean>>("marcarCredencialInvalida")(tx, c, t);

let admin: Pool;
let ec: EscenarioAuditoria;
let X: string;
let Y: string;
let ux: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioAuditoria(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  uy = await ec.usuarioDe(Y);
});
afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
});

async function sembrar(c: ClientePrueba, cuantas: number, prefijo: string) {
  const prop = await ec.propuesta(X, c, { libro: "compras", nuevas: cuantas });
  const compras: { id: string }[] = [];
  for (let i = 0; i < cuantas; i += 20) {
    const lote = await Promise.all(
      Array.from({ length: Math.min(20, cuantas - i) }, (_, k) =>
        ec.compra(X, c, { serie: prefijo, numero: String(i + k + 1), propuestaId: prop }),
      ),
    );
    compras.push(...lote);
  }
  return compras;
}

const masiva = (c: ClientePrueba, ids: { id: string }[], accion = "clasificar") =>
  ec.comoBackend(X, ux, (tx) =>
    aplicarMasiva(
      tx,
      {
        clienteId: c.id,
        periodo: PERIODO,
        usuarioId: ux,
        accion,
        parametros: { tipo: "dng" },
        items: ids.map((x) => ({ compraId: x.id, versionBase: 1 })),
      },
      { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
    ),
  );

// =================================================================================================
describe("CA-5 · una operacion es UNA fila (D-4), con el antes -> despues en compra_version", () => {
  let c: ClientePrueba;
  let compras: { id: string }[];
  let op: string;

  it("una masiva de 300 compras deja una fila compra.operacion con filas = 300 y ninguna fila por compra", async () => {
    c = await ec.cliente(X);
    compras = await sembrar(c, 300, "FA01");
    const previas = (await ec.filas(X)).length;
    const { filas, resultado } = await ec.capturar(X, "compra.operacion", () => masiva(c, compras));
    expect(resultado.aplicadas).toBe(300);
    op = resultado.operacionId!;
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: ux,
      cliente_id: c.id,
      entidad: "compra_operacion",
      entidad_id: op,
      datos: { tipo: "clasificar", periodo: PERIODO, filas: 300, referenciaId: null },
    });
    // Ni compra ni compra_version dejan filas propias: la operacion es la unica fila nueva de la masiva.
    expect((await ec.filas(X)).length - previas).toBe(1);
    const porCompra = await admin.query(
      "select count(*)::int as n from auditoria where tenant_id = $1 and entidad in ('compra', 'compra_version')",
      [X],
    );
    expect(porCompra.rows[0].n).toBe(0);
  }, 180_000);

  it("leerCambiosDeOperacion devuelve el antes -> despues de cada una de las 300 compras, por compraId ascendente", async () => {
    const cambios = await ec.comoBackend(X, ux, (tx) => leerCambiosDeOperacion(tx, op));
    expect(cambios).toHaveLength(300);
    const ids = cambios.map((x) => x.compraId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set(compras.map((x) => x.id)));
    for (const x of cambios) {
      expect(x.antes).toMatchObject({ n: 1, excluida: false, biDg: "1000.00", biDng: "0.00" });
      expect(x.despues).toMatchObject({ n: 2, excluida: false, biDg: "0.00", biDng: "1000.00" });
    }
  });

  it("leerCambiosDeOperacion con una operacion de otro estudio o inexistente devuelve [] (RLS)", async () => {
    const otroEstudio = await ec.comoBackend(Y, uy, (tx) => leerCambiosDeOperacion(tx, op));
    expect(otroEstudio).toEqual([]);
    const fantasma = await ec.comoBackend(X, ux, (tx) => leerCambiosDeOperacion(tx, "00000000-0000-4000-8000-000000000050"));
    expect(fantasma).toEqual([]);
  });

  it("deshacer deja su PROPIA fila (tipo 'deshacer', referenciaId = la operacion, filas = 300) y la original no cambia", async () => {
    const { filas, resultado } = await ec.capturar(X, "compra.operacion", () =>
      ec.comoBackend(X, ux, (tx) =>
        deshacer(tx, { clienteId: c.id, periodo: PERIODO, usuarioId: ux }, { evaluar: sinHallazgos().evaluar }),
      ),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: ux,
      entidad: "compra_operacion",
      entidad_id: resultado.operacionId,
      datos: { tipo: "deshacer", periodo: PERIODO, filas: 300, referenciaId: op },
    });
    const original = await ec.filas(X, "compra.operacion");
    expect(original.filter((f) => f.entidad_id === op)).toHaveLength(1);
    const cambios = await ec.comoBackend(X, ux, (tx) => leerCambiosDeOperacion(tx, resultado.operacionId));
    expect(cambios).toHaveLength(300);
    expect(cambios[0]!.antes).toMatchObject({ n: 2, biDng: "1000.00" });
    expect(cambios[0]!.despues).toMatchObject({ n: 3, biDg: "1000.00", biDng: "0.00" });
  }, 120_000);

  it("si la masiva se revierte no queda la fila (el constraint trigger diferido corre con la transaccion)", async () => {
    const c2 = await ec.cliente(X);
    const cs = await sembrar(c2, 3, "FA02");
    const antes = (await ec.filas(X, "compra.operacion")).length;
    await expect(
      ec.comoBackend(X, ux, async (tx) => {
        await aplicarMasiva(
          tx,
          {
            clienteId: c2.id,
            periodo: PERIODO,
            usuarioId: ux,
            accion: "clasificar",
            parametros: { tipo: "dng" },
            items: cs.map((x) => ({ compraId: x.id, versionBase: 1 })),
          },
          { transformar: transformarFalso, evaluar: sinHallazgos().evaluar },
        );
        throw new Error("revertir");
      }),
    ).rejects.toThrow("revertir");
    expect((await ec.filas(X, "compra.operacion")).length).toBe(antes);
  });
});

// =================================================================================================
describe("listarAuditoria · orden, cursor, tope de 50 y descifrados (D-6, P-2)", () => {
  let c: ClientePrueba;
  let credId: string;
  const MOTIVO = "MOTIVO-DESCIFRADO-T2-7c1e";

  beforeAll(async () => {
    c = await ec.cliente(X);
    await ec.ea.clientes(X, 60); // 60 filas cliente.creado (sistema)
    credId = await ec.credencial(X, c.id, "sol");
    await ec.comoWorker(X, {}, (tx) =>
      registrarDescifrado(tx, { credencialId: credId, clienteId: c.id, tipo: "sol", motivo: MOTIVO, resultado: "ok" }),
    );
    // Una fila de Y con su propio descifrado, para CA-7.
    await ec.cliente(Y);
  }, 60_000);

  it("devuelve a lo sumo 50 filas por pagina (aunque se pida mas), de la mas nueva a la mas vieja por (ocurridaEn, id)", async () => {
    const p1 = await ec.comoBackend(X, ux, (tx) => listarAuditoria(tx, { limite: 50 }));
    expect(p1).toHaveLength(50);
    const grande = await ec.comoBackend(X, ux, (tx) => listarAuditoria(tx, { limite: 500 }));
    expect(grande.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < p1.length; i++) {
      const a = p1[i - 1]!;
      const b = p1[i]!;
      const ta = new Date(a.ocurridaEn).getTime();
      const tb = new Date(b.ocurridaEn).getTime();
      expect(ta > tb || (ta === tb && a.id > b.id), `orden en ${i}`).toBe(true);
    }
  });

  it("el cursor (ocurridaEn, id) de la ultima fila da la pagina siguiente sin repetir ni saltar: recorre todo el estudio", async () => {
    const todas = await ec.filas(X);
    const descifrados = (await admin.query("select count(*)::int as n from auditoria_descifrado where tenant_id = $1", [X])).rows[0].n;
    const esperado = todas.length + descifrados;
    const vistas: FilaAuditoria[] = [];
    let antes: { en: Date; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const pagina = await ec.comoBackend(X, ux, (tx) => listarAuditoria(tx, antes ? { antes, limite: 50 } : { limite: 50 }));
      if (pagina.length === 0) break;
      vistas.push(...pagina);
      const ult = pagina[pagina.length - 1]!;
      antes = { en: new Date(ult.ocurridaEn), id: ult.id };
    }
    expect(new Set(vistas.map((f) => f.id)).size, "sin repetidas").toBe(vistas.length);
    expect(vistas).toHaveLength(esperado);
    expect(esperado).toBeGreaterThan(60);
  });

  it("incluye los descifrados de 003 como accion `credencial.descifrada` del cliente, sin tocar auditoria_descifrado", async () => {
    const todas: FilaAuditoria[] = [];
    let antes: { en: Date; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const pagina = await ec.comoBackend(X, ux, (tx) => listarAuditoria(tx, antes ? { antes, limite: 50 } : { limite: 50 }));
      if (pagina.length === 0) break;
      todas.push(...pagina);
      const ult = pagina[pagina.length - 1]!;
      antes = { en: new Date(ult.ocurridaEn), id: ult.id };
    }
    const d = todas.filter((f) => f.accion === "credencial.descifrada");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ clienteId: c.id, datos: { tipo: "sol", motivo: MOTIVO, resultado: "ok" } });
    expect(todas.some((f) => f.accion === "cliente.creado")).toBe(true);
  });

  it("CA-7: con la sesion de Y no aparece ninguna fila de X, tampoco el descifrado de X (por la funcion de lectura)", async () => {
    const idsX = new Set((await ec.filas(X)).map((f) => f.id));
    const pagina = await ec.comoBackend(Y, uy, (tx) => listarAuditoria(tx, { limite: 50 }));
    expect(pagina.length).toBeGreaterThan(0);
    expect(pagina.every((f) => !idsX.has(f.id))).toBe(true);
    expect(pagina.some((f) => f.accion === "credencial.descifrada")).toBe(false);
    expect(JSON.stringify(pagina)).not.toContain(MOTIVO);
    const directo = await ec.comoBackend(Y, uy, async (tx) =>
      (await tx.query("select * from auditoria_descifrado_listar(null, null, 50)")).rows,
    );
    expect(JSON.stringify(directo)).not.toContain(MOTIVO);
    const deX = await ec.comoBackend(X, ux, async (tx) =>
      (await tx.query("select * from auditoria_descifrado_listar(null, null, 50)")).rows,
    );
    expect(deX.map((r: { motivo: string }) => r.motivo)).toContain(MOTIVO);
  });

  it("CA-7: sin contexto de estudio la funcion de descifrados no devuelve nada", async () => {
    const r = await ec.backend.withUsuario({ userId: ux }, async (tx) =>
      (await tx.query("select * from auditoria_descifrado_listar(null, null, 50)")).rows,
    );
    expect(r).toEqual([]);
  });
});

// =================================================================================================
describe("CA-6 · sin secretos en auditoria (D-5): guardar, verificar, invalidar y descifrar con centinelas", () => {
  it("ningun valor centinela (en claro, hex ni base64) aparece en auditoria", async () => {
    const CENT = "CENTINELA-SOL-CLAVE-017-5b9d";
    const CENT_SECRET = "CENTINELA-CLIENT-SECRET-017-e2a4";
    const c = await ec.cliente(X);
    const trabajo = await ec.trabajo(X, c, ux);
    await ec.comoBackend(X, ux, (tx) =>
      guardarSobre(tx, {
        clienteId: c.id,
        tipo: "sol",
        sobre: {
          ciphertext: Buffer.concat([Buffer.from(`ct-${CENT}`), randomBytes(32)]),
          nonce: randomBytes(12),
          tag: randomBytes(16),
          dekEnvuelta: Buffer.concat([Buffer.from(`dek-${CENT_SECRET}`), randomBytes(480)]),
          kekId: "k1",
          version: 1,
        },
      }),
    );
    const credId = await ec.credencialCentinela(X, c.id, CENT_SECRET).catch(() => null);
    await ec.comoWorker(X, { trabajoId: trabajo }, async (tx) => {
      await marcarCredencialInvalida(tx, c.id, "sol");
      await registrarDescifrado(tx, {
        credencialId: credId ?? (await tx.query("select id from credencial where cliente_id = $1 limit 1", [c.id])).rows[0].id,
        clienteId: c.id,
        tipo: "sol",
        motivo: "verificar",
        resultado: "ok",
      });
    });
    const volcado = (await admin.query("select to_jsonb(a)::text as t from auditoria a where tenant_id = $1", [X])).rows
      .map((r) => r.t as string)
      .join("\n")
      .toLowerCase();
    for (const s of [CENT, CENT_SECRET]) {
      for (const forma of [s, Buffer.from(s).toString("hex"), Buffer.from(s).toString("base64"), Buffer.from(`ct-${s}`).toString("base64")]) {
        expect(volcado.includes(forma.toLowerCase()), `centinela ${s} (${forma.slice(0, 12)}...)`).toBe(false);
      }
    }
    for (const prohibido of ["ciphertext", "dek_envuelta", "dekenvuelta", "nonce", "password", "hash_contrasena", "token_hash"]) {
      expect(volcado, prohibido).not.toContain(prohibido);
    }
    expect(volcado).toContain("credencial.guardada"); // el control no es vacuo: las filas existen
  });
});

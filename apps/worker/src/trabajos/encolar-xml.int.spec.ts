// Spec 016 (T12b): `encolarLotesXml` con la función acotada `encolar_xml_obtener` de 0037 (PostgreSQL y Redis reales).
// Fija que la clave de dedupe que calcula la función es la misma que `claveDedupe` de @contapp/queue (así deduplica contra el
// backend), el outbox (publicar tras el commit), la cola llena sin error y la propagación de los demás errores.
import { randomUUID } from "node:crypto";
import { TrabajosRepoError, type ContappDb } from "@contapp/db";
import { claveDedupe, crearClaves, encolar } from "@contapp/queue";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  type ClientePrueba,
} from "../../test/trabajos.js";
import { encolarLotesXml } from "./encolar-xml.js";

const PERIODO = "202410";
let admin: ContappDb;
let worker: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let tenant: string;
let otro: string;
let cliente: ClientePrueba;
let ajeno: ClientePrueba;
let usuario: string;
const prefijos: string[] = [];

const ids = (n: number): string[] =>
  Array.from({ length: n }, () => randomUUID()).sort();

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 2);
  backend = crearDbRol("contapp_backend", 2);
  redis = conectarRedis();
  e = new Escenario(admin);
  tenant = await e.estudio();
  otro = await e.estudio();
  cliente = await e.cliente(tenant);
  ajeno = await e.cliente(otro);
  usuario = await e.usuario(tenant);
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), backend?.close(), admin?.close()]);
});

const fila = async (id: string) =>
  (await admin.pool.query("select * from job_registro where id = $1", [id]))
    .rows[0];
const xmlDelEstudio = async () =>
  (
    await admin.pool.query(
      "select id, parametros, clave_dedupe from job_registro where tenant_id = $1 and tipo = 'xml.obtener' order by creado_en, id",
      [tenant],
    )
  ).rows as {
    id: string;
    parametros: { compraIds: string[] };
    clave_dedupe: Buffer;
  }[];
const borrarXml = () =>
  admin.pool.query(
    "delete from job_registro where tenant_id = $1 and tipo = 'xml.obtener'",
    [tenant],
  );

describe("encolarLotesXml con encolar_xml_obtener", () => {
  it("encola el lote canónico (ordenado, único, en minúscula) y la clave de dedupe es la de `claveDedupe` de TS", async () => {
    await borrarXml();
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const base = ids(3);
    const desordenado = [base[2]!.toUpperCase(), base[0]!, base[1]!, base[0]!];
    const r = await encolarLotesXml(
      { db: worker, redis, prefijo },
      {
        tenantId: tenant,
        clienteId: cliente.id,
        usuarioId: usuario,
        periodo: PERIODO,
        lotes: [desordenado],
      },
    );
    expect(r).toEqual({ encolados: 1, colaLlena: false });
    const [t] = await xmlDelEstudio();
    expect(t!.parametros.compraIds).toEqual(base);
    const esperada = claveDedupe("xml.obtener", cliente.id, {
      periodo: PERIODO,
      compraIds: base,
    });
    expect(Buffer.compare(t!.clave_dedupe, esperada)).toBe(0);
    expect(await fila(t!.id)).toMatchObject({
      prioridad: "programado",
      creado_por: usuario,
      cola: "xml",
    });
    // Publicado tras el commit: la pista del estudio en la cola xml.
    const pend = await redis.zrange(
      crearClaves(prefijo).pend("xml", tenant),
      "0",
      "-1",
    );
    expect(pend).toEqual([t!.id]);
    // El backend, con la misma entrada, deduplica contra el trabajo del worker.
    const b = await backend.withTenant({ tenantId: tenant }, (tx) =>
      encolar(tx, {
        tipo: "xml.obtener",
        clienteId: cliente.id,
        parametros: { periodo: PERIODO, compraIds: base },
        prioridad: "interactivo",
        creadoPor: null,
      }),
    );
    expect(b).toMatchObject({ nuevo: false, trabajo: { id: t!.id } });
  });

  it("repetir un lote vivo no cuenta ni publica; sin Redis solo escribe en BD", async () => {
    await borrarXml();
    const lote = ids(2);
    const entrada = {
      tenantId: tenant,
      clienteId: cliente.id,
      usuarioId: usuario,
      periodo: PERIODO,
      lotes: [lote],
    };
    expect(await encolarLotesXml({ db: worker }, entrada)).toEqual({
      encolados: 1,
      colaLlena: false,
    });
    expect(await encolarLotesXml({ db: worker, redis }, entrada)).toEqual({
      encolados: 0,
      colaLlena: false,
    });
    expect(await xmlDelEstudio()).toHaveLength(1);
  });

  it("con la cola llena se detiene sin error y deja lo ya encolado", async () => {
    await borrarXml();
    await fijarConfig(admin, "xml", { maxPendientes: 1 });
    try {
      const r = await encolarLotesXml(
        { db: worker, redis },
        {
          tenantId: tenant,
          clienteId: cliente.id,
          usuarioId: usuario,
          periodo: PERIODO,
          lotes: [ids(2), ids(2), ids(2)],
        },
      );
      expect(r).toEqual({ encolados: 1, colaLlena: true });
      expect(await xmlDelEstudio()).toHaveLength(1);
    } finally {
      await restaurarConfig(admin);
    }
  });

  it("otro error de la función (cliente de otro estudio) se propaga como TrabajosRepoError 23503 sin crear nada", async () => {
    await borrarXml();
    const error = await encolarLotesXml(
      { db: worker },
      {
        tenantId: tenant,
        clienteId: ajeno.id,
        usuarioId: usuario,
        periodo: PERIODO,
        lotes: [ids(2)],
      },
    ).catch((x: unknown) => x);
    expect(error).toBeInstanceOf(TrabajosRepoError);
    expect((error as TrabajosRepoError).codigo).toBe("23503");
    expect(await xmlDelEstudio()).toHaveLength(0);
  });
});

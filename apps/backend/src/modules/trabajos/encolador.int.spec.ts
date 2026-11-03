/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y mensajes JSON dinámicos en pruebas */
// T6 (008) · CA-1 (RF-040): `Encolador` crea la fila `job_registro` en la transacción `withTenant` del caso de uso y
// la publica en Redis DESPUÉS del commit (D3); si la transacción falla no queda nada en Redis; con Redis caído la
// petición no espera ni falla y el trabajo queda `en_cola`. PG y Redis reales; la app se levanta con `crearApp`.
// Rojo: `./encolador.js` y la opción `redis` de `crearApp` aún no existen (T11).
//
// Contrato fijado por estas pruebas (T11):
//  - `import { Encolador } from "./encolador.js"`: clase `@Injectable()` registrada en el módulo (token = la clase;
//    `app.get(Encolador)`). Método `encolar(ctx: { tenantId: string; userId?: string }, e: EntradaEncolar):
//    Promise<ResultadoEncolar>` (ambos tipos de `@contapp/queue`): abre un `withTenant(ctx)`, llama a `encolar`, hace
//    commit y solo entonces `publicar` (pista `pend:{cola}:{tenantId}` y `tenants:{cola}`) y emite el evento `trabajo`
//    (`estado: "en_cola"`, `posicion: null`) en `eventos:{tenantId}`. Con `nuevo: false` (dedupe, D8) no publica nada.
//  - Los errores de `encolar` (`TipoDesconocidoError`, `ParametrosInvalidosError`, `ClienteDesconocidoError`,
//    `ColaLlenaError`...) se propagan sin envolver; no queda fila ni nada en Redis.
//  - `crearApp({ redis: { url, prefijo } })` (ver `test/soporte-trabajos.ts`). Con Redis caído `crearApp` no falla, las
//    lecturas de BD responden y `Encolador.encolar` termina en menos de 5 s con el trabajo `en_cola` (los errores de
//    Redis no se propagan; el reconciliador repone al volver).
import { randomUUID } from "node:crypto";
import {
  ClienteDesconocidoError,
  ParametrosInvalidosError,
  TipoDesconocidoError,
  type EntradaEncolar,
} from "@contapp/queue";
import { trabajoVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  observarEventos,
  URL_REDIS_CAIDO,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";
import { Encolador } from "./encolador.js";

let b: BancoTrabajos;
let E: Estudio;
let ajeno: Estudio;
let cliente: string;
let clienteAjeno: string;
let n = 0;
const entrada = (o: Partial<EntradaEncolar> = {}): EntradaEncolar => ({
  tipo: "prueba.eco",
  clienteId: cliente,
  parametros: { n: (n += 1) },
  prioridad: "interactivo",
  creadoPor: E.titular.id,
  ...o,
});
const ctx = () => ({ tenantId: E.tenantId, userId: E.titular.id });
const encolador = () => b.h.app.get(Encolador);
const enRedis = (id: string) =>
  b.redis.zscore(b.claves.pend("sire", E.tenantId), id) as Promise<
    string | null
  >;
const filas = async (): Promise<number> =>
  (
    await b.sql(
      "select count(*)::int as n from job_registro where tenant_id = $1",
      [E.tenantId],
    )
  )[0].n;

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  ajeno = await b.estudio();
  [cliente] = (await b.clientes(E.tenantId, 1)) as [string];
  [clienteAjeno] = (await b.clientes(ajeno.tenantId, 1)) as [string];
});
afterAll(async () => {
  await b?.cerrar();
});

describe("CA-1 · encolar crea la fila y publica después del commit", () => {
  it("devuelve el trabajo en_cola (vista pública), la fila existe en el estudio del contexto y Redis recibe la pista", async () => {
    const e = entrada();
    const { trabajo, nuevo } = await encolador().encolar(ctx(), e);
    expect(nuevo).toBe(true);
    expect(trabajoVistaSchema.safeParse(trabajo).success).toBe(true);
    expect(trabajo).toMatchObject({
      tipo: "prueba.eco",
      clienteId: cliente,
      estado: "en_cola",
      intentos: 0,
      motivo: null,
      creadoPor: { usuarioId: E.titular.id },
    });
    const fila = await b.fila(trabajo.id);
    expect(fila).toMatchObject({
      tenant_id: E.tenantId,
      cliente_id: cliente,
      estado: "en_cola",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
    });
    expect(await enRedis(trabajo.id)).not.toBeNull();
    expect(await b.redis.sismember(b.claves.tenants("sire"), E.tenantId)).toBe(
      1,
    );
  });

  it("el estudio sale del contexto: un trabajo programado sin creador queda en el estudio del contexto", async () => {
    const { trabajo } = await encolador().encolar(
      { tenantId: E.tenantId },
      entrada({ prioridad: "programado", creadoPor: null }),
    );
    expect(trabajo.creadoPor).toBeNull();
    expect((await b.fila(trabajo.id)).tenant_id).toBe(E.tenantId);
    expect((await b.fila(trabajo.id)).prioridad).toBe("programado");
  });

  it("publica en Redis solo después del commit: cuando Redis recibe el ZADD, la fila ya es visible desde otra conexión", async () => {
    const monitor = await b.redis.monitor();
    const visibles: Promise<boolean>[] = [];
    monitor.on("monitor", (_hora: string, args: string[]) => {
      if (
        String(args[0]).toLowerCase() === "zadd" &&
        args[1] === b.claves.pend("sire", E.tenantId)
      ) {
        visibles.push(
          b
            .fila(String(args[args.length - 1]))
            .then((f) => f !== undefined && f.estado === "en_cola"),
        );
      }
    });
    try {
      const { trabajo } = await encolador().encolar(ctx(), entrada());
      await new Promise((r) => setTimeout(r, 300));
      expect(
        visibles.length,
        "no se vio el ZADD de la pista",
      ).toBeGreaterThanOrEqual(1);
      expect(await Promise.all(visibles)).toEqual(visibles.map(() => true));
      expect(await enRedis(trabajo.id)).not.toBeNull();
    } finally {
      monitor.disconnect();
    }
  });

  it("emite el evento trabajo/en_cola en eventos:{tenantId} después del commit", async () => {
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      const { trabajo } = await encolador().encolar(ctx(), entrada());
      const ev = await obs.esperar((m) => m.id === trabajo.id);
      expect(ev).not.toBeNull();
      expect(trabajoVistaSchema.safeParse(ev).success).toBe(true);
      expect(ev).toMatchObject({
        estado: "en_cola",
        posicion: null,
        clienteId: cliente,
        intentos: 0,
        motivo: null,
      });
    } finally {
      obs.cerrar();
    }
  });

  it("encolar lo mismo dos veces devuelve el mismo trabajo (D8): una fila, una pista y un solo evento", async () => {
    const e = entrada({ parametros: { n: 424242 } });
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      const a = await encolador().encolar(ctx(), e);
      const otra = await encolador().encolar(ctx(), { ...e });
      expect(a.nuevo).toBe(true);
      expect(otra.nuevo).toBe(false);
      expect(otra.trabajo.id).toBe(a.trabajo.id);
      expect(
        (
          await b.sql(
            "select count(*)::int as n from job_registro where id = $1",
            [a.trabajo.id],
          )
        )[0].n,
      ).toBe(1);
      await obs.esperar((m) => m.id === a.trabajo.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(obs.mensajes.filter((m) => m.id === a.trabajo.id)).toHaveLength(1);
    } finally {
      obs.cerrar();
    }
  });
});

describe("CA-1 · si la transacción falla, no queda nada en Redis", () => {
  it("un creador que no es miembro (FK) rechaza el encolado sin fila, sin pista y sin evento", async () => {
    const antes = await filas();
    const zset = await b.redis.zcard(b.claves.pend("sire", E.tenantId));
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      await expect(
        encolador().encolar(ctx(), entrada({ creadoPor: randomUUID() })),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 300));
      expect(await filas()).toBe(antes);
      expect(await b.redis.zcard(b.claves.pend("sire", E.tenantId))).toBe(zset);
      expect(obs.mensajes).toEqual([]);
    } finally {
      obs.cerrar();
    }
  });

  it("los errores de encolar se propagan tipados y no dejan nada: parámetros inválidos, tipo desconocido y cliente de otro estudio", async () => {
    const antes = await filas();
    const zset = await b.redis.zcard(b.claves.pend("sire", E.tenantId));
    await expect(
      encolador().encolar(
        ctx(),
        entrada({ parametros: { n: "no-es-numero" } }),
      ),
    ).rejects.toBeInstanceOf(ParametrosInvalidosError);
    await expect(
      encolador().encolar(ctx(), entrada({ tipo: "no.existe" })),
    ).rejects.toBeInstanceOf(TipoDesconocidoError);
    await expect(
      encolador().encolar(ctx(), entrada({ clienteId: clienteAjeno })),
    ).rejects.toBeInstanceOf(ClienteDesconocidoError);
    await expect(
      encolador().encolar(ctx(), entrada({ clienteId: randomUUID() })),
    ).rejects.toBeInstanceOf(ClienteDesconocidoError);
    expect(await filas()).toBe(antes);
    expect(await b.redis.zcard(b.claves.pend("sire", E.tenantId))).toBe(zset);
    // Ni rastro en el otro estudio.
    expect(
      (
        await b.sql(
          "select count(*)::int as n from job_registro where tenant_id = $1",
          [ajeno.tenantId],
        )
      )[0].n,
    ).toBe(0);
  });
});

describe("CA-1 · con Redis caído la petición no falla ni espera", () => {
  let caido: BancoTrabajos;
  let Ec: Estudio;
  let clienteC: string;

  beforeAll(async () => {
    caido = await abrirBancoTrabajos({ redisApp: URL_REDIS_CAIDO });
    Ec = await caido.estudio();
    [clienteC] = (await caido.clientes(Ec.tenantId, 1)) as [string];
  });
  afterAll(async () => {
    await caido?.cerrar();
  });

  it("la app arranca y las lecturas de BD responden", async () => {
    const t0 = Date.now();
    const r = await caido.llamar(Ec.titular, "GET", "/trabajos");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("Encolador.encolar termina en menos de 5 s con el trabajo en_cola; la fila existe y Redis no recibió nada", async () => {
    const t0 = Date.now();
    const { trabajo, nuevo } = await caido.h.app.get(Encolador).encolar(
      { tenantId: Ec.tenantId, userId: Ec.titular.id },
      {
        tipo: "prueba.eco",
        clienteId: clienteC,
        parametros: { n: 7 },
        prioridad: "interactivo",
        creadoPor: Ec.titular.id,
      },
    );
    expect(Date.now() - t0, "encolar esperó a un Redis caído").toBeLessThan(
      5000,
    );
    expect(nuevo).toBe(true);
    expect(trabajo.estado).toBe("en_cola");
    expect((await caido.fila(trabajo.id)).estado).toBe("en_cola");
    // Lo que falta en Redis lo repone el reconciliador al volver (T5/T9/T10).
    expect(
      await caido.redis.zscore(
        caido.claves.pend("sire", Ec.tenantId),
        trabajo.id,
      ),
    ).toBeNull();
    // Y el trabajo es visible por la API.
    const lista = await caido.llamar(Ec.titular, "GET", "/trabajos");
    expect(lista.body.map((x: any) => x.id)).toContain(trabajo.id);
  }, 30_000);
});

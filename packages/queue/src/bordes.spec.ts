import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ClienteDesconocidoError,
  ColaNoConfiguradaError,
  Despachador,
  ParametrosInvalidosError,
  TipoInvalidoError,
  aPublicable,
  claveDedupe,
  crearClaves,
  encolar,
  jsonCanonico,
  publicarEvento,
  registrarTipo,
  rolesPermitidos,
  vistaDeFila,
} from "./index.js";
import { bd, dbFalsa, uuidDe } from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

vi.mock(
  "@contapp/db",
  async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso,
);

// T9 (backend): casos borde de packages/queue que las pruebas de T4/T4b no recorren (cobertura por
// archivo, DoD A). Las firmas son las de los encabezados de T4; el doble de BD es bd-falsa.ts.
const TA = uuidDe(0xa1);
const CLIENTE = uuidDe(0xc1);
const tx = { tenantId: TA } as never;

registrarTipo({
  tipo: "bordes.sire",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "bordes.archivos",
  cola: "archivos",
  canal: "ninguno",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});

let reloj: RelojFalso;
let redis: RedisFalso;
let agregados: unknown[];
const k = crearClaves("p1:");

beforeEach(() => {
  bd.reiniciar();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  agregados = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function sembrar(extra: Record<string, unknown> = {}): Promise<string> {
  const id = bd.siguienteId();
  const creadoEn = new Date(reloj.ms() - 1000);
  bd.trabajos.set(id, {
    id,
    tenantId: TA,
    clienteId: CLIENTE,
    ruc: "20100000001",
    tipo: "bordes.sire",
    cola: "sire",
    canal: "sire",
    prioridad: "interactivo",
    estado: "en_cola",
    intentos: 0,
    motivo: null,
    creadoPor: null,
    creadoEn,
    disponibleDesde: creadoEn,
    iniciadoEn: null,
    terminadoEn: null,
    claveDedupe: id,
    parametros: {},
    ...extra,
  });
  await redis.sadd(k.tenants("sire"), TA);
  return id;
}

const despachador = (
  o: Partial<ConstructorParameters<typeof Despachador>[0]> = {},
) =>
  new Despachador({
    db: dbFalsa as never,
    redis: redis as never,
    reloj,
    prefijo: "p1:",
    agregarACola: async (_c, p) => {
      agregados.push(p);
    },
    ...o,
  });

describe("despachador: bordes", () => {
  it("un tipo que ya no esta en el catalogo termina en error/error_interno sin ejecutarse", async () => {
    const id = await sembrar({ tipo: "bordes.retirado" });
    await despachador().ciclo();
    expect(bd.trabajos.get(id)).toMatchObject({
      estado: "error",
      motivo: "error_interno",
    });
    expect(agregados).toHaveLength(0);
    const evento = redis.publicados.find((p) => p.canal === k.eventos(TA));
    expect(JSON.parse(evento!.mensaje)).toMatchObject({
      id,
      estado: "error",
      motivo: "error_interno",
    });
  });

  it("si descartar pierde la carrera no publica evento ni toma nada", async () => {
    const id = await sembrar({ tipo: "bordes.retirado" });
    bd.perdedores.add(id);
    await despachador().ciclo();
    expect(bd.trabajos.get(id)!.estado).toBe("cancelado");
    expect(redis.publicados).toHaveLength(0);
  });

  it("si agregarACola falla el trabajo queda ejecutando con su arriendo y el ciclo no lanza", async () => {
    const id = await sembrar();
    await expect(
      despachador({
        agregarACola: async () => {
          throw new Error("bullmq caido CANARIO-TOKEN-x");
        },
      }).ciclo(),
    ).resolves.toBeUndefined();
    expect(bd.trabajos.get(id)!.estado).toBe("ejecutando");
    expect(await redis.zscore(k.cupoGlobal("sire"), id)).not.toBeNull();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "CANARIO",
    );
  });

  it("si la transaccion falla despues de tomar el lock, lo suelta", async () => {
    const id = await sembrar();
    const db = {
      ...dbFalsa,
      withTenant: async (
        ctx: { tenantId: string },
        fn: (t: unknown) => Promise<unknown>,
      ) => {
        await dbFalsa.withTenant(ctx, fn as never);
        throw new Error("commit fallido");
      },
    };
    await despachador({ db: db as never }).ciclo();
    expect(await redis.exists(k.lockRuc("sire", "20100000001"))).toBe(0);
    expect(agregados).toHaveLength(0);
    expect(bd.trabajos.get(id)).toBeDefined();
  });

  it("si soltar el lock falla tampoco lanza (el lock vence solo)", async () => {
    await sembrar();
    const db = {
      ...dbFalsa,
      withTenant: async (
        ctx: { tenantId: string },
        fn: (t: unknown) => Promise<unknown>,
      ) => {
        await dbFalsa.withTenant(ctx, fn as never);
        redis.fallar(new Error("redis caido"));
        throw new Error("commit fallido");
      },
    };
    await expect(
      despachador({ db: db as never }).ciclo(),
    ).resolves.toBeUndefined();
  });

  it("un fallo de Redis en una cola no impide el ciclo", async () => {
    await sembrar();
    vi.spyOn(redis, "smembers").mockRejectedValueOnce(new Error("x"));
    await expect(despachador().ciclo()).resolves.toBeUndefined();
  });

  it("pierde el liderazgo si la renovacion no encuentra la clave", async () => {
    const d = despachador();
    await d.ciclo();
    await sembrar();
    vi.spyOn(redis, "pexpire").mockResolvedValueOnce(0);
    await d.ciclo();
    expect(agregados).toHaveLength(0);
    await d.ciclo();
    expect(agregados).toHaveLength(1);
  });

  it("canal ninguno no toma lock de RUC", async () => {
    bd.config.set("archivos", { ...bd.config.get("sire")! });
    const id = await sembrar({
      tipo: "bordes.archivos",
      cola: "archivos",
      canal: "ninguno",
    });
    await redis.sadd(k.tenants("archivos"), TA);
    await despachador().ciclo();
    expect(bd.trabajos.get(id)!.estado).toBe("ejecutando");
    expect(redis.claves().some((c) => c.includes("lock:ruc"))).toBe(false);
  });
});

describe("encolado: bordes", () => {
  const entrada = (extra: Record<string, unknown> = {}) => ({
    tipo: "bordes.sire",
    clienteId: CLIENTE,
    parametros: {},
    prioridad: "interactivo" as const,
    creadoPor: null,
    ...extra,
  });

  it("guarda max_intentos = 1 + reintentos y el RUC del cliente", async () => {
    await encolar(tx, entrada());
    expect(bd.insertados[0]).toMatchObject({
      maxIntentos: 4,
      ruc: "20100000001",
    });
  });

  it("una prioridad fuera del catalogo lanza ParametrosInvalidosError", async () => {
    await expect(
      encolar(tx, entrada({ prioridad: "urgente" })),
    ).rejects.toBeInstanceOf(ParametrosInvalidosError);
    expect(bd.insertados).toHaveLength(0);
  });

  it("una cola sin fila en config_sistema lanza ColaNoConfiguradaError sin insertar", async () => {
    const e: unknown = await encolar(
      tx,
      entrada({ tipo: "bordes.archivos" }),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ColaNoConfiguradaError);
    expect((e as { codigo: string }).codigo).toBe("cola_no_configurada");
    expect(bd.insertados).toHaveLength(0);
  });

  it("un cliente que no es del estudio lanza ClienteDesconocidoError sin insertar", async () => {
    const { moduloDbFalso } = await import("./soporte-pruebas/bd-falsa.js");
    vi.spyOn(moduloDbFalso, "leerCliente").mockResolvedValueOnce(null as never);
    const e: unknown = await encolar(tx, entrada()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClienteDesconocidoError);
    expect((e as { codigo: string }).codigo).toBe("cliente_no_encontrado");
    expect(bd.insertados).toHaveLength(0);
  });

  it("aPublicable toma la cola del catalogo y el estudio del contexto", async () => {
    const { trabajo } = await encolar(tx, entrada());
    expect(aPublicable(TA, trabajo, "interactivo")).toEqual({
      id: trabajo.id,
      tenantId: TA,
      cola: "sire",
      prioridad: "interactivo",
      creadoEn: trabajo.creadoEn,
    });
  });
});

describe("eventos", () => {
  const fila = {
    id: uuidDe(1),
    tipo: "bordes.sire",
    clienteId: CLIENTE,
    intentos: 0,
    creadoPor: uuidDe(2),
    creadoEn: new Date("2026-10-27T15:00:00.000Z"),
  };

  it("vistaDeFila arma la vista publica sin datos internos", () => {
    const v = vistaDeFila(
      { ...fila, ruc: "20100000001", parametros: { x: 1 } } as never,
      { estado: "ejecutando", motivo: null, iniciadoEn: fila.creadoEn },
    );
    expect(v).toEqual({
      id: fila.id,
      tipo: "bordes.sire",
      clienteId: CLIENTE,
      estado: "ejecutando",
      posicion: null,
      intentos: 0,
      motivo: null,
      creadoEn: "2026-10-27T15:00:00.000Z",
      iniciadoEn: "2026-10-27T15:00:00.000Z",
      terminadoEn: null,
      creadoPor: { usuarioId: uuidDe(2) },
    });
  });

  it("un evento invalido no se publica", async () => {
    const v = vistaDeFila(
      { ...fila, id: "no-uuid" },
      { estado: "ejecutando", motivo: null },
    );
    await publicarEvento(redis as never, TA, v);
    expect(redis.publicados).toHaveLength(0);
  });

  it("un fallo de Redis al publicar no se propaga", async () => {
    redis.fallar(new Error("caido"));
    await expect(
      publicarEvento(
        redis as never,
        TA,
        vistaDeFila(fila, { estado: "en_cola", motivo: null }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("catalogo y claves: bordes", () => {
  const base = {
    tipo: "bordes.conflicto",
    cola: "sire",
    canal: "sire",
    credencial: null,
    permiso: null,
    idempotente: true,
    parametros: z.object({}),
  } as const;

  it("no deja redefinir un tipo con otra forma, pero si repetir la misma", () => {
    registrarTipo(base);
    expect(() => registrarTipo({ ...base })).not.toThrow();
    expect(() => registrarTipo({ ...base, idempotente: false })).toThrow(
      TipoInvalidoError,
    );
    expect(() => registrarTipo({ ...base, cola: "sol" })).toThrow(
      TipoInvalidoError,
    );
  });

  it.each([
    ["cola", { cola: "otra" }],
    ["canal", { canal: "fax" }],
    ["credencial", { credencial: "clave" }],
    ["permiso", { permiso: "todo.poder" }],
    ["idempotente", { idempotente: "si" }],
    ["parametros", { parametros: {} }],
  ])("rechaza una definicion con %s invalido", (_n, malo) => {
    expect(() =>
      registrarTipo({ ...base, tipo: "bordes.malo", ...malo } as never),
    ).toThrow(TipoInvalidoError);
  });

  it("rechaza una definicion que no es objeto", () => {
    expect(() => registrarTipo(null as never)).toThrow(TipoInvalidoError);
  });

  it("rolesPermitidos: null sin permiso", () => {
    expect(rolesPermitidos(null)).toBeNull();
  });

  it("jsonCanonico usa toJSON, omite claves undefined y pone null en arreglos", () => {
    expect(
      jsonCanonico({
        b: undefined,
        a: new Date("2026-01-01T00:00:00.000Z"),
        c: [undefined, 1],
      }),
    ).toBe('{"a":"2026-01-01T00:00:00.000Z","c":[null,1]}');
    expect(jsonCanonico(undefined)).toBe("null");
  });

  it("claveDedupe acepta parametros ausentes", () => {
    expect(claveDedupe("a.b", CLIENTE, undefined)).toHaveLength(32);
  });
});

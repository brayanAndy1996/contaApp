/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD sin tipo en pruebas */
import { randomBytes } from "node:crypto";
import { crearKeyWrapper, cifrarCredencial } from "@contapp/crypto";
import type { Sobre, TipoCredencial } from "@contapp/crypto";
import {
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
} from "@contapp/crypto/descifrado";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  borrarDirectorio,
  directorioTemporal,
  envBackend,
  envWorker,
  generarParLocal,
  guardar,
  instantanea,
  limpiar,
  SEED,
  type ParLocal,
} from "../../test/bd.js";
import { loggerEspia, uuid, valorDe } from "../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dbEspiada,
  Escenario,
  esperarHasta,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../test/trabajos.js";
import { main as encolarKekRotar } from "../cli/encolar-kek-rotar.js";
import { crearServicioCredenciales } from "../credenciales/descifrar-credencial.js";
import { authPurgar } from "./procesadores/auth-purgar.js";
import { kekRotar } from "./procesadores/kek-rotar.js";

// Spec 008, T5 (rojo; integración con PostgreSQL y Redis reales): trabajos de sistema (D10). CA-12 (`kek.rotar`) y CA-13 (`auth.purgar`).
//
// CONTRATO que fija (T10), en apps/worker/src/trabajos/procesadores/ y apps/worker/src/cli/:
// - `kek-rotar.ts`: `kekRotar({ db, anterior, activa, desde, lote?, logger? }) → Promise<{ estudios, reenvueltas, omitidas, corruptas }>`
//     (conteos numéricos). Enumera los estudios con `withSistema(estudiosIds)` (una sola transacción de sistema, ya cerrada) y luego rota
//     cada estudio con `rotarKekTenantDetalle` (003) en su propio `withTenant`, EN SECUENCIA y NUNCA anidado. Una fila corrupta no
//     aborta: se cuenta en `corruptas` (la KEK anterior no se puede jubilar). No crea filas en `job_registro` (D10).
// - `auth-purgar.ts`: `authPurgar({ db, retenciones?, trabajosDias?, logger? }) → Promise<{ sesiones, tokens, intentos, limites, trabajos }>`.
//     Retenciones por defecto de D16 en días: { sesionDias: 30, tokenDias: 7, intentoDias: 90, limiteDias: 1 }, `trabajosDias` = 90.
//     Llama a `purgarAuth` con `withSistema` y borra los `job_registro` terminados con `purgarTerminados` en un `withTenant` por estudio
//     (estudiosIds), en secuencia. Una retención < 1 día falla (TrabajosRepoError, SQLSTATE 22023) sin borrar nada. No toca sesiones vigentes.
// - `cli/encolar-kek-rotar.ts`: `main(argv, env, deps?) → Promise<number>` (nunca lanza), `deps = { conexionBull?, prefijo?, escribir?, escribirError? }`.
//     `--desde <kekId>` (kekId con la forma de 003: ^[a-z0-9][a-z0-9-]{0,62}$) encola en BullMQ, cola `programados`, un job de nombre
//     `kek.rotar` con data EXACTA { tipo: "kek.rotar", desde } y sale 0; argumentos inválidos (falta, repetido, forma mala, opción
//     desconocida) → 2 sin tocar Redis. La salida no incluye REDIS_URL ni credenciales.
// - `iniciarTrabajos({ kek: { activa, anterior(desde) } })` atiende ese job: rota todos los estudios y registra un `auth.purgar`
//     repetible diario (03:30, America/Lima) en la cola `programados`; ninguno de los dos crea filas en `job_registro`.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const A = SEED.tenantA;
const B = SEED.tenantB;
const MOTIVO = "prueba:rotacion";

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
let dir: string;
let k1: ParLocal;
let k2: ParLocal;
const clientes: string[] = [];
const prefijos: string[] = [];
const procesos: ProcesoWorker[] = [];

const activaK2 = () => crearKeyUnwrapper(envWorker(k2));
const anteriorK1 = () =>
  crearKeyUnwrapperAnterior({ kekId: "k1", rutaPrivada: k1.privada });

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  redis = conectarRedis();
  e = new Escenario(admin);
  dir = await directorioTemporal();
  [k1, k2] = await Promise.all([
    generarParLocal(dir, "k1"),
    generarParLocal(dir, "k2"),
  ]);
  await limpiar(admin, { kekIds: ["k1", "k2"] });
});

afterAll(async () => {
  await Promise.all(
    procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)),
  );
  await limpiar(admin, { kekIds: ["k1", "k2"], clientes }).catch(
    () => undefined,
  );
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  if (dir) await borrarDirectorio(dir);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

interface Sembrada {
  id: string;
  tenantId: string;
  clienteId: string;
  tipo: TipoCredencial;
  valor: Record<string, string>;
  sobre: Sobre;
}

/** Credenciales envueltas con la KEK k1 (guardadas con el rol backend, la única vía de escritura). */
async function sembrarK1(
  tenantId: string,
  tipos: TipoCredencial[],
): Promise<Sembrada[]> {
  const w = crearKeyWrapper(envBackend(k1));
  const salida: Sembrada[] = [];
  for (const tipo of tipos) {
    const clienteId = uuid();
    clientes.push(clienteId);
    const valor = valorDe(tipo, uuid().slice(0, 8)) as Record<string, string>;
    const sobre = await cifrarCredencial(
      w,
      { tenantId, clienteId, tipo },
      valor as never,
    );
    const id = await guardar(backend, tenantId, clienteId, tipo, sobre);
    salida.push({ id, tenantId, clienteId, tipo, valor, sobre });
  }
  return salida;
}

async function secretoDe(tenantId: string, id: string) {
  const { descifrarCredencial } = crearServicioCredenciales({
    db: worker as never,
    unwrapper: activaK2(),
    logger: loggerEspia().logger as never,
  });
  return (await descifrarCredencial({ tenantId }, id, MOTIVO)).usar((v) => ({
    ...v,
  }));
}

const kekDe = async (s: Sembrada) =>
  (await instantanea(worker, s.tenantId, [s.id])).get(s.id)!.kek_id;
const sinFilasDeSistema = async () =>
  Number(
    (
      await admin.pool.query(
        "select count(*)::int as n from job_registro where tipo ~ '^(kek|auth)[.]'",
      )
    ).rows[0].n,
  );

describe("CA-12: kek.rotar rota todos los estudios, cada uno en su transacción, sin anidar", () => {
  it("rota los estudios del seed y uno nuevo con el rol del worker (sin BYPASSRLS), conserva los secretos y nunca anida withTenant", async () => {
    const T = await e.estudio();
    const sembradas = [
      ...(await sembrarK1(A, ["sol", "sire_api"])),
      ...(await sembrarK1(B, ["sol"])),
      ...(await sembrarK1(T, ["sol", "sire_api", "sol"])),
    ];
    for (const s of sembradas) expect(await kekDe(s)).toBe("k1");

    const espia = dbEspiada(worker, { muerto: false });
    const r = await kekRotar({
      db: espia.db,
      anterior: anteriorK1(),
      activa: activaK2(),
      desde: "k1",
    });

    expect(Object.keys(r).sort()).toEqual([
      "corruptas",
      "estudios",
      "omitidas",
      "reenvueltas",
    ]);
    expect(
      r.estudios,
      "recorre todos los estudios de la base (al menos A, B y el nuevo)",
    ).toBeGreaterThanOrEqual(3);
    expect(r.reenvueltas).toBeGreaterThanOrEqual(sembradas.length);
    expect(r.corruptas).toBe(0);
    for (const s of sembradas)
      expect(await kekDe(s), `credencial ${s.id}`).toBe("k2");
    for (const s of [sembradas[0]!, sembradas[2]!, sembradas[3]!])
      expect(await secretoDe(s.tenantId, s.id)).toEqual(s.valor);

    expect(
      espia.estado.maxAbiertas,
      "withTenant nunca anidado (ni dentro de withSistema)",
    ).toBe(1);
    expect(
      espia.estado.aperturas,
      "1 enumeración + al menos una transacción por estudio",
    ).toBeGreaterThanOrEqual(1 + 3);
    expect(
      await sinFilasDeSistema(),
      "los trabajos de sistema no dejan filas en job_registro (D10)",
    ).toBe(0);
  });

  it("es idempotente: la segunda corrida no cambia nada", async () => {
    const T = await e.estudio();
    const sembradas = await sembrarK1(T, ["sol", "sire_api"]);
    const a = await kekRotar({
      db: worker,
      anterior: anteriorK1(),
      activa: activaK2(),
      desde: "k1",
    });
    expect(a.reenvueltas).toBeGreaterThanOrEqual(2);
    const antes = await instantanea(
      worker,
      T,
      sembradas.map((s) => s.id),
    );
    const b = await kekRotar({
      db: worker,
      anterior: anteriorK1(),
      activa: activaK2(),
      desde: "k1",
    });
    expect(b.reenvueltas).toBe(0);
    const despues = await instantanea(
      worker,
      T,
      sembradas.map((s) => s.id),
    );
    for (const s of sembradas)
      expect(
        Buffer.compare(
          despues.get(s.id)!.dek_envuelta,
          antes.get(s.id)!.dek_envuelta,
        ),
      ).toBe(0);
  });

  it("una fila corrupta no aborta la rotación: se cuenta en corruptas y las demás se rotan", async () => {
    const T = await e.estudio();
    const [buena, mala] = await sembrarK1(T, ["sol", "sire_api"]);
    // Un bit alterado en la DEK envuelta: la KEK anterior no la abre (la rotación no descifra el ciphertext).
    await admin.pool.query(
      "update credencial set dek_envuelta = set_byte(dek_envuelta, 100, get_byte(dek_envuelta, 100) # 1) where id = $1",
      [mala!.id],
    );
    const r = await kekRotar({
      db: worker,
      anterior: anteriorK1(),
      activa: activaK2(),
      desde: "k1",
    });
    expect(r.corruptas).toBeGreaterThanOrEqual(1);
    expect(await kekDe(buena!)).toBe("k2");
    expect(
      await kekDe(mala!),
      "la corrupta sigue en k1: la KEK anterior no se puede jubilar",
    ).toBe("k1");
    await admin.pool.query("delete from credencial where id = $1", [mala!.id]);
  });
});

describe("CLI trabajos:kek-rotar (encolar-kek-rotar)", () => {
  const correr = async (argv: string[], prefijo: string) => {
    const salida: string[] = [];
    const codigo = await encolarKekRotar(
      argv,
      { REDIS_URL: process.env.REDIS_URL },
      {
        conexionBull: opcionesBull(),
        prefijo,
        escribir: (l: string) => salida.push(l),
        escribirError: (l: string) => salida.push(l),
      },
    );
    return { codigo, salida: salida.join("\n") };
  };
  const jobsDeSistema = async (prefijo: string) => {
    const claves = await redis.keys(`${prefijo}bull:programados:*`);
    const filas = [];
    for (const c of claves)
      if ((await redis.type(c)) === "hash") filas.push(await redis.hgetall(c));
    return filas.filter((f) => f.name === "kek.rotar");
  };

  it("--desde <kekId> encola un job kek.rotar en la cola programados con data exacta y sale 0, sin imprimir la URL de Redis", async () => {
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const r = await correr(["--desde", "k1"], prefijo);
    expect(r.codigo).toBe(0);
    const jobs = await jobsDeSistema(prefijo);
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.data!)).toEqual({
      tipo: "kek.rotar",
      desde: "k1",
    });
    if (process.env.REDIS_URL)
      expect(r.salida).not.toContain(process.env.REDIS_URL);
    expect(r.salida).not.toMatch(/redis:\/\//i);
    expect(await sinFilasDeSistema()).toBe(0);
  });

  it.each([
    ["sin --desde", []],
    ["--desde repetido", ["--desde", "k1", "--desde", "k2"]],
    ["--desde sin valor", ["--desde"]],
    ["kekId con forma inválida", ["--desde", "K1; drop table credencial"]],
    ["kekId vacío", ["--desde", ""]],
    ["opción desconocida", ["--desde", "k1", "--todos", "si"]],
    ["argumento suelto", ["k1"]],
  ])("argumentos inválidos (%s): sale 2 y no encola nada", async (_n, argv) => {
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const r = await correr(argv, prefijo);
    expect(r.codigo).toBe(2);
    expect(await redis.keys(`${prefijo}*`)).toHaveLength(0);
  });
});

describe("kek.rotar de punta a punta: el comando lo encola y el worker lo ejecuta", () => {
  it("el worker toma el job de la cola programados y rota todos los estudios sin crear filas en job_registro", async () => {
    const T = await e.estudio();
    const sembradas = [
      ...(await sembrarK1(A, ["sol"])),
      ...(await sembrarK1(T, ["sol", "sire_api"])),
    ];
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const salida: string[] = [];
    const codigo = await encolarKekRotar(
      ["--desde", "k1"],
      { REDIS_URL: process.env.REDIS_URL },
      {
        conexionBull: opcionesBull(),
        prefijo,
        escribir: (l: string) => salida.push(l),
        escribirError: (l: string) => salida.push(l),
      },
    );
    expect(codigo).toBe(0);

    const p = await arrancar({
      prefijo,
      kek: { activa: activaK2(), anterior: () => anteriorK1() } as never,
    });
    procesos.push(p);
    await esperarHasta(
      async () =>
        (await Promise.all(sembradas.map(kekDe))).every((x) => x === "k2"),
      "todas las credenciales en k2",
      { timeoutMs: 40_000 },
    );
    for (const s of sembradas)
      expect(await secretoDe(s.tenantId, s.id)).toEqual(s.valor);
    expect(await sinFilasDeSistema()).toBe(0);
    await p.detener({ esperaMs: 2000 });
  });

  it("auth.purgar queda registrado como trabajo repetible diario (03:30 America/Lima) en la cola programados", async () => {
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const p = await arrancar({ prefijo });
    procesos.push(p);
    await esperarHasta(
      async () =>
        /auth\.purgar/.test(
          await volcarPrefijo(redis, `${prefijo}bull:programados`),
        ),
      "auth.purgar registrado como repetible",
    );
    const volcado = await volcarPrefijo(redis, `${prefijo}bull:programados`);
    expect(volcado).toContain("30 3 * * *");
    expect(volcado).toContain("America/Lima");
    expect(await sinFilasDeSistema()).toBe(0);
    await p.detener({ esperaMs: 2000 });
  });
});

describe("CA-13: auth.purgar borra solo lo terminado y vencido (D16)", () => {
  const dias = (n: number) => `now() - interval '${n} days'`;
  const adm = async (sql: string, v: unknown[] = []) =>
    (await admin.pool.query(sql, v)).rows as any[];
  const S = {} as Record<string, string>;
  const Tk = {} as Record<string, string>;
  const claves = {} as Record<string, Buffer>;
  const sujetos = {} as Record<string, string>;
  const J = {} as Record<string, string>;
  let usuario: string;
  let estudio: string;

  beforeAll(async () => {
    estudio = await e.estudio();
    usuario = await e.usuario(estudio, "contador");
    const c = await e.cliente(estudio);

    const sesion = async (
      n: string,
      o: { expira: string; revocada?: string },
    ) => {
      S[n] = (
        await adm(
          `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, revocada_en, motivo)
           values ($1, $2, now() - interval '200 days', now() - interval '200 days', ${o.expira}, ${o.revocada ?? "null"}, ${o.revocada ? "'logout'" : "null"}) returning id`,
          [randomBytes(32), usuario],
        )
      )[0].id;
    };
    await sesion("vigente_vieja", { expira: "now() + interval '12 hours'" });
    await sesion("revocada_31d", {
      expira: "now() + interval '1 day'",
      revocada: dias(31),
    });
    await sesion("revocada_29d", {
      expira: "now() + interval '1 day'",
      revocada: dias(29),
    });
    await sesion("vencida_31d", { expira: dias(31) });
    await sesion("vencida_29d", { expira: dias(29) });

    const token = async (
      n: string,
      col: "usado_en" | "invalidado_en" | "expira_en" | "vigente",
      cuando: string,
    ) => {
      Tk[n] = (
        await adm(
          `insert into auth.token_recuperacion (token_hash, usuario_id, creado_en, expira_en, usado_en, invalidado_en)
           values ($1, $2, now() - interval '200 days',
                   ${col === "expira_en" ? cuando : "now() + interval '30 minutes'"},
                   ${col === "usado_en" ? cuando : "null"},
                   ${col === "invalidado_en" ? cuando : "null"}) returning id`,
          [randomBytes(32), usuario],
        )
      )[0].id;
    };
    await token("usado_8d", "usado_en", dias(8));
    await token("usado_6d", "usado_en", dias(6));
    await token("invalidado_8d", "invalidado_en", dias(8));
    await token("vencido_8d", "expira_en", dias(8));
    await token("vencido_6d", "expira_en", dias(6));
    await token("vigente", "vigente", "now()");

    const intento = async (n: string, ventana: string, bloqueo: string) => {
      claves[n] = randomBytes(32);
      await adm(
        "insert into auth.intento_login (clave, fallos, ventana_inicio, bloqueado_hasta) values ($1, 5, " +
          ventana +
          ", " +
          bloqueo +
          ")",
        [claves[n]],
      );
    };
    await intento("sin_bloqueo_91d", dias(91), "null");
    await intento("bloqueo_vigente_91d", dias(91), "now() + interval '1 hour'");
    await intento("sin_bloqueo_89d", dias(89), "null");

    const limite = async (n: string, ventana: string) => {
      sujetos[n] = `t5-${n}-${randomBytes(4).toString("hex")}`;
      await adm(
        "insert into auth.limite_tasa (tipo, sujeto, ventana_inicio, conteo) values ('login_ip', $1, " +
          ventana +
          ", 3)",
        [sujetos[n]],
      );
    };
    await limite("limite_3d", dias(3));
    await limite("limite_1h", "now() - interval '1 hour'");

    // job_registro: terminados hace 91 y 89 días, y vivos muy viejos.
    const job = async (n: string, estado: string, hace: number) => {
      const terminal = ["completado", "error", "cancelado"].includes(estado);
      J[n] = (
        await adm(
          `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, intentos, max_intentos,
                                     creado_en, iniciado_en, terminado_en, actualizado_en)
           values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', $4, '{"n":1}', $5, 0, 4,
                   now() - make_interval(days => $6::int), ${estado === "en_cola" ? "null" : "now() - make_interval(days => $6::int)"},
                   ${terminal ? "now() - make_interval(days => $6::int)" : "null"}, now() - make_interval(days => $6::int)) returning id`,
          [estudio, c.id, c.ruc, estado, randomBytes(32), hace],
        )
      )[0].id;
    };
    await job("completado_91d", "completado", 91);
    await job("error_91d", "error", 91);
    await job("cancelado_91d", "cancelado", 91);
    await job("completado_89d", "completado", 89);
    await job("en_cola_200d", "en_cola", 200);
    await job("ejecutando_200d", "ejecutando", 200);
  });

  afterAll(async () => {
    await adm("delete from auth.intento_login where clave = any($1::bytea[])", [
      Object.values(claves),
    ]).catch(() => undefined);
    await adm("delete from auth.limite_tasa where sujeto = any($1::text[])", [
      Object.values(sujetos),
    ]).catch(() => undefined);
    await adm("delete from auth.token_recuperacion where usuario_id = $1", [
      usuario,
    ]).catch(() => undefined);
    await adm("delete from auth.sesion where usuario_id = $1", [usuario]).catch(
      () => undefined,
    );
  });

  const vivos = async (tabla: string, expr: string, ids: string[]) =>
    new Set(
      (
        await adm(
          `select ${expr}::text as k from ${tabla} where ${expr}::text = any($1::text[])`,
          [ids],
        )
      ).map((r) => r.k as string),
    );

  it("borra lo vencido según D16 y deja lo vigente; devuelve los conteos", async () => {
    const espia = dbEspiada(worker, { muerto: false });
    const r = await authPurgar({ db: espia.db });
    expect(Object.keys(r).sort()).toEqual([
      "intentos",
      "limites",
      "sesiones",
      "tokens",
      "trabajos",
    ]);
    expect(r.sesiones).toBeGreaterThanOrEqual(2);
    expect(r.tokens).toBeGreaterThanOrEqual(3);
    expect(r.intentos).toBeGreaterThanOrEqual(1);
    expect(r.limites).toBeGreaterThanOrEqual(1);
    expect(r.trabajos).toBeGreaterThanOrEqual(3);

    expect(
      [...(await vivos("auth.sesion", "id", Object.values(S)))].sort(),
    ).toEqual([S.vigente_vieja, S.revocada_29d, S.vencida_29d].sort());
    expect(
      [
        ...(await vivos("auth.token_recuperacion", "id", Object.values(Tk))),
      ].sort(),
    ).toEqual([Tk.usado_6d, Tk.vencido_6d, Tk.vigente].sort());
    expect(
      [
        ...(await vivos(
          "auth.intento_login",
          "encode(clave, 'hex')",
          Object.values(claves).map((b) => b.toString("hex")),
        )),
      ].sort(),
    ).toEqual(
      [
        claves.bloqueo_vigente_91d!.toString("hex"),
        claves.sin_bloqueo_89d!.toString("hex"),
      ].sort(),
    );
    expect([
      ...(await vivos("auth.limite_tasa", "sujeto", Object.values(sujetos))),
    ]).toEqual([sujetos.limite_1h]);
    expect(
      [...(await vivos("job_registro", "id", Object.values(J)))].sort(),
    ).toEqual([J.completado_89d, J.en_cola_200d, J.ejecutando_200d].sort());
    expect(
      espia.estado.maxAbiertas,
      "los job_registro se purgan en un withTenant por estudio, sin anidar",
    ).toBe(1);
  });

  it("es idempotente y la segunda corrida no encuentra nada de esta prueba", async () => {
    const r = await authPurgar({ db: worker });
    expect(
      r.sesiones + r.tokens + r.intentos + r.limites,
    ).toBeGreaterThanOrEqual(0);
    expect((await vivos("auth.sesion", "id", Object.values(S))).size).toBe(3);
    expect((await vivos("job_registro", "id", Object.values(J))).size).toBe(3);
  });

  it("una retención menor a un día falla (22023) y no borra nada", async () => {
    // Se vuelven a sembrar una sesión y un trabajo borrables para comprobar que siguen ahí tras el rechazo.
    const sesion = (
      await adm(
        `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, revocada_en, motivo)
         values ($1, $2, now() - interval '200 days', now() - interval '200 days', now() - interval '100 days', null, null) returning id`,
        [randomBytes(32), usuario],
      )
    )[0].id as string;
    const err = await authPurgar({
      db: worker,
      retenciones: {
        sesionDias: 0,
        tokenDias: 7,
        intentoDias: 90,
        limiteDias: 1,
      },
    }).then(
      () => null,
      (x: { codigo?: string }) => x,
    );
    expect(err?.codigo).toBe("22023");
    expect((await vivos("auth.sesion", "id", [sesion])).size).toBe(1);
    await adm("delete from auth.sesion where id = $1", [sesion]);
  });
});

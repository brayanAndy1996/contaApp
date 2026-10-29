import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crearClaves } from "./claves.js";
import {
  anunciar,
  armar,
  conectarRedis,
  crearDbAdmin,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  rucNuevo,
  volcarPrefijo,
  dormir,
  type Armado,
  type OpcionesArmado,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con PostgreSQL y Redis reales y BullMQ real): reparto justo, mismo RUC y ventana de candidatos
// (CA-2, CA-3, D21; T9c (4)), y lo que viaja por Redis (CA-15, CA-16).
// Contrato que fijan (ya implementado en T9/T9d): el despachador (`new Despachador({ db, redis, reloj, prefijo, agregarACola })`,
// bucle de `ciclo()`) deja un trabajo `ejecutando` con cupos y lock tomados y lo entrega a BullMQ con el payload exacto
// { jobId, tenantId, tipo }; el ejecutor (aquí `EjecutorMinimo`, el del worker en T10) libera el cupo y deja el lock del RUC con
// PX = espera_ruc_ms. Los máximos de concurrencia se miden en memoria, no con Redis. `config_sistema` se cambia por prueba
// (esperas cortas) y se restaura a D12 al final. Un doble de ejecutor registra marcas { inicio, fin } con Date.now().

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

let admin: ContappDb;
let redis: Redis;
let e: Escenario;
const armados: Armado[] = [];
const prefijos: string[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  redis = conectarRedis();
  e = new Escenario(admin);
  await restaurarConfig(admin);
});

afterAll(async () => {
  await Promise.all(armados.map((a) => a.detener().catch(() => undefined)));
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await admin?.close();
});

async function nuevo(o: Omit<OpcionesArmado, "prefijo"> = {}) {
  const prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  const a = await armar({ prefijo, ...o });
  armados.push(a);
  return { a, prefijo, k: crearClaves(prefijo) };
}

const clientes = async (t: string, n: number): Promise<ClientePrueba[]> =>
  Promise.all(Array.from({ length: n }, () => e.cliente(t)));

describe("CA-2: reparto entre estudios", () => {
  it("A con 1,000 pendientes y C también: B (1 trabajo) empieza al liberarse el primer cupo y nadie pasa de 2 por estudio ni de 4 en total", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
    const [A, B, C] = [await e.estudio(), await e.estudio(), await e.estudio()];
    const idsA = await e.trabajosEnMasa(A, await clientes(A, 40), 1000);
    const idsC = await e.trabajosEnMasa(C, await clientes(C, 20), 200);
    const [idB] = await e.trabajosEnMasa(B, await e.cliente(B), 1);
    const { a, prefijo } = await nuevo({ duracionMs: 250 });
    // Medición sin carrera de tiempos: los 4 primeros trabajos (A y C llenan el cupo global) quedan retenidos en una compuerta hasta
    // que B ya esté anunciado. Así "antes de B" es un conteo exacto (4) y no depende de cuánto tarde el sondeo de la prueba o de cuántos
    // cupos se liberaron entre una lectura y otra (con CPU cargada o cobertura, el sondeo llegaba tarde y B se anunciaba tras 7 u 8
    // inicios ya hechos, sin que el despachador hubiera fallado). Los cupos se liberan de a uno; el resto de los trabajos dura 250 ms.
    const compuertas: Array<() => void> = [];
    a.ejecutor.comportamiento = async () => {
      if (compuertas.length < 4)
        await new Promise<void>((resolver) => compuertas.push(resolver));
      else await dormir(250);
    };
    const liberarTodas = (): void => compuertas.forEach((liberar) => liberar());

    try {
      await anunciar(redis, prefijo, A, idsA);
      await anunciar(redis, prefijo, C, idsC);
      // A (2) y C (2) llenan el cupo global de 4 y no hay más cupos mientras las compuertas sigan cerradas.
      await esperarHasta(
        () => compuertas.length >= 4,
        "A y C ocupan los 4 cupos",
      );
      await dormir(300); // con los 4 cupos llenos y retenidos nada más puede iniciar: se comprueba abajo
      expect(a.ejecutor.iniciados).toHaveLength(4);
      await anunciar(redis, prefijo, B, [idB]); // B ya es visible para el despachador antes de liberar el primer cupo

      // Se libera un cupo a la vez; en cada uno el despachador reparte un trabajo (round-robin A, B, C).
      for (
        let i = 0;
        i < compuertas.length && !a.ejecutor.iniciados.includes(idB);
        i++
      ) {
        const antes = a.ejecutor.iniciados.length;
        compuertas[i]!();
        await esperarHasta(
          () => a.ejecutor.iniciados.length > antes,
          `se reparte el cupo liberado ${i + 1}`,
          { timeoutMs: 10_000 },
        );
      }
      await esperarHasta(
        () => a.ejecutor.iniciados.includes(idB),
        "B empieza al liberarse el primer cupo",
        { timeoutMs: 10_000 },
      );
      const delosGrandes = new Set([...idsA, ...idsC]);
      const iniciadosAntes = a.ejecutor.iniciados
        .slice(0, a.ejecutor.iniciados.indexOf(idB))
        .filter((id) => delosGrandes.has(id)).length;
      // Sin justicia B esperaría a que terminaran los 1,200 trabajos; con round-robin entra tras, a lo sumo, un trabajo más de cada estudio.
      expect(iniciadosAntes - 4).toBeLessThanOrEqual(2);
      expect(iniciadosAntes).toBeLessThanOrEqual(6);
    } finally {
      liberarTodas();
    }

    await esperarHasta(
      async () => (await e.fila(idB))?.estado === "completado",
      "B completado",
    );
    expect(a.ejecutor.maxPorTenant.get(A)).toBeLessThanOrEqual(2);
    expect(a.ejecutor.maxPorTenant.get(C)).toBeLessThanOrEqual(2);
    expect(a.ejecutor.maxGlobal).toBeLessThanOrEqual(4);
    await a.detener(); // quedan ~1,000 pendientes: se detiene el despachador
  });

  it("tres estudios con pendientes se despachan en round-robin (global 1: el orden de inicio se repite de a tres)", async () => {
    await fijarConfig(admin, "sire", { global: 1, tenant: 1, espera: 0 });
    const estudios = [await e.estudio(), await e.estudio(), await e.estudio()];
    const dueno = new Map<string, string>();
    const todos: string[] = [];
    for (const t of estudios) {
      const ids = await e.trabajosEnMasa(t, await clientes(t, 4), 4);
      for (const id of ids) dueno.set(id, t);
      todos.push(...ids);
    }
    const { a, prefijo } = await nuevo({ duracionMs: 30 });
    for (const t of estudios)
      await anunciar(
        redis,
        prefijo,
        t,
        todos.filter((id) => dueno.get(id) === t),
      );

    await esperarHasta(
      () => a.ejecutor.marcas.length >= 12,
      "12 trabajos ejecutados",
    );
    const orden = a.ejecutor.iniciados.map((id) => dueno.get(id)!);
    expect(new Set(orden.slice(0, 3)).size).toBe(3);
    for (let i = 0; i + 3 < orden.length; i++)
      expect(orden[i + 3], `posición ${i + 3}`).toBe(orden[i]);
    expect(a.ejecutor.maxGlobal).toBe(1);
  });

  it("dentro de un estudio, un interactivo sale antes que cualquier programado", async () => {
    await fijarConfig(admin, "sire", { global: 1, tenant: 1, espera: 0 });
    const t = await e.estudio();
    const cs = await clientes(t, 5);
    const prog = await e.trabajosEnMasa(t, cs.slice(0, 3), 3, {
      prioridad: "programado",
    });
    const inter = await e.trabajosEnMasa(t, cs.slice(3), 2, {
      prioridad: "interactivo",
    });
    const { a, prefijo } = await nuevo({ duracionMs: 20 });
    await anunciar(redis, prefijo, t, [...prog, ...inter]);

    await esperarHasta(
      () => a.ejecutor.marcas.length >= 5,
      "5 trabajos ejecutados",
    );
    expect(a.ejecutor.iniciados).toEqual([...inter, ...prog]);
  });

  it("un interactivo con el RUC ocupado no frena al programado de RUC libre; cuando el RUC se libera, sale el interactivo (CA-2 precisado, D21)", async () => {
    await fijarConfig(admin, "sire", { global: 1, tenant: 1, espera: 0 });
    const t = await e.estudio();
    const [cOcupado, cLibre] = await clientes(t, 2);
    const [inter] = await e.trabajosEnMasa(t, cOcupado!, 1, {
      prioridad: "interactivo",
    });
    const [prog] = await e.trabajosEnMasa(t, cLibre!, 1, {
      prioridad: "programado",
    });
    const { a, prefijo, k } = await nuevo({ duracionMs: 20 });
    // Otro proceso (otro estudio) tiene ocupado ese RUC unos instantes.
    await redis.set(
      k.lockRuc("sire", cOcupado!.ruc),
      "otro-trabajo",
      "PX",
      900,
    );
    await anunciar(redis, prefijo, t, [inter!, prog!]);

    await esperarHasta(
      () => a.ejecutor.marcas.length >= 2,
      "ambos ejecutados",
      { timeoutMs: 10_000 },
    );
    expect(a.ejecutor.iniciados).toEqual([prog, inter]);
    const [mProg, mInter] = [
      a.ejecutor.marcas.find((m) => m.id === prog)!,
      a.ejecutor.marcas.find((m) => m.id === inter)!,
    ];
    expect(mInter.inicio).toBeGreaterThanOrEqual(mProg.fin);
  });
});

describe("CA-3: un mismo RUC nunca en paralelo y con la espera mínima", () => {
  it("20 trabajos del mismo RUC desde dos estudios con 4 cupos: sin solapes y con ≥ espera entre el fin de uno y el inicio del siguiente", async () => {
    const ESPERA = 200;
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: ESPERA });
    const [A, B] = [await e.estudio(), await e.estudio()];
    const ruc = rucNuevo();
    const [cA, cB] = [await e.cliente(A, ruc), await e.cliente(B, ruc)];
    const idsA = await e.trabajosEnMasa(A, cA, 10);
    const idsB = await e.trabajosEnMasa(B, cB, 10);
    const { a, prefijo } = await nuevo({ duracionMs: 40, esperaRucMs: ESPERA });
    await anunciar(redis, prefijo, A, idsA);
    await anunciar(redis, prefijo, B, idsB);

    await esperarHasta(
      () => a.ejecutor.marcas.length >= 20,
      "20 trabajos ejecutados",
      { timeoutMs: 60_000 },
    );
    const m = a.ejecutor.deRuc(ruc);
    expect(m).toHaveLength(20);
    for (let i = 0; i + 1 < m.length; i++) {
      expect(
        m[i + 1]!.inicio,
        `trabajo ${i + 1} no empieza antes de que termine el ${i}`,
      ).toBeGreaterThanOrEqual(m[i]!.fin);
      expect(
        m[i + 1]!.inicio - m[i]!.fin,
        `espera entre ${i} y ${i + 1}`,
      ).toBeGreaterThanOrEqual(ESPERA - 10);
    }
    expect(
      new Set(m.map((x) => x.tenantId)).size,
      "se atendieron los dos estudios",
    ).toBe(2);
    expect(a.ejecutor.maxGlobal).toBe(1); // el mismo RUC nunca corre dos a la vez

    // T9e (ajuste de T5, plan "Ratificaciones de T5/T6" (7)): round-robin de CA-2 con el RUC compartido. Ordenadas por inicio, ningún
    // estudio acumula 3 marcas seguidas mientras el otro aún tiene pendientes (el puntero solo avanza con quien despacha). Rojo contra el
    // despachador actual (BBBBBBBBBBAAAAAAAAAA); se tolera hasta 2 seguidas por los tiempos reales de liberación del lock.
    const orden = [...m]
      .sort((p, q) => p.inicio - q.inicio)
      .map((x) => x.tenantId);
    for (let i = 0; i + 2 < orden.length; i++) {
      if (orden[i] !== orden[i + 1] || orden[i] !== orden[i + 2]) continue;
      const otro = orden[i] === A ? B : A;
      const pendientesDelOtro = orden
        .slice(i + 3)
        .filter((t) => t === otro).length;
      expect(
        pendientesDelOtro,
        `3 seguidas de un estudio desde la posición ${i} con el otro aún pendiente: ${orden.map((t) => (t === A ? "A" : "B")).join("")}`,
      ).toBe(0);
    }
  });

  it("canal ninguno no usa lock: dos trabajos del mismo RUC pueden correr a la vez", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 500 });
    const t = await e.estudio();
    const c = await e.cliente(t);
    const ids = await e.trabajosEnMasa(t, c, 2, { canal: "ninguno" });
    const { a, prefijo } = await nuevo({ duracionMs: 400, esperaRucMs: 500 });
    await anunciar(redis, prefijo, t, ids);
    await esperarHasta(
      () => a.ejecutor.marcas.length >= 2,
      "2 trabajos ejecutados",
    );
    const [x, y] = a.ejecutor.marcas.sort((p, q) => p.inicio - q.inicio);
    expect(y!.inicio).toBeLessThan(x!.fin);
  });
});

describe("D21 (T9c, 4): ventana de candidatos", () => {
  it("30 trabajos de un RUC y 1 de otro RUC dentro de los primeros 20: el segundo se despacha sin esperar a los 30, y la espera del RUC se respeta", async () => {
    const ESPERA = 100;
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: ESPERA });
    const t = await e.estudio();
    const [cX, cY] = await clientes(t, 2);
    // Orden de creación: 5 de X, el de Y (puesto 6) y 25 de X.
    const antes = await e.trabajosEnMasa(t, cX!, 5);
    const [idY] = await e.trabajosEnMasa(t, cY!, 1, { desplazarMs: 100 });
    const despues = await e.trabajosEnMasa(t, cX!, 25, { desplazarMs: 1000 });
    const { a, prefijo } = await nuevo({ duracionMs: 60, esperaRucMs: ESPERA });
    await anunciar(redis, prefijo, t, [...antes, idY!, ...despues]);

    await esperarHasta(
      () => a.ejecutor.iniciados.includes(idY!),
      "el de otro RUC empieza",
      { timeoutMs: 10_000 },
    );
    expect(
      a.ejecutor.iniciados.indexOf(idY!),
      "empieza el segundo: el RUC de X está ocupado por el primero",
    ).toBeLessThanOrEqual(1);

    await esperarHasta(
      () => a.ejecutor.marcas.length >= 31,
      "31 trabajos ejecutados",
      { timeoutMs: 60_000 },
    );
    const mx = a.ejecutor.deRuc(cX!.ruc);
    expect(mx).toHaveLength(30);
    for (let i = 0; i + 1 < mx.length; i++) {
      expect(
        mx[i + 1]!.inicio - mx[i]!.fin,
        `espera del RUC X entre ${i} y ${i + 1}`,
      ).toBeGreaterThanOrEqual(ESPERA - 10);
    }
  });

  it("con el de otro RUC en el puesto 31, la ventana de 20 lo alcanza en cuanto salen los primeros 11 (mucho antes de que terminen los 30)", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 50 });
    const t = await e.estudio();
    const [cX, cY] = await clientes(t, 2);
    const idsX = await e.trabajosEnMasa(t, cX!, 30);
    const [idY] = await e.trabajosEnMasa(t, cY!, 1, { desplazarMs: 5000 });
    const { a, prefijo } = await nuevo({ duracionMs: 30, esperaRucMs: 50 });
    await anunciar(redis, prefijo, t, [...idsX, idY!]);

    await esperarHasta(
      () => a.ejecutor.iniciados.includes(idY!),
      "el del puesto 31 empieza",
      { timeoutMs: 30_000 },
    );
    const pos = a.ejecutor.iniciados.indexOf(idY!);
    expect(
      pos,
      "tras salir ~11 de X el de Y entra en la ventana",
    ).toBeLessThanOrEqual(13);
    expect(pos).toBeLessThan(29);
    await a.detener();
  });

  it("riesgo aceptado: con el RUC libre en el puesto 21 y los 20 primeros ocupados, ese ciclo no despacha; al liberarse el RUC sale", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
    const t = await e.estudio();
    const [cX, cY] = await clientes(t, 2);
    const idsX = await e.trabajosEnMasa(t, cX!, 20);
    const [idY] = await e.trabajosEnMasa(t, cY!, 1, { desplazarMs: 5000 }); // puesto 21
    const { a, prefijo, k } = await nuevo({
      duracionMs: 20,
      automatico: false,
    });
    await redis.set(k.lockRuc("sire", cX!.ruc), "otro-trabajo", "PX", 700);
    await anunciar(redis, prefijo, t, [...idsX, idY!]);

    for (let i = 0; i < 6; i++) {
      await a.despachador.ciclo();
      await dormir(40);
    }
    expect(
      (await e.fila(idY!)).estado,
      "el puesto 21 no entra en la ventana de 20",
    ).toBe("en_cola");
    expect(a.ejecutor.iniciados).toHaveLength(0);

    await dormir(600); // el lock ajeno vence
    for (let i = 0; i < 40 && !a.ejecutor.iniciados.includes(idY!); i++) {
      await a.despachador.ciclo();
      await dormir(40);
    }
    expect(
      a.ejecutor.iniciados,
      "al liberarse el RUC se despacha uno de X y, con su lock, Y entra en la ventana",
    ).toContain(idY);
    await a.detener();
  });
});

describe("CA-15 y CA-16: lo que viaja y se guarda en Redis", () => {
  it("el payload de BullMQ es exactamente { jobId, tenantId, tipo } y ningún valor de Redis trae RUC ni parámetros", async () => {
    await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
    const t = await e.estudio();
    const c = await e.cliente(t);
    const CANARIO = `CANARIO-param-${Math.random().toString(36).slice(2)}`;
    const { a, prefijo } = await nuevo({ duracionMs: 10 });
    // El trabajo lleva un canario en sus parámetros; el ejecutor lo mantiene en vuelo para poder mirar Redis.
    const [id] = await e.trabajosEnMasa(t, c, 1);
    await admin.pool.query(
      "update job_registro set parametros = $2::jsonb where id = $1",
      [id, JSON.stringify({ rango: CANARIO })],
    );
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    a.ejecutor.comportamiento = () => puerta;
    await anunciar(redis, prefijo, t, [id!]);
    await esperarHasta(
      () => a.ejecutor.iniciados.includes(id!),
      "el trabajo está en vuelo",
    );

    const datos = await redis.hget(`${prefijo}bull:sire:${id}`, "data");
    expect(datos).not.toBeNull();
    expect(Object.keys(JSON.parse(datos!)).sort()).toEqual([
      "jobId",
      "tenantId",
      "tipo",
    ]);
    expect(JSON.parse(datos!)).toEqual({
      jobId: id,
      tenantId: t,
      tipo: "prueba.eco",
    });

    try {
      // Los valores no traen parámetros ni RUC (el nombre del lock sí lleva el RUC por diseño: `lock:ruc:{canal}:{ruc}`).
      const valores = await volcarPrefijo(redis, prefijo, { claves: false });
      expect(valores).not.toContain(CANARIO);
      expect(valores).not.toContain(c.ruc);
      expect(valores).not.toContain(c.id);
    } finally {
      soltar();
    }
    await esperarHasta(
      async () => (await e.fila(id!))?.estado === "completado",
      "completado",
    );
  });
});

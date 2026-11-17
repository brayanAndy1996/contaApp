// Spec 023 (T4, rojo): programacion del buzon en BD real (D-5, D-6; CA-1, CA-2). Candado del ciclo con vencimiento y reloj de BD,
// estudios con suscripcion vigente, candidatos, encolado acotado de `sol.buzon.revisar` y elevacion de prioridad. Falla hoy
// porque las migraciones 0054-0056 aun no existen. El contrato esta en la cabecera de buzon-soporte.ts.
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enRollback, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  claveBuzon,
  comoAdmin,
  comoRol,
  conExecute,
  conSistema,
  crearDb,
  EscenarioBuzon,
  infoFuncion,
  probar,
  ROLES_EXEC,
  upsertEstado,
  UUID,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let backend: ContappDb;
let worker: ContappDb;
let P: string; // activa, plan de 720
let Pb: string; // prueba vigente, plan de 60
let Pv: string; // prueba vencida
let Ps: string; // sin suscripcion
let Q: string; // tope
let uP: string; // miembro de P
let cOk: ClientePrueba;
let cVer: ClientePrueba;
let cInv: ClientePrueba;
let cSin: ClientePrueba;
let cSire: ClientePrueba;
let cArch: ClientePrueba;
let cViva: ClientePrueba;
let cEjec: ClientePrueba;
let cTerm: ClientePrueba;
let cOtroTipo: ClientePrueba;
let cB: ClientePrueba;
let cPv: ClientePrueba;
let cPs: ClientePrueba;
let qs: ClientePrueba[];
let jViva: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  eb = new EscenarioBuzon(admin);
  await eb.guardarProgramacion();
  P = await eb.estudioSub({ estado: "activa", frecuenciaMin: 720 });
  Pb = await eb.estudioSub({
    estado: "prueba",
    venceEn: "10 days",
    frecuenciaMin: 60,
  });
  Pv = await eb.estudioSub({
    estado: "prueba",
    venceEn: "-1 day",
    frecuenciaMin: 240,
  });
  Ps = await eb.estudioSub({ estado: null });
  Q = await eb.estudioSub({ estado: "activa" });
  uP = (await eb.et.miembro(P, "contador")).id;
  cOk = await eb.clienteCon(P, { cred: "configurada" });
  cVer = await eb.clienteCon(P, { cred: "verificada" });
  cInv = await eb.clienteCon(P, { cred: "invalida" });
  cSin = await eb.clienteCon(P, { cred: null });
  cSire = await eb.clienteCon(P, { cred: "solo_sire" });
  cArch = await eb.clienteCon(P, { cred: "configurada", archivado: true });
  cViva = await eb.clienteCon(P, { cred: "configurada" });
  cEjec = await eb.clienteCon(P, { cred: "configurada" });
  cTerm = await eb.clienteCon(P, { cred: "configurada" });
  cOtroTipo = await eb.clienteCon(P, { cred: "configurada" });
  cB = await eb.clienteCon(Pb, { cred: "configurada" });
  cPv = await eb.clienteCon(Pv, { cred: "configurada" });
  cPs = await eb.clienteCon(Ps, { cred: "configurada" });
  jViva = await eb.revisar(P, cViva, { estado: "en_cola" });
  await eb.revisar(P, cEjec, { estado: "ejecutando" });
  await eb.revisar(P, cTerm, { estado: "completado" });
  await eb.et.job(P, cOtroTipo, {
    tipo: "prueba.eco",
    cola: "sire",
    canal: "sire",
    estado: "en_cola",
  });
  qs = [];
  for (let i = 0; i < 5; i++)
    qs.push(await eb.clienteCon(Q, { cred: "configurada" }));
  // Un trabajo pendiente de la cola sol de Q de otro cliente: ocupa un cupo del tope.
  await eb.et.job(Q, await eb.clienteCon(Q, { cred: "configurada" }), {
    tipo: "sol.verificar",
    cola: "sol",
    canal: "sol",
    estado: "en_cola",
  });
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await eb?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};
const uuids = (filas: Record<string, unknown>[]): string[] =>
  filas.map((f) => String(Object.values(f)[0]));

// ---- catalogo de funciones ---------------------------------------------------------------------------------------------------
const FUNCIONES_WORKER = [
  "sistema.buzon_ciclo_tomar(text)",
  "sistema.buzon_ciclo_renovar(text)",
  "sistema.buzon_ciclo_soltar(text)",
  "sistema.estudios_buzon()",
  "public.buzon_candidatos()",
  "public.encolar_buzon_programados(uuid[])",
];

describe("funciones acotadas: dueño sin privilegios, search_path fijo y EXECUTE solo a quien toca (0055)", () => {
  it.each([...FUNCIONES_WORKER, "public.buzon_elevar_prioridad(uuid)"])(
    "%s es SECURITY DEFINER de un dueño sin superusuario (y sin BYPASSRLS salvo la enumeracion de estudios, como 0018)",
    async (firma) => {
      const f = await infoFuncion(admin, firma);
      expect(f.secdef).toBe(true);
      expect(f.duenoSuper, `dueño ${f.dueno}`).toBe(false);
      // `sistema.estudios_buzon` lee suscripciones de todos los estudios: como `sistema.estudios_ids` (0018) la puede poseer el rol
      // `contapp_enumerador` (BYPASSRLS, nadie hace SET ROLE a el); el resto de funciones respeta la RLS dentro.
      if (firma !== "sistema.estudios_buzon()")
        expect(f.duenoBypass, `dueño ${f.dueno}`).toBe(false);
      expect(f.config.join(",")).toMatch(/search_path=pg_catalog, pg_temp/);
    },
  );

  it.each(FUNCIONES_WORKER)(
    "%s: EXECUTE solo para contapp_worker",
    async (firma) => {
      expect(await conExecute(admin, firma, ROLES_EXEC)).toEqual([
        "contapp_worker",
      ]);
    },
  );

  it("buzon_elevar_prioridad: EXECUTE solo para contapp_backend", async () => {
    expect(
      await conExecute(
        admin,
        "public.buzon_elevar_prioridad(uuid)",
        ROLES_EXEC,
      ),
    ).toEqual(["contapp_backend"]);
  });

  it("el backend no puede llamar a ninguna funcion del programador (42501)", async () => {
    for (const sql of [
      "select * from sistema.buzon_ciclo_tomar('x')",
      "select sistema.buzon_ciclo_renovar('x')",
      "select sistema.buzon_ciclo_soltar('x')",
      "select * from sistema.estudios_buzon()",
      "select * from buzon_candidatos()",
      "select * from encolar_buzon_programados(array[gen_random_uuid()])",
    ]) {
      const r = await comoRol(admin, "contapp_backend", P, (c) =>
        probar(c, sql),
      );
      expect(r.ok === false && r.code, sql).toBe("42501");
    }
  });

  it("el worker no puede elevar prioridad (42501)", async () => {
    const r = await comoRol(admin, "contapp_worker", P, (c) =>
      probar(c, "select buzon_elevar_prioridad(gen_random_uuid())"),
    );
    rechazo(r, "42501");
  });
});

// ---- candado del ciclo (CA-1: cambiar el intervalo surte efecto sin reiniciar) ------------------------------------------------
describe("candado del ciclo: un solo ciclo vivo, con vencimiento y reloj de BD (D-5)", () => {
  /** Fija la fila unica con tiempos relativos al reloj de BD: `hasta` y `inicio` son intervalos SQL contra ahora (o null). */
  async function fijar(
    c: PoolClient,
    o: {
      intervalo?: number;
      dueno?: string | null;
      hasta?: string | null;
      inicio?: string | null;
    },
  ) {
    await c.query(
      `update buzon_programacion set intervalo_min = $1, ciclo_dueno = $2,
         ciclo_hasta = case when $3::interval is null then null else clock_timestamp() + $3::interval end,
         ultimo_ciclo_inicio = case when $4::interval is null then null else clock_timestamp() + $4::interval end, ultimo_ciclo_fin = null`,
      [o.intervalo ?? 15, o.dueno ?? null, o.hasta ?? null, o.inicio ?? null],
    );
  }
  const tomar = (c: PoolClient, dueno: string) =>
    probar(c, "select * from sistema.buzon_ciclo_tomar($1::text)", [dueno]);
  const estado = async (c: PoolClient) =>
    (await c.query("select * from buzon_programacion")).rows[0];
  /** Ejecuta `fn` como worker y devuelve al superusuario para leer el estado; todo se revierte. */
  const enCiclo = <T>(fn: (c: PoolClient) => Promise<T>) =>
    comoRol(admin, "contapp_worker", null, fn);
  const leerEstado = (c: PoolClient) =>
    comoAdmin(c, "contapp_worker", () => estado(c));
  const ajustar = (c: PoolClient, o: Parameters<typeof fijar>[1]) =>
    comoAdmin(c, "contapp_worker", () => fijar(c, o));

  it("el primer ciclo (nunca ejecutado) lo toma el primero: devuelve ahora (reloj de BD) y la configuracion, y fija candado de 5 min", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {});
      const t0 = Date.now();
      const x = await tomar(c, "dueno-A");
      const e = await leerEstado(c);
      return { x, e, t0 };
    });
    expect(r.x.ok).toBe(true);
    const fila = (r.x as { rows: any[] }).rows;
    expect(fila).toHaveLength(1);
    expect(Object.keys(fila[0]).sort()).toEqual([
      "ahora",
      "intervalo_min",
      "lote_estudio",
      "reserva_interactiva",
    ]);
    expect(fila[0]).toMatchObject({
      intervalo_min: 15,
      reserva_interactiva: 50,
      lote_estudio: 1000,
    });
    expect(Math.abs(new Date(fila[0].ahora).getTime() - r.t0)).toBeLessThan(
      5000,
    );
    expect(r.e.ciclo_dueno).toBe("dueno-A");
    const hastaMs =
      new Date(r.e.ciclo_hasta).getTime() - new Date(fila[0].ahora).getTime();
    expect(hastaMs).toBeGreaterThan(299_000);
    expect(hastaMs).toBeLessThan(301_000);
    expect(new Date(r.e.ultimo_ciclo_inicio).getTime()).toBeLessThanOrEqual(
      new Date(fila[0].ahora).getTime() + 1000,
    );
  });

  it("antes de cumplirse el intervalo desde el ultimo ciclo no toma nada (vacio)", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, { intervalo: 15, inicio: "-5 minutes" });
      return tomar(c, "dueno-A");
    });
    expect(r.ok && r.rows).toEqual([]);
  });

  it("cumplido el intervalo (y soltado el candado) lo toma", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, { intervalo: 15, inicio: "-16 minutes" });
      return tomar(c, "dueno-A");
    });
    expect(r.ok && r.rows).toHaveLength(1);
  });

  it("con el candado vivo de otro dueño no toma, aunque el intervalo se haya cumplido", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        intervalo: 15,
        inicio: "-20 minutes",
        dueno: "dueno-A",
        hasta: "3 minutes",
      });
      const x = await tomar(c, "dueno-B");
      const e = await leerEstado(c);
      return { x, e };
    });
    expect(r.x.ok && r.x.rows).toEqual([]);
    expect(r.e.ciclo_dueno).toBe("dueno-A");
  });

  it("candado vencido y intervalo cumplido: otro dueño toma el ciclo", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        intervalo: 15,
        inicio: "-20 minutes",
        dueno: "dueno-A",
        hasta: "-1 minute",
      });
      const x = await tomar(c, "dueno-B");
      const e = await leerEstado(c);
      return { x, e };
    });
    expect(r.x.ok && r.x.rows).toHaveLength(1);
    expect(r.e.ciclo_dueno).toBe("dueno-B");
  });

  it("candado vencido pero intervalo sin cumplir: no se ejecuta dos ciclos en un intervalo (vacio)", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        intervalo: 15,
        inicio: "-6 minutes",
        dueno: "dueno-A",
        hasta: "-1 minute",
      });
      return tomar(c, "dueno-B");
    });
    expect(r.ok && r.rows).toEqual([]);
  });

  it("cambiar intervalo_min en la BD surte efecto en la llamada siguiente, sin reiniciar", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, { intervalo: 15, inicio: "-8 minutes" });
      const con15 = await tomar(c, "dueno-A");
      await ajustar(c, { intervalo: 5, inicio: "-8 minutes" });
      const con5 = await tomar(c, "dueno-A");
      return { con15, con5 };
    });
    expect(r.con15.ok && r.con15.rows).toEqual([]);
    expect(r.con5.ok && r.con5.rows).toHaveLength(1);
    expect((r.con5 as { rows: any[] }).rows[0].intervalo_min).toBe(5);
  });

  it("p_dueno nulo o vacio: 22023", async () => {
    const r = await enCiclo(async (c) => [
      await probar(c, "select * from sistema.buzon_ciclo_tomar(null)"),
      await tomar(c, ""),
    ]);
    for (const x of r) rechazo(x, "22023");
  });

  it("renovar: true para el dueño con candado vivo (lo extiende 5 min); false para otro dueño o con el candado vencido, sin cambios", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        dueno: "dueno-A",
        hasta: "1 minute",
        inicio: "-2 minutes",
      });
      const dueño = await probar(
        c,
        "select sistema.buzon_ciclo_renovar($1::text) as ok",
        ["dueno-A"],
      );
      const extendido = await leerEstado(c);
      const ajeno = await probar(
        c,
        "select sistema.buzon_ciclo_renovar($1::text) as ok",
        ["dueno-B"],
      );
      await ajustar(c, {
        dueno: "dueno-A",
        hasta: "-1 minute",
        inicio: "-2 minutes",
      });
      const vencido = await probar(
        c,
        "select sistema.buzon_ciclo_renovar($1::text) as ok",
        ["dueno-A"],
      );
      const tras = await leerEstado(c);
      return { dueño, extendido, ajeno, vencido, tras };
    });
    expect(r.dueño.ok && r.dueño.rows![0].ok).toBe(true);
    const ms = new Date(r.extendido.ciclo_hasta).getTime() - Date.now();
    expect(ms).toBeGreaterThan(290_000);
    expect(r.ajeno.ok && r.ajeno.rows![0].ok).toBe(false);
    expect(r.vencido.ok && r.vencido.rows![0].ok).toBe(false);
    expect(new Date(r.tras.ciclo_hasta).getTime()).toBeLessThan(Date.now());
  });

  it("quien perdio el candado (lo tomo otro) renueva false y no pisa al nuevo dueño", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        intervalo: 15,
        inicio: "-20 minutes",
        dueno: "dueno-A",
        hasta: "-1 minute",
      });
      await tomar(c, "dueno-B");
      const a = await probar(
        c,
        "select sistema.buzon_ciclo_renovar($1::text) as ok",
        ["dueno-A"],
      );
      const e = await leerEstado(c);
      return { a, e };
    });
    expect(r.a.ok && r.a.rows![0].ok).toBe(false);
    expect(r.e.ciclo_dueno).toBe("dueno-B");
  });

  it("soltar: el dueño fija ultimo_ciclo_fin y libera el candado; otro dueño no cambia nada; despues no se toma antes del intervalo", async () => {
    const r = await enCiclo(async (c) => {
      await ajustar(c, {
        intervalo: 15,
        inicio: "-1 minute",
        dueno: "dueno-A",
        hasta: "4 minutes",
      });
      await probar(c, "select sistema.buzon_ciclo_soltar($1::text)", [
        "dueno-B",
      ]);
      const ajeno = await leerEstado(c);
      const soltar = await probar(
        c,
        "select sistema.buzon_ciclo_soltar($1::text)",
        ["dueno-A"],
      );
      const libre = await leerEstado(c);
      const otraVez = await tomar(c, "dueno-B");
      return { ajeno, soltar, libre, otraVez };
    });
    expect(r.ajeno.ciclo_dueno).toBe("dueno-A");
    expect(r.ajeno.ciclo_hasta).not.toBeNull();
    expect(r.soltar.ok).toBe(true);
    expect(r.libre.ciclo_hasta).toBeNull();
    expect(r.libre.ultimo_ciclo_fin).not.toBeNull();
    // El intervalo se mide desde el INICIO del ultimo ciclo: soltar no lo reinicia.
    expect(r.otraVez.ok && r.otraVez.rows).toEqual([]);
  });

  it("dos ciclo_tomar simultaneos (conexiones y transacciones distintas): uno toma y el otro recibe vacio", async () => {
    await eb.guardarProgramacion();
    const sis = conSistema("contapp_worker", 8);
    try {
      for (let ronda = 0; ronda < 5; ronda++) {
        await admin.query(
          "update buzon_programacion set intervalo_min = 15, ciclo_dueno = null, ciclo_hasta = null, ultimo_ciclo_inicio = null, ultimo_ciclo_fin = null",
        );
        const llamadas = Array.from({ length: 8 }, (_, i) =>
          sis.withSistema(
            async (tx) =>
              (
                await tx.query(
                  "select * from sistema.buzon_ciclo_tomar($1::text)",
                  [`proceso-${ronda}-${i}`],
                )
              ).rows,
          ),
        );
        const filas = await Promise.all(llamadas);
        const ganadores = filas
          .map((f, i) => ({ f, i }))
          .filter((x) => x.f.length === 1);
        expect(ganadores, `ronda ${ronda}`).toHaveLength(1);
        const e = (
          await admin.query("select ciclo_dueno from buzon_programacion")
        ).rows[0];
        expect(e.ciclo_dueno).toBe(`proceso-${ronda}-${ganadores[0]!.i}`);
      }
    } finally {
      await sis.close().catch(() => undefined);
    }
  }, 30_000);
});

// ---- estudios con suscripcion vigente -----------------------------------------------------------------------------------------
describe("sistema.estudios_buzon: solo estudios con suscripcion activa o prueba vigente, y solo uuid y enteros", () => {
  it("devuelve (tenant_id, frecuencia_min) de los estudios vigentes y omite prueba vencida y sin suscripcion", async () => {
    const sis = conSistema("contapp_worker", 2);
    try {
      const filas = await sis.withSistema(
        async (tx) =>
          (await tx.query("select * from sistema.estudios_buzon()")).rows,
      );
      const mios = filas.filter((f) =>
        [P, Pb, Pv, Ps, Q].includes(f.tenant_id),
      );
      expect(
        mios
          .map((f) => ({ t: f.tenant_id, f: f.frecuencia_min }))
          .sort((a, b) => (a.t < b.t ? -1 : 1)),
      ).toEqual(
        [
          { t: P, f: 720 },
          { t: Pb, f: 60 },
          { t: Q, f: 1440 },
        ].sort((a, b) => (a.t < b.t ? -1 : 1)),
      );
      for (const f of filas) {
        expect(Object.keys(f).sort()).toEqual(["frecuencia_min", "tenant_id"]);
        expect(f.tenant_id).toMatch(UUID);
        expect(typeof f.frecuencia_min).toBe("number");
      }
    } finally {
      await sis.close().catch(() => undefined);
    }
  });
});

// ---- candidatos ---------------------------------------------------------------------------------------------------------------
describe("buzon_candidatos: clientes elegibles del estudio, solo ids y fechas (D-5)", () => {
  const candidatos = (tenantId: string) =>
    enRollback(
      worker,
      { tenantId },
      async (tx) => (await tx.query("select * from buzon_candidatos()")).rows,
    );

  it("devuelve los no archivados con credencial SOL configurada o verificada y sin captura viva", async () => {
    const filas = await candidatos(P);
    const ids = filas.map((f) => f.cliente_id).sort();
    expect(ids).toEqual([cOk.id, cVer.id, cTerm.id, cOtroTipo.id].sort());
    for (const x of [cInv, cSin, cSire, cArch, cViva, cEjec])
      expect(ids, x.id).not.toContain(x.id);
    for (const f of filas)
      expect(Object.keys(f).sort()).toEqual([
        "cliente_id",
        "ultima_programada_en",
      ]);
  });

  it("ultima_programada_en sale del estado del cliente (NULL si nunca se programo)", async () => {
    await upsertEstado(admin, P, cOk.id, { programadaHace: "3 hours" });
    const filas = await candidatos(P);
    const ok = filas.find((f) => f.cliente_id === cOk.id);
    const ver = filas.find((f) => f.cliente_id === cVer.id);
    expect(ver.ultima_programada_en).toBeNull();
    const hace = Date.now() - new Date(ok.ultima_programada_en).getTime();
    expect(hace).toBeGreaterThan(3 * 3600_000 - 60_000);
    expect(hace).toBeLessThan(3 * 3600_000 + 60_000);
  });

  it("solo ve los del estudio de la sesion", async () => {
    const delOtro = (await candidatos(Pb)).map((f) => f.cliente_id);
    expect(delOtro).toEqual([cB.id]);
  });

  it("sin estudio en la sesion: 42501", async () => {
    const sis = conSistema("contapp_worker", 2);
    try {
      const r = await sis.withSistema(async (tx) =>
        probar(tx as never, "select * from buzon_candidatos()"),
      );
      rechazo(r, "42501");
    } finally {
      await sis.close().catch(() => undefined);
    }
  });
});

// ---- encolado programado ------------------------------------------------------------------------------------------------------
describe("encolar_buzon_programados: crea solo lo valido, con campos fijados en SQL (D-5, CA-1, CA-2)", () => {
  const SQL = "select * from encolar_buzon_programados($1::uuid[])";
  const llamar = (c: PoolClient, ids: string[] | null) => probar(c, SQL, [ids]);
  const conWorker = <T>(tenant: string, fn: (c: PoolClient) => Promise<T>) =>
    comoRol(admin, "contapp_worker", tenant, fn);
  const jobs = async (c: PoolClient, clienteId: string) =>
    (
      await c.query(
        "select * from job_registro where cliente_id = $1 and tipo = 'sol.buzon.revisar' order by creado_en",
        [clienteId],
      )
    ).rows;

  it("crea un trabajo por cliente valido: tipo, cola y canal sol, programado, en_cola, sin creador, max_intentos de la cola, clave del catalogo", async () => {
    const r = await conWorker(P, async (c) => {
      const cfg = (
        await c.query(
          "select reintentos from config_sistema where cola = 'sol'",
        )
      ).rows[0];
      const x = await llamar(c, [cOk.id, cVer.id, cTerm.id]);
      const porCliente: Record<string, any[]> = {};
      for (const id of [cOk.id, cVer.id, cTerm.id])
        porCliente[id] = await jobs(c, id);
      return { cfg, x, porCliente };
    });
    expect(r.x.ok).toBe(true);
    const devueltos = uuids((r.x as { rows: any[] }).rows);
    expect(devueltos).toHaveLength(3);
    for (const cl of [cOk, cVer, cTerm]) {
      const vivos = r.porCliente[cl.id]!.filter((j) => j.estado === "en_cola");
      expect(vivos, cl.id).toHaveLength(1);
      const j = vivos[0];
      expect(devueltos).toContain(j.id);
      expect(j).toMatchObject({
        tenant_id: P,
        tipo: "sol.buzon.revisar",
        cola: "sol",
        canal: "sol",
        prioridad: "programado",
        estado: "en_cola",
        creado_por: null,
        intentos: 0,
        parametros: {},
        ruc: cl.ruc,
        max_intentos: r.cfg.reintentos + 1,
      });
      expect(Buffer.compare(j.clave_dedupe, claveBuzon(cl.id))).toBe(0);
    }
  });

  it("consume la franja: fija ultima_programada_en = ahora en el estado de cada cliente encolado", async () => {
    const r = await conWorker(P, async (c) => {
      await llamar(c, [cOk.id]);
      return (
        await c.query(
          `select ultima_programada_en is not null as hay,
                  abs(extract(epoch from (clock_timestamp() - ultima_programada_en))) < 10 as reciente
             from buzon_estado_cliente where cliente_id = $1`,
          [cOk.id],
        )
      ).rows;
    });
    expect(r).toEqual([{ hay: true, reciente: true }]);
  });

  it("omite sin error y sin consumir la franja: archivado, sin credencial SOL, solo SIRE, invalida y captura viva o en curso", async () => {
    const r = await conWorker(P, async (c) => {
      const x = await llamar(c, [
        cInv.id,
        cSin.id,
        cSire.id,
        cArch.id,
        cViva.id,
        cEjec.id,
      ]);
      const nuevos = (
        await c.query(
          "select cliente_id from job_registro where cliente_id = any($1::uuid[]) and tipo = 'sol.buzon.revisar' and creado_por is null and creado_en >= now()",
          [[cInv.id, cSin.id, cSire.id, cArch.id]],
        )
      ).rows;
      const franjas = (
        await c.query(
          "select cliente_id from buzon_estado_cliente where cliente_id = any($1::uuid[]) and ultima_programada_en is not null",
          [[cInv.id, cSin.id, cSire.id, cArch.id, cViva.id, cEjec.id]],
        )
      ).rows;
      const vivos = (
        await c.query(
          "select id from job_registro where cliente_id = $1 and tipo = 'sol.buzon.revisar' and estado in ('en_cola','ejecutando')",
          [cViva.id],
        )
      ).rows;
      return { x, nuevos, franjas, vivos };
    });
    expect(r.x.ok && r.x.rows).toEqual([]);
    expect(r.nuevos).toEqual([]);
    expect(r.franjas).toEqual([]);
    expect(r.vivos.map((v) => v.id)).toEqual([jViva]);
  });

  it("una llamada mixta encola solo al valido", async () => {
    const r = await conWorker(P, async (c) => {
      const x = await llamar(c, [cOk.id, cInv.id, cArch.id, cViva.id]);
      const n = (await jobs(c, cOk.id)).filter(
        (j) => j.estado === "en_cola",
      ).length;
      return { x, n };
    });
    expect(r.x.ok && r.x.rows).toHaveLength(1);
    expect(r.n).toBe(1);
  });

  it("repetir la llamada no duplica: la segunda ya ve la captura viva", async () => {
    const r = await conWorker(P, async (c) => {
      const a = await llamar(c, [cOk.id]);
      const b = await llamar(c, [cOk.id]);
      const n = (await jobs(c, cOk.id)).filter((j) =>
        ["en_cola", "ejecutando"].includes(j.estado),
      ).length;
      return { a, b, n };
    });
    expect(r.a.ok && r.a.rows).toHaveLength(1);
    expect(r.b.ok && r.b.rows).toEqual([]);
    expect(r.n).toBe(1);
  });

  it("estudio sin suscripcion o con prueba vencida: no encola nada; con prueba vigente si", async () => {
    const sinSub = await conWorker(Ps, (c) => llamar(c, [cPs.id]));
    const vencida = await conWorker(Pv, (c) => llamar(c, [cPv.id]));
    const vigente = await conWorker(Pb, (c) => llamar(c, [cB.id]));
    expect(sinSub.ok && sinSub.rows).toEqual([]);
    expect(vencida.ok && vencida.rows).toEqual([]);
    expect(vigente.ok && vigente.rows).toHaveLength(1);
    const colados = (
      await admin.query(
        "select count(*)::int as n from job_registro where cliente_id = any($1::uuid[]) and tipo = 'sol.buzon.revisar'",
        [[cPs.id, cPv.id]],
      )
    ).rows[0].n;
    expect(colados).toBe(0);
  });

  it("un cliente de otro estudio o inexistente: 23503 y no queda trabajo del valido", async () => {
    const r = await conWorker(P, async (c) => {
      const ajeno = await llamar(c, [cOk.id, cB.id]);
      const inexistente = await llamar(c, [
        cOk.id,
        "00000000-0000-4000-8000-00000000dead",
      ]);
      const n = (await jobs(c, cOk.id)).filter(
        (j) => j.estado === "en_cola",
      ).length;
      return { ajeno, inexistente, n };
    });
    rechazo(r.ajeno, "23503");
    rechazo(r.inexistente, "23503");
    expect(r.n).toBe(0);
  });

  it("entrada invalida: NULL, vacio, con NULL o con repetidos dan 22023", async () => {
    const r = await conWorker(P, async (c) => [
      await llamar(c, null),
      await llamar(c, []),
      await probar(c, SQL, [[cOk.id, null]]),
      await llamar(c, [cOk.id, cOk.id]),
    ]);
    for (const x of r) rechazo(x, "22023");
  });

  it("mas de lote_estudio ids: 22023; con exactamente lote_estudio, bien", async () => {
    const r = await conWorker(P, async (c) => {
      await comoAdmin(c, "contapp_worker", () =>
        c.query("update buzon_programacion set lote_estudio = 2"),
      );
      const demasiados = await llamar(c, [cOk.id, cVer.id, cTerm.id]);
      const justo = await llamar(c, [cOk.id, cVer.id]);
      return { demasiados, justo };
    });
    rechazo(r.demasiados, "22023");
    expect(r.justo.ok && r.justo.rows).toHaveLength(2);
  });

  it("sin estudio en la sesion: 42501", async () => {
    const r = await comoRol(admin, "contapp_worker", null, (c) =>
      llamar(c, [cOk.id]),
    );
    rechazo(r, "42501");
  });

  it("respeta max_pendientes_tenant - reserva_interactiva: con cupo 2 de 5 clientes entran los dos de menor id", async () => {
    const r = await conWorker(Q, async (c) => {
      await comoAdmin(c, "contapp_worker", async () => {
        await c.query(
          "update config_sistema set max_pendientes_tenant = 5 where cola = 'sol'",
        );
        await c.query("update buzon_programacion set reserva_interactiva = 2");
      });
      // 1 pendiente sembrado + cupo (5 - 2 - 1) = 2
      const x = await llamar(
        c,
        qs.map((q) => q.id),
      );
      const pend = (
        await c.query(
          "select count(*)::int as n from job_registro where cola = 'sol' and estado = 'en_cola'",
        )
      ).rows[0].n;
      return { x, pend };
    });
    const clientes = (r.x as { rows: any[] }).rows.length;
    expect(r.x.ok).toBe(true);
    expect(clientes).toBe(2);
    expect(r.pend).toBe(3);
  });

  it("los dos que entran son los de menor id y sin cupo (pendientes >= max - reserva) no entra ninguno, sin error", async () => {
    const r = await conWorker(Q, async (c) => {
      await comoAdmin(c, "contapp_worker", async () => {
        await c.query(
          "update config_sistema set max_pendientes_tenant = 5 where cola = 'sol'",
        );
        await c.query("update buzon_programacion set reserva_interactiva = 2");
      });
      const ids = qs.map((q) => q.id);
      const x = await llamar(c, ids);
      const creados = (
        await c.query(
          "select cliente_id from job_registro where tipo = 'sol.buzon.revisar' and estado = 'en_cola' order by cliente_id",
        )
      ).rows.map((f) => f.cliente_id);
      const sinCupo = await llamar(c, ids);
      return { x, creados, sinCupo };
    });
    expect(r.creados).toEqual(
      qs
        .map((q) => q.id)
        .sort()
        .slice(0, 2),
    );
    expect(r.sinCupo.ok && r.sinCupo.rows).toEqual([]);
  });

  it("con holgura (tope 100, reserva 0) entran los cinco", async () => {
    const r = await conWorker(Q, async (c) => {
      await comoAdmin(c, "contapp_worker", async () => {
        await c.query(
          "update config_sistema set max_pendientes_tenant = 100 where cola = 'sol'",
        );
        await c.query("update buzon_programacion set reserva_interactiva = 0");
      });
      return llamar(
        c,
        qs.map((q) => q.id),
      );
    });
    expect(r.ok && r.rows).toHaveLength(5);
  });
});

// ---- elevar prioridad ---------------------------------------------------------------------------------------------------------
describe("buzon_elevar_prioridad: solo sol.buzon.revisar en cola del mismo estudio pasa de programado a interactivo (D-6)", () => {
  let jProg: string;
  let jInter: string;
  let jEjec: string;
  let jOtroTipo: string;
  let jAjeno: string;
  let cE1: ClientePrueba;
  let cE2: ClientePrueba;
  let cE3: ClientePrueba;
  let cE4: ClientePrueba;
  let cAj: ClientePrueba;
  let sembrado: Promise<void> | undefined;
  const sembrar = () =>
    (sembrado ??= (async () => {
      cE1 = await eb.clienteCon(P);
      cE2 = await eb.clienteCon(P);
      cE3 = await eb.clienteCon(P);
      cE4 = await eb.clienteCon(P);
      jProg = await eb.revisar(P, cE1, { prioridad: "programado" });
      jInter = await eb.revisar(P, cE2, { prioridad: "interactivo" });
      jEjec = await eb.revisar(P, cE3, {
        estado: "ejecutando",
        prioridad: "programado",
      });
      jOtroTipo = await eb.et.job(P, cE4, {
        tipo: "xml.obtener",
        cola: "xml",
        canal: "ninguno",
        prioridad: "programado",
        estado: "en_cola",
      });
      cAj = await eb.clienteCon(Pb);
      jAjeno = await eb.revisar(Pb, cAj, { prioridad: "programado" });
    })());
  const elevar = (id: string) =>
    enRollback(backend, { tenantId: P, userId: uP }, async (tx) => {
      const r = await tx.query(
        "select buzon_elevar_prioridad($1::uuid) as ok",
        [id],
      );
      const j = (
        await tx.query("select * from job_registro where id = $1", [id])
      ).rows[0];
      return { ok: r.rows[0].ok as boolean, j };
    });

  it("sube un revisar en cola programado a interactivo y no toca otra columna", async () => {
    await sembrar();
    const antes = (
      await admin.query("select * from job_registro where id = $1", [jProg])
    ).rows[0];
    const r = await elevar(jProg);
    expect(r.ok).toBe(true);
    expect(r.j.prioridad).toBe("interactivo");
    const { prioridad: _p, actualizado_en: _a, ...resto } = r.j;
    const { prioridad: _p2, actualizado_en: _a2, ...restoAntes } = antes;
    expect(resto).toEqual(restoAntes);
  });

  it("false sin cambios para uno ya interactivo, uno en curso, otro tipo, uno de otro estudio y uno inexistente", async () => {
    await sembrar();
    for (const [id, prioridad] of [
      [jInter, "interactivo"],
      [jEjec, "programado"],
      [jOtroTipo, "programado"],
    ] as const) {
      const r = await elevar(id);
      expect(r.ok, id).toBe(false);
      expect(r.j.prioridad, id).toBe(prioridad);
    }
    const ajeno = await enRollback(
      backend,
      { tenantId: P, userId: uP },
      async (tx) =>
        (
          await tx.query("select buzon_elevar_prioridad($1::uuid) as ok", [
            jAjeno,
          ])
        ).rows[0].ok,
    );
    expect(ajeno).toBe(false);
    expect(
      (
        await admin.query("select prioridad from job_registro where id = $1", [
          jAjeno,
        ])
      ).rows[0].prioridad,
    ).toBe("programado");
    const nada = await enRollback(
      backend,
      { tenantId: P, userId: uP },
      async (tx) =>
        (
          await tx.query(
            "select buzon_elevar_prioridad(gen_random_uuid()) as ok",
          )
        ).rows[0].ok,
    );
    expect(nada).toBe(false);
  });

  it("sin estudio en la sesion: 42501", async () => {
    await sembrar();
    const r = await comoRol(admin, "contapp_backend", null, (c) =>
      probar(c, "select buzon_elevar_prioridad($1::uuid)", [jProg]),
    );
    rechazo(r, "42501");
  });
});

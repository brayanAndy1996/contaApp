// Spec 023 (T4, rojo): concurrencia del buzon en BD real (D-5, D-6; CA-6, CA-11). Programador contra «Revisar ahora» sin
// interbloqueo y con un solo trabajo vivo, dos capturas del mismo mensaje con una fila y un aviso por destinatario, y dos
// aperturas del mismo adjunto. El orden de bloqueo del plan es estado del cliente -> trabajo. Falla hoy porque las migraciones
// 0054-0056 aun no existen. El contrato esta en la cabecera de buzon-soporte.ts.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import {
  abrirAdmin,
  claveBuzon,
  crearDb,
  dormir,
  EscenarioBuzon,
  insertarMensaje,
  sqlAdjunto,
  sqlMensaje,
  upsertEstado,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let backend: ContappDb;
let worker: ContappDb;
let worker2: ContappDb;
let P: string; // estudio con suscripcion
let uP: string;
let uDueno: string;
let uAdmin: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  eb = new EscenarioBuzon(admin);
  P = await eb.estudioSub({ estado: "activa" });
  uP = (await eb.et.miembro(P, "contador")).id;
  uDueno = (await eb.et.miembro(P, "dueno")).id;
  uAdmin = (await eb.et.miembro(P, "admin")).id;
  backend = crearDb("contapp_backend", 14);
  worker = crearDb("contapp_worker", 6);
  worker2 = crearDb("contapp_worker", 6);
});
afterAll(async () => {
  await eb?.limpiar();
  for (const d of [backend, worker, worker2])
    await d?.close().catch(() => undefined);
  await admin?.end();
});

const vivos = async (clienteId: string) =>
  (
    await admin.query(
      "select id, prioridad, estado, creado_por from job_registro where cliente_id = $1 and tipo = 'sol.buzon.revisar' and estado in ('en_cola', 'ejecutando')",
      [clienteId],
    )
  ).rows;

/** «Revisar ahora» tal como lo ordena el plan: estado FOR UPDATE, luego trabajo vivo (elevarlo) o encolar interactivo. */
async function revisarAhora(c: ClientePrueba, esperaMs = 30): Promise<string> {
  return backend.withTenant({ tenantId: P, userId: uP }, async (tx) => {
    await tx.query(
      "select 1 from buzon_estado_cliente where cliente_id = $1 for update",
      [c.id],
    );
    if (esperaMs > 0)
      await tx.query("select pg_sleep($1::float)", [esperaMs / 1000]);
    const vivo = (
      await tx.query(
        "select id from job_registro where cliente_id = $1 and tipo = 'sol.buzon.revisar' and estado in ('en_cola', 'ejecutando')",
        [c.id],
      )
    ).rows[0];
    if (vivo) {
      await tx.query("select buzon_elevar_prioridad($1::uuid)", [vivo.id]);
      return vivo.id as string;
    }
    const nuevo = await tx.query(
      `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
       values ($1, $2, 'sol.buzon.revisar', 'sol', 'sol', 'interactivo', 'en_cola', '{}'::jsonb, $3, $4, 4) returning id`,
      [c.id, c.ruc, claveBuzon(c.id), uP],
    );
    await tx.query(
      "update buzon_estado_cliente set ultima_solicitud_en = now() where cliente_id = $1",
      [c.id],
    );
    return nuevo.rows[0].id as string;
  });
}

const programar = (c: ClientePrueba) =>
  worker.withTenant(
    { tenantId: P },
    async (tx) =>
      (
        await tx.query("select * from encolar_buzon_programados($1::uuid[])", [
          [c.id],
        ])
      ).rows,
  );

describe("programador y «Revisar ahora» (CA-11, riesgo de interbloqueo del plan)", () => {
  it("10 rondas simultaneas: sin interbloqueo ni error y con un solo trabajo vivo, interactivo", async () => {
    const clientes: ClientePrueba[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await eb.clienteCon(P, { cred: "configurada" });
      await upsertEstado(admin, P, c.id, {});
      clientes.push(c);
    }
    for (let i = 0; i < clientes.length; i++) {
      const c = clientes[i]!;
      // Rondas pares: el backend toma el estado primero y el programador espera; impares: al reves.
      const prog = (async () => {
        if (i % 2 === 0) await dormir(8);
        return programar(c);
      })();
      const ahora = (async () => {
        if (i % 2 === 1) await dormir(8);
        return revisarAhora(c, i % 3 === 0 ? 0 : 30);
      })();
      const [a, b] = await Promise.allSettled([prog, ahora]);
      expect(
        a.status === "rejected"
          ? `programador: ${String((a.reason as { code?: string }).code)}`
          : "ok",
        `ronda ${i}`,
      ).toBe("ok");
      expect(
        b.status === "rejected"
          ? `revisar: ${String((b.reason as { code?: string }).code)}`
          : "ok",
        `ronda ${i}`,
      ).toBe("ok");
      const v = await vivos(c.id);
      expect(v, `ronda ${i}: un solo trabajo vivo`).toHaveLength(1);
      expect(
        v[0]!.prioridad,
        `ronda ${i}: queda interactivo (lo encolo «ahora» o se elevo el programado)`,
      ).toBe("interactivo");
      expect(
        b.status === "fulfilled" && b.value,
        `ronda ${i}: «ahora» devuelve el trabajo vivo`,
      ).toBe(v[0]!.id);
    }
  }, 60_000);

  it("12 «Revisar ahora» a la vez del mismo cliente dejan un solo trabajo, todos con el mismo id", async () => {
    const c = await eb.clienteCon(P, { cred: "configurada" });
    await upsertEstado(admin, P, c.id, {});
    const r = await Promise.allSettled(
      Array.from({ length: 12 }, () => revisarAhora(c, 5)),
    );
    expect(r.filter((x) => x.status === "rejected")).toEqual([]);
    const v = await vivos(c.id);
    expect(v).toHaveLength(1);
    const ids = new Set(
      r.map((x) => (x.status === "fulfilled" ? x.value : "")),
    );
    expect([...ids]).toEqual([v[0]!.id]);
  }, 30_000);

  it("dos programadores (dos workers) sobre el mismo cliente dejan un solo trabajo vivo y uno de ellos recibe vacio", async () => {
    const c = await eb.clienteCon(P, { cred: "configurada" });
    const llamar = (db: ContappDb) =>
      db.withTenant(
        { tenantId: P },
        async (tx) =>
          (
            await tx.query(
              "select * from encolar_buzon_programados($1::uuid[])",
              [[c.id]],
            )
          ).rows,
      );
    const [a, b] = await Promise.all([llamar(worker), llamar(worker2)]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(await vivos(c.id)).toHaveLength(1);
  }, 30_000);
});

describe("dos capturas del mismo mensaje nuevo (CA-6, CA-11)", () => {
  /** Inserta el mismo critico avisado con ON CONFLICT DO NOTHING; `retraso` espera antes de empezar y `sostener` antes de confirmar. */
  async function insertarCritico(
    db: ContappDb,
    c: ClientePrueba,
    idSunat: string,
    o: { retraso?: number; sostener?: number; fallar?: boolean },
  ): Promise<string | undefined> {
    if (o.retraso) await dormir(o.retraso);
    const m = sqlMensaje(P, c.id, {
      idSunat,
      critico: true,
      avisado: true,
      categoria: "coactiva",
      conflicto: true,
    });
    return db.withTenant({ tenantId: P }, async (tx) => {
      const id = (await tx.query(m.text, m.values)).rows[0]?.id as
        string | undefined;
      if (o.sostener)
        await tx.query("select pg_sleep($1::float)", [o.sostener / 1000]);
      if (o.fallar) throw new Error("revertir");
      return id;
    });
  }

  it("5 rondas: una fila y una notificacion por destinatario; si la primera se revierte, entra la segunda y avisa una vez", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await eb.clienteCon(P, { cred: null });
      const idSunat = `DUP-${ronda}`;
      const revierte = ronda % 2 === 1;
      const [a, b] = await Promise.allSettled([
        insertarCritico(worker, c, idSunat, {
          sostener: 150,
          fallar: revierte,
        }),
        insertarCritico(worker2, c, idSunat, { retraso: 40 }),
      ]);
      expect(b.status, `ronda ${ronda} segunda captura`).toBe("fulfilled");
      if (revierte) {
        expect(a.status).toBe("rejected");
        expect(
          b.status === "fulfilled" && b.value,
          `ronda ${ronda}: la segunda inserta`,
        ).toBeTruthy();
      } else {
        expect(
          a.status === "fulfilled" && a.value,
          `ronda ${ronda}: la primera inserta`,
        ).toBeTruthy();
        expect(
          b.status === "fulfilled" && b.value,
          `ronda ${ronda}: la segunda no inserta`,
        ).toBeUndefined();
      }
      const filas = (
        await admin.query(
          "select id from buzon_mensaje where cliente_id = $1 and id_sunat = $2",
          [c.id, idSunat],
        )
      ).rows;
      expect(filas, `ronda ${ronda}: una fila`).toHaveLength(1);
      const destinos = await eb.avisados(P, c.id);
      expect(
        destinos,
        `ronda ${ronda}: una notificacion por destinatario`,
      ).toEqual([uDueno, uAdmin].sort());
      const claves = (
        await eb.notifs(P, { tipo: "buzon_critico", clienteId: c.id })
      ).map((n) => n.clave_dedupe);
      expect(new Set(claves)).toEqual(
        new Set([`buzon_critico:${filas[0]!.id}`]),
      );
    }
  }, 60_000);

  it("dos aperturas del mismo adjunto a la vez dejan una sola fila (unica por mensaje e id de SUNAT)", async () => {
    const c = await eb.clienteCon(P, { cred: null });
    const m = await insertarMensaje(admin, P, c.id, {});
    const unA = sqlAdjunto(P, c.id, m, { idSunat: "ADJ-UNICO" });
    const texto = unA.text.replace(
      " returning id",
      " on conflict (tenant_id, mensaje_id, id_sunat) do nothing returning id",
    );
    const abrir = (db: ContappDb, retraso: number, sostener: number) =>
      db.withTenant({ tenantId: P }, async (tx) => {
        if (retraso) await dormir(retraso);
        // cada apertura guarda el mismo adjunto con su propia ruta (uuid distinto)
        const v = sqlAdjunto(P, c.id, m, { idSunat: "ADJ-UNICO" }).values;
        const r = await tx.query(texto, v);
        if (sostener)
          await tx.query("select pg_sleep($1::float)", [sostener / 1000]);
        return r.rowCount ?? 0;
      });
    const [a, b] = await Promise.all([
      abrir(worker, 0, 120),
      abrir(worker2, 30, 0),
    ]);
    expect([a, b].sort()).toEqual([0, 1]);
    const n = (
      await admin.query(
        "select count(*)::int as n from buzon_adjunto where mensaje_id = $1",
        [m],
      )
    ).rows[0].n;
    expect(n).toBe(1);
  }, 30_000);
});

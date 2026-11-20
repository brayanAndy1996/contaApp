// Spec 023 (T11, decisión del orquestador sobre el punto 2 de T4): «Revisar ahora» antes del primer ciclo, en BD real. Sin fila de
// buzon_estado_cliente no hay nada que bloquear con FOR UPDATE y el backend no tiene INSERT en esa tabla: la función acotada
// public.buzon_estado_bloquear(p_cliente) (0055, SECURITY DEFINER, EXECUTE solo contapp_backend) crea la fila si falta
// (ON CONFLICT DO NOTHING) y la bloquea. Con ella el orden global estado -> trabajo vale también para el primer pedido.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import {
  abrirAdmin,
  claveBuzon,
  conExecute,
  crearDb,
  dormir,
  EscenarioBuzon,
  infoFuncion,
  ROLES_EXEC,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let backend: ContappDb;
let worker: ContappDb;
let P: string;
let Y: string;
let uP: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  eb = new EscenarioBuzon(admin);
  P = await eb.estudioSub({ estado: "activa" });
  Y = await eb.estudioSub({ estado: "activa" });
  uP = (await eb.et.miembro(P, "contador")).id;
  backend = crearDb("contapp_backend", 14);
  worker = crearDb("contapp_worker", 6);
});
afterAll(async () => {
  await eb?.limpiar();
  for (const d of [backend, worker]) await d?.close().catch(() => undefined);
  await admin?.end();
});

const FIRMA = "public.buzon_estado_bloquear(uuid)";
const ctxB = () => ({ tenantId: P, userId: uP });
const estados = async (clienteId: string) =>
  (
    await admin.query(
      "select * from buzon_estado_cliente where cliente_id = $1",
      [clienteId],
    )
  ).rows;
const vivos = async (clienteId: string) =>
  (
    await admin.query(
      "select id, prioridad from job_registro where cliente_id = $1 and tipo = 'sol.buzon.revisar' and estado in ('en_cola', 'ejecutando')",
      [clienteId],
    )
  ).rows;

/** «Revisar ahora» del plan sin sembrar el estado: bloquear (crea si falta) -> vivo (elevar) o encolar -> ultima_solicitud_en. */
function revisarAhora(c: ClientePrueba, esperaMs = 20): Promise<string> {
  return backend.withTenant(ctxB(), async (tx) => {
    await tx.query("select * from buzon_estado_bloquear($1::uuid)", [c.id]);
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

describe("buzon_estado_bloquear: función acotada del backend (0055)", () => {
  it("SECURITY DEFINER de un dueño sin superusuario ni BYPASSRLS, search_path fijo y EXECUTE solo para contapp_backend", async () => {
    const f = await infoFuncion(admin, FIRMA);
    expect(f.secdef).toBe(true);
    expect(f.duenoSuper).toBe(false);
    expect(f.duenoBypass).toBe(false);
    expect(f.config.join(",")).toMatch(/search_path=pg_catalog, pg_temp/);
    expect(await conExecute(admin, FIRMA, ROLES_EXEC)).toEqual([
      "contapp_backend",
    ]);
  });

  it("sin fila de estado (antes del primer ciclo): la crea vacía, la devuelve y el backend puede fijar ultima_solicitud_en", async () => {
    const c = await eb.clienteCon(P, { cred: "configurada" });
    expect(await estados(c.id)).toEqual([]);
    const r = await backend.withTenant(ctxB(), async (tx) => {
      const e = (
        await tx.query("select * from buzon_estado_bloquear($1::uuid)", [c.id])
      ).rows;
      await tx.query(
        "update buzon_estado_cliente set ultima_solicitud_en = now() where cliente_id = $1",
        [c.id],
      );
      return e;
    });
    expect(r).toEqual([
      {
        ultima_programada_en: null,
        ultima_solicitud_en: null,
        ultima_captura_en: null,
        sincronizado_en: null,
        cursor_pendiente: null,
      },
    ]);
    const filas = await estados(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      tenant_id: P,
      ultima_programada_en: null,
      sincronizado_en: null,
    });
    expect(filas[0].ultima_solicitud_en).not.toBeNull();
  });

  it("con fila existente no la duplica ni la cambia y devuelve sus valores", async () => {
    const c = await eb.clienteCon(P, { cred: "configurada" });
    await admin.query(
      "insert into buzon_estado_cliente (tenant_id, cliente_id, ultima_captura_en, cursor_pendiente) values ($1, $2, now(), 'c-1')",
      [P, c.id],
    );
    const r = await backend.withTenant(
      ctxB(),
      async (tx) =>
        (
          await tx.query("select * from buzon_estado_bloquear($1::uuid)", [
            c.id,
          ])
        ).rows,
    );
    expect(r).toHaveLength(1);
    expect(r[0].cursor_pendiente).toBe("c-1");
    expect(r[0].ultima_captura_en).not.toBeNull();
    expect(await estados(c.id)).toHaveLength(1);
  });

  it("deja la fila bloqueada hasta el fin de la transacción (FOR UPDATE)", async () => {
    // Fila ya confirmada: la que crea la propia transacción no es visible para otra hasta el COMMIT (la serializa la única).
    const c = await eb.clienteCon(P, { cred: "configurada" });
    await admin.query(
      "insert into buzon_estado_cliente (tenant_id, cliente_id) values ($1, $2)",
      [P, c.id],
    );
    const bloqueado = await backend.withTenant(ctxB(), async (tx) => {
      await tx.query("select * from buzon_estado_bloquear($1::uuid)", [c.id]);
      // Otra conexión que intenta bloquear sin esperar falla con 55P03 mientras esta transacción sigue abierta.
      const otra = await admin.connect();
      try {
        await otra.query("begin");
        return await otra
          .query(
            "select 1 from buzon_estado_cliente where cliente_id = $1 for update nowait",
            [c.id],
          )
          .then(
            () => "libre",
            (e: { code?: string }) => e.code,
          );
      } finally {
        await otra.query("rollback").catch(() => undefined);
        otra.release();
      }
    });
    expect(bloqueado).toBe("55P03");
  });

  it("cliente de otro estudio o inexistente: 23503 y no crea nada; NULL: 22023; sin estudio: 42501; el worker no puede (42501)", async () => {
    const cy = await eb.clienteCon(Y, { cred: "configurada" });
    const sql = "select * from buzon_estado_bloquear($1::uuid)";
    const ajeno = await intentar(backend, ctxB(), sql, [cy.id]);
    const inexistente = await intentar(backend, ctxB(), sql, [
      "00000000-0000-4000-8000-00000000dead",
    ]);
    const nulo = await intentar(backend, ctxB(), sql, [null]);
    for (const [r, code] of [
      [ajeno, "23503"],
      [inexistente, "23503"],
      [nulo, "22023"],
    ] as const) {
      expect(r.ok).toBe(false);
      expect((r as { code?: string }).code).toBe(code);
    }
    expect(await estados(cy.id)).toEqual([]);
    const sinEstudio = await admin.connect();
    try {
      await sinEstudio.query("begin");
      await sinEstudio.query("set local role contapp_backend");
      const code = await sinEstudio.query(sql, [cy.id]).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect(code).toBe("42501");
    } finally {
      await sinEstudio.query("rollback").catch(() => undefined);
      sinEstudio.release();
    }
    const c = await eb.clienteCon(P, { cred: "configurada" });
    const w = await intentar(worker, { tenantId: P }, sql, [c.id]);
    expect(w.ok).toBe(false);
    expect((w as { code?: string }).code).toBe("42501");
  });
});

describe("«Revisar ahora» antes del primer ciclo frente al programador (CA-11, orden estado -> trabajo)", () => {
  it("10 rondas sin fila de estado previa: sin interbloqueo, una sola fila de estado y un solo trabajo vivo, interactivo", async () => {
    for (let i = 0; i < 10; i++) {
      const c = await eb.clienteCon(P, { cred: "configurada" });
      expect(await estados(c.id), `ronda ${i}: sin estado previo`).toEqual([]);
      const prog = (async () => {
        if (i % 2 === 0) await dormir(8);
        return worker.withTenant(
          { tenantId: P },
          async (tx) =>
            (
              await tx.query(
                "select * from encolar_buzon_programados($1::uuid[])",
                [[c.id]],
              )
            ).rows,
        );
      })();
      const ahora = (async () => {
        if (i % 2 === 1) await dormir(8);
        return revisarAhora(c, i % 3 === 0 ? 0 : 25);
      })();
      const [a, b] = await Promise.allSettled([prog, ahora]);
      expect(
        a.status === "rejected"
          ? String((a.reason as { code?: string }).code)
          : "ok",
        `ronda ${i} programador`,
      ).toBe("ok");
      expect(
        b.status === "rejected"
          ? String((b.reason as { code?: string }).code)
          : "ok",
        `ronda ${i} revisar`,
      ).toBe("ok");
      expect(
        await estados(c.id),
        `ronda ${i}: una fila de estado`,
      ).toHaveLength(1);
      const v = await vivos(c.id);
      expect(v, `ronda ${i}: un trabajo vivo`).toHaveLength(1);
      expect(v[0]!.prioridad, `ronda ${i}: interactivo`).toBe("interactivo");
      expect(
        b.status === "fulfilled" && b.value,
        `ronda ${i}: «ahora» devuelve el vivo`,
      ).toBe(v[0]!.id);
    }
  }, 60_000);

  it("8 «Revisar ahora» simultáneos de un cliente sin estado: una fila, un trabajo y el mismo id para todos", async () => {
    const c = await eb.clienteCon(P, { cred: "configurada" });
    const r = await Promise.allSettled(
      Array.from({ length: 8 }, () => revisarAhora(c, 5)),
    );
    expect(r.filter((x) => x.status === "rejected")).toEqual([]);
    expect(await estados(c.id)).toHaveLength(1);
    const v = await vivos(c.id);
    expect(v).toHaveLength(1);
    expect(
      new Set(r.map((x) => (x.status === "fulfilled" ? x.value : ""))),
    ).toEqual(new Set([v[0]!.id]));
  }, 30_000);
});

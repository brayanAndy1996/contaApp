// Spec 005 · T17 (H-005-2a-1, H-005-2b-1): pruebas propias del orden global de bloqueo con pares que las
// adversariales no cubren. Una transacción de la prueba retiene un cliente para fijar el orden de la carrera (la
// misma carrera ocurre sola); ninguna petición debe morir por interbloqueo (500) ni subir `deadlocks`.
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco } from "../../../test/soporte-acceso.js";
import { pausa } from "../../../test/soporte.js";

let b: Banco;
let bloqueos: ReturnType<typeof createDb>;

beforeAll(async () => {
  b = await abrirBanco();
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
  bloqueos = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
});
afterAll(async () => {
  await bloqueos?.close();
  await b?.cerrar();
});

/** Retiene el cliente (FOR UPDATE) en una transacción propia hasta `fin`. */
async function retenerCliente(tenantId: string, clienteId: string) {
  const c = await bloqueos.pool.connect();
  const pid = (await c.query("select pg_backend_pid() as p")).rows[0].p as number;
  await c.query("begin");
  await c.query("select 1 from cliente where tenant_id = $1 and id = $2 for update", [tenantId, clienteId]);
  return {
    pid,
    fin: async () => {
      try {
        await c.query("commit");
      } finally {
        c.release();
      }
    },
  };
}

/** Espera a que `n` conexiones queden bloqueadas, directa o indirectamente, por `pid`. */
async function esperarEspera(pid: number, n: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const r = await b.sql(
      `with d as (select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid)))
       select ((select count(*) from d) + (select count(*) from pg_stat_activity a
         where a.pid not in (select pid from d) and pg_blocking_pids(a.pid) && array(select pid from d)))::int as n`,
      [pid],
    );
    if (r[0].n >= n) return;
    await pausa(100);
  }
  throw new Error("ninguna petición llegó a esperar el bloqueo (entorno)");
}

const interbloqueos = async (): Promise<number> =>
  Number((await b.sql("select deadlocks from pg_stat_database where datname = current_database()"))[0].deadlocks);

describe("T17 · orden global de bloqueo (membresías -> clientes -> asignaciones)", () => {
  it("por-cliente de un Administrador y por-usuario de otro cruzados sobre el mismo cliente y miembro: 200 y 200", async () => {
    const E = await b.estudio();
    const a1 = await b.miembro(E.tenantId, "admin");
    const a2 = await b.miembro(E.tenantId, "admin");
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = await b.clientes(E.tenantId, 1);
    const antes = await interbloqueos();
    const h = await retenerCliente(E.tenantId, c!);
    // por-cliente llega primero a la cola del cliente; por-usuario ya tiene (a1, u). Antes de T17, por-cliente tomaba
    // el cliente y esperaba a (u, a1) FOR SHARE mientras por-usuario esperaba el cliente: 40P01.
    const p1 = b.llamar(a2, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [u.id, a1.id] });
    await esperarEspera(h.pid, 1);
    const p2 = b.llamar(a1, "POST", "/asignaciones/por-usuario", { usuarioId: u.id, clienteIds: [c], tipo: "colaborador" });
    await esperarEspera(h.pid, 2);
    await h.fin();
    const rs = await Promise.all([p1, p2]);
    expect({ estados: rs.map((r) => r.status), interbloqueos: (await interbloqueos()) - antes }).toEqual({
      estados: [200, 200],
      interbloqueos: 0,
    });
  }, 30_000);

  it("error de regla limpio: por-cliente en vuelo y el Dueño desactiva a un miembro del lote -> 200 + 200 o 409, nunca 500", async () => {
    const E = await b.estudio();
    const adm = await b.miembro(E.tenantId, "admin");
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = await b.clientes(E.tenantId, 1);
    const antes = await interbloqueos();
    const h = await retenerCliente(E.tenantId, c!);
    const p1 = b.llamar(adm, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [u.id] });
    await esperarEspera(h.pid, 1);
    const p2 = b.llamar(E.titular, "POST", `/usuarios/${u.id}/desactivar`);
    await esperarEspera(h.pid, 2);
    await h.fin();
    const rs = await Promise.all([p1, p2]);
    // El lote ganó la membresía: asigna y luego desactivar la retira (D19).
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await b.sql("select 1 from asignacion where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id])).toEqual([]);
    expect((await interbloqueos()) - antes).toBe(0);

    // Ya desactivado: el lote responde 409 de regla, no 500.
    const r = await b.llamar(adm, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [u.id] });
    expect(r.status).toBe(409);
  }, 30_000);
});

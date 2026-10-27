// Spec 005 · T16b · ronda adversarial 2b (ataques nuevos contra las correcciones de T15 y huecos restantes),
// capa HTTP. Solo afirma el comportamiento seguro esperado; si una prueba falla es un hallazgo (tasks.md,
// Resultado de T16b). Estudios, usuarios y correos propios por ejecución (abrirBanco los borra al cerrar);
// canarios, sin secretos. Los bloqueos de la prueba solo fijan el orden de una carrera que también ocurre sola.
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { pausa } from "../../../test/soporte.js";

let b: Banco;
let bloqueos: ReturnType<typeof createDb>;
const PWD_R2B = "Clave-r2b-005-canario-ñ";

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

const aceptarR2b = (token: string, nombre = "Invitado r2b") =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre, contrasena: PWD_R2B } });
const consultarR2b = (token: string) => b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } });
const membresiaR2b = async (tenantId: string, correo: string) =>
  (
    await b.sql(
      "select m.rol from membresia m join usuario u on u.id = m.usuario_id where m.tenant_id = $1 and u.email = $2",
      [tenantId, correo],
    )
  )[0];
const pendientesVivasDe = async (tenantId: string, usuarioId: string): Promise<number> =>
  (
    await b.sql(
      `select count(*)::int as n from invitacion
        where tenant_id = $1 and invitado_por = $2 and aceptada_en is null and revocada_en is null`,
      [tenantId, usuarioId],
    )
  )[0].n;

/** Espera (máx. ~8 s) a que `n` conexiones queden bloqueadas, directa o indirectamente, por la transacción `pid`. */
async function esperarEsperaR2b(pid: number, n = 1): Promise<void> {
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

/** Transacción de la prueba que retiene filas; `fin` la confirma (no cambia datos: solo SELECT … FOR UPDATE). */
async function retenerR2b(sqls: Array<[string, unknown[]]>): Promise<{ pid: number; fin: () => Promise<void> }> {
  const c = await bloqueos.pool.connect();
  const pid = (await c.query("select pg_backend_pid() as p")).rows[0].p as number;
  await c.query("begin");
  try {
    for (const [t, v] of sqls) await c.query(t, v);
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    c.release();
    throw e;
  }
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

const retenerCliente = (tenantId: string, clienteId: string) =>
  retenerR2b([["select 1 from cliente where tenant_id = $1 and id = $2 for update", [tenantId, clienteId]]]);

/** Miembro sin sesión cuyo ID ordena ANTES que `ref` (los bloqueos de miembros van en orden de ID). */
async function miembroMenorQue(tenantId: string, ref: string): Promise<string> {
  for (let i = 0; i < 24; i++) {
    const m = await b.miembro(tenantId, "contador", { sesion: false });
    if (m.id < ref) return m.id;
  }
  throw new Error("no se obtuvo un ID menor (entorno)");
}

describe("T16b · lote por-cliente en carrera con otras escrituras (orden de bloqueos miembros/clientes)", () => {
  it("PUT de un Administrador y por-cliente de otro sobre el mismo cliente y miembro: ambos terminan sin 5xx", async () => {
    const E: Estudio = await b.estudio();
    const a1: Actor = await b.miembro(E.tenantId, "admin");
    const a2: Actor = await b.miembro(E.tenantId, "admin");
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = await b.clientes(E.tenantId, 1);
    const h = await retenerCliente(E.tenantId, c!);
    // por-cliente: actor (FOR UPDATE) -> cliente -> miembros (FOR SHARE).
    const p1 = b.llamar(a1, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [u.id] });
    await esperarEsperaR2b(h.pid, 1);
    // PUT: actor y objetivo (FOR UPDATE) -> cliente.
    const p2 = b.llamar(a2, "PUT", `/clientes/${c}/asignaciones/${u.id}`, { tipo: "responsable" });
    await esperarEsperaR2b(h.pid, 2);
    await h.fin();
    const rs = await Promise.all([p1, p2]);
    // Seguro: las dos escrituras se serializan sobre el cliente (ninguna muere por interbloqueo -> 500).
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const filas = await b.sql("select tipo from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3", [
      E.tenantId,
      c,
      u.id,
    ]);
    expect(filas).toEqual([{ tipo: "responsable" }]);
  }, 30_000);

  it("H-005-1b-4: por-cliente de un Administrador en carrera con su propio desactivar del miembro: sin 5xx", async () => {
    const E = await b.estudio();
    const admin = await b.miembro(E.tenantId, "admin");
    const u = await miembroMenorQue(E.tenantId, admin.id);
    const [c] = await b.clientes(E.tenantId, 1);
    const h = await retenerCliente(E.tenantId, c!);
    // por-cliente bloquea al actor (nuevo en T15) y espera el cliente.
    const p1 = b.llamar(admin, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [u] });
    await esperarEsperaR2b(h.pid, 1);
    // desactivar bloquea (u, admin) en orden de ID: toma u y espera al actor.
    const p2 = b.llamar(admin, "POST", `/usuarios/${u}/desactivar`);
    await esperarEsperaR2b(h.pid, 2);
    await h.fin();
    const rs = await Promise.all([p1, p2]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const activo = (
      await b.sql("select desactivada_en is null as activo from membresia where tenant_id = $1 and usuario_id = $2", [
        E.tenantId,
        u,
      ])
    )[0].activo;
    const filas = await b.sql("select 1 from asignacion where tenant_id = $1 and usuario_id = $2", [E.tenantId, u]);
    // D19: desactivado => sin asignaciones.
    if (activo === false) expect(filas).toEqual([]);
  }, 30_000);
});

describe("T16b · H-005-1b-1 (a) por otras vías: invitar en vuelo, reenviar, otros estudios", () => {
  it("invitar en carrera con desactivar o degradar a quien invita nunca deja una invitación viva que no podría emitir", async () => {
    const E = await b.estudio();
    const vistos: Array<Record<string, unknown>> = [];
    for (const accion of ["desactivar", "degradar"] as const) {
      for (const primero of ["invitar", "quitar"] as const) {
        const x = await b.miembro(E.tenantId, "admin");
        const correo = b.correoNuevo();
        const h = await retenerR2b([
          ["select 1 from membresia where tenant_id = $1 and usuario_id = $2 for update", [E.tenantId, x.id]],
        ]);
        const invitar = () => b.llamar(x, "POST", "/invitaciones", { correo, rol: "admin" });
        const quitar = () =>
          accion === "desactivar"
            ? b.llamar(E.titular, "POST", `/usuarios/${x.id}/desactivar`)
            : b.llamar(E.titular, "PATCH", `/usuarios/${x.id}/rol`, { rol: "contador" });
        const p1 = (primero === "invitar" ? invitar : quitar)();
        await esperarEsperaR2b(h.pid, 1);
        const p2 = (primero === "invitar" ? quitar : invitar)();
        await esperarEsperaR2b(h.pid, 2);
        await h.fin();
        const [r1, r2] = await Promise.all([p1, p2]);
        const rInv = primero === "invitar" ? r1 : r2;
        let consulta: number | null = null;
        if (rInv.status === 201) consulta = (await consultarR2b(await b.tokenDe(correo))).status;
        vistos.push({
          accion,
          primero,
          sin5xx: r1.status < 500 && r2.status < 500,
          vivas: await pendientesVivasDe(E.tenantId, x.id),
          consulta: consulta ?? 400,
        });
      }
    }
    expect(vistos).toEqual(
      ["desactivar", "degradar"].flatMap((accion) =>
        ["invitar", "quitar"].map((primero) => ({ accion, primero, sin5xx: true, vivas: 0, consulta: 400 })),
      ),
    );
  }, 90_000);

  it("una invitación revocada por desactivar o degradar no revive con reenviar (antes ni después de reactivar)", async () => {
    const E = await b.estudio();
    const d2 = await b.miembro(E.tenantId, "dueno");
    const x = await b.miembro(E.tenantId, "admin");
    const cX = b.correoNuevo();
    const iX = await b.invitar(x, cX, "contador");
    const cD = b.correoNuevo();
    const iD = await b.invitar(E.titular, cD, "dueno");
    expect([iX.r.status, iD.r.status]).toEqual([201, 201]);

    expect((await b.llamar(E.titular, "POST", `/usuarios/${x.id}/desactivar`)).status).toBe(200);
    expect((await b.llamar(d2, "PATCH", `/usuarios/${E.titular.id}/rol`, { rol: "admin" })).status).toBe(200);

    const re1 = await b.llamar(d2, "POST", `/invitaciones/${iX.r.body.id}/reenviar`);
    const re2 = await b.llamar(d2, "POST", `/invitaciones/${iD.r.body.id}/reenviar`);
    expect((await b.llamar(d2, "POST", `/usuarios/${x.id}/reactivar`)).status).toBe(200);
    const re3 = await b.llamar(d2, "POST", `/invitaciones/${iX.r.body.id}/reenviar`);
    await pausa(100);
    expect({
      reenvios: [re1.status, re2.status, re3.status],
      correosNuevos: [b.h.correo.para(cX).length, b.h.correo.para(cD).length],
      consultas: [(await consultarR2b(iX.token!)).status, (await consultarR2b(iD.token!)).status],
    }).toEqual({ reenvios: [404, 404, 404], correosNuevos: [1, 1], consultas: [400, 400] });
  });

  it("desactivar a un Administrador en A no revoca ni invalida lo que invitó en B (la revocación no cruza estudios)", async () => {
    const A = await b.estudio();
    const B = await b.estudio();
    const x = await b.miembro(A.tenantId, "admin");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')", [B.tenantId, x.id]);
    const sB = await b.sesion(x, B.tenantId);
    const xB: Actor = { ...x, tenantId: B.tenantId, ...sB };
    const cA = b.correoNuevo();
    const cB = b.correoNuevo();
    const iA = await b.invitar(x, cA, "contador");
    const iB = await b.invitar(xB, cB, "contador");
    expect([iA.r.status, iB.r.status]).toEqual([201, 201]);

    expect((await b.llamar(A.titular, "POST", `/usuarios/${x.id}/desactivar`)).status).toBe(200);

    expect((await consultarR2b(iA.token!)).status).toBe(400);
    expect((await consultarR2b(iB.token!)).status).toBe(200);
    expect((await aceptarR2b(iB.token!)).status).toBe(204);
    expect((await membresiaR2b(B.tenantId, cB))?.rol).toBe("contador");
  });
});

describe("T16b · H-005-1b-3 por otra vía: nombres que se ven en blanco sin ser control ni espacio", () => {
  it("un nombre hecho solo de caracteres de formato invisibles (ZWSP, WJ, marcas bidi) se rechaza con 400", async () => {
    const E = await b.estudio();
    const vistos: Array<{ nombre: string; status: number; cuenta: boolean }> = [];
    for (const nombre of ["​​", "⁠", "‮‬"]) {
      const correo = b.correoNuevo();
      const { token } = await b.invitar(E.titular, correo, "lectura");
      const r = await aceptarR2b(token!, nombre);
      vistos.push({
        nombre: [...nombre].map((ch) => ch.codePointAt(0)!.toString(16)).join(" "),
        status: r.status,
        cuenta: (await membresiaR2b(E.tenantId, correo)) !== undefined,
      });
    }
    expect(vistos).toEqual(
      ["200b 200b", "2060", "202e 202c"].map((nombre) => ({ nombre, status: 400, cuenta: false })),
    );
  });
});

describe("T16b · H-005-1a-1 por otra vía: IDs del cuerpo de los lotes con otra grafía", () => {
  it("el mismo UUID en minúsculas y en mayúsculas dentro de un lote es un solo ID (200, 1 asignado), no 404", async () => {
    const E = await b.estudio();
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c1, c2] = await b.clientes(E.tenantId, 2);
    const r1 = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", {
      usuarioId: u.id,
      clienteIds: [c1, c1!.toUpperCase()],
      tipo: "colaborador",
    });
    const r2 = await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", {
      clienteId: c2,
      usuarioIds: [u.id, u.id.toUpperCase()],
    });
    expect([
      { status: r1.status, body: r1.body },
      { status: r2.status, body: r2.body },
    ]).toEqual([
      { status: 200, body: { asignados: 1 } },
      { status: 200, body: { asignados: 1 } },
    ]);
  });
});

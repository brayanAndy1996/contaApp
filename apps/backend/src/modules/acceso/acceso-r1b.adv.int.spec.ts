// Spec 005 · T14b · ronda adversarial 1b (escenarios nuevos, caja blanca), capa HTTP. Solo afirma el
// comportamiento seguro esperado; si una prueba falla es un hallazgo (tasks.md, Resultado de T14b).
// Estudios, usuarios y correos propios por ejecución (abrirBanco los borra al cerrar); canarios, sin secretos.
import { randomBytes } from "node:crypto";
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { ORIGEN, pausa } from "../../../test/soporte.js";

let b: Banco;
let bloqueos: ReturnType<typeof createDb>;
const PWD_NUEVA = "Clave-r1b-005-canario-ñ";

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

const aceptar = (token: string, nombre = "Invitado r1b", contrasena = PWD_NUEVA) =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre, contrasena } });
const consultar = (token: string) => b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } });
const membresiaDe = async (tenantId: string, correo: string) =>
  (
    await b.sql(
      "select m.rol, m.desactivada_en from membresia m join usuario u on u.id = m.usuario_id where m.tenant_id = $1 and u.email = $2",
      [tenantId, correo],
    )
  )[0];

/** Espera (máx. ~8 s) a que `n` conexiones queden bloqueadas por la transacción `pid` de la prueba. */
async function esperarEspera(pid: number, n = 1): Promise<void> {
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

/** Abre una transacción de la prueba que retiene filas de membresía; `fin` la confirma. */
async function retener(sqls: Array<[string, unknown[]]>): Promise<{ pid: number; fin: () => Promise<void> }> {
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

describe("T14b · invitaciones emitidas por quien ya perdió la autoridad (D8: nadie otorga lo que no tiene)", () => {
  it("la invitación de un Administrador que luego se desactiva no debe seguir otorgando el rol admin", async () => {
    const E: Estudio = await b.estudio();
    const admin = await b.miembro(E.tenantId, "admin");
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(admin, correo, "admin");
    expect(r.status).toBe(201);

    const off = await b.llamar(E.titular, "POST", `/usuarios/${admin.id}/desactivar`);
    expect(off.status).toBe(200);

    const acc = await aceptar(token as string);
    // Seguro: la invitación muere con la autoridad de quien la emitió (o se revoca al desactivarlo).
    expect(acc.status).toBe(400);
    expect(await membresiaDe(E.tenantId, correo)).toBeUndefined();
  });

  it("la invitación de rol dueno de un Dueño que luego es degradado no debe crear un Dueño nuevo", async () => {
    const E = await b.estudio();
    const d2 = await b.miembro(E.tenantId, "dueno");
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(E.titular, correo, "dueno");
    expect(r.status).toBe(201);

    const deg = await b.llamar(d2, "PATCH", `/usuarios/${E.titular.id}/rol`, { rol: "lectura" });
    expect(deg.status).toBe(200);

    const acc = await aceptar(token as string);
    expect(acc.status).toBe(400);
    expect((await membresiaDe(E.tenantId, correo))?.rol).not.toBe("dueno");
  });
});

describe("T14b · entradas hostiles al invitar y aceptar (correo y nombre, cabeceras)", () => {
  let E: Estudio;
  beforeAll(async () => {
    E = await b.estudio();
  });

  it("un correo con NUL o caracteres de control se rechaza con 400 (ni 500 ni invitación creada)", async () => {
    const vistos: Array<{ ctl: number; status: number; correos: number }> = [];
    for (const ctl of ["\u0000", "\u0007", "\u001b"]) {
      const correo = `r1b${randomBytes(4).toString("hex")}${ctl}x@r1b.contapp.test`;
      const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "lectura" });
      await pausa(50);
      vistos.push({ ctl: ctl.charCodeAt(0), status: r.status, correos: b.h.correo.para(correo).length });
    }
    expect(vistos).toEqual([0, 7, 27].map((ctl) => ({ ctl, status: 400, correos: 0 })));
  });

  it("Host y X-Forwarded-Host hostiles no cambian el enlace del correo (sale de APP_ORIGIN)", async () => {
    const correo = b.correoNuevo();
    const r = await b.llamar(
      E.titular,
      "POST",
      "/invitaciones",
      { correo, rol: "lectura" },
      { cabeceras: { Host: "evil.r1b.example", "X-Forwarded-Host": "evil.r1b.example", "X-Forwarded-Proto": "http" } },
    );
    expect(r.status).toBe(201);
    const m = (await b.h.correo.esperar(correo, 1))[0]!;
    expect(m.texto).toContain(`${ORIGEN}/invitacion#t=`);
    expect(JSON.stringify(m)).not.toContain("evil.r1b.example");
  });

  it("aceptar con un nombre que trae NUL responde 400 solicitud_invalida y el token sigue vivo", async () => {
    const correo = b.correoNuevo();
    const { token } = await b.invitar(E.titular, correo, "lectura");
    const r = await aceptar(token as string, "Ana\u0000r1b");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await consultar(token as string)).status).toBe(200);
    expect(await membresiaDe(E.tenantId, correo)).toBeUndefined();
  });
});

describe("T14b · carreras con bloqueos reales", () => {
  it("D18: cambio a Lectura y asignación como responsable en carrera nunca dejan un Lectura responsable (ambos órdenes)", async () => {
    const E = await b.estudio();
    for (const primero of ["asignar", "degradar"] as const) {
      const m = await b.miembro(E.tenantId, "contador", { sesion: false });
      const [c] = await b.clientes(E.tenantId, 1);
      const h = await retener([
        ["select 1 from membresia where tenant_id = $1 and usuario_id = $2 for update", [E.tenantId, m.id]],
      ]);
      const asignar = () => b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${m.id}`, { tipo: "responsable" });
      const degradar = () => b.llamar(E.titular, "PATCH", `/usuarios/${m.id}/rol`, { rol: "lectura" });
      const p1 = (primero === "asignar" ? asignar : degradar)();
      await esperarEspera(h.pid, 1);
      const p2 = (primero === "asignar" ? degradar : asignar)();
      await esperarEspera(h.pid, 2);
      await h.fin();
      const rs = await Promise.all([p1, p2]);
      for (const r of rs) expect([200, 409]).toContain(r.status);
      const rol = (await b.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]))[0].rol;
      const resp = await b.sql(
        "select 1 from asignacion where tenant_id = $1 and usuario_id = $2 and tipo = 'responsable'",
        [E.tenantId, m.id],
      );
      expect({ primero, rol, responsable: resp.length }).toEqual({ primero, rol: "lectura", responsable: 0 });
    }
  }, 60_000);

  it("un Administrador degradado a Lectura mientras su asignación está en vuelo no la completa (como en miembros)", async () => {
    const E = await b.estudio();
    const admin: Actor = await b.miembro(E.tenantId, "admin");
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = await b.clientes(E.tenantId, 1);
    // La prueba degrada al actor (sin confirmar) y retiene al objetivo: el guard lee el rol confirmado (admin)
    // y la escritura ocurre después de confirmarse la degradación.
    const h = await retener([
      ["update membresia set rol = 'lectura' where tenant_id = $1 and usuario_id = $2", [E.tenantId, admin.id]],
      ["select 1 from membresia where tenant_id = $1 and usuario_id = $2 for update", [E.tenantId, m.id]],
    ]);
    const p = b.llamar(admin, "PUT", `/clientes/${c}/asignaciones/${m.id}`, { tipo: "colaborador" });
    await esperarEspera(h.pid, 1);
    await h.fin();
    const r = await p;
    const filas = await b.sql("select 1 from asignacion where tenant_id = $1 and cliente_id = $2", [E.tenantId, c]);
    expect({ status: r.status, filas: filas.length }).toEqual({ status: 403, filas: 0 });
  }, 30_000);
});

describe("T14b · alcance y efectos con membresías en dos estudios (RLS como única barra de los SQL sin tenant)", () => {
  it("asignaciones de otro estudio no se ven, y degradar/desactivar en A no toca las asignaciones de B", async () => {
    const A = await b.estudio();
    const B = await b.estudio();
    const u = await b.miembro(A.tenantId, "contador");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [B.tenantId, u.id]);
    const [cA] = await b.clientes(A.tenantId, 1);
    const [cB] = await b.clientes(B.tenantId, 1);
    await b.asignar(B.tenantId, cB!, u.id, "responsable");

    // En A, con la asignación solo en B: nada visible y el cliente de B es el mismo 404.
    const lista = await b.llamar(u, "GET", "/clientes");
    expect(lista.status).toBe(200);
    expect(lista.body).toEqual([]);
    expect((await b.llamar(u, "GET", `/clientes/${cB}`)).status).toBe(404);
    expect((await b.llamar(u, "GET", `/clientes/${cA}`)).status).toBe(404);

    await b.asignar(A.tenantId, cA!, u.id, "responsable");
    // D18 en A (pasa a Lectura) y D19 en A (desactivar): las sentencias sin tenant_id no deben alcanzar B.
    expect((await b.llamar(A.titular, "PATCH", `/usuarios/${u.id}/rol`, { rol: "lectura" })).status).toBe(200);
    expect((await b.llamar(A.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);
    const enB = await b.sql("select tipo from asignacion where tenant_id = $1 and usuario_id = $2", [B.tenantId, u.id]);
    expect(enB).toEqual([{ tipo: "responsable" }]);
    const enA = await b.sql("select 1 from asignacion where tenant_id = $1 and usuario_id = $2", [A.tenantId, u.id]);
    expect(enA).toEqual([]);
  });
});

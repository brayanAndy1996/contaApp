// Spec 005 · T16a · ronda adversarial 2a (regresión): reintenta cada corrección de T15 (3127e6e) por otra vía
// real de uso. Solo afirma el comportamiento seguro esperado; si una prueba falla es un hallazgo (tasks.md,
// Resultado de T16a). Estudios, usuarios y correos propios (abrirBanco los borra al cerrar); canarios.
import { randomBytes } from "node:crypto";
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco } from "../../../test/soporte-acceso.js";
import { pausa } from "../../../test/soporte.js";

let b: Banco;
let bloqueos: ReturnType<typeof createDb>;
const PWD_NUEVA = "Clave-r2a-005-canario-ñ";

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

const aceptar = (token: string, nombre = "Invitado r2a") =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre, contrasena: PWD_NUEVA } });
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

/** Transacción de la prueba que retiene filas; `fin` la confirma. */
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

/** Alterna mayúsculas y minúsculas en las letras hex del UUID (otra grafía del mismo ID). */
const mixto = (id: string): string =>
  [...id].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join("");

describe("T16a · H-005-1a-1 por otras grafías del propio ID", () => {
  it("mayúsculas mezcladas y guiones %2D sobre uno mismo dan 403 en cambiar rol y desactivar (Dueño y Administrador)", async () => {
    const E = await b.estudio();
    await b.miembro(E.tenantId, "dueno", { sesion: false }); // el titular no es el último Dueño
    const adm = await b.miembro(E.tenantId, "admin");
    const vistos: Record<string, number> = {};
    for (const a of [E.titular, adm] as Actor[]) {
      const grafias = { mixto: mixto(a.id), pct: a.id.toUpperCase().replace(/-/g, "%2D") };
      for (const [g, id] of Object.entries(grafias)) {
        vistos[`${a.rol} rol ${g}`] = (await b.llamar(a, "PATCH", `/usuarios/${id}/rol`, { rol: "lectura" })).status;
        vistos[`${a.rol} desactivar ${g}`] = (await b.llamar(a, "POST", `/usuarios/${id}/desactivar`)).status;
      }
    }
    expect(vistos).toEqual(Object.fromEntries(Object.keys(vistos).map((k) => [k, 403])));
    const filas = await b.sql(
      "select rol, desactivada_en is null as activo from membresia where tenant_id = $1 and usuario_id = any($2::uuid[]) order by rol",
      [E.tenantId, [E.titular.id, adm.id]],
    );
    expect(filas).toEqual([
      { rol: "admin", activo: true },
      { rol: "dueno", activo: true },
    ]);
  });
});

describe("T16a · H-005-1b-1 (decisión: revalidar al aceptar y revocar al desactivar/degradar) por otras vías", () => {
  it("D15: la invitación dueno de un Dueño degradado no la acepta una cuenta existente con su sesión", async () => {
    const E = await b.estudio();
    const d2 = await b.miembro(E.tenantId, "dueno");
    const B = await b.estudio();
    const u = await b.miembro(B.tenantId, "contador"); // cuenta existente con sesión en otro estudio
    const { r, token } = await b.invitar(E.titular, u.correo, "dueno");
    expect(r.status).toBe(201);

    expect((await b.llamar(d2, "PATCH", `/usuarios/${E.titular.id}/rol`, { rol: "admin" })).status).toBe(200);

    expect((await consultar(token as string)).status).toBe(400);
    const acc = await b.llamar(u, "POST", "/invitaciones/aceptar-con-sesion", { token });
    expect({ status: acc.status, body: acc.body }).toEqual({ status: 400, body: { codigo: "invitacion_invalida" } });
    expect(await membresiaDe(E.tenantId, u.correo)).toBeUndefined();
  });

  it("desactivar en A a quien es Administrador en A y en B revoca solo sus invitaciones de A (la de B se acepta)", async () => {
    const A = await b.estudio();
    const B = await b.estudio();
    const x = await b.miembro(A.tenantId, "admin");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')", [B.tenantId, x.id]);
    const sB = await b.sesion(x, B.tenantId);
    const xB: Actor = { ...x, tenantId: B.tenantId, ...sB };
    const correoA = b.correoNuevo();
    const correoB = b.correoNuevo();
    const iA = await b.invitar(x, correoA, "contador");
    const iB = await b.invitar(xB, correoB, "contador");
    expect([iA.r.status, iB.r.status]).toEqual([201, 201]);

    expect((await b.llamar(A.titular, "POST", `/usuarios/${x.id}/desactivar`)).status).toBe(200);

    expect((await aceptar(iA.token as string)).status).toBe(400);
    expect(await membresiaDe(A.tenantId, correoA)).toBeUndefined();
    expect((await aceptar(iB.token as string)).status).toBe(204);
    expect((await membresiaDe(B.tenantId, correoB))?.rol).toBe("contador");
  });

  it("una invitación revocada al degradar no se revive: reenviar/revocar dan 404 y volver a Administrador no la reactiva", async () => {
    const E = await b.estudio();
    const x = await b.miembro(E.tenantId, "admin");
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(x, correo, "contador");
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;

    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${x.id}/rol`, { rol: "lectura" })).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${id}/reenviar`)).status).toBe(404);
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${id}/revocar`)).status).toBe(404);
    await pausa(100);
    expect(b.h.correo.para(correo).length).toBe(1);

    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${x.id}/rol`, { rol: "admin" })).status).toBe(200);
    expect((await consultar(token as string)).status).toBe(400);
    expect((await aceptar(token as string)).status).toBe(400);
    expect(await membresiaDe(E.tenantId, correo)).toBeUndefined();
    // El índice de pendientes quedó libre: otra invitación al mismo correo se emite.
    expect((await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "contador" })).status).toBe(201);
  });

  it("carrera: degradar al invitador mientras otro Dueño reenvía su invitación nunca deja un token vivo", async () => {
    const E = await b.estudio();
    const d3 = await b.miembro(E.tenantId, "dueno");
    const x = await b.miembro(E.tenantId, "admin");
    const correo = b.correoNuevo();
    const { r } = await b.invitar(x, correo, "admin");
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;

    const h = await retener([["select 1 from invitacion where id = $1 for update", [id]]]);
    const degradar = b.llamar(E.titular, "PATCH", `/usuarios/${x.id}/rol`, { rol: "lectura" });
    await esperarEspera(h.pid, 1);
    const reenviar = b.llamar(d3, "POST", `/invitaciones/${id}/reenviar`);
    await esperarEspera(h.pid, 2);
    await h.fin();
    const [rd, rr] = await Promise.all([degradar, reenviar]);
    expect(rd.status).toBe(200);
    expect([200, 404]).toContain(rr.status);
    if (rr.status === 200) await b.h.correo.esperar(correo, 2);
    const ultimo = await b.tokenDe(correo); // el del reenvío si lo hubo; si no, el original
    expect((await consultar(ultimo)).status).toBe(400);
    const fila = (await b.sql("select revocada_en is not null as revocada from invitacion where id = $1", [id]))[0];
    expect(fila).toEqual({ revocada: true });
  }, 30_000);
});

describe("T16a · H-005-1b-2/3 con caracteres que no son de control (Cc)", () => {
  it("correos con separadores Unicode, ancho cero, NEL, NBSP o sustitutos sueltos dan 400 sin invitación ni correo", async () => {
    const E = await b.estudio();
    const vistos: Record<string, string> = {};
    for (const [k, ch] of Object.entries({
      ls: " ",
      zwsp: "​",
      nel: "\u0085",
      nbsp: " ",
      sustituto: "\ud800",
    })) {
      const correo = `r2a${randomBytes(4).toString("hex")}${ch}x@r2a.contapp.test`;
      const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "lectura" });
      await pausa(30);
      vistos[k] = `${r.status}/${b.h.correo.para(correo).length}`;
    }
    const filas = await b.sql("select count(*)::int as n from invitacion where tenant_id = $1", [E.tenantId]);
    expect({ vistos, filas: filas[0].n }).toEqual({
      vistos: { ls: "400/0", zwsp: "400/0", nel: "400/0", nbsp: "400/0", sustituto: "400/0" },
      filas: 0,
    });
  });

  it("un nombre invisible o con control bidireccional (formato Cf: U+200B, U+2060, U+202E) se rechaza con 400", async () => {
    const E = await b.estudio();
    const nombres: Record<string, string> = {
      anchoCero: "​​",
      unionPalabra: "⁠",
      bidi: "Ana‮nimda",
    };
    const vistos: Record<string, string> = {};
    for (const [k, nombre] of Object.entries(nombres)) {
      const correo = b.correoNuevo();
      const { token } = await b.invitar(E.titular, correo, "lectura");
      const r = await aceptar(token as string, nombre);
      const creado = (await b.sql("select nombre from usuario where email = $1", [correo]))[0];
      vistos[k] = `${r.status}/${creado === undefined ? "sin cuenta" : "cuenta creada"}`;
    }
    // Seguro (como el nombre en blanco de H-005-1b-3): 400 solicitud_invalida y ninguna cuenta creada.
    expect(vistos).toEqual(Object.fromEntries(Object.keys(nombres).map((k) => [k, "400/sin cuenta"])));
  });
});

describe("T16a · H-005-1b-4 por retirar, por-cliente y por-usuario (actor desactivado en vuelo)", () => {
  it("un Administrador desactivado mientras su retirar/por-cliente/por-usuario espera no completa la acción", async () => {
    const E = await b.estudio();
    const vistos: Record<string, string> = {};
    for (const op of ["retirar", "por-cliente", "por-usuario"] as const) {
      const adm = await b.miembro(E.tenantId, "admin");
      const m = await b.miembro(E.tenantId, "contador", { sesion: false });
      const [c] = (await b.clientes(E.tenantId, 1)) as [string];
      if (op === "retirar") await b.asignar(E.tenantId, c, m.id, "colaborador");
      const h = await retener([
        ["update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, adm.id]],
      ]);
      const p =
        op === "retirar"
          ? b.llamar(adm, "DELETE", `/clientes/${c}/asignaciones/${m.id}`)
          : op === "por-cliente"
            ? b.llamar(adm, "POST", "/asignaciones/por-cliente", { clienteId: c, usuarioIds: [m.id] })
            : b.llamar(adm, "POST", "/asignaciones/por-usuario", { usuarioId: m.id, clienteIds: [c], tipo: "colaborador" });
      await esperarEspera(h.pid, 1);
      await h.fin();
      const r = await p;
      const filas = await b.sql("select count(*)::int as n from asignacion where tenant_id = $1 and cliente_id = $2", [
        E.tenantId,
        c,
      ]);
      vistos[op] = `${r.status}/${filas[0].n}`;
    }
    // Seguro: 403 y el cliente queda como estaba (1 fila en retirar, 0 en los lotes).
    expect(vistos).toEqual({ retirar: "403/1", "por-cliente": "403/0", "por-usuario": "403/0" });
  }, 60_000);

  it("dos Administradores que se agregan mutuamente por /asignaciones/por-cliente a la vez no reciben 500 (interbloqueo)", async () => {
    const E = await b.estudio();
    const a1 = await b.miembro(E.tenantId, "admin");
    const a2 = await b.miembro(E.tenantId, "admin");
    const [c1, c2] = (await b.clientes(E.tenantId, 2)) as [string, string];
    // Retiene ambos clientes: cada petición bloquea primero a su actor (FOR UPDATE, T15) y se detiene en el cliente.
    const h = await retener([["select 1 from cliente where id = any($1::uuid[]) for update", [[c1, c2]]]]);
    const p1 = b.llamar(a1, "POST", "/asignaciones/por-cliente", { clienteId: c1, usuarioIds: [a2.id] });
    await esperarEspera(h.pid, 1);
    const p2 = b.llamar(a2, "POST", "/asignaciones/por-cliente", { clienteId: c2, usuarioIds: [a1.id] });
    await esperarEspera(h.pid, 2);
    await h.fin();
    const rs = await Promise.all([p1, p2]);
    const filas = await b.sql("select count(*)::int as n from asignacion where tenant_id = $1", [E.tenantId]);
    // Seguro: ambas completan (dos filas) o la perdedora recibe un 409 limpio; nunca 500.
    const estados = rs.map((r) => (r.status === 200 || r.status === 409 ? "200|409" : r.status));
    expect({ estados, filas: filas[0].n }).toEqual({
      estados: ["200|409", "200|409"],
      filas: rs.filter((r) => r.status === 200).length,
    });
  }, 30_000);
});

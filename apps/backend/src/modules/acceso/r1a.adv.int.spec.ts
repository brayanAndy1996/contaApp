/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T14a (005) · Ronda adversarial 1a, caja negra: lista mínima de "Ataques mínimos" de la spec.
// Solo usa el contrato público (HTTP, `crearApp`, tablas) a través de `test/soporte-acceso.ts`.
// Estudios, usuarios, clientes e invitaciones propios de este archivo; `b.cerrar()` los borra.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { forma, type Resp } from "../../../test/soporte.js";

const CANARIO = "Canario-r1a-Contrasena-Larga-2026";

let b: Banco;
let A: Estudio;
let B: Estudio;
beforeAll(async () => {
  b = await abrirBanco();
  A = await b.estudio();
  B = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const membresia = async (t: string, u: string) =>
  (await b.sql("select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [t, u]))[0];
const asignaciones = async (t: string) =>
  b.sql<{ cliente_id: string; usuario_id: string; tipo: string }>(
    "select cliente_id, usuario_id, tipo from asignacion where tenant_id = $1 order by cliente_id, usuario_id",
    [t],
  );
const consultar = (token: string) => b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } });
const aceptar = (token: string) =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Invitado R1a", contrasena: CANARIO } });
const conSesion = (s: { cookie: string; csrf: string }, token: string) =>
  b.h.pedir({ ruta: "/invitaciones/aceptar-con-sesion", cuerpo: { token }, cookie: s.cookie, csrf: s.csrf });
const sinDato = (r: Resp) => ({ status: r.status, codigo: r.body?.codigo });

// =================================================================================================
describe("asistente y lectura contra gestión y asignación", () => {
  it("todas las rutas de gestión dan el mismo 403 genérico, exista o no el objetivo, y no cambian nada", async () => {
    const [c1] = await b.clientes(A.tenantId, 1);
    const [cB] = await b.clientes(B.tenantId, 1);
    const otro = await b.miembro(A.tenantId, "contador", { sesion: false });
    for (const rol of ["asistente", "lectura"] as const) {
      const a = await b.miembro(A.tenantId, rol);
      await b.asignar(A.tenantId, c1!, a.id, "colaborador");
      const antes = await asignaciones(A.tenantId);
      const invAntes = (await b.sql("select count(*)::int n from invitacion where tenant_id = $1", [A.tenantId]))[0].n;
      const intentos: [string, string, unknown?][] = [
        ["GET", "/usuarios"],
        ["GET", "/invitaciones"],
        ["POST", "/invitaciones", { correo: b.correoNuevo(), rol: "lectura" }],
        ["PATCH", `/usuarios/${otro.id}/rol`, { rol: "lectura" }],
        ["PATCH", `/usuarios/${a.id}/rol`, { rol: "admin" }],
        ["POST", `/usuarios/${otro.id}/desactivar`],
        ["GET", `/clientes/${c1}/asignaciones`],
        ["GET", `/clientes/${randomUUID()}/asignaciones`],
        ["GET", `/clientes/${cB}/asignaciones`],
        ["GET", `/clientes/no-es-uuid/asignaciones`],
        ["PUT", `/clientes/${c1}/asignaciones/${a.id}`, { tipo: "responsable", anterior: "retirar" }],
        ["PUT", `/clientes/${randomUUID()}/asignaciones/${a.id}`, { tipo: "responsable" }],
        ["DELETE", `/clientes/${c1}/asignaciones/${a.id}`],
        ["POST", "/asignaciones/por-usuario", { usuarioId: a.id, clienteIds: [c1], tipo: "responsable", anterior: "retirar" }],
        ["POST", "/asignaciones/por-cliente", { clienteId: c1, usuarioIds: [otro.id] }],
      ];
      const respuestas: Resp[] = [];
      for (const [m, ruta, cuerpo] of intentos) respuestas.push(await b.llamar(a, m as any, ruta, cuerpo));
      for (const [i, r] of respuestas.entries()) {
        expect({ ruta: intentos[i]![1], rol, ...sinDato(r) }).toEqual({ ruta: intentos[i]![1], rol, status: 403, codigo: "permiso_denegado" });
      }
      // El 403 de un cliente propio, uno inexistente, uno ajeno y uno mal formado es idéntico (sin oráculo).
      const f = respuestas.slice(6, 10).map(forma);
      for (const x of f.slice(1)) expect(x).toEqual(f[0]);
      expect(await asignaciones(A.tenantId)).toEqual(antes);
      expect((await b.sql("select count(*)::int n from invitacion where tenant_id = $1", [A.tenantId]))[0].n).toBe(invAntes);
      expect((await membresia(A.tenantId, a.id)).rol).toBe(rol);
      expect((await membresia(A.tenantId, otro.id))).toMatchObject({ rol: "contador", desactivada_en: null });
    }
  });
});

// =================================================================================================
describe("autoescalada y autodesactivación con representaciones alternativas del propio UUID", () => {
  it("un Dueño no puede desactivarse ni cambiarse el rol usando su ID en mayúsculas, con llaves o sin guiones", async () => {
    // Hay otro Dueño (el titular): el invariante del último Dueño no protegería al atacante.
    const variantes: [string, (id: string) => string][] = [
      ["mayusculas", (id) => id.toUpperCase()],
      ["llaves", (id) => `%7B${id}%7D`],
      ["sin-guiones", (id) => id.replace(/-/g, "")],
      ["espacio", (id) => `%20${id}`],
    ];
    const obtenido: Record<string, unknown> = {};
    const esperado: Record<string, unknown> = {};
    for (const [nombre, v] of variantes) {
      for (const [rolActor, rolNuevo] of [["dueno", "admin"], ["admin", "lectura"]] as const) {
        const a = await b.miembro(A.tenantId, rolActor);
        const r1 = await b.llamar(a, "PATCH", `/usuarios/${v(a.id)}/rol`, { rol: rolNuevo });
        const a2 = await b.miembro(A.tenantId, rolActor);
        const r2 = await b.llamar(a2, "POST", `/usuarios/${v(a2.id)}/desactivar`);
        const clave = `${rolActor}/${nombre}`;
        obtenido[clave] = {
          rol: [r1.status === 403 || r1.status === 404, await membresia(A.tenantId, a.id)],
          desactivar: [r2.status === 403 || r2.status === 404, (await membresia(A.tenantId, a2.id)).desactivada_en],
        };
        esperado[clave] = { rol: [true, { rol: rolActor, desactivada_en: null }], desactivar: [true, null] };
      }
    }
    expect(obtenido).toEqual(esperado);
  });
});

// =================================================================================================
describe("escalada de Administrador a Dueño (D8)", () => {
  it("un Administrador no invita, asciende, degrada, desactiva ni reenvía/revoca nada de rol Dueño", async () => {
    const ad = await b.miembro(A.tenantId, "admin");
    const victima = await b.miembro(A.tenantId, "contador", { sesion: false });
    const dueno2 = await b.miembro(A.tenantId, "dueno", { sesion: false });
    const correoD = b.correoNuevo();
    const invD = await b.invitar(A.titular, correoD, "dueno");
    expect(invD.r.status).toBe(201);

    const intentos: [string, string, unknown?][] = [
      ["POST", "/invitaciones", { correo: b.correoNuevo(), rol: "dueno" }],
      ["PATCH", `/usuarios/${victima.id}/rol`, { rol: "dueno" }],
      ["PATCH", `/usuarios/${dueno2.id}/rol`, { rol: "admin" }],
      ["POST", `/usuarios/${dueno2.id}/desactivar`],
      ["POST", `/invitaciones/${invD.r.body.id}/reenviar`],
      ["POST", `/invitaciones/${invD.r.body.id}/revocar`],
    ];
    for (const [m, ruta, cuerpo] of intentos) {
      const r = await b.llamar(ad, m as any, ruta, cuerpo);
      expect({ ruta, status: r.status }).toEqual({ ruta, status: 403 });
    }
    // Variantes de escritura del rol: nunca crean un Dueño (400 o 403, jamás 2xx).
    for (const rol of ["DUENO", "Dueno", "dueno ", " dueno", "dueño", "dueno\u0000"]) {
      const r = await b.llamar(ad, "PATCH", `/usuarios/${victima.id}/rol`, { rol });
      expect(r.status >= 400 && r.status < 500, `rol ${JSON.stringify(rol)} → ${r.status}`).toBe(true);
    }
    expect((await membresia(A.tenantId, victima.id)).rol).toBe("contador");
    expect(await membresia(A.tenantId, dueno2.id)).toEqual({ rol: "dueno", desactivada_en: null });
    const inv = (await b.sql("select revocada_en from invitacion where id = $1", [invD.r.body.id]))[0];
    expect(inv.revocada_en).toBeNull();
  });
});

// =================================================================================================
describe("efecto inmediato con sesión viva (CA-6, CA-9)", () => {
  it("desactivado: la sesión en A queda sin estudio, no puede volver a elegir A y su sesión en B sigue", async () => {
    const u = await b.miembro(A.tenantId, "contador");
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')", [B.tenantId, u.id]);
    const sB = await b.sesion(u, B.tenantId);
    const [c1] = await b.clientes(A.tenantId, 1);
    await b.asignar(A.tenantId, c1!, u.id, "colaborador");
    expect((await b.llamar(u, "GET", `/clientes/${c1}`)).status).toBe(200);

    expect((await b.llamar(A.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);

    const yo = await b.llamar(u, "GET", "/acceso/yo");
    const cl = await b.llamar(u, "GET", `/clientes/${c1}`);
    const lista = await b.llamar(u, "GET", "/clientes");
    for (const r of [yo, cl, lista]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.text).not.toContain(c1);
    }
    // Volver a elegir el estudio desde la misma sesión (o sin X-Estudio) no le devuelve el acceso.
    const elegir = await b.h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: A.tenantId }, cookie: u.cookie, csrf: u.csrf });
    expect(elegir.status).not.toBe(200);
    const sinCabecera = await b.h.pedir({ ruta: `/clientes/${c1}`, cookie: u.cookie });
    expect(sinCabecera.status).toBeGreaterThanOrEqual(400);
    // Iniciar sesión de nuevo tampoco le deja elegir A.
    const nueva = await b.h.entrar(u);
    const elegir2 = await b.h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: A.tenantId }, cookie: nueva.cookie, csrf: nueva.csrf });
    expect(elegir2.status).not.toBe(200);
    // La sesión del otro estudio sigue viva.
    const enB = await b.llamar({ ...sB, tenantId: B.tenantId }, "GET", "/acceso/yo");
    expect(enB.status).toBe(200);
    expect(enB.body.rol).toBe("contador");
  });

  it("desasignado y rol cambiado: la siguiente petición ya da 404 idéntico a inexistente y 403 en lo que perdió", async () => {
    const u = await b.miembro(A.tenantId, "contador");
    const [c1, c2] = await b.clientes(A.tenantId, 2);
    await b.asignar(A.tenantId, c1!, u.id, "colaborador");
    await b.asignar(A.tenantId, c2!, u.id, "responsable");
    expect((await b.llamar(u, "GET", `/clientes/${c1}`)).status).toBe(200);
    expect((await b.llamar(A.titular, "DELETE", `/clientes/${c1}/asignaciones/${u.id}`)).status).toBe(204);

    const desasignado = await b.llamar(u, "GET", `/clientes/${c1}`);
    const inexistente = await b.llamar(u, "GET", `/clientes/${randomUUID()}`);
    expect(desasignado.status).toBe(404);
    expect(forma(desasignado)).toEqual(forma(inexistente));
    expect((await b.llamar(u, "GET", "/clientes")).body.map((x: any) => x.id)).toEqual([c2]);

    // Contador → lectura con la sesión viva: pierde sire.* al instante y deja de ser responsable (D18).
    expect((await b.llamar(A.titular, "PATCH", `/usuarios/${u.id}/rol`, { rol: "lectura" })).status).toBe(200);
    const yo = await b.llamar(u, "GET", "/acceso/yo");
    expect(yo.body.rol).toBe("lectura");
    expect(yo.body.permisos).not.toContain("sire.clasificar");
    const resp = (await b.sql("select count(*)::int n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c2]))[0].n;
    expect(resp).toBe(0);
    // Vuelve a contador: no recupera la responsabilidad por sí sola.
    expect((await b.llamar(A.titular, "PATCH", `/usuarios/${u.id}/rol`, { rol: "contador" })).status).toBe(200);
    expect((await b.sql("select count(*)::int n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c2]))[0].n).toBe(0);
  });
});

// =================================================================================================
describe("IDOR en lotes y asignación masiva de campos", () => {
  it("lotes con un ID ajeno o inexistente en cualquier posición: 404 idéntico y nada aplicado", async () => {
    const m = await b.miembro(A.tenantId, "contador", { sesion: false });
    const m2 = await b.miembro(A.tenantId, "asistente", { sesion: false });
    const cs = await b.clientes(A.tenantId, 3);
    const [cB] = await b.clientes(B.tenantId, 1);
    const uB = await b.miembro(B.tenantId, "contador", { sesion: false });
    const antes = await asignaciones(A.tenantId);
    const antesB = await asignaciones(B.tenantId);
    const lotes: unknown[] = [
      { usuarioId: m.id, clienteIds: [cs[0], cB, cs[1]], tipo: "colaborador" },
      { usuarioId: m.id, clienteIds: [cs[0], cs[1], randomUUID()], tipo: "colaborador" },
      { usuarioId: uB.id, clienteIds: [cs[0]], tipo: "colaborador" },
      { usuarioId: B.titular.id, clienteIds: cs, tipo: "colaborador" },
    ];
    const r1 = await Promise.all(lotes.map((l) => b.llamar(A.titular, "POST", "/asignaciones/por-usuario", l)));
    const r2 = await Promise.all(
      [[m.id, uB.id], [m.id, randomUUID()], [uB.id, m2.id, m.id]].map((us) =>
        b.llamar(A.titular, "POST", "/asignaciones/por-cliente", { clienteId: cs[2], usuarioIds: us }),
      ),
    );
    const r3 = await b.llamar(A.titular, "POST", "/asignaciones/por-cliente", { clienteId: cB, usuarioIds: [m.id] });
    const todas = [...r1, ...r2, r3];
    for (const r of todas) expect(r.status).toBe(404);
    for (const r of todas.slice(1)) expect(forma(r)).toEqual(forma(todas[0]!));
    for (const r of todas) expect(r.text).not.toMatch(new RegExp(`${cB}|${uB.id}|${B.titular.id}`));
    expect(await asignaciones(A.tenantId)).toEqual(antes);
    expect(await asignaciones(B.tenantId)).toEqual(antesB);
  });

  it("lotes con IDs repetidos no dan 500 ni filas duplicadas", async () => {
    const m = await b.miembro(A.tenantId, "contador", { sesion: false });
    const [c1, c2] = await b.clientes(A.tenantId, 2);
    const r1 = await b.llamar(A.titular, "POST", "/asignaciones/por-usuario", {
      usuarioId: m.id,
      clienteIds: [c1, c1, c1],
      tipo: "colaborador",
    });
    const r2 = await b.llamar(A.titular, "POST", "/asignaciones/por-cliente", { clienteId: c2, usuarioIds: [m.id, m.id] });
    const r3 = await b.llamar(A.titular, "POST", "/asignaciones/por-usuario", {
      usuarioId: m.id,
      clienteIds: [c2, c2],
      tipo: "responsable",
      anterior: "colaborador",
    });
    for (const r of [r1, r2, r3]) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    const filas = await b.sql("select cliente_id, tipo from asignacion where usuario_id = $1", [m.id]);
    const porCliente = new Map<string, number>();
    for (const f of filas) porCliente.set(f.cliente_id, (porCliente.get(f.cliente_id) ?? 0) + 1);
    for (const n of porCliente.values()) expect(n).toBe(1);
  });

  it("por-cliente (colaboradores) no degrada en silencio al responsable actual incluido en la lista", async () => {
    const r = await b.miembro(A.tenantId, "contador", { sesion: false });
    const x = await b.miembro(A.tenantId, "asistente", { sesion: false });
    const [c1] = await b.clientes(A.tenantId, 1);
    await b.asignar(A.tenantId, c1!, r.id, "responsable");
    const resp = await b.llamar(A.titular, "POST", "/asignaciones/por-cliente", { clienteId: c1, usuarioIds: [r.id, x.id] });
    expect(resp.status).toBeLessThan(500);
    const fila = (await b.sql("select tipo from asignacion where cliente_id = $1 and usuario_id = $2", [c1, r.id]))[0];
    // CA-7: el anterior responsable solo pasa a colaborador "según lo que pida el usuario" (`anterior`).
    expect(fila?.tipo).toBe("responsable");
  });

  it("campos rol, tenantId, usuarioId, clienteId, invitadoPor y venceEn del cuerpo se ignoran", async () => {
    const m = await b.miembro(A.tenantId, "asistente", { sesion: false });
    const otro = await b.miembro(A.tenantId, "lectura", { sesion: false });
    const [c1, c2] = await b.clientes(A.tenantId, 2);
    const [cB] = await b.clientes(B.tenantId, 1);

    const correo = b.correoNuevo();
    const inv = await b.llamar(A.titular, "POST", "/invitaciones", {
      correo,
      rol: "lectura",
      tenantId: B.tenantId,
      estudioId: B.tenantId,
      invitadoPor: otro.id,
      venceEn: "2099-01-01T00:00:00Z",
      tokenHash: "00".repeat(32),
      id: randomUUID(),
    });
    expect(inv.status).toBe(201);
    const fi = await b.sql(
      "select tenant_id, invitado_por, rol, extract(epoch from (vence_en - now()))::int s from invitacion where correo = $1",
      [correo],
    );
    expect(fi).toHaveLength(1);
    expect(fi[0]).toMatchObject({ tenant_id: A.tenantId, invitado_por: A.titular.id, rol: "lectura" });
    expect(fi[0].s).toBeGreaterThan(71 * 3600);
    expect(fi[0].s).toBeLessThanOrEqual(72 * 3600);

    const put = await b.llamar(A.titular, "PUT", `/clientes/${c1}/asignaciones/${m.id}`, {
      tipo: "colaborador",
      usuarioId: otro.id,
      clienteId: c2,
      tenantId: B.tenantId,
    });
    expect(put.status).toBe(200);
    expect(await asignaciones(A.tenantId).then((f) => f.filter((x) => [c1, c2].includes(x.cliente_id)))).toEqual([
      { cliente_id: c1, usuario_id: m.id, tipo: "colaborador" },
    ]);

    const pat = await b.llamar(A.titular, "PATCH", `/usuarios/${m.id}/rol`, {
      rol: "contador",
      usuarioId: otro.id,
      tenantId: B.tenantId,
    });
    expect(pat.status).toBe(200);
    expect((await membresia(A.tenantId, m.id)).rol).toBe("contador");
    expect((await membresia(A.tenantId, otro.id)).rol).toBe("lectura");
    expect(await asignaciones(B.tenantId).then((f) => f.filter((x) => x.cliente_id === cB))).toEqual([]);
  });
});

// =================================================================================================
describe("carreras: último Dueño y responsable único", () => {
  it("dos Dueños que se degradan o desactivan mutuamente a la vez: siempre queda al menos uno", async () => {
    for (const [op1, op2] of [
      ["rol", "rol"],
      ["desactivar", "desactivar"],
      ["rol", "desactivar"],
    ] as const) {
      const E = await b.estudio();
      const d2 = await b.miembro(E.tenantId, "dueno");
      const op = (actor: Actor, objetivo: string, o: string) =>
        o === "rol"
          ? b.llamar(actor, "PATCH", `/usuarios/${objetivo}/rol`, { rol: "admin" })
          : b.llamar(actor, "POST", `/usuarios/${objetivo}/desactivar`);
      const rs = await Promise.all([op(E.titular, d2.id, op1), op(d2, E.titular.id, op2)]);
      for (const r of rs) expect(r.status).toBeLessThan(500);
      const n = (
        await b.sql("select count(*)::int n from membresia where tenant_id = $1 and rol = 'dueno' and desactivada_en is null", [E.tenantId])
      )[0].n;
      expect(n, `${op1}/${op2}: ${rs.map((r) => r.status).join(",")}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("dos responsables simultáneos al mismo cliente dejan exactamente uno y ningún 500", async () => {
    const xs = await Promise.all([1, 2, 3, 4].map(() => b.miembro(A.tenantId, "contador", { sesion: false })));
    for (let vuelta = 0; vuelta < 4; vuelta += 1) {
      const [c] = await b.clientes(A.tenantId, 1);
      const rs = await Promise.all(
        xs.map((x) => b.llamar(A.titular, "PUT", `/clientes/${c}/asignaciones/${x.id}`, { tipo: "responsable", anterior: "colaborador" })),
      );
      for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      const n = (await b.sql("select count(*)::int n from asignacion where cliente_id = $1 and tipo = 'responsable'", [c]))[0].n;
      expect(n).toBe(1);
    }
  });
});

// =================================================================================================
describe("token de invitación en todas sus variantes (CA-3)", () => {
  it("variantes de escritura del token (bits de relleno, '=', '+/', espacios) no son el token: 400 invalida", async () => {
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(A.titular, correo, "lectura");
    expect(r.status).toBe(201);
    const t = token!;
    expect((await consultar(t)).status).toBe(200);
    const ALFA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const ultimo = t[t.length - 1]!;
    const relleno = t.slice(0, -1) + ALFA[ALFA.indexOf(ultimo) ^ 1]; // cambia solo bits sobrantes del último carácter
    const variantes = [
      relleno,
      `${t}=`,
      `${t} `,
      `${t}\n`,
      `${t}.`,
      t.replace(/-/g, "+").replace(/_/g, "/"),
    ].filter((v) => v !== t);
    const base = await consultar(`${t.slice(0, -4)}AAAA`);
    expect(base.status).toBe(400);
    for (const v of variantes) {
      const c = await consultar(v);
      expect({ v: JSON.stringify(v), ...sinDato(c) }).toEqual({ v: JSON.stringify(v), status: 400, codigo: "invitacion_invalida" });
      expect(forma(c)).toEqual(forma(base));
    }
    const ac = await aceptar(relleno);
    expect(ac.status).toBe(400);
    expect((await b.sql("select aceptada_en from invitacion where correo = $1", [correo]))[0].aceptada_en).toBeNull();
  });

  it("reusado, concurrente, vencido, revocado, reenviado, de otro estudio u otro correo: misma respuesta, nada consumido", async () => {
    const aleatorio = await aceptar("A".repeat(43));
    expect(aleatorio.status).toBe(400);
    const igual = (r: Resp) => expect(forma(r)).toEqual(forma(aleatorio));

    // Concurrente y reusado.
    const c1 = b.correoNuevo();
    const t1 = (await b.invitar(A.titular, c1, "asistente")).token!;
    const rs = await Promise.all([aceptar(t1), aceptar(t1), aceptar(t1)]);
    expect(rs.map((r) => r.status).sort()).toEqual([204, 400, 400]);
    for (const r of rs.filter((x) => x.status === 400)) igual(r);
    igual(await aceptar(t1));
    expect((await b.sql("select count(*)::int n from usuario where email = $1", [c1]))[0].n).toBe(1);

    // Vencido.
    const c2 = b.correoNuevo();
    const t2 = (await b.invitar(A.titular, c2, "lectura")).token!;
    await b.sql("update invitacion set vence_en = now() - interval '1 second' where correo = $1", [c2]);
    igual(await aceptar(t2));

    // Revocado.
    const c3 = b.correoNuevo();
    const i3 = await b.invitar(A.titular, c3, "lectura");
    expect((await b.llamar(A.titular, "POST", `/invitaciones/${i3.r.body.id}/revocar`)).status).toBe(204);
    igual(await aceptar(i3.token!));

    // Reenviado: el token anterior muere.
    const c4 = b.correoNuevo();
    const i4 = await b.invitar(A.titular, c4, "lectura");
    expect((await b.llamar(A.titular, "POST", `/invitaciones/${i4.r.body.id}/reenviar`)).status).toBe(200);
    await b.h.correo.esperar(c4, 2);
    igual(await aceptar(i4.token!));
    for (const c of [c2, c3, c4]) expect((await b.sql("select count(*)::int n from usuario where email = $1", [c]))[0].n).toBe(0);

    // Otro correo con sesión: una cuenta distinta no puede usar el token de otra persona.
    const destino = await b.h.crearUsuario({ estudios: [] });
    const intruso = await b.miembro(B.tenantId, "contador");
    const i5 = await b.invitar(A.titular, destino.correo, "admin");
    const robado = await conSesion(intruso, i5.token!);
    const azar = await conSesion(intruso, "B".repeat(43));
    expect(robado.status).toBe(400);
    expect(forma(robado)).toEqual(forma(azar));
    expect(await membresia(A.tenantId, intruso.id)).toBeUndefined();
    // El token de una cuenta existente tampoco sirve sin sesión (D15) y no cambia su contraseña.
    const hashAntes = (await b.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [destino.id]))[0].hash;
    const sinSesion = await aceptar(i5.token!);
    expect(sinSesion.status).toBe(409);
    expect((await b.sql("select hash from auth.usuario_contrasena where usuario_id = $1", [destino.id]))[0].hash).toBe(hashAntes);
    expect(await membresia(A.tenantId, destino.id)).toBeUndefined();
    expect((await consultar(i5.token!)).status).toBe(200);
  });
});

// =================================================================================================
describe("enumeración al invitar (CA-2)", () => {
  it("invitar a un correo nuevo o a una cuenta existente da la misma forma y el mismo correo; la grafía no evita el 409", async () => {
    const existente = await b.miembro(B.tenantId, "contador", { sesion: false });
    const nuevo = b.correoNuevo();
    const rN = await b.invitar(A.titular, nuevo, "lectura");
    const rE = await b.invitar(A.titular, existente.correo, "lectura");
    expect([rN.r.status, rE.r.status]).toEqual([201, 201]);
    expect(Object.keys(rE.r.body).sort()).toEqual(Object.keys(rN.r.body).sort());
    expect(Object.keys(rE.r.headers).sort()).toEqual(Object.keys(rN.r.headers).sort());
    const limpio = (correo: string, token: string) => {
      const m = b.h.correo.para(correo).at(-1)!;
      return JSON.stringify({ asunto: (m as any).asunto ?? null, texto: m.texto, html: (m as any).html ?? null })
        .split(token).join("<T>")
        .split(correo).join("<C>");
    };
    expect(limpio(existente.correo, rE.token!)).toBe(limpio(nuevo, rN.token!));

    // Un miembro activo escrito en mayúsculas o con espacios sigue siendo miembro: 409 ya_es_miembro, sin fila nueva.
    const activo = await b.miembro(A.tenantId, "asistente", { sesion: false });
    for (const v of [activo.correo.toUpperCase(), `  ${activo.correo} `]) {
      const r = await b.llamar(A.titular, "POST", "/invitaciones", { correo: v, rol: "lectura" });
      expect(r.status >= 400, `${JSON.stringify(v)} → ${r.status}`).toBe(true);
      if (r.status === 409) expect(r.body.codigo).toBe("ya_es_miembro");
    }
    expect(
      (await b.sql("select count(*)::int n from invitacion where tenant_id = $1 and lower(correo) = lower($2)", [A.tenantId, activo.correo]))[0].n,
    ).toBe(0);
  });
});

// =================================================================================================
describe("oráculos 403/404 (CA-5)", () => {
  it("contador: no asignado, inexistente, de otro estudio y mal formado dan el mismo 404 en lectura y en DELETE", async () => {
    const u = await b.miembro(A.tenantId, "contador");
    const [mio, ajenoA] = await b.clientes(A.tenantId, 2);
    const [cB] = await b.clientes(B.tenantId, 1);
    await b.asignar(A.tenantId, mio!, u.id, "colaborador");
    const objetivos = [ajenoA!, randomUUID(), cB!, "no-es-uuid", ajenoA!.toUpperCase(), "00000000-0000-0000-0000-000000000000"];
    const rs = await Promise.all(objetivos.map((c) => b.llamar(u, "GET", `/clientes/${c}`)));
    for (const r of rs) expect(r.status).toBe(404);
    for (const r of rs.slice(1)) expect(forma(r)).toEqual(forma(rs[0]!));

    // DELETE de una asignación con el Dueño: usuario de otro estudio, inexistente o miembro no asignado → mismo 404.
    const noAsig = await b.miembro(A.tenantId, "lectura", { sesion: false });
    const uB = await b.miembro(B.tenantId, "contador", { sesion: false });
    const ds = await Promise.all(
      [uB.id, randomUUID(), noAsig.id, "no-es-uuid"].map((x) => b.llamar(A.titular, "DELETE", `/clientes/${mio}/asignaciones/${x}`)),
    );
    for (const r of ds) expect(r.status).toBe(404);
    for (const r of ds.slice(1)) expect(forma(r)).toEqual(forma(ds[0]!));
    // PUT con usuario de otro estudio o inexistente: mismo 404.
    const ps = await Promise.all(
      [uB.id, randomUUID()].map((x) => b.llamar(A.titular, "PUT", `/clientes/${mio}/asignaciones/${x}`, { tipo: "colaborador" })),
    );
    for (const r of ps) expect(r.status).toBe(404);
    expect(forma(ps[1]!)).toEqual(forma(ps[0]!));
    expect((await b.sql("select count(*)::int n from asignacion where usuario_id = $1", [uB.id]))[0].n).toBe(0);
  });
});

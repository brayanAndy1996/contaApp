// T3 (030) · CA-10 (concurrencia por HTTP, D4): editar o eliminar un rol mientras se invita, se acepta, se cambia de rol o se desactiva da un
// resultado consistente (nunca una membresía o invitación con un rol inexistente, ningún 5xx, ningún interbloqueo); crear en paralelo no supera
// el límite de U9 ni repite nombre. El orden de bloqueo y las funciones SQL las prueba T1 en BD.
// Cubre: `acceso/roles/roles.service.ts`, `usuarios.service.ts`, `invitaciones.service.ts`.
// Rojo: `/roles` (T9), la asignación de roles propios (T8) y las tablas de la 0082 (T6) aún no existen.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco } from "../../../../test/soporte-acceso.js";
import {
  asignar,
  asignarSistema,
  crear,
  crearOk,
  cuentaRoles,
  editar,
  eliminar,
  filaRol,
  huerfanos,
  invitar,
  LIMITE_ROLES,
  membresiaDe,
  miembroConRol,
  nombreUnico,
  permisosEnBd,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let b: Banco;
const RONDAS = 5;

beforeAll(async () => {
  b = await abrirBanco();
});
afterAll(async () => {
  await b?.cerrar();
});

const sin5xx = (...rs: Array<{ status: number; text: string }>): void => {
  for (const r of rs) expect(r.status, r.text).toBeLessThan(500);
};

describe("U9 · crear en paralelo", () => {
  it("25 altas simultáneas con nombres distintos: exactamente 20 dan 201, el resto 409 limite_roles y en BD quedan 20", async () => {
    const L = await b.estudio();
    const rs = await Promise.all(Array.from({ length: LIMITE_ROLES + 5 }, (_, i) => crear(b, L.titular, { nombre: `Paralelo ${i}`, permisos: [] })));
    sin5xx(...rs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(LIMITE_ROLES);
    for (const r of rs.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "limite_roles" });
    }
    expect(await cuentaRoles(b, L.tenantId)).toBe(LIMITE_ROLES);
  });

  it("10 altas simultáneas del mismo nombre (con mayúsculas y tildes distintas): una sola da 201 y el resto 409 nombre_duplicado", async () => {
    const L = await b.estudio();
    const variantes = ["Contadór Junior", "CONTADOR JUNIOR", "contador junior", "Contador Júnior", "contadór junior"];
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => crear(b, L.titular, { nombre: variantes[i % variantes.length]!, permisos: [] })));
    sin5xx(...rs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 201)) expect(r.body).toEqual({ codigo: "nombre_duplicado" });
    expect(await cuentaRoles(b, L.tenantId)).toBe(1);
  });
});

describe("eliminar un rol mientras se asigna", () => {
  it("DELETE y PATCH /usuarios/:id/rol a la vez: o se asigna y el borrado da 409, o se borra y la asignación da 404; nunca un huérfano", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
      const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
      const [del, asig] = await Promise.all([eliminar(b, E.titular, rol.id), asignar(b, E.titular, m.id, rol.id)]);
      sin5xx(del, asig);
      if (asig.status === 200) {
        expect(del.status, del.text).toBe(409);
        expect(del.body).toMatchObject({ codigo: "rol_en_uso", miembros: 1 });
        expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
        expect(await filaRol(b, rol.id)).toBeDefined();
      } else {
        expect(asig.status, asig.text).toBe(404);
        expect(del.status, del.text).toBe(204);
        expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "lectura", rol_id: null });
        expect(await filaRol(b, rol.id)).toBeUndefined();
      }
      expect(await huerfanos(b, E.tenantId)).toBe(0);
    }
  });

  it("DELETE y POST /invitaciones a la vez: o la invitación existe y el borrado da 409, o se borró y la invitación da 404", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: [], alcance: "asignado" });
      const [del, inv] = await Promise.all([eliminar(b, E.titular, rol.id), invitar(b, E.titular, b.correoNuevo(), rol.id)]);
      sin5xx(del, inv);
      if (inv.status === 201) {
        expect(del.status, del.text).toBe(409);
        expect(del.body).toMatchObject({ codigo: "rol_en_uso", invitaciones: 1 });
      } else {
        expect(inv.status, inv.text).toBe(404);
        expect(del.status, del.text).toBe(204);
      }
      expect(await huerfanos(b, E.tenantId)).toBe(0);
    }
  });

  it("DELETE y el cambio de rol del propio miembro hacia otro rol a la vez: el rol borrado nunca queda asignado", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
      const m = await miembroConRol(b, E.titular, rol.id, { sesion: false });
      const [del, sale] = await Promise.all([eliminar(b, E.titular, rol.id), asignarSistema(b, E.titular, m.id, "lectura")]);
      sin5xx(del, sale);
      expect(sale.status, sale.text).toBe(200);
      expect([204, 409], del.text).toContain(del.status); // 409 si el borrado ganó la carrera por delante del cambio
      expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "lectura", rol_id: null });
      expect(await huerfanos(b, E.tenantId)).toBe(0);
    }
  });

  it("DELETE y desactivar al miembro a la vez: queda consistente (el rol borrado o conservado, pero nunca referenciado sin existir)", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
      const m = await miembroConRol(b, E.titular, rol.id, { sesion: false });
      const [del, off] = await Promise.all([eliminar(b, E.titular, rol.id), b.llamar(E.titular, "POST", `/usuarios/${m.id}/desactivar`)]);
      sin5xx(del, off);
      expect(off.status, off.text).toBe(200);
      expect([204, 409], del.text).toContain(del.status);
      expect(await huerfanos(b, E.tenantId)).toBe(0);
    }
  });
});

describe("editar un rol mientras se asigna o se acepta", () => {
  it("PATCH /roles/:id y asignaciones a la vez: el rol queda con lo editado, la asignación se completa y no hay 5xx", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
      const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
      const [ed, asig] = await Promise.all([editar(b, E.titular, rol.id, { permisos: ["clientes.ver", "clientes.crear"], alcance: "global" }), asignar(b, E.titular, m.id, rol.id)]);
      sin5xx(ed, asig);
      expect(ed.status, ed.text).toBe(200);
      expect(asig.status, asig.text).toBe(200);
      expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.crear", "clientes.ver"]);
      expect((await filaRol(b, rol.id))?.alcance).toBe("global");
      expect(await membresiaDe(b, E.tenantId, m.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
    }
  });

  it("aceptar la invitación y eliminar el rol a la vez: el borrado siempre da 409 (invitación vigente o miembro) y la aceptación funciona", async () => {
    const E = await b.estudio();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
      const correo = b.correoNuevo();
      expect((await invitar(b, E.titular, correo, rol.id)).status).toBe(201);
      const token = await b.tokenDe(correo);
      const [acepta, del] = await Promise.all([
        b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Concurrente", contrasena: "Clave-nueva-030-canario-ñ" } }),
        eliminar(b, E.titular, rol.id),
      ]);
      sin5xx(acepta, del);
      expect(acepta.status, acepta.text).toBe(204);
      expect(del.status, del.text).toBe(409);
      expect(del.body.codigo).toBe("rol_en_uso");
      const u = (await b.sql("select id from usuario where email = $1", [correo]))[0];
      expect(await membresiaDe(b, E.tenantId, u.id)).toMatchObject({ rol: "propio", rol_id: rol.id });
      expect(await huerfanos(b, E.tenantId)).toBe(0);
    }
  });

  it("dos ediciones del mismo rol a la vez: gana una completa (permisos y alcance de una sola), sin mezclar ni 5xx", async () => {
    const E = await b.estudio();
    const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const A = { nombre: nombreUnico("A"), permisos: ["clientes.ver", "clientes.crear"], alcance: "global" };
      const B = { nombre: nombreUnico("B"), permisos: ["clientes.ver", "buzon.ver"], alcance: "asignado" };
      const [ra, rb] = await Promise.all([editar(b, E.titular, rol.id, A), editar(b, E.titular, rol.id, B)]);
      sin5xx(ra, rb);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const fila = await filaRol(b, rol.id);
      const permisos = await permisosEnBd(b, rol.id);
      const ganoA = fila?.nombre === A.nombre;
      const g = ganoA ? A : B;
      expect(fila).toMatchObject({ nombre: g.nombre, alcance: g.alcance });
      expect(permisos).toEqual([...g.permisos].sort());
    }
  });

  it("ediciones del Dueño y del Administrador, asignaciones, cambios de rol e invitación sobre el mismo rol a la vez: sin interbloqueo ni 5xx", async () => {
    const E = await b.estudio();
    const admin = await b.miembro(E.tenantId, "admin");
    const rol = await crearOk(b, E.titular, { permisos: ["clientes.ver"], alcance: "asignado" });
    const miembros: Actor[] = [];
    for (let i = 0; i < 4; i++) miembros.push(await b.miembro(E.tenantId, "lectura", { sesion: false }));
    const ops = [
      editar(b, E.titular, rol.id, { permisos: ["clientes.ver", "clientes.crear"] }),
      editar(b, admin, rol.id, { permisos: ["clientes.ver", "clientes.editar"] }),
      ...miembros.map((m, i) => (i % 2 === 0 ? asignar(b, E.titular, m.id, rol.id) : asignarSistema(b, admin, m.id, "asistente"))),
      invitar(b, admin, b.correoNuevo(), rol.id),
    ];
    const rs = await Promise.all(ops);
    sin5xx(...rs);
    for (const r of rs) expect([200, 201, 404, 409], r.text).toContain(r.status);
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });
});

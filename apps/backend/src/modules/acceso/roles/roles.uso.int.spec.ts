/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T3 (030) · CA-6 (rol en uso, U5–U6) y la vista previa de impacto (`POST /roles/:id/impacto`, U6, U8).
// Cubre: `acceso/roles/roles.controller.ts`, `acceso/roles/roles.service.ts`.
// Rojo: `/roles` (T9), la asignación de roles propios (T8) y las tablas de la 0082 (T6) aún no existen.
// Contrato (plan 030, «HTTP»): DELETE con miembros activos o invitaciones vigentes: 409 `{ codigo: "rol_en_uso", miembros, invitaciones }`;
// `impacto` responde `{ miembros, clientesSinResponsable, miembrosSinTotpExigidos }` sin cambiar nada; editar un rol que pierde
// `sire.clasificar` borra las asignaciones `responsable` de sus miembros (los clientes quedan sin responsable, 005 D18).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import { activarTotp } from "../../../../test/soporte-totp.js";
import {
  asignar,
  asignarSistema,
  cerrar,
  crearOk,
  cuentaAuditoria,
  editar,
  eliminar,
  filaRol,
  huerfanos,
  impacto,
  invitar,
  listar,
  miembroConRol,
  permisosEnBd,
  propiosDe,
  uuidInexistente,
} from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
const PWD_NUEVA = "Clave-nueva-030-canario-ñ";

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const D = (): Actor => E.titular;
const nInvitaciones = async (rolId: string, filtro = "true"): Promise<number> =>
  Number((await b.sql(`select count(*)::int as n from invitacion where rol_id = $1 and ${filtro}`, [rolId]))[0].n);

describe("U5 · eliminar un rol en uso: 409 rol_en_uso con ambos conteos", () => {
  it("con miembros activos e invitaciones vigentes: 409 {rol_en_uso, miembros, invitaciones}; no vigentes (revocada, vencida) no cuentan", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    const m1 = await miembroConRol(b, D(), rol.id, { sesion: false });
    const m2 = await miembroConRol(b, D(), rol.id, { sesion: false });
    const vigente = await invitar(b, D(), b.correoNuevo(), rol.id);
    const aRevocar = await invitar(b, D(), b.correoNuevo(), rol.id);
    const aVencer = await invitar(b, D(), b.correoNuevo(), rol.id);
    for (const r of [vigente, aRevocar, aVencer]) expect(r.status, r.text).toBe(201);
    expect((await b.llamar(D(), "POST", `/invitaciones/${aRevocar.body.id}/revocar`)).status).toBe(204);
    await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [aVencer.body.id]);

    const r = await eliminar(b, D(), rol.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "rol_en_uso", miembros: 2, invitaciones: 1 });
    expect(await filaRol(b, rol.id)).toBeDefined();
    expect(propiosDe(await listar(b, D())).find((x) => x.id === rol.id)).toMatchObject({ miembros: 2, invitaciones: 1 });

    // Quitar una a una lo que lo usa deja eliminarlo.
    expect((await b.llamar(D(), "POST", `/invitaciones/${vigente.body.id}/revocar`)).status).toBe(204);
    expect((await eliminar(b, D(), rol.id)).body).toEqual({ codigo: "rol_en_uso", miembros: 2, invitaciones: 0 });
    expect((await asignarSistema(b, D(), m1.id, "lectura")).status).toBe(200);
    expect((await eliminar(b, D(), rol.id)).body).toEqual({ codigo: "rol_en_uso", miembros: 1, invitaciones: 0 });
    expect((await asignarSistema(b, D(), m2.id, "lectura")).status).toBe(200);
    const fin = await eliminar(b, D(), rol.id);
    expect(fin.status, fin.text).toBe(204);
    expect(await filaRol(b, rol.id)).toBeUndefined();
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });

  it("una invitación aceptada pasa a contar como miembro (no como invitación)", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    const correo = b.correoNuevo();
    expect((await invitar(b, D(), correo, rol.id)).status).toBe(201);
    const token = await b.tokenDe(correo);
    expect((await b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Nuevo Pasante", contrasena: PWD_NUEVA } })).status).toBe(204);
    const r = await eliminar(b, D(), rol.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "rol_en_uso", miembros: 1, invitaciones: 0 });
    expect(await nInvitaciones(rol.id, "aceptada_en is not null")).toBe(1);
  });

  it("CA-6: con un miembro desactivado (la membresía sigue apuntando al rol) nunca queda una referencia a un rol inexistente", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    const m = await miembroConRol(b, D(), rol.id, { sesion: false });
    expect((await b.llamar(D(), "POST", `/usuarios/${m.id}/desactivar`)).status).toBe(200);
    const r = await eliminar(b, D(), rol.id);
    expect([204, 409], r.text).toContain(r.status);
    if (r.status === 409) expect(r.body).toMatchObject({ codigo: "rol_en_uso" });
    expect(await huerfanos(b, E.tenantId)).toBe(0);
  });

  it("un id ajeno o inexistente en DELETE sigue siendo 404 aunque el rol esté en uso en otro estudio", async () => {
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });
    await miembroConRol(b, otro.titular, ajeno.id, { sesion: false });
    for (const id of [ajeno.id, uuidInexistente()]) expect((await eliminar(b, D(), id)).status).toBe(404);
    expect(await filaRol(b, ajeno.id)).toBeDefined();
  });
});

describe("U6 · POST /roles/:id/impacto: vista previa sin escribir", () => {
  const R_PERMISOS = ["clientes.ver", "sire.descargar", "sire.clasificar"];
  let rol: Awaited<ReturnType<typeof crearOk>>;
  let m1: Actor;
  let m2: Actor;
  let m3: Actor;
  let clientes: string[];
  let contador: Actor;

  beforeAll(async () => {
    rol = await crearOk(b, D(), { nombre: "Clasificador", permisos: R_PERMISOS, alcance: "asignado" });
    [m1, m2, m3] = [await miembroConRol(b, D(), rol.id, { sesion: false }), await miembroConRol(b, D(), rol.id, { sesion: false }), await miembroConRol(b, D(), rol.id, { sesion: false })];
    contador = await b.miembro(E.tenantId, "contador", { sesion: false });
    clientes = await b.clientes(E.tenantId, 6);
    const [c1, c2, c3, c4, c5, c6] = clientes as [string, string, string, string, string, string];
    await b.asignar(E.tenantId, c1, m1.id, "responsable");
    await b.asignar(E.tenantId, c2, m1.id, "responsable");
    await b.asignar(E.tenantId, c6, m1.id, "colaborador");
    await b.asignar(E.tenantId, c3, m2.id, "responsable");
    await b.asignar(E.tenantId, c4, m3.id, "colaborador");
    await b.asignar(E.tenantId, c5, contador.id, "responsable"); // de otro rol: no se toca
  });

  const foto = async () => ({
    asignaciones: await b.sql("select cliente_id, usuario_id, tipo from asignacion where tenant_id = $1 order by cliente_id, usuario_id", [E.tenantId]),
    permisos: await permisosEnBd(b, rol.id),
    fila: await filaRol(b, rol.id),
    auditoria: await cuentaAuditoria(b, E.tenantId, "%"),
  });

  it("quitar sire.clasificar: 3 miembros, 3 clientes quedarían sin responsable (los de m1 y m2, no el del Contador) y no se escribe nada", async () => {
    const antes = await foto();
    const r = await impacto(b, D(), rol.id, { permisos: ["clientes.ver", "sire.descargar"] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ miembros: 3, clientesSinResponsable: 3, miembrosSinTotpExigidos: 0 });
    expect(await foto()).toEqual(antes);
  });

  it("ediciones que no quitan sire.clasificar (o solo cambian el nombre), o el cuerpo vacío: 0 clientes sin responsable", async () => {
    for (const cuerpo of [{ permisos: [...R_PERMISOS, "reglas.ver"] }, { nombre: "Otro nombre" }, {}, { alcance: "global" }]) {
      const r = await impacto(b, D(), rol.id, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(200);
      expect(r.body).toEqual({ miembros: 3, clientesSinResponsable: 0, miembrosSinTotpExigidos: 0 });
    }
  });

  it("el cuerpo se valida como el de editar: 422 de U3 y 422 de plan.gestionar; 404 de id ajeno o de sistema", async () => {
    const combinacion = await impacto(b, D(), rol.id, { permisos: ["sire.descargar"] });
    expect(combinacion.status).toBe(422);
    expect(combinacion.body).toMatchObject({ codigo: "combinacion_invalida", permiso: "clientes.ver" });
    const plan = await impacto(b, D(), rol.id, { permisos: ["plan.gestionar"] });
    expect(plan.status).toBe(422);
    expect(plan.body.codigo).toBe("permiso_invalido");
    const otro = await b.estudio();
    const ajeno = await crearOk(b, otro.titular, { permisos: [] });
    for (const id of [ajeno.id, uuidInexistente(), "no-es-uuid", "dueno", "lectura"]) expect((await impacto(b, D(), id, {})).status, id).toBe(404);
  });

  it("editar de verdad: los miembros dejan de ser responsables (sin filas 'responsable'), esos clientes quedan sin responsable y lo demás se conserva", async () => {
    const r = await editar(b, D(), rol.id, { permisos: ["clientes.ver", "sire.descargar"] });
    expect(r.status, r.text).toBe(200);
    const filas = await b.sql("select cliente_id, usuario_id, tipo from asignacion where tenant_id = $1", [E.tenantId]);
    expect(filas.filter((f: any) => [m1.id, m2.id, m3.id].includes(f.usuario_id) && f.tipo === "responsable")).toEqual([]);
    expect(filas.find((f: any) => f.usuario_id === m1.id && f.cliente_id === clientes[5])).toMatchObject({ tipo: "colaborador" });
    expect(filas.find((f: any) => f.usuario_id === m3.id && f.cliente_id === clientes[3])).toMatchObject({ tipo: "colaborador" });
    expect(filas.find((f: any) => f.usuario_id === contador.id && f.cliente_id === clientes[4])).toMatchObject({ tipo: "responsable" });
    const lista = await b.llamar(D(), "GET", "/clientes");
    const resp = (id: string) => lista.body.find((c: any) => c.id === id)?.responsable;
    expect([resp(clientes[0]!), resp(clientes[1]!), resp(clientes[2]!)]).toEqual([null, null, null]);
    expect(resp(clientes[4]!)).not.toBeNull();
    // Ya no puede volver a ser responsable un miembro del rol sin sire.clasificar (D18).
    const otra = await b.llamar(D(), "PUT", `/clientes/${clientes[0]}/asignaciones/${m1.id}`, { tipo: "responsable" });
    expect(otra.status, otra.text).toBe(409);
    expect(otra.body).toEqual({ codigo: "miembro_no_asignable" });
    // Y la vista previa ya no tiene nada que avisar.
    expect((await impacto(b, D(), rol.id, { permisos: ["clientes.ver"] })).body.clientesSinResponsable).toBe(0);
  });
});

describe("U8 · impacto: miembros que quedarían exigidos de TOTP sin tenerlo", () => {
  it("ganar un permiso sensible cuenta a los miembros sin TOTP activo; quien ya lo tiene no cuenta; sin permiso sensible, 0", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"], alcance: "asignado" });
    const conTotp = await b.miembro(E.tenantId, "lectura");
    const sinTotp1 = await b.miembro(E.tenantId, "lectura");
    const sinTotp2 = await b.miembro(E.tenantId, "lectura");
    for (const m of [conTotp, sinTotp1, sinTotp2]) expect((await asignar(b, D(), m.id, rol.id)).status).toBe(200);
    await activarTotp(b.h, conTotp);

    for (const sensible of [["credenciales.editar"], ["usuarios.gestionar"], ["roles.gestionar"]]) {
      const r = await impacto(b, D(), rol.id, { permisos: cerrar(["clientes.ver", ...sensible]) });
      expect(r.status, r.text).toBe(200);
      expect(r.body, sensible.join()).toEqual({ miembros: 3, clientesSinResponsable: 0, miembrosSinTotpExigidos: 2 });
    }
    const noSensible = await impacto(b, D(), rol.id, { permisos: cerrar(["clientes.ver", "clientes.crear", "reglas.gestionar", "auditoria.ver"]) });
    expect(noSensible.body).toEqual({ miembros: 3, clientesSinResponsable: 0, miembrosSinTotpExigidos: 0 });
    expect(await permisosEnBd(b, rol.id)).toEqual(["clientes.ver"]); // sin escribir
  });

  it("quitar el permiso sensible no avisa de nada (se libera, no se exige)", async () => {
    const rol = await crearOk(b, D(), { permisos: cerrar(["credenciales.editar"]), alcance: "asignado" });
    await miembroConRol(b, D(), rol.id, { sesion: false });
    const r = await impacto(b, D(), rol.id, { permisos: ["clientes.ver"] });
    expect(r.body).toEqual({ miembros: 1, clientesSinResponsable: 0, miembrosSinTotpExigidos: 0 });
  });

  it("un rol sin miembros: 0 en todo", async () => {
    const rol = await crearOk(b, D(), { permisos: ["clientes.ver"] });
    const r = await impacto(b, D(), rol.id, { permisos: cerrar(["usuarios.gestionar"]) });
    expect(r.body).toEqual({ miembros: 0, clientesSinResponsable: 0, miembrosSinTotpExigidos: 0 });
  });
});

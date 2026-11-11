/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 017 · T18a-servidor (P-4): `objetivo` en `GET /auditoria`. Contrato:
//  - Cada item trae `objetivo`: el usuario AFECTADO, `{ id, nombre, activo }` (misma forma y reglas que `actor.autor`, D-12), o null.
//  - miembro.* (alta, rol_cambiado, desactivado, reactivado): el usuario de la membresía. Un miembro ya eliminado (la fila no existe)
//    da null. asignacion.* (agregada, quitada, tipo_cambiado): `datos.usuarioId`. invitacion.* (creada, revocada, modificada): quien
//    la aceptó; una invitación sin aceptar, null. El correo de la invitación NUNCA sale (D-5).
//  - Las demás acciones, null. Un usuario que no es miembro del estudio da `nombre: null`, `activo: false` (nunca el nombre ajeno).
//  - `datos.cambios` de `cliente.editado` llega como `{ columna: [antes, después] }` (cambiosClienteAuditoriaSchema).
import { cambiosClienteAuditoriaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { limpiarAvisosDeEstudios, sembrarAuditoria } from "../../../test/soporte-notificaciones.js";

let b: Banco;
let E: Estudio;
let F: Estudio;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  F = await b.estudio();
});
afterAll(async () => {
  if (b && E && F) await limpiarAvisosDeEstudios([E.tenantId, F.tenantId]);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const nombrar = (id: string, nombre: string) => sql("update usuario set nombre = $2 where id = $1", [id, nombre]);

/** Todas las filas de auditoría de la sesión E (estudio nuevo: caben en una página salvo que se diga). */
async function filas(accion?: string, entidadId?: string): Promise<any[]> {
  const r = await b.llamar(E.titular, "GET", "/auditoria");
  expect(r.status, r.text).toBe(200);
  return (r.body.items as any[]).filter((x) => (accion === undefined || x.accion === accion) && (entidadId === undefined || x.entidadId === entidadId));
}
const membresiaDe = async (usuarioId: string): Promise<string> =>
  (await sql<{ id: string }>("select id from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, usuarioId]))[0]!.id;

describe("P-4 · objetivo de miembro.*", () => {
  it("rol cambiado, desactivado y reactivado: el miembro afectado con su nombre; el actor sigue siendo el Dueño", async () => {
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    await nombrar(m.id, "Beto Contador");
    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${m.id}/rol`, { rol: "asistente" })).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${m.id}/desactivar`)).status).toBe(200);
    // Desactivado: conserva el nombre con activo false (D-12).
    const mid = await membresiaDe(m.id);
    const desactivado = (await filas("miembro.desactivado", mid))[0];
    expect(desactivado.objetivo).toEqual({ id: m.id, nombre: "Beto Contador", activo: false });
    expect((await b.llamar(E.titular, "POST", `/usuarios/${m.id}/reactivar`)).status).toBe(200);

    const rol = (await filas("miembro.rol_cambiado", mid))[0];
    expect(rol.datos).toMatchObject({ de: "contador", a: "asistente" });
    expect(rol.objetivo).toEqual({ id: m.id, nombre: "Beto Contador", activo: true });
    expect(rol.actor.autor).toMatchObject({ id: E.titular.id });
    const reactivado = (await filas("miembro.reactivado", mid))[0];
    expect(reactivado.objetivo).toEqual({ id: m.id, nombre: "Beto Contador", activo: true });
    expect(Object.keys(rol.objetivo).sort()).toEqual(["activo", "id", "nombre"]);
  }, 30_000);

  it("el alta: el miembro que se unió; un miembro eliminado (la membresía ya no existe) da objetivo null", async () => {
    const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const mid = await membresiaDe(m.id);
    const alta = (await filas("miembro.alta", mid))[0];
    expect(alta.objetivo).toMatchObject({ id: m.id, activo: true });
    await sembrarAuditoria(sql, { tenantId: E.tenantId, accion: "miembro.eliminado", entidad: "membresia", datos: { rol: "lectura" } });
    const eliminado = (await filas("miembro.eliminado"))[0];
    expect(eliminado.objetivo).toBeNull();
  }, 30_000);
});

describe("P-4 · objetivo de asignacion.*", () => {
  it("agregada, tipo cambiado y quitada: el usuario de datos.usuarioId", async () => {
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    await nombrar(m.id, "Carla Asignada");
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    const put = (cuerpo: unknown) => b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${m.id}`, cuerpo);
    expect((await put({ tipo: "colaborador" })).status).toBe(200);
    expect((await put({ tipo: "responsable" })).status).toBe(200);
    expect((await b.llamar(E.titular, "DELETE", `/clientes/${c}/asignaciones/${m.id}`)).status).toBeLessThan(300);
    const del = (await filas()).filter((x) => x.entidad === "asignacion" && x.datos.usuarioId === m.id);
    expect(del.map((x) => x.accion).sort()).toEqual(["asignacion.agregada", "asignacion.quitada", "asignacion.tipo_cambiado"]);
    for (const x of del) expect(x.objetivo, x.accion).toEqual({ id: m.id, nombre: "Carla Asignada", activo: true });
  }, 30_000);

  it("un usuario que no es miembro del estudio sale sin nombre y como inactivo, nunca con su nombre", async () => {
    const ajeno = await b.miembro(F.tenantId, "contador", { sesion: false });
    await nombrar(ajeno.id, "Nombre Ajeno Secreto");
    const fila = await sembrarAuditoria(sql, { tenantId: E.tenantId, accion: "asignacion.agregada", entidad: "asignacion", datos: { tipo: "colaborador", usuarioId: ajeno.id } });
    const x = (await filas()).find((y) => y.id === fila.id);
    expect(x.objetivo).toEqual({ id: ajeno.id, nombre: null, activo: false });
    expect(JSON.stringify(x)).not.toContain("Nombre Ajeno Secreto");
  }, 30_000);
});

describe("P-4 · objetivo de invitacion.*", () => {
  it("sin aceptar: objetivo null y el correo no aparece en ninguna parte de la respuesta", async () => {
    const correo = b.correoNuevo();
    const { r } = await b.invitar(E.titular, correo, "contador");
    expect(r.status, r.text).toBe(201);
    const creada = (await filas("invitacion.creada", r.body.id))[0];
    expect(creada.objetivo).toBeNull();
    expect((await b.llamar(E.titular, "POST", `/invitaciones/${r.body.id}/revocar`)).status).toBe(204);
    const revocada = (await filas("invitacion.revocada", r.body.id))[0];
    expect(revocada.objetivo).toBeNull();
    const todo = await b.llamar(E.titular, "GET", "/auditoria");
    expect(todo.text.toLowerCase()).not.toContain(correo.toLowerCase());
    expect(JSON.stringify(creada.datos)).not.toMatch(/correo|email/i);
  }, 30_000);

  it("aceptada: el usuario que la aceptó, con su nombre", async () => {
    const { r } = await b.invitar(E.titular, b.correoNuevo(), "asistente");
    expect(r.status, r.text).toBe(201);
    const m = await b.miembro(E.tenantId, "asistente", { sesion: false });
    await nombrar(m.id, "Ana Aceptó");
    await sql("update invitacion set aceptada_en = now(), aceptada_por = $2 where id = $1", [r.body.id, m.id]);
    const creada = (await filas("invitacion.creada", r.body.id))[0];
    expect(creada.objetivo).toEqual({ id: m.id, nombre: "Ana Aceptó", activo: true });
  }, 30_000);
});

describe("P-4 · el resto de acciones y cliente.editado", () => {
  it("las acciones cuyo sujeto no es un usuario tienen objetivo null", async () => {
    const todas = await filas();
    expect(todas.length).toBeGreaterThan(0);
    for (const x of todas) {
      if (/^(miembro|asignacion|invitacion)\./.test(x.accion)) continue;
      expect(x.objetivo, x.accion).toBeNull();
    }
  });

  it("cliente.editado trae el antes → después en datos.cambios con la forma del esquema", async () => {
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    await sql("update cliente set razon_social = 'RAZON NUEVA SAC', ventas_mixtas = true where id = $1", [c]);
    const editado = (await filas("cliente.editado", c)).find((x) => x.datos.cambios?.razon_social !== undefined);
    expect(editado, "no hay cliente.editado con razon_social").toBeDefined();
    expect(cambiosClienteAuditoriaSchema.safeParse(editado.datos.cambios).success, JSON.stringify(editado.datos)).toBe(true);
    expect(editado.datos.cambios.razon_social[1]).toBe("RAZON NUEVA SAC");
    expect(editado.datos.cambios.ventas_mixtas).toEqual([false, true]);
    expect(editado.objetivo).toBeNull();
  }, 30_000);
});

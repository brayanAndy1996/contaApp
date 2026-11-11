/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// Spec 017 · T16 (rojo) · H-017-1 de punta a punta: el cambio de tipo de una asignación por la ruta real de 005 queda en `GET /auditoria`
// como `asignacion.tipo_cambiado {de, a, usuarioId}` (acción nueva del catálogo; contrato en tests/aislamiento/auditoria-correcciones.spec.ts).
// Distinta de `notificaciones/r1.adv.int.spec.ts` (que prueba la AUSENCIA del rastro): aquí se fija QUÉ fila se espera, con quién actuó,
// y que el rol del Dueño que reasigna sea el de la sesión, no uno del cuerpo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { limpiarAvisosDeEstudios } from "../../../test/soporte-notificaciones.js";

let b: Banco;
let E: Estudio;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  if (b && E) await limpiarAvisosDeEstudios([E.tenantId]);
  await b?.cerrar();
});

/** Filas de `GET /auditoria` (el estudio es nuevo: cabe en la primera página) de asignaciones del cliente `c`. */
async function deAsignacion(c: string): Promise<any[]> {
  const r = await b.llamar(E.titular, "GET", "/auditoria");
  expect(r.status, r.text).toBe(200);
  return (r.body.items as any[]).filter((x) => x.entidad === "asignacion" && x.cliente?.id === c);
}
const put = (c: string, u: string, cuerpo: unknown) => b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${u}`, cuerpo);

describe("H-017-1 · GET /auditoria muestra el cambio de tipo de una asignación", () => {
  it("promover a un colaborador a responsable: una fila asignacion.tipo_cambiado {de, a, usuarioId}, con el Dueño de la sesión como actor", async () => {
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    expect((await put(c, m.id, { tipo: "colaborador" })).status).toBe(200);
    const promocion = await put(c, m.id, { tipo: "responsable" });
    expect(promocion.status, promocion.text).toBe(200);

    const cambios = (await deAsignacion(c)).filter((x) => x.accion === "asignacion.tipo_cambiado");
    expect(cambios).toHaveLength(1);
    expect(cambios[0].datos).toEqual({ de: "colaborador", a: "responsable", usuarioId: m.id });
    expect(cambios[0].actor).toMatchObject({ tipo: "usuario", autor: { id: E.titular.id } });
    expect(cambios[0].cliente.id).toBe(c);
  }, 30_000);

  it("PUT del nuevo responsable con `anterior: 'colaborador'`: el responsable previo aparece degradado y el nuevo, agregado", async () => {
    const m1 = await b.miembro(E.tenantId, "contador", { sesion: false });
    const m2 = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    expect((await put(c, m1.id, { tipo: "responsable" })).status).toBe(200);
    const cambio = await put(c, m2.id, { tipo: "responsable", anterior: "colaborador" });
    expect(cambio.status, cambio.text).toBe(200);

    const filas = await deAsignacion(c);
    const degradado = filas.filter((x) => x.accion === "asignacion.tipo_cambiado");
    expect(degradado.map((x) => x.datos)).toEqual([{ de: "responsable", a: "colaborador", usuarioId: m1.id }]);
    const altas = filas.filter((x) => x.accion === "asignacion.agregada").map((x) => x.datos.usuarioId);
    expect([...altas].sort()).toEqual([m1.id, m2.id].sort());
  }, 30_000);

  it("repetir el PUT con el mismo tipo no agrega ninguna fila", async () => {
    const m = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [c] = (await b.clientes(E.tenantId, 1)) as [string];
    expect((await put(c, m.id, { tipo: "responsable" })).status).toBe(200);
    const antes = (await deAsignacion(c)).length;
    expect((await put(c, m.id, { tipo: "responsable" })).status).toBe(200);
    expect((await deAsignacion(c)).length).toBe(antes);
  }, 30_000);
});

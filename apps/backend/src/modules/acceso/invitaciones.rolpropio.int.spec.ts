/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T15a (030) · defecto menor hallado por la E2E: la pantalla de aceptar invitación mostraba «como propio» porque
// `POST /invitaciones/consultar` no devolvía el nombre del rol propio.
// Contrato (público, sin sesión, sin efectos):
//   - Invitación a rol de sistema: igual que hoy `{ estudio: { nombre }, rol, correo, cuentaExiste }`, SIN la clave `rolPropio`.
//   - Invitación a rol propio: `{ estudio: { nombre }, rol: "propio", rolPropio: { nombre }, correo, cuentaExiste }` con el
//     nombre ACTUAL del rol. `rolPropio` lleva SOLO `nombre`: nunca id, permisos, alcance ni `rolId`.
//   - Invitación no viva (revocada, vencida, token alterado) o de un rol ya eliminado: 400 `invitacion_invalida` idéntico
//     al de cualquier token inválido, sin el nombre del rol.
//   - Solo se lee el rol de la propia invitación: nunca el de otro estudio.
// Rojo: la respuesta aún no incluye `rolPropio`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { cerrar, crearOk, editar, eliminar, invitar, nombreUnico } from "../../../test/soporte-roles.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
const D = (): Actor => E.titular;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const consultar = (token: string) => b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } });

/** Invita a un rol propio y devuelve el token y el id de la invitación. */
async function invitadoAPropio(rolId: string, correo = b.correoNuevo()) {
  const r = await invitar(b, D(), correo, rolId);
  expect(r.status, r.text).toBe(201);
  return { correo, id: r.body.id as string, token: await b.tokenDe(correo) };
}

describe("consultar invitación · nombre del rol propio (T15a)", () => {
  it("rol propio: devuelve rol 'propio' y rolPropio { nombre }, sin ids, permisos ni alcance", async () => {
    const rol = await crearOk(b, D(), { nombre: nombreUnico("Practicante"), permisos: cerrar(["clientes.ver", "buzon.ver"]), alcance: "asignado" });
    const { correo, token } = await invitadoAPropio(rol.id);
    const r = await consultar(token);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({
      estudio: { nombre: expect.any(String) },
      rol: "propio",
      rolPropio: { nombre: rol.nombre },
      correo,
      cuentaExiste: false,
    });
    expect(Object.keys(r.body.rolPropio)).toEqual(["nombre"]);
    const texto = JSON.stringify(r.body);
    expect(texto).not.toContain(rol.id);
    expect(texto).not.toContain(E.tenantId);
    expect(texto).not.toMatch(/permisos|alcance|rolId|rol_id|clientes\.ver|buzon\.ver/);
  });

  it("cuenta existente: también trae el nombre del rol propio (y cuentaExiste: true)", async () => {
    const rol = await crearOk(b, D(), { nombre: nombreUnico("Pasante"), permisos: ["clientes.ver"], alcance: "asignado" });
    const u = await b.h.crearUsuario({ estudios: [] });
    const { token } = await invitadoAPropio(rol.id, u.correo);
    const r = await consultar(token);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ rol: "propio", rolPropio: { nombre: rol.nombre }, cuentaExiste: true });
  });

  it("devuelve el nombre ACTUAL: si el rol se renombra después de invitar, la consulta muestra el nuevo", async () => {
    const rol = await crearOk(b, D(), { nombre: nombreUnico("Antes"), permisos: ["clientes.ver"], alcance: "asignado" });
    const { token } = await invitadoAPropio(rol.id);
    const nuevo = nombreUnico("Despues");
    const e = await editar(b, D(), rol.id, { nombre: nuevo });
    expect(e.status, e.text).toBe(200);
    const r = await consultar(token);
    expect(r.status, r.text).toBe(200);
    expect(r.body.rolPropio).toEqual({ nombre: nuevo });
  });

  it("rol de sistema: la respuesta no cambia y no trae la clave rolPropio", async () => {
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(E.titular, correo, "contador");
    expect(r.status).toBe(201);
    const c = await consultar(token as string);
    expect(c.status, c.text).toBe(200);
    expect(c.body).toEqual({ estudio: { nombre: expect.any(String) }, rol: "contador", correo, cuentaExiste: false });
    expect(c.body).not.toHaveProperty("rolPropio");
  });

  it("solo lee el rol de su propia invitación: con roles de otro estudio (incluso de igual nombre) no mezcla ni filtra nada", async () => {
    const otro = await b.estudio();
    const propioNombre = nombreUnico("Aux A");
    const ajenoNombre = nombreUnico("Aux B");
    const rolA = await crearOk(b, D(), { nombre: propioNombre, permisos: ["clientes.ver"], alcance: "asignado" });
    const rolB = await crearOk(b, otro.titular, { nombre: ajenoNombre, permisos: ["clientes.ver"], alcance: "asignado" });
    const { token } = await invitadoAPropio(rolA.id);
    const r = await consultar(token);
    expect(r.status, r.text).toBe(200);
    expect(r.body.rolPropio).toEqual({ nombre: propioNombre });
    const texto = JSON.stringify(r.body);
    expect(texto).not.toContain(ajenoNombre);
    expect(texto).not.toContain(rolB.id);
    expect(texto).not.toContain(otro.tenantId);
  });
});

describe("consultar invitación a rol propio no viva · sin filtrar el nombre", () => {
  it("revocada, vencida y token alterado dan el mismo 400 invitacion_invalida y nunca el nombre del rol", async () => {
    const nombre = nombreUnico("Secreto");
    const rol = await crearOk(b, D(), { nombre, permisos: ["clientes.ver"], alcance: "asignado" });
    const revocada = await invitadoAPropio(rol.id);
    const vencida = await invitadoAPropio(rol.id);
    const viva = await invitadoAPropio(rol.id);
    expect((await b.llamar(D(), "POST", `/invitaciones/${revocada.id}/revocar`)).status).toBe(204);
    await b.sql("update invitacion set vence_en = now() - interval '1 minute' where id = $1", [vencida.id]);
    expect((await consultar(viva.token)).status).toBe(200); // la viva sí responde

    const referencia = await consultar("token-alterado-canario-030");
    expect(referencia.status).toBe(400);
    for (const t of [revocada.token, vencida.token]) {
      const r = await consultar(t);
      expect(r.status, r.text).toBe(400);
      expect(forma(r)).toEqual(forma(referencia));
      expect(r.text).not.toContain(nombre);
      expect(r.text).not.toContain(rol.id);
    }
  });

  it("tras revocar y eliminar el rol, el enlace antiguo sigue dando el mismo 400 sin nombre", async () => {
    const nombre = nombreUnico("Eliminado");
    const rol = await crearOk(b, D(), { nombre, permisos: ["clientes.ver"], alcance: "asignado" });
    const inv = await invitadoAPropio(rol.id);
    expect((await b.llamar(D(), "POST", `/invitaciones/${inv.id}/revocar`)).status).toBe(204);
    const el = await eliminar(b, D(), rol.id);
    expect(el.status, el.text).toBe(204);
    const referencia = await consultar("token-alterado-canario-030");
    const r = await consultar(inv.token);
    expect(r.status, r.text).toBe(400);
    expect(forma(r)).toEqual(forma(referencia));
    expect(r.text).not.toContain(nombre);
  });
});

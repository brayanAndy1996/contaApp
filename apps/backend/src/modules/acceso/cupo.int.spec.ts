// T4 (005) · D11: `CupoUsuarios` se llama al invitar, aceptar y reactivar, en la misma transacción, y su
// rechazo (409 `cupo_usuarios`) deshace la operación. Rojo: el puerto y `crearApp({ cupoUsuarios })` aún no existen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { CupoEspia } from "../../../test/soporte-cupo.js";

const PWD_NUEVA = "Clave-nueva-005-canario-ñ";
const cupoEspia = new CupoEspia();
let b: Banco;
let E: Estudio;
beforeAll(async () => {
  b = await abrirBanco(cupoEspia);
  E = await b.estudio();
});
afterAll(async () => {
  await b?.cerrar();
});

const fila = async (correo: string) =>
  (await b.sql("select * from invitacion where tenant_id = $1 and correo = $2 order by creada_en desc", [E.tenantId, correo]))[0];
const aceptar = (token: string) =>
  b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Nuevo Miembro", contrasena: PWD_NUEVA } });
const usuarioPorCorreo = async (correo: string) =>
  (await b.sql("select id from usuario where email = $1", [correo]))[0];
async function invitado(rol: Parameters<Banco["invitar"]>[2] = "contador") {
  const correo = b.correoNuevo();
  const { r, token } = await b.invitar(E.titular, correo, rol);
  expect(r.status).toBe(201);
  return { correo, token: token as string, id: r.body.id as string };
}

describe("D11 · CupoUsuarios en la misma transacción", () => {
  it("se llama al invitar (con la transacción de la invitación), al aceptar y al reactivar (con la de la membresía)", async () => {
    cupoEspia.reiniciar();
    const correo = b.correoNuevo();
    const { r, token } = await b.invitar(E.titular, correo, "contador");
    expect(r.status).toBe(201);
    const [llamadaInvitar] = cupoEspia.de("invitar", E.tenantId);
    expect(cupoEspia.de("invitar", E.tenantId)).toHaveLength(1);
    const xmin = (await b.sql("select xmin::text as x from invitacion where id = $1", [r.body.id]))[0].x;
    expect(llamadaInvitar!.xid).toBe(xmin); // misma transacción que escribió la invitación

    expect((await aceptar(token as string)).status).toBe(204);
    expect(cupoEspia.de("aceptar", E.tenantId)).toHaveLength(1);

    const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]);
    cupoEspia.reiniciar();
    expect((await b.llamar(E.titular, "POST", `/usuarios/${m.id}/reactivar`)).status).toBe(200);
    const [llamadaReactivar] = cupoEspia.de("reactivar", E.tenantId);
    expect(cupoEspia.de("reactivar", E.tenantId)).toHaveLength(1);
    const xminM = (await b.sql("select xmin::text as x from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]))[0].x;
    expect(llamadaReactivar!.xid).toBe(xminM);
  });

  it("si el cupo rechaza al invitar: 409 cupo_usuarios, sin invitación ni correo", async () => {
    cupoEspia.reiniciar();
    cupoEspia.falla.add("invitar");
    const correo = b.correoNuevo();
    try {
      const r = await b.llamar(E.titular, "POST", "/invitaciones", { correo, rol: "lectura" });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "cupo_usuarios" });
    } finally {
      cupoEspia.reiniciar();
    }
    expect(await fila(correo)).toBeUndefined();
    expect(b.h.correo.para(correo)).toHaveLength(0);
  });

  it("si el cupo rechaza al aceptar: 409 cupo_usuarios, sin usuario y la invitación sigue viva", async () => {
    const { correo, token, id } = await invitado("lectura");
    cupoEspia.falla.add("aceptar");
    try {
      const r = await aceptar(token);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "cupo_usuarios" });
    } finally {
      cupoEspia.reiniciar();
    }
    expect(await usuarioPorCorreo(correo)).toBeUndefined();
    expect((await b.sql("select aceptada_en from invitacion where id = $1", [id]))[0].aceptada_en).toBeNull();
    expect((await aceptar(token)).status).toBe(204); // sin el rechazo, se acepta
  });

  it("si el cupo rechaza al reactivar: 409 cupo_usuarios y el miembro sigue desactivado", async () => {
    const m = await b.miembro(E.tenantId, "lectura", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]);
    cupoEspia.falla.add("reactivar");
    try {
      const r = await b.llamar(E.titular, "POST", `/usuarios/${m.id}/reactivar`);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "cupo_usuarios" });
    } finally {
      cupoEspia.reiniciar();
    }
    const f = (await b.sql("select desactivada_en from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, m.id]))[0];
    expect(f.desactivada_en).not.toBeNull();
  });
});

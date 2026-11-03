// T3 (006) · GET /plan/uso (D8, CA-2, CA-8). Rojo: la ruta, el plan y la suscripción aún no existen (T5, T7).
// `crearApp` con el adaptador real por defecto (T7); los límites salen siempre de `plan` + `suscripcion`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "../../../test/soporte-acceso.js";
import { abrirBancoPlanes, type BancoPlanes } from "../../../test/soporte-planes.js";

let p: BancoPlanes;
beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  await p?.cerrar();
});

const uso = (a: Actor) => p.b.llamar(a, "GET", "/plan/uso");
/** Ningún campo de precio ni de otro estudio en la respuesta (D8, CA-8). */
const sinPrecios = (texto: string) => expect(texto).not.toMatch(/precio|price|monto|tarifa/i);

describe("GET /plan/uso · contenido (D8)", () => {
  it("devuelve nombre del plan, estado, límites y uso, sin precios ni IDs internos", async () => {
    const plan = await p.plan({ maxRucs: 20, maxUsuarios: 4, maxRucsExtra: 4, precioMensual: "321.00", precioRucExtra: "7.00" });
    const E = await p.estudio(plan, { estado: "activa", rucsExtra: 3 });
    await p.b.clientes(E.tenantId, 5);
    await p.b.miembro(E.tenantId, "contador", { sesion: false });
    const inv = await p.b.invitar(E.titular, p.b.correoNuevo(), "lectura");
    expect(inv.r.status).toBe(201);

    const r = await uso(E.titular);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.plan).toEqual({ codigo: plan.codigo, nombre: `Plan T3 ${plan.codigo}` });
    expect(r.body.estado).toBe("activa");
    expect(r.body.pruebaVenceEn).toBeNull();
    // límite efectivo de RUCs = max_rucs + min(contratados, tope) (D6, D10); libres = límite - usados
    expect(r.body.rucs).toMatchObject({ usados: 5, limite: 23, libres: 18, extra: 3 });
    // usados = membresías activas (el Dueño cuenta); pendientes = invitaciones vigentes (D7)
    expect(r.body.usuarios).toEqual({ usados: 2, pendientes: 1, limite: 4 });
    sinPrecios(r.text);
    // Ajuste de 006: el codigo aleatorio del plan (p. ej. t3_321ac5d5_1) puede contener "321" y volvia intermitente la
    // prueba. Se quita el codigo del texto antes de buscar el precio, y se busca el precio completo, no un fragmento.
    const sinCodigo = r.text.split(plan.codigo).join("");
    expect(sinCodigo).not.toContain("321");
    expect(r.text).not.toContain("321.00");
    expect(r.text).not.toMatch(/"(id|planId|tenantId|estudioId)"/);
  });

  it("en prueba informa el vencimiento (14 días) y el plan Prueba del seed trae 5 RUCs y 1 usuario (D9)", async () => {
    const E = await p.b.estudio();
    const prueba = (await p.sql("select id from plan where codigo = 'prueba'"))[0];
    await p.fijarPlan(E.tenantId, prueba.id, { estado: "prueba" });
    const r = await uso(E.titular);
    expect(r.status).toBe(200);
    expect(r.body.plan.codigo).toBe("prueba");
    expect(r.body.estado).toBe("prueba");
    const dias = (Date.parse(r.body.pruebaVenceEn) - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(13.9);
    expect(dias).toBeLessThanOrEqual(14.01);
    expect(r.body.rucs.limite).toBe(5);
    expect(r.body.usuarios).toMatchObject({ usados: 1, limite: 1 });
  });

  it("max_usuarios NULL se informa como limite null (ilimitado) y el seed corporativo no limita en la práctica", async () => {
    const E = await p.b.estudio(); // fixture: corporativo
    const r = await uso(E.titular);
    expect(r.status).toBe(200);
    expect(r.body.plan.codigo).toBe("corporativo");
    expect(r.body.usuarios.limite).toBeNull();
    expect(r.body.rucs.limite).toBeGreaterThanOrEqual(600);
  });

  it("la respuesta usa el límite de contratados acotado por el tope del plan, aunque se haya bajado el tope (D10)", async () => {
    const plan = await p.plan({ maxRucs: 20, maxRucsExtra: 4 });
    const E = await p.estudio(plan, { rucsExtra: 4 });
    await p.editarPlan(plan, { max_rucs_extra: 1 }); // tope bajado: 4 contratados, vale 1
    const r = await uso(E.titular);
    expect(r.body.rucs.limite).toBe(21);
  });
});

describe("GET /plan/uso · acceso (D8, CA-8)", () => {
  it.each(ROLES)("lo lee un miembro con rol %s", async (rol) => {
    const plan = await p.plan();
    const E = await p.estudio(plan);
    const a = rol === "dueno" ? E.titular : await p.b.miembro(E.tenantId, rol);
    const r = await uso(a);
    expect(r.status).toBe(200);
    expect(r.body.plan.codigo).toBe(plan.codigo);
    sinPrecios(r.text);
  });

  it("sin sesión: 401; sin estudio activo: 403 o 409 (es @SoloEstudio)", async () => {
    const anon = await p.b.h.pedir({ ruta: "/plan/uso" });
    expect(anon.status).toBe(401);
    const u = await p.b.h.crearUsuario({ estudios: [] });
    const s = await p.b.h.entrar(u);
    const sin = await p.b.h.pedir({ ruta: "/plan/uso", cookie: s.cookie });
    expect([400, 403, 409]).toContain(sin.status);
    expect(sin.body.plan).toBeUndefined();
  });

  it("un estudio sin suscripción responde 409 sin_plan (falla cerrado, nunca 'sin límite')", async () => {
    const E = await p.estudio(null);
    const r = await uso(E.titular);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "sin_plan" });
  });

  it("nunca devuelve datos de otro estudio: cada estudio ve su plan y su uso, y X-Estudio ajeno no pasa", async () => {
    const pa = await p.plan({ maxRucs: 11, maxUsuarios: 7 });
    const pb = await p.plan({ maxRucs: 12, maxUsuarios: 8 });
    const A = await p.estudio(pa);
    const B = await p.estudio(pb);
    await p.b.clientes(B.tenantId, 4);
    const ra = await uso(A.titular);
    const rb = await uso(B.titular);
    expect(ra.body.plan.codigo).toBe(pa.codigo);
    expect(rb.body.plan.codigo).toBe(pb.codigo);
    expect(ra.body.rucs.usados).toBe(0);
    expect(rb.body.rucs.usados).toBe(4);
    expect(ra.text).not.toContain(pb.codigo);
    expect(ra.text).not.toContain(B.tenantId);
    const cruzada = await p.b.llamar({ ...A.titular, tenantId: B.tenantId }, "GET", "/plan/uso");
    expect([403, 404, 409]).toContain(cruzada.status);
    expect(cruzada.text).not.toContain(pb.codigo);
    expect(cruzada.text).not.toContain(B.tenantId);
  });
});

describe("CA-2 · el límite sale de la BD y cambia sin reiniciar la app", () => {
  it("editar el plan o cambiar la suscripción por SQL cambia la respuesta de la siguiente petición", async () => {
    const chico = await p.plan({ maxRucs: 10, maxUsuarios: 2 });
    const grande = await p.plan({ maxRucs: 50, maxUsuarios: null });
    const E = await p.estudio(chico);
    expect((await uso(E.titular)).body).toMatchObject({ rucs: { limite: 10 }, usuarios: { limite: 2 } });

    await p.editarPlan(chico, { max_rucs: 15, max_usuarios: 9 });
    expect((await uso(E.titular)).body).toMatchObject({ rucs: { limite: 15 }, usuarios: { limite: 9 } });

    await p.fijarPlan(E.tenantId, grande, { rucsExtra: 0 });
    const r = await uso(E.titular);
    expect(r.body.plan.codigo).toBe(grande.codigo);
    expect(r.body).toMatchObject({ rucs: { limite: 50 }, usuarios: { limite: null } });
  });
});

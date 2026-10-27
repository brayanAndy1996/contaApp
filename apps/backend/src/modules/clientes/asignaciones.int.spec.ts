/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T4 (005) · CA-7 (asignación individual, responsable único, D18, D19) y CA-8 (asignación masiva).
// Rojo: endpoints de asignación, tabla `asignacion` y guards aún no existen.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { forma } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
let otro: Estudio;
let c1: Actor; // contador
let c2: Actor; // contador
let a1: Actor; // asistente
let l1: Actor; // lectura (no puede ser responsable)
let clientes: string[];
let clienteAjeno: string;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  otro = await b.estudio();
  c1 = await b.miembro(E.tenantId, "contador");
  c2 = await b.miembro(E.tenantId, "contador", { sesion: false });
  a1 = await b.miembro(E.tenantId, "asistente", { sesion: false });
  l1 = await b.miembro(E.tenantId, "lectura", { sesion: false });
  clientes = await b.clientes(E.tenantId, 530);
  [clienteAjeno] = (await b.clientes(otro.tenantId, 1)) as [string];
});
afterAll(async () => {
  await b?.cerrar();
});

const filas = (clienteId: string) =>
  b.sql<{ usuario_id: string; tipo: string }>(
    "select usuario_id, tipo from asignacion where tenant_id = $1 and cliente_id = $2 order by tipo, usuario_id",
    [E.tenantId, clienteId],
  );
const responsables = async (clienteId: string) => (await filas(clienteId)).filter((f) => f.tipo === "responsable");
const cuenta = async (tenantId: string) =>
  Number((await b.sql("select count(*)::int as n from asignacion where tenant_id = $1", [tenantId]))[0].n);
const put = (cliente: string, usuarioId: string, cuerpo: object) =>
  b.llamar(E.titular, "PUT", `/clientes/${cliente}/asignaciones/${usuarioId}`, cuerpo);

describe("CA-7 · asignación individual (RF-024, HU-07)", () => {
  it("asigna responsable y colaborador y devuelve las asignaciones del cliente", async () => {
    const cl = clientes[0]!;
    const r = await put(cl, c1.id, { tipo: "responsable" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ usuarioId: c1.id, nombre: expect.any(String), tipo: "responsable" }]);
    const r2 = await put(cl, a1.id, { tipo: "colaborador" });
    expect(r2.status).toBe(200);
    expect(r2.body).toHaveLength(2);
    const lista = await b.llamar(E.titular, "GET", `/clientes/${cl}/asignaciones`);
    expect(lista.status).toBe(200);
    expect(lista.body.map((x: any) => `${x.usuarioId}:${x.tipo}`).sort()).toEqual(
      [`${c1.id}:responsable`, `${a1.id}:colaborador`].sort(),
    );
  });

  it("un responsable nuevo pasa al anterior a colaborador o lo retira, según `anterior`; sin `anterior` da 400", async () => {
    const [x, y, z] = [clientes[1]!, clientes[2]!, clientes[3]!];
    for (const cl of [x, y, z]) expect((await put(cl, c1.id, { tipo: "responsable" })).status).toBe(200);

    const sin = await put(x, c2.id, { tipo: "responsable" });
    expect(sin.status).toBe(400);
    expect((await responsables(x)).map((f) => f.usuario_id)).toEqual([c1.id]); // nada cambió

    expect((await put(y, c2.id, { tipo: "responsable", anterior: "colaborador" })).status).toBe(200);
    expect((await filas(y)).map((f) => `${f.usuario_id}:${f.tipo}`).sort()).toEqual(
      [`${c1.id}:colaborador`, `${c2.id}:responsable`].sort(),
    );

    expect((await put(z, c2.id, { tipo: "responsable", anterior: "retirar" })).status).toBe(200);
    expect((await filas(z)).map((f) => `${f.usuario_id}:${f.tipo}`)).toEqual([`${c2.id}:responsable`]);
    // `anterior` inválido
    expect((await put(x, c2.id, { tipo: "responsable", anterior: "borrar" })).status).toBe(400);
    expect((await put(x, c2.id, { tipo: "jefe" })).status).toBe(400);
  });

  it("solo se asigna a miembros activos; responsable exige sire.clasificar (D18): lectura puede ser colaborador, no responsable", async () => {
    const cl = clientes[4]!;
    const noResp = await put(cl, l1.id, { tipo: "responsable" });
    expect(noResp.status).toBe(409);
    expect(noResp.body).toEqual({ codigo: "miembro_no_asignable" });
    expect((await filas(cl)).filter((f) => f.usuario_id === l1.id)).toHaveLength(0);
    expect((await put(cl, l1.id, { tipo: "colaborador" })).status).toBe(200);

    const off = await b.miembro(E.tenantId, "contador", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, off.id]);
    for (const tipo of ["colaborador", "responsable"]) {
      const r = await put(cl, off.id, { tipo });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ codigo: "miembro_no_asignable" });
    }
  });

  it("usuario o cliente de otro estudio, no miembro o inexistente dan 404 y no escriben", async () => {
    const miembroAjeno = await b.miembro(otro.tenantId, "contador", { sesion: false });
    const cl = clientes[5]!;
    const antes = await cuenta(E.tenantId);
    const casos: [string, string][] = [
      [cl, miembroAjeno.id], // usuario de otro estudio
      [cl, randomUUID()], // inexistente
      [cl, "no-es-uuid"],
      [clienteAjeno, c1.id], // cliente de otro estudio
      [randomUUID(), c1.id],
      ["no-es-uuid", c1.id],
    ];
    const formas = [];
    for (const [cli, u] of casos) formas.push(forma(await put(cli, u, { tipo: "colaborador" })));
    for (const f of formas) expect(f.status).toBe(404);
    // Usuario ajeno e inexistente no se distinguen.
    expect(formas[0]).toEqual(formas[1]);
    expect(await cuenta(E.tenantId)).toBe(antes);
    expect(await cuenta(otro.tenantId)).toBe(0);
  });

  it("retirar: 204 y luego 404; retirar a un usuario sin asignación, ajeno o en cliente ajeno da 404", async () => {
    const cl = clientes[6]!;
    expect((await put(cl, a1.id, { tipo: "colaborador" })).status).toBe(200);
    expect((await b.llamar(E.titular, "DELETE", `/clientes/${cl}/asignaciones/${a1.id}`)).status).toBe(204);
    expect(await filas(cl)).toHaveLength(0);
    expect((await b.llamar(E.titular, "DELETE", `/clientes/${cl}/asignaciones/${a1.id}`)).status).toBe(404);
    expect((await b.llamar(E.titular, "DELETE", `/clientes/${clienteAjeno}/asignaciones/${a1.id}`)).status).toBe(404);
    expect((await b.llamar(E.titular, "DELETE", `/clientes/${cl}/asignaciones/${randomUUID()}`)).status).toBe(404);
  });

  it("dos asignaciones de responsable simultáneas al mismo cliente dejan exactamente uno", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const cl = clientes[10 + ronda]!;
      const rs = await Promise.all([
        put(cl, c1.id, { tipo: "responsable", anterior: "colaborador" }),
        put(cl, c2.id, { tipo: "responsable", anterior: "colaborador" }),
      ]);
      for (const r of rs) expect(r.status).toBeLessThan(500);
      expect(rs.map((r) => r.status)).toContain(200);
      expect(await responsables(cl)).toHaveLength(1);
      const todas = await filas(cl);
      expect(new Set(todas.map((f) => f.usuario_id)).size).toBe(todas.length); // una fila por usuario
    }
  });

  it("al perder sire.clasificar por cambio de rol, sus responsabilidades pasan a colaborador y conserva la visibilidad (D18)", async () => {
    const u = await b.miembro(E.tenantId, "contador", { sesion: true });
    const cl = clientes[20]!;
    expect((await put(cl, u.id, { tipo: "responsable" })).status).toBe(200);
    expect((await b.llamar(E.titular, "PATCH", `/usuarios/${u.id}/rol`, { rol: "lectura" })).status).toBe(200);
    expect(await responsables(cl)).toHaveLength(0);
    expect((await filas(cl)).map((f) => `${f.usuario_id}:${f.tipo}`)).toEqual([`${u.id}:colaborador`]);
    const visto = await b.llamar(u, "GET", "/clientes");
    const fila = visto.body.find((x: any) => x.id === cl);
    expect(fila).toBeDefined();
    expect(fila.responsable).toBeNull();
  });

  it("desactivar quita todas las asignaciones y reactivar no las devuelve (D19)", async () => {
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [r1, r2] = [clientes[21]!, clientes[22]!];
    expect((await put(r1, u.id, { tipo: "responsable" })).status).toBe(200);
    expect((await put(r2, u.id, { tipo: "colaborador" })).status).toBe(200);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${u.id}/desactivar`)).status).toBe(200);
    expect(await filas(r1)).toHaveLength(0);
    expect(await filas(r2)).toHaveLength(0);
    expect((await b.llamar(E.titular, "POST", `/usuarios/${u.id}/reactivar`)).status).toBe(200);
    expect(await filas(r1)).toHaveLength(0);
    expect(await filas(r2)).toHaveLength(0);
  });

  it("los campos extra del cuerpo (tenantId, usuarioId, clienteId, rol) no cambian a quién se asigna", async () => {
    const cl = clientes[23]!;
    const r = await put(cl, a1.id, {
      tipo: "colaborador",
      tenantId: otro.tenantId,
      usuarioId: c1.id,
      clienteId: clienteAjeno,
      rol: "dueno",
    });
    expect(r.status).toBe(200);
    expect((await filas(cl)).map((f) => f.usuario_id)).toEqual([a1.id]);
    expect(await cuenta(otro.tenantId)).toBe(0);
    expect((await b.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, a1.id]))[0].rol).toBe("asistente");
  });
});

describe("CA-8 · asignación masiva (RF-025)", () => {
  it("por usuario: 500 clientes en una petición, todo o nada, y el usuario los ve en su siguiente petición", async () => {
    const u = await b.miembro(E.tenantId, "contador");
    const lote = clientes.slice(30, 530);
    expect(lote).toHaveLength(500);
    const r = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: u.id, clienteIds: lote, tipo: "colaborador" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ asignados: 500 });
    expect(Number((await b.sql("select count(*)::int as n from asignacion where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id]))[0].n)).toBe(500);
    const vistos = await b.llamar(u, "GET", "/clientes");
    expect(vistos.body).toHaveLength(500);
  });

  it("por cliente: 500 usuarios en una petición (colaboradores)", async () => {
    const cl = clientes[7]!;
    const usuarios = await b.miembrosMasivos(E.tenantId, 500);
    const r = await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", { clienteId: cl, usuarioIds: usuarios });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ asignados: 500 });
    const filasCl = await filas(cl);
    expect(filasCl.filter((f) => f.tipo === "colaborador").length).toBeGreaterThanOrEqual(500);
  });

  it("más de 500 o cero elementos dan 400 y no se aplica nada", async () => {
    const antes = await cuenta(E.tenantId);
    const demasiados = clientes.slice(0, 501);
    expect((await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: c2.id, clienteIds: demasiados, tipo: "colaborador" })).status).toBe(400);
    expect((await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: c2.id, clienteIds: [], tipo: "colaborador" })).status).toBe(400);
    const muchosUsuarios = await b.miembrosMasivos(E.tenantId, 501);
    expect((await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", { clienteId: clientes[8], usuarioIds: muchosUsuarios })).status).toBe(400);
    expect((await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", { clienteId: clientes[8], usuarioIds: [] })).status).toBe(400);
    expect(await cuenta(E.tenantId)).toBe(antes);
  });

  it("un ID ajeno o inexistente en el lote: 404 genérico, nada se aplica y la respuesta no dice cuál falló", async () => {
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const propios = clientes.slice(100, 114); // 14 propios
    const antes = await cuenta(E.tenantId);
    const conAjeno = [...propios.slice(0, 7), clienteAjeno, ...propios.slice(7)];
    const conInexistente = [...propios.slice(0, 7), randomUUID(), ...propios.slice(7)];
    const rA = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: u.id, clienteIds: conAjeno, tipo: "colaborador" });
    const rI = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: u.id, clienteIds: conInexistente, tipo: "colaborador" });
    expect(rA.status).toBe(404);
    expect(forma(rA)).toEqual(forma(rI));
    expect(rA.text).not.toContain(clienteAjeno);
    expect(await cuenta(E.tenantId)).toBe(antes);
    expect(await cuenta(otro.tenantId)).toBe(0);

    // Por cliente: usuario de otro estudio mezclado.
    const miembroAjeno = await b.miembro(otro.tenantId, "contador", { sesion: false });
    const usuariosPropios = [c1.id, c2.id, a1.id];
    const rU = await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", {
      clienteId: clientes[9],
      usuarioIds: [...usuariosPropios, miembroAjeno.id],
    });
    expect(rU.status).toBe(404);
    expect(rU.text).not.toContain(miembroAjeno.id);
    expect((await filas(clientes[9]!))).toHaveLength(0);
    expect(await cuenta(otro.tenantId)).toBe(0);
  });

  it("un lote con un miembro desactivado o no asignable no aplica nada (409 miembro_no_asignable)", async () => {
    const off = await b.miembro(E.tenantId, "contador", { sesion: false });
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, off.id]);
    const cl = clientes[120]!;
    const antes = await cuenta(E.tenantId);
    const r = await b.llamar(E.titular, "POST", "/asignaciones/por-cliente", { clienteId: cl, usuarioIds: [c1.id, off.id] });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "miembro_no_asignable" });
    const r2 = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: l1.id, clienteIds: [cl, clientes[121]], tipo: "responsable" });
    expect(r2.status).toBe(409);
    expect(await cuenta(E.tenantId)).toBe(antes);
  });

  it("los duplicados del lote se deduplican y los campos extra (rol, tenantId) se ignoran", async () => {
    const u = await b.miembro(E.tenantId, "contador", { sesion: false });
    const [x, y] = [clientes[130]!, clientes[131]!];
    const r = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", {
      usuarioId: u.id,
      clienteIds: [x, y, x, y, x],
      tipo: "colaborador",
      rol: "dueno",
      tenantId: otro.tenantId,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ asignados: 2 });
    expect((await filas(x)).filter((f) => f.usuario_id === u.id)).toHaveLength(1);
    expect((await b.sql("select rol from membresia where tenant_id = $1 and usuario_id = $2", [E.tenantId, u.id]))[0].rol).toBe("contador");
    expect(await cuenta(otro.tenantId)).toBe(0);
  });

  it("por usuario con tipo responsable: asigna responsables y respeta `anterior`", async () => {
    const [x, y] = [clientes[140]!, clientes[141]!];
    expect((await put(x, c1.id, { tipo: "responsable" })).status).toBe(200);
    const sin = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", { usuarioId: c2.id, clienteIds: [x, y], tipo: "responsable" });
    expect(sin.status).toBe(400); // x ya tiene responsable y falta `anterior`
    expect(await responsables(y)).toHaveLength(0); // todo o nada
    const con = await b.llamar(E.titular, "POST", "/asignaciones/por-usuario", {
      usuarioId: c2.id,
      clienteIds: [x, y],
      tipo: "responsable",
      anterior: "colaborador",
    });
    expect(con.status).toBe(200);
    expect((await responsables(x)).map((f) => f.usuario_id)).toEqual([c2.id]);
    expect((await responsables(y)).map((f) => f.usuario_id)).toEqual([c2.id]);
    expect((await filas(x)).find((f) => f.usuario_id === c1.id)!.tipo).toBe("colaborador");
  });
});

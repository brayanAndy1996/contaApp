// T13a (030) · Ronda adversarial 2, caja negra por HTTP. Ataca las correcciones de la ronda 1 (ec25bae: alcance en las asignaciones masivas,
// impacto 403, nombres reservados; 3ca88db: revocación de invitaciones al editar el rol del invitador) solo con spec.md, plan.md#contratos y
// la interfaz HTTP. Una prueba roja es un hallazgo.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import { cerrar, crear, crearOk, editar, impacto, invitar, membresiaDe, miembroConRol, nombreUnico, type RolCreado } from "../../../../test/soporte-roles.js";
import { PWD } from "../../../../test/soporte.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
let D: Actor;
// Gestor con rol propio global: roles y usuarios, sin credenciales.editar ni clientes.editar.
let G: RolCreado;
let gestor: Actor;
// Un rol con más que el gestor.
let H: RolCreado;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  D = E.titular;
  G = await crearOk(b, D, { nombre: nombreUnico("Gestor R2"), permisos: cerrar(["roles.gestionar", "usuarios.gestionar", "clientes.crear"]), alcance: "global" });
  gestor = await miembroConRol(b, D, G.id);
  H = await crearOk(b, D, { nombre: nombreUnico("Mayor R2"), permisos: cerrar(["credenciales.editar", "clientes.editar"]), alcance: "global" });
});
afterAll(async () => {
  await b?.cerrar();
});

const forma = (r: { status: number; body: unknown }) => ({ status: r.status, body: r.body });

describe("(a) reactivar no es una puerta lateral para un rol que el gestor no contiene", () => {
  it("POST /usuarios/:id/reactivar de un miembro desactivado del rol H: 403 y sigue desactivado; el Dueño sí lo reactiva", async () => {
    const M = await miembroConRol(b, D, H.id, { sesion: false });
    const des = await b.llamar(D, "POST", `/usuarios/${M.id}/desactivar`);
    expect(des.status, des.text).toBeLessThan(300);
    const r = await b.llamar(gestor, "POST", `/usuarios/${M.id}/reactivar`);
    const sigue = (await membresiaDe(b, E.tenantId, M.id)).desactivada_en !== null;
    const ctrl = await b.llamar(D, "POST", `/usuarios/${M.id}/reactivar`);
    expect({ gestor: r.status, sigueDesactivado: sigue, dueno: ctrl.status < 300 }).toEqual({ gestor: 403, sigueDesactivado: true, dueno: true });
  });
});

describe("(b) invitaciones pendientes tras editar el rol del invitador o el rol invitado", () => {
  it("el rol del invitador pierde lo que el invitado recibiría, o el rol invitado gana lo que el invitador no tiene: consultar y aceptar dan 400 y no nace la cuenta", async () => {
    const G3 = await crearOk(b, D, { nombre: nombreUnico("Invitador R2"), permisos: cerrar(["usuarios.gestionar", "clientes.crear"]), alcance: "global" });
    const g3 = await miembroConRol(b, D, G3.id);
    const Q = await crearOk(b, D, { nombre: nombreUnico("Invitado R2"), permisos: cerrar(["clientes.crear"]), alcance: "asignado" });
    const Q2 = await crearOk(b, D, { nombre: nombreUnico("Invitado2 R2"), permisos: ["clientes.ver"], alcance: "asignado" });
    const c1 = b.correoNuevo();
    const c2 = b.correoNuevo();
    for (const [c, rol] of [[c1, Q.id], [c2, Q2.id]] as const) {
      const r = await invitar(b, g3, c, rol);
      expect(r.status, r.text).toBe(201);
    }
    const t1 = await b.tokenDe(c1);
    const t2 = await b.tokenDe(c2);
    // 1: el Dueño le quita clientes.crear al rol del invitador. 2: el Dueño le da credenciales.editar al rol invitado Q2.
    expect((await editar(b, D, G3.id, { permisos: cerrar(["usuarios.gestionar"]) })).status).toBe(200);
    expect((await editar(b, D, Q2.id, { permisos: cerrar(["credenciales.editar"]) })).status).toBe(200);
    const res: Record<string, number> = {};
    for (const [k, token] of [["1", t1], ["2", t2]] as const) {
      res[`consultar${k}`] = (await b.h.pedir({ ruta: "/invitaciones/consultar", cuerpo: { token } })).status;
      res[`aceptar${k}`] = (await b.h.pedir({ ruta: "/invitaciones/aceptar", cuerpo: { token, nombre: "Invitado R2", contrasena: PWD } })).status;
    }
    const cuentas = Number((await b.sql("select count(*)::int n from usuario where email = any($1::text[])", [[c1, c2]]))[0].n);
    expect({ ...res, cuentas }).toEqual({ consultar1: 400, aceptar1: 400, consultar2: 400, aceptar2: 400, cuentas: 0 });
  });
});

describe("(f) asignaciones masivas con alcance asignado: lote mezclado y ajenos dan el mismo 404 y no escriben nada", () => {
  it("por-usuario y por-cliente con clientes dentro y fuera de alcance, inexistentes o de otro estudio, y usuarios de otro estudio", async () => {
    const rol = await crearOk(b, D, { nombre: nombreUnico("Asignador R2"), permisos: cerrar(["clientes.asignar"]), alcance: "asignado" });
    const M = await miembroConRol(b, D, rol.id);
    const [c1, c2] = await b.clientes(E.tenantId, 2);
    await b.asignar(E.tenantId, c1!, M.id, "colaborador");
    const otro = await b.miembro(E.tenantId, "lectura", { sesion: false });
    const ajeno = await b.estudio();
    const [cAjeno] = await b.clientes(ajeno.tenantId, 1);
    const uAjeno = await b.miembro(ajeno.tenantId, "lectura", { sesion: false });
    const filas = async () => Number((await b.sql("select count(*)::int n from asignacion where tenant_id = any($1::uuid[])", [[E.tenantId, ajeno.tenantId]]))[0].n);
    const antes = await filas();
    const pu = (a: Actor, usuarioId: string, clienteIds: string[]) => b.llamar(a, "POST", "/asignaciones/por-usuario", { usuarioId, clienteIds, tipo: "colaborador" });
    const pc = (a: Actor, clienteId: string, usuarioIds: string[]) => b.llamar(a, "POST", "/asignaciones/por-cliente", { clienteId, usuarioIds });
    const intentos = {
      mezclado: forma(await pu(M, otro.id, [c1!, c2!])),
      mezcladoInexistente: forma(await pu(M, otro.id, [c1!, randomUUID()])),
      mezcladoAjeno: forma(await pu(M, otro.id, [c1!, cAjeno!])),
      usuarioAjeno: forma(await pu(M, uAjeno.id, [c1!])),
      usuarioInexistente: forma(await pu(M, randomUUID(), [c1!])),
      porClienteUsuarioAjeno: forma(await pc(M, c1!, [otro.id, uAjeno.id])),
      porClienteFuera: forma(await pc(M, c2!, [otro.id])),
      duenoMezcladoAjeno: forma(await pu(D, otro.id, [c1!, cAjeno!])),
      duenoPorClienteAjeno: forma(await pc(D, cAjeno!, [otro.id])),
    };
    const esperado = forma(await pu(M, otro.id, [randomUUID()]));
    expect(esperado.status).toBe(404);
    const distintos = Object.entries(intentos)
      .filter(([, v]) => JSON.stringify(v) !== JSON.stringify(esperado))
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    expect({ distintos, filasNuevas: (await filas()) - antes }).toEqual({ distintos: [], filasNuevas: 0 });
  });
});

describe("(g) POST /roles/:id/impacto con las mismas reglas que el PATCH", () => {
  it("alcance que sube a global, permisos que exceden, 'antes' global que excede, gestor sin roles.gestionar: 403 sin conteos; dentro de contención 200", async () => {
    const GA = await crearOk(b, D, { nombre: nombreUnico("GestorAsig R2"), permisos: cerrar(["roles.gestionar", "usuarios.gestionar", "clientes.crear"]), alcance: "asignado" });
    const ga = await miembroConRol(b, D, GA.id);
    const soloUsuarios = await crearOk(b, D, { nombre: nombreUnico("SoloUsuarios R2"), permisos: cerrar(["usuarios.gestionar", "clientes.crear"]), alcance: "global" });
    const su = await miembroConRol(b, D, soloUsuarios.id);
    const A = await crearOk(b, D, { nombre: nombreUnico("Chico R2"), permisos: ["clientes.ver"], alcance: "asignado" });
    const Glob = await crearOk(b, D, { nombre: nombreUnico("ChicoGlobal R2"), permisos: ["clientes.ver"], alcance: "global" });
    const st = async (a: Actor, id: string, cuerpo: unknown) => {
      const r = await impacto(b, a, id, cuerpo);
      return r.status === 200 ? 200 : `${r.status}${/miembros/i.test(r.text) ? "+conteos" : ""}`;
    };
    expect({
      control: await st(ga, A.id, {}),
      subeAGlobal: await st(ga, A.id, { alcance: "global" }),
      excede: await st(ga, A.id, { permisos: cerrar(["credenciales.editar"]) }),
      antesGlobal: await st(ga, Glob.id, { alcance: "asignado" }),
      sinRolesGestionar: await st(su, A.id, {}),
      globalExcede: await st(gestor, A.id, { permisos: cerrar(["clientes.editar"]) }),
    }).toEqual({ control: 200, subeAGlobal: "403", excede: "403", antesGlobal: "403", sinRolesGestionar: "403", globalExcede: "403" });
  });
});

describe("(e) nombres que se ven como uno de sistema o como otro rol (CA-1)", () => {
  // Conocida: riesgo bajo aceptado por el usuario (030) — confusables/homoglifos en nombres de rol.
  it.fails("«Dueño» en ancho completo o con una e cirílica, «Lectura» con selector de variación y un duplicado con una A cirílica: 409, y no se crea nada", async () => {
    const base = nombreUnico("Auditor");
    expect((await crear(b, D, { nombre: base, permisos: ["clientes.ver"] })).status).toBe(201);
    const intentos: Record<string, string> = {
      anchoCompleto: "Ｄｕｅñｏ",
      cirilico: "Duеño",
      selectorVariacion: "Lectura️",
      duplicadoCirilico: base.replace("A", "А"),
    };
    const vistos: Record<string, number> = {};
    for (const [k, nombre] of Object.entries(intentos)) vistos[k] = (await crear(b, D, { nombre, permisos: ["clientes.ver"] })).status;
    expect(vistos).toEqual({ anchoCompleto: 409, cirilico: 409, selectorVariacion: 409, duplicadoCirilico: 409 });
  });
});

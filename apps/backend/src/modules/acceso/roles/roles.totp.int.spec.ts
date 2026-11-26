// T3 (030) · CA-7 (U8 = U2 de 029): la regla de exigencia del segundo factor con permisos efectivos. Un rol propio con usuarios.gestionar,
// roles.gestionar, plan.gestionar o credenciales.editar exige TOTP; los demás roles propios, no. Un rol que gana un permiso sensible exige
// el factor en la SIGUIENTE petición de sus miembros; perderlo los libera; `/auth/totp/desactivar` aplica la misma regla (409 totp_exigido).
// Misma tabla que el TS y el SQL: `CASOS_FACTOR_EXIGIDO` de `packages/shared` (filas de rol propio, `rolSistema: null`).
// Cubre: `auth/totp/exigencia.ts`, `guards/permiso.guard.ts`, `acceso/roles/roles.service.ts`.
// Rojo: la asignación de roles propios (T8), `/roles` (T9) y la exigencia con permisos efectivos (T8) no existen; faltan las tablas de la 0082.
// Los casos con `plan.gestionar` no se pueden crear por API (CA-2: 422), así que se saltan aquí (los prueba T1 en BD y T2 en shared).
// La tabla es solo de pruebas y no se exporta por el paquete: se importa de su build (`pnpm --filter @contapp/shared build`).
import { CASOS_FACTOR_EXIGIDO } from "@contapp/shared/dist/auth/factor-exigido.casos.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor, Banco, Estudio } from "../../../../test/soporte-acceso.js";
import {
  abrirBancoTotp,
  activarTotp,
  congelarReloj,
  EXIGIDO,
  filaTotp,
  type Reloj,
} from "../../../../test/soporte-totp.js";
import { asignar, asignarSistema, cerrar, crearOk, editar, eliminar, miembroConRol, SENSIBLES } from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let b: Banco;
let E: Estudio;
let D: Actor; // Dueño con TOTP verificado: puede editar roles y asignarlos
let reloj: Reloj | undefined;

beforeAll(async () => {
  b = await abrirBancoTotp();
  E = await b.estudio();
  const c = await activarTotp(b.h, E.titular);
  D = { ...E.titular, cookie: c.cookie, csrf: c.csrf };
});
afterAll(async () => {
  await b?.cerrar();
});
afterEach(() => reloj?.liberar());

const estudioActual = (a: Actor) => b.llamar(a, "GET", "/estudio/actual");
const sesion = (a: Actor) => b.h.pedir({ ruta: "/auth/sesion", cookie: a.cookie });

describe("CA-7 · ganar o perder un permiso sensible cambia la exigencia en la siguiente petición", () => {
  it.each(SENSIBLES.map((p) => [p] as const))("%s: al ganarlo, 403 segundo_factor_requerido; al perderlo, vuelve a pasar", async (p) => {
    const rol = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    expect((await estudioActual(P)).status).toBe(200);
    expect((await sesion(P)).body).toMatchObject({ factor: "sin_factor", totpActivo: false, factorExigido: false });

    expect((await editar(b, D, rol.id, { permisos: cerrar(["clientes.ver", p]) })).status).toBe(200);
    const exigido = await estudioActual(P);
    expect(exigido.status, exigido.text).toBe(403);
    expect(exigido.body).toEqual(EXIGIDO);
    expect((await b.llamar(P, "GET", "/clientes")).body).toEqual(EXIGIDO);
    expect((await sesion(P)).body).toMatchObject({ totpActivo: false, factorExigido: true });

    expect((await editar(b, D, rol.id, { permisos: ["clientes.ver"] })).status).toBe(200);
    expect((await estudioActual(P)).status).toBe(200);
    expect((await sesion(P)).body.factorExigido).toBe(false);
  });

  it("ganar permisos que no son sensibles no exige el factor", async () => {
    const rol = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    const otros = cerrar(["clientes.crear", "clientes.editar", "reglas.gestionar", "prorrata.gestionar", "auditoria.ver", "estudio.configurar", "usuarios.ver", "sire.aprobar_generar"]);
    expect((await editar(b, D, rol.id, { permisos: otros })).status).toBe(200);
    expect((await estudioActual(P)).status).toBe(200);
    expect((await sesion(P)).body.factorExigido).toBe(false);
  });

  it("asignar al miembro un rol propio sensible (o sacarlo de él) también cambia la exigencia en la siguiente petición", async () => {
    const sensible = await crearOk(b, D, { permisos: cerrar(["credenciales.editar"]), alcance: "asignado" });
    const P = await b.miembro(E.tenantId, "lectura");
    expect((await estudioActual(P)).status).toBe(200);
    expect((await b.llamar(D, "PATCH", `/usuarios/${P.id}/rol`, { rol: { rolId: sensible.id } })).status).toBe(200);
    expect((await estudioActual(P)).body).toEqual(EXIGIDO);
    expect((await asignarSistema(b, D, P.id, "asistente")).status).toBe(200);
    expect((await estudioActual(P)).status).toBe(200);
  });

  it("con el TOTP enrolado y la sesión verificada, el miembro de un rol sensible pasa", async () => {
    const rol = await crearOk(b, D, { permisos: cerrar(["roles.gestionar"]), alcance: "global" });
    const P = await miembroConRol(b, D, rol.id);
    expect((await estudioActual(P)).body).toEqual(EXIGIDO);
    const c = await activarTotp(b.h, P);
    const verificado = { ...P, cookie: c.cookie, csrf: c.csrf };
    expect((await estudioActual(verificado)).status).toBe(200);
    expect((await b.llamar(verificado, "GET", "/roles")).status).toBe(200);
    expect((await sesion(verificado)).body).toMatchObject({ factor: "verificado", totpActivo: true, factorExigido: true });
  });
});

// Filas de la tabla común con rol propio; el resultado esperado es el mismo que en TS (`factorExigido`) y en SQL (`totp_desactivar`).
const CASOS_PROPIOS = CASOS_FACTOR_EXIGIDO.filter((c) => c.rolSistema === null && !c.plataforma && !c.permisos.includes("plan.gestionar"));

describe("CA-7 · CASOS_FACTOR_EXIGIDO con rol propio, por HTTP", () => {
  it("la tabla trae filas de rol propio exigidas y no exigidas (si no, la prueba no prueba nada)", () => {
    expect(CASOS_PROPIOS.some((c) => c.exigido)).toBe(true);
    expect(CASOS_PROPIOS.some((c) => !c.exigido)).toBe(true);
  });

  it.each(CASOS_PROPIOS.map((c) => [c.nombre, c] as const))("%s", async (_nombre, caso) => {
    const rol = await crearOk(b, D, { permisos: cerrar(caso.permisos), alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    try {
      expect((await sesion(P)).body.factorExigido).toBe(caso.exigido);
      const r = await estudioActual(P);
      if (caso.exigido) {
        expect(r.status, r.text).toBe(403);
        expect(r.body).toEqual(EXIGIDO);
      } else {
        expect(r.status, r.text).toBe(200);
      }
    } finally {
      await asignarSistema(b, D, P.id, "lectura");
      await eliminar(b, D, rol.id);
    }
  });
});

describe("CA-7 · `/auth/totp/desactivar` aplica la misma regla con roles propios", () => {
  const desactivar = (c: { cookie: string; csrf: string }, contrasena: string, codigo: string) =>
    b.h.pedir({ ruta: "/auth/totp/desactivar", cuerpo: { contrasena, codigo }, cookie: c.cookie, csrf: c.csrf });

  it("con un rol propio sensible: 409 totp_exigido y el factor sigue; al perder el permiso sensible, se puede desactivar (204)", async () => {
    reloj = congelarReloj();
    const rol = await crearOk(b, D, { permisos: cerrar(["usuarios.gestionar"]), alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    const c = await activarTotp(b.h, P, reloj);
    reloj.avanzar(1);
    const r = await desactivar(c, P.contrasena, reloj.codigo(c.secreto));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "totp_exigido" });
    expect((await filaTotp(b.h, P.id))?.activo_cifrado).toBeTruthy();

    expect((await editar(b, D, rol.id, { permisos: ["usuarios.ver"] })).status).toBe(200);
    reloj.avanzar(1);
    const libre = await desactivar(c, P.contrasena, reloj.codigo(c.secreto));
    expect(libre.status, libre.text).toBe(204);
    expect((await filaTotp(b.h, P.id))?.activo_cifrado ?? null).toBeNull();
  });

  it("con un rol propio sin permisos sensibles: 204; y quien gana uno después queda exigido sin poder desactivar", async () => {
    reloj = congelarReloj();
    const rol = await crearOk(b, D, { permisos: ["clientes.ver", "clientes.crear"], alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    const c = await activarTotp(b.h, P, reloj);
    reloj.avanzar(1);
    expect((await editar(b, D, rol.id, { permisos: cerrar(["credenciales.editar"]) })).status).toBe(200);
    const denegado = await desactivar(c, P.contrasena, reloj.codigo(c.secreto));
    expect(denegado.status, denegado.text).toBe(409);
    expect(denegado.body).toEqual({ codigo: "totp_exigido" });
    expect((await editar(b, D, rol.id, { permisos: ["clientes.ver", "clientes.crear"] })).status).toBe(200);
    reloj.avanzar(1);
    const ok = await desactivar(c, P.contrasena, reloj.codigo(c.secreto));
    expect(ok.status, ok.text).toBe(204);
  });

  it("un miembro de rol propio sin sensibles en este estudio, pero con uno sensible en otro estudio, tampoco lo desactiva (se miran todas las membresías)", async () => {
    reloj = congelarReloj();
    const otro = await b.estudio();
    const c0 = await activarTotp(b.h, otro.titular, reloj);
    const D2 = { ...otro.titular, cookie: c0.cookie, csrf: c0.csrf };
    const sensible = await crearOk(b, D2, { permisos: cerrar(["roles.gestionar"]), alcance: "asignado" });
    const rol = await crearOk(b, D, { permisos: ["clientes.ver"], alcance: "asignado" });
    const P = await miembroConRol(b, D, rol.id);
    await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'lectura')", [otro.tenantId, P.id]);
    expect((await asignar(b, D2, P.id, sensible.id)).status).toBe(200); // en el otro estudio P tiene roles.gestionar
    const c = await activarTotp(b.h, P, reloj);
    reloj.avanzar(1);
    const r = await desactivar(c, P.contrasena, reloj.codigo(c.secreto));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "totp_exigido" });
  });
});

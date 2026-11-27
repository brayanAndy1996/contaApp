/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// T15 (029) · Ronda adversarial 2 (CA-11) contra las correcciones de T14: la lista cerrada `@PermitirSinFactor` de `PermisoGuard` (rutas
// sin estudio fuera de `/auth`, cuenta que pasa a exigir el factor, falla cerrada sin el servicio), el contador de códigos frente al
// cambio de contraseña y `totp/confirmar` concurrente desde dos sesiones. Cada prueba que falla es un hallazgo.
import { randomBytes, randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claveCorreo, cookieSesion, type Harness, type Resp } from "../../../test/soporte.js";
import type { Banco } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTotp,
  activarTotp,
  codigoErroneo,
  congelarReloj,
  entrarConTotp,
  entrarSinTotp,
  EXIGIDO,
  filaTotp,
  sesionDeCookie,
  type Reloj,
  type SesionTotp,
} from "../../../test/soporte-totp.js";
import { PermisoGuard } from "../acceso/guards/permiso.guard.js";
import { fijarSesion, PermitirSinFactor, SinEstudio, type PeticionAuth } from "./guards/decoradores.js";

let b: Banco;
let h: Harness;
let reloj: Reloj | undefined;
beforeAll(async () => {
  b = await abrirBancoTotp();
  h = b.h;
});
afterAll(async () => {
  await b?.cerrar();
});
afterEach(() => {
  reloj?.liberar();
  reloj = undefined;
});

const post = (s: { cookie: string; csrf: string }, ruta: string, cuerpo: unknown = {}): Promise<Resp> =>
  h.pedir({ ruta, cuerpo, cookie: s.cookie, csrf: s.csrf });
const ok = (r: Resp) => r.status >= 200 && r.status < 300;
const contrasenaNueva = () => `R2-${randomBytes(6).toString("hex")}-Larga-Segura`;

describe("R2 · contador de códigos frente al cambio de contraseña (CA-3)", () => {
  it("cambiar la contraseña cada 4 códigos erróneos no permite más de 5 evaluaciones en 15 min", async () => {
    const r = congelarReloj();
    reloj = r;
    const u = await h.crearUsuario();
    const cuenta = await activarTotp(h, u, r);
    let s: SesionTotp = await entrarConTotp(h, u, cuenta.secreto, r);
    let contrasena = u.contrasena;
    const evaluados: number[] = [];
    for (let ronda = 0; ronda < 3; ronda++) {
      for (let i = 0; i < 4; i++) {
        const x = await post(s, "/auth/totp/recuperacion", { contrasena, codigo: codigoErroneo(cuenta.secreto, r.ahora()) });
        if (x.body?.codigo === "codigo_invalido") evaluados.push(ronda);
      }
      const nueva = contrasenaNueva();
      const c = await post(s, "/auth/contrasena", { actual: contrasena, nueva });
      const cookie = cookieSesion(c);
      if (c.status !== 204 || !cookie) break; // si el cambio se rechaza, el contador sí aguantó
      contrasena = nueva;
      s = await sesionDeCookie(h, cookie.valor);
    }
    const fila = (await h.sql("select fallos, coalesce(bloqueado_hasta > now(), false) as b from auth.intento_login where clave = $1", [claveCorreo(u.correo)]))[0];
    expect(evaluados.length, `códigos evaluados en 15 min: ${evaluados.length}; contador ${JSON.stringify(fila)}`).toBeLessThanOrEqual(5);
  });
});

describe("R2 · lista cerrada `@PermitirSinFactor` (CA-4, U1–U3)", () => {
  it("un Dueño sin factor no alcanza las rutas sin estudio fuera de /auth (aceptar invitación o confirmar registro con sesión)", async () => {
    const { titular } = await b.estudio();
    const estados: string[] = [];
    for (const ruta of ["/invitaciones/aceptar-con-sesion", "/registro/confirmar-con-sesion", "/auth/totp/desactivar", "/auth/totp/recuperacion"]) {
      const x = await b.llamar(titular, "POST", ruta, { token: randomBytes(32).toString("base64url"), contrasena: titular.contrasena, codigo: "000000" });
      if (x.status !== 403 || x.body?.codigo !== EXIGIDO.codigo) estados.push(`${ruta} → ${x.status} ${JSON.stringify(x.body)}`);
    }
    expect(estados).toEqual([]);
  });

  it("la exigencia se evalúa en cada petición: un Contador sin factor ascendido a Dueño o dado de alta como super-admin pierde /auth/sesiones", async () => {
    const { tenantId } = await b.estudio();
    const c = await b.miembro(tenantId, "contador");
    expect((await b.llamar(c, "GET", "/auth/sesiones")).status).toBe(200);
    await b.sql("update membresia set rol = 'dueno' where usuario_id = $1 and tenant_id = $2", [c.id, tenantId]);
    const x = await b.llamar(c, "GET", "/auth/sesiones");
    await b.sql("update membresia set rol = 'contador' where usuario_id = $1 and tenant_id = $2", [c.id, tenantId]);
    await b.sql("insert into admin_plataforma (usuario_id) values ($1)", [c.id]);
    let y: Resp;
    try {
      y = await b.llamar(c, "GET", "/auth/sesiones");
    } finally {
      await b.sql("delete from admin_plataforma where usuario_id = $1", [c.id]);
    }
    expect([x.status, y.status]).toEqual([403, 403]);
    expect([x.body, y.body]).toEqual([EXIGIDO, EXIGIDO]);
  });

  it("falla cerrada: sin el servicio de exigencia o si este falla, una ruta sin estudio fuera de la lista no se atiende a `sin_factor`", async () => {
    class Rutas {
      @SinEstudio()
      fuera(): void {}
      @SinEstudio()
      @PermitirSinFactor()
      dentro(): void {}
    }
    const ctx = (handler: () => void, factor: unknown): ExecutionContext => {
      const req = { method: "POST", headers: {} } as PeticionAuth;
      fijarSesion(req, {
        sesionId: randomUUID(),
        usuarioId: randomUUID(),
        tenantActivo: null,
        token: "t",
        factor,
      } as any);
      return {
        getHandler: () => handler,
        getClass: () => Rutas,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    };
    const db = { withTenant: () => Promise.reject(new Error("no debe consultar")) } as any;
    const reflector = new Reflector();
    const resultado = (p: Promise<boolean>): Promise<string> =>
      p.then(
        (v) => `pasa:${v}`,
        (e) => `rechaza:${(e as any)?.codigo ?? (e as Error).message}`,
      );
    const sinServicio = new PermisoGuard(reflector, db);
    const falla = new PermisoGuard(reflector, db, { factorExigido: () => Promise.reject(new Error("bd caída")) });
    const noExige = new PermisoGuard(reflector, db, { factorExigido: () => Promise.resolve(false) });
    const salida = {
      sinServicio: await resultado(sinServicio.canActivate(ctx(Rutas.prototype.fuera, "sin_factor"))),
      sinServicioFactorRaro: await resultado(sinServicio.canActivate(ctx(Rutas.prototype.fuera, "VERIFICADO"))),
      falla: (await resultado(falla.canActivate(ctx(Rutas.prototype.fuera, undefined)))).startsWith("rechaza"),
      listaCerrada: await resultado(sinServicio.canActivate(ctx(Rutas.prototype.dentro, "sin_factor"))),
      noExige: await resultado(noExige.canActivate(ctx(Rutas.prototype.fuera, "sin_factor"))),
    };
    expect(salida).toEqual({
      sinServicio: "rechaza:segundo_factor_requerido",
      sinServicioFactorRaro: "rechaza:segundo_factor_requerido",
      falla: true,
      listaCerrada: "pasa:true",
      noExige: "pasa:true",
    });
  });
});

describe("R2 · confirmar desde dos sesiones a la vez (CA-1, U3)", () => {
  it("el mismo código en totp/confirmar desde dos sesiones `sin_factor`: un solo éxito, la otra sesión muere y el secreto es el enrolado", async () => {
    const r = congelarReloj();
    reloj = r;
    const u = await h.crearUsuario();
    const s1 = await entrarSinTotp(h, u);
    const s2 = await entrarSinTotp(h, u);
    const en = await post(s1, "/auth/totp/enrolar", { contrasena: u.contrasena });
    expect(en.status).toBe(200);
    const secreto = new URL(en.body.uri).searchParams.get("secret")!;
    const codigo = r.codigo(secreto);
    const rs = await Promise.all([post(s1, "/auth/totp/confirmar", { codigo }), post(s2, "/auth/totp/confirmar", { codigo })]);
    expect(rs.every((x) => x.status < 500), JSON.stringify(rs.map((x) => x.status))).toBe(true);
    expect(rs.filter(ok)).toHaveLength(1);
    const vivas = (await h.sql("select factor from auth.sesion where usuario_id = $1 and revocada_en is null", [u.id])).map((f: any) => f.factor);
    expect(vivas).toEqual(["verificado"]);
    expect((await filaTotp(h, u.id))?.activo_cifrado).toBeTruthy();
    // El activo es el del URI: login y código del paso siguiente entran (lanza si no).
    const v = await entrarConTotp(h, u, secreto, r);
    expect(v.verificar.status).toBe(200);
  });
});

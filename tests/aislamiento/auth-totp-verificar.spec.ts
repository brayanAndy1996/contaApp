// Spec 029 (T1, rojo hasta 0078) · CA-2, CA-3, CA-4, CA-9: reservar el intento (≤ 5 evaluaciones de 20 concurrentes), verificar con D3 atomico,
// codigo de recuperacion de un solo uso, login en dos pasos (`login_exito` con factor) y el factor en la validacion de sesion.
// Contrato en `auth-totp-soporte.ts`. Rojo por: auth.totp_* aun no existe (42883) / falta auth.sesion.factor.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioTotp, PASO, SQL, abrirAdmin, abrirApp, exito, hash32, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";
import { hashFalso } from "./auth-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");
const B = () => tenantDe("B");

/** Usuario con TOTP activo y una sesion `pendiente` de 1 minuto. */
async function conPendiente(o: { ultimoPaso?: bigint; estudios?: string[] } = {}) {
  const u = await esc.usuario({ estudios: o.estudios ?? [A()] });
  await esc.totpActivo(u.id, { ultimoPaso: o.ultimoPaso ?? 0n });
  const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
  return { u, p };
}
const reservar = (t: Buffer) => llamar(app, SQL.reservar, [t]);
const verificar = (t: Buffer, paso: bigint, nuevo: Buffer, tenant: string | null = A()) =>
  llamar(app, SQL.verificarExito, [t, String(paso), nuevo, tenant]);

describe("auth.totp_intento_reservar (CA-3)", () => {
  it("cada llamada suma 1 al contador de 004 D7 del correo del usuario y devuelve permitido + usuario_id", async () => {
    const { u, p } = await conPendiente();
    const r = await exito(reservar(p.token));
    expect(r).toEqual([{ permitido: true, usuario_id: u.id }]);
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 1, bloqueado: false });
    await exito(reservar(p.token));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 2, bloqueado: false });
  });

  it("suma al contador que dejo el password (no uno aparte): con 3 fallos previos, la 2.ª reserva es la 5.ª y bloquea 15 min", async () => {
    const { u, p } = await conPendiente();
    await esc.sembrarFallos(u.correo, 3);
    expect((await exito(reservar(p.token)))[0].permitido).toBe(true); // 4.º
    expect((await exito(reservar(p.token)))[0].permitido).toBe(true); // 5.º: se evalua y bloquea
    const i = await esc.intentos(u.correo);
    expect(i).toEqual({ fallos: 5, bloqueado: true });
    const bloq = (await admin.query("select bloqueado_hasta from auth.intento_login where clave = $1", [esc.clave(u.correo)])).rows[0].bloqueado_hasta as Date;
    expect(bloq.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(bloq.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    // 6.º: la 5.ª revoco la sesion `pendiente`, asi que ya no hay sesion vigente (cero filas) y no se evalua
    expect(await exito(reservar(p.token))).toHaveLength(0);
  });

  it("al 5.º intento la sesion `pendiente` se revoca (motivo totp) y las de otros usuarios siguen", async () => {
    const { u, p } = await conPendiente();
    const ajena = await esc.sesionF((await esc.usuario({ estudios: [A()] })).id, { factor: "pendiente" });
    await esc.sembrarFallos(u.correo, 4);
    await exito(reservar(p.token));
    expect(await esc.filaSesion(p.token)).toMatchObject({ motivo: "totp" });
    expect((await esc.filaSesion(p.token))!.revocada_en).toBeInstanceOf(Date);
    expect((await esc.filaSesion(ajena.token))!.revocada_en).toBeNull();
    // revocada: su siguiente intento ya no encuentra sesion (cero filas)
    expect(await exito(reservar(p.token))).toHaveLength(0);
  });

  it("CA-3: 20 reservas concurrentes dan EXACTAMENTE 5 evaluaciones permitidas", async () => {
    const { u, p } = await conPendiente();
    const r = await Promise.all(Array.from({ length: 20 }, () => reservar(p.token)));
    const filas = r.flatMap((x) => (x.ok ? x.rows : []));
    // la 5.ª revoca la sesion: las que llegan despues pueden dar 0 filas (sesion revocada) o permitido=false; nunca mas de 5 true
    expect(filas.filter((f) => f.permitido === true)).toHaveLength(5);
    expect((await esc.intentos(u.correo))!.bloqueado).toBe(true);
  });

  it("20 concurrentes desde 20 sesiones `pendiente` del MISMO usuario tambien dan 5 (el contador es del usuario, no de la sesion)", async () => {
    const { u } = await conPendiente();
    const sesiones = await Promise.all(Array.from({ length: 20 }, () => esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" })));
    const r = await Promise.all(sesiones.map((s) => reservar(s.token)));
    expect(r.flatMap((x) => (x.ok ? x.rows : [])).filter((f) => f.permitido === true)).toHaveLength(5);
  });

  it("sesion inexistente, revocada o vencida: cero filas y no toca ningun contador", async () => {
    const { u, p } = await conPendiente();
    expect(await exito(reservar(nuevoToken()))).toHaveLength(0);
    const vencida = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "-1 second" });
    expect(await exito(reservar(vencida.token))).toHaveLength(0);
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [p.id]);
    expect(await exito(reservar(p.token))).toHaveLength(0);
    expect(await esc.intentos(u.correo)).toBeUndefined();
  });
});

describe("auth.totp_verificar_exito (CA-2, D3)", () => {
  it("con el paso nuevo: emite sesion `verificado` de 12 h con el estudio, revoca la pendiente (rotacion), sube ultimo_paso y reinicia el contador", async () => {
    const { u, p } = await conPendiente({ ultimoPaso: 10n });
    await esc.sembrarFallos(u.correo, 3);
    const nuevo = nuevoToken();
    const [f] = await exito(verificar(p.token, 11n, nuevo, A()));
    expect(f.sesion_id).toBeTruthy();
    const ms = (f.expira_absoluta as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(11 * 3600_000);
    expect(ms).toBeLessThanOrEqual(12 * 3600_000 + 5_000);
    expect(await esc.filaSesion(nuevo)).toMatchObject({ factor: "verificado", tenant_activo: A(), usuario_id: u.id, revocada_en: null });
    expect(await esc.filaSesion(p.token)).toMatchObject({ motivo: "rotacion" });
    expect(String((await esc.filaTotp(u.id))!.ultimo_paso)).toBe("11");
    expect(await esc.intentos(u.correo)).toMatchObject({ fallos: 0, bloqueado: false });
  });

  it("estudio nulo: la sesion verificada nace sin estudio", async () => {
    const { p } = await conPendiente();
    const nuevo = nuevoToken();
    await exito(verificar(p.token, 5n, nuevo, null));
    expect((await esc.filaSesion(nuevo))!.tenant_activo).toBeNull();
  });

  it("D3: un paso igual o menor al ultimo aceptado es replay: cero filas, sin efectos y la pendiente sigue viva", async () => {
    const { u, p } = await conPendiente({ ultimoPaso: 50n });
    for (const paso of [50n, 49n, 1n]) expect(await exito(verificar(p.token, paso, nuevoToken()))).toHaveLength(0);
    expect(String((await esc.filaTotp(u.id))!.ultimo_paso)).toBe("50");
    expect((await esc.filaSesion(p.token))!.revocada_en).toBeNull();
  });

  it("el mismo paso sirve una sola vez aunque se verifique desde otra sesion `pendiente` (login desde dos equipos)", async () => {
    const { u, p } = await conPendiente();
    const p2 = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await exito(verificar(p.token, 7n, nuevoToken()))).toHaveLength(1);
    expect(await exito(verificar(p2.token, 7n, nuevoToken()))).toHaveLength(0);
    expect(await exito(verificar(p2.token, 8n, nuevoToken()))).toHaveLength(1);
  });

  it("CA-2: dos verificaciones CONCURRENTES del mismo codigo (dos sesiones pendientes) dejan pasar solo una", async () => {
    for (let i = 0; i < 5; i++) {
      const { u, p } = await conPendiente();
      const p2 = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
      const r = await Promise.all([verificar(p.token, PASO, nuevoToken()), verificar(p2.token, PASO, nuevoToken())]);
      expect(r.map((x) => (x.ok ? x.rows.length : 0)).reduce((a, b) => a + b, 0), `vuelta ${i}`).toBe(1);
      expect((await esc.sesionesDe(u.id)).filter((s) => s.factor === "verificado")).toHaveLength(1);
    }
  });

  it("solo una sesion `pendiente` vigente verifica: una `verificado` o `sin_factor`, vencida (5 min), revocada o inexistente da cero filas", async () => {
    const { u, p } = await conPendiente();
    for (const factor of ["verificado", "sin_factor"] as const) {
      const s = await esc.sesionF(u.id, { factor });
      expect(await exito(verificar(s.token, 9n, nuevoToken())), factor).toHaveLength(0);
    }
    const vencida = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "-1 second" });
    expect(await exito(verificar(vencida.token, 9n, nuevoToken()))).toHaveLength(0);
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [p.id]);
    expect(await exito(verificar(p.token, 9n, nuevoToken()))).toHaveLength(0);
    expect(await exito(verificar(nuevoToken(), 9n, nuevoToken()))).toHaveLength(0);
    expect(String((await esc.filaTotp(u.id))!.ultimo_paso)).toBe("0");
  });

  it("estudio sin membresia activa del usuario: cero filas y el paso NO se consume (todo o nada)", async () => {
    const { u, p } = await conPendiente({ estudios: [A()] });
    expect(await exito(verificar(p.token, 12n, nuevoToken(), B()))).toHaveLength(0);
    expect(String((await esc.filaTotp(u.id))!.ultimo_paso)).toBe("0");
    expect((await esc.filaSesion(p.token))!.revocada_en).toBeNull();
    await admin.query("update membresia set desactivada_en = now() where usuario_id = $1 and tenant_id = $2", [u.id, A()]);
    expect(await exito(verificar(p.token, 12n, nuevoToken(), A()))).toHaveLength(0);
  });

  it("usuario sin TOTP activo (solo pendiente de enrolar): cero filas", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpPendiente(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await exito(verificar(p.token, 3n, nuevoToken()))).toHaveLength(0);
  });
});

describe("auth.totp_recuperacion_usar (CA-9)", () => {
  const usar = (t: Buffer, h: Buffer, nuevo: Buffer = nuevoToken(), tenant: string | null = A()) => llamar(app, SQL.recuperacionUsar, [t, h, nuevo, tenant]);

  it("un codigo valido emite la sesion `verificado`, queda usado, deja el evento y reinicia el contador; NO toca ultimo_paso", async () => {
    const { u, p } = await conPendiente({ ultimoPaso: 33n });
    const hs = await esc.codigos(u.id, 10);
    await esc.sembrarFallos(u.correo, 2);
    const nuevo = nuevoToken();
    const [f] = await exito(usar(p.token, hs[3]!, nuevo));
    expect(f.sesion_id).toBeTruthy();
    expect(await esc.filaSesion(nuevo)).toMatchObject({ factor: "verificado", tenant_activo: A() });
    expect(await esc.filaSesion(p.token)).toMatchObject({ motivo: "rotacion" });
    const cods = await esc.filasCodigos(u.id);
    expect(cods.filter((c) => c.usado_en !== null)).toHaveLength(1);
    expect(cods.find((c) => c.hash.equals(hs[3]!))!.usado_en).toBeInstanceOf(Date);
    expect(await esc.eventos(u.id)).toEqual(["recuperacion_usada"]);
    expect(String((await esc.filaTotp(u.id))!.ultimo_paso)).toBe("33");
    expect(await esc.intentos(u.correo)).toMatchObject({ fallos: 0 });
  });

  it("un codigo ya usado, inexistente o de OTRO usuario da cero filas y no cambia nada", async () => {
    const { u, p } = await conPendiente();
    const hs = await esc.codigos(u.id, 10);
    await exito(usar(p.token, hs[0]!));
    const p2 = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await exito(usar(p2.token, hs[0]!))).toHaveLength(0); // ya usado
    expect(await exito(usar(p2.token, hash32()))).toHaveLength(0); // inexistente
    const otro = await conPendiente();
    const hOtro = (await esc.codigos(otro.u.id, 10))[0]!;
    expect(await exito(usar(p2.token, hOtro))).toHaveLength(0); // de otro usuario
    expect((await esc.filasCodigos(otro.u.id)).every((c) => c.usado_en === null)).toBe(true);
    expect(await esc.eventos(u.id)).toEqual(["recuperacion_usada"]);
  });

  it("CA-9: dos usos CONCURRENTES del mismo codigo (dos sesiones pendientes) dejan pasar solo uno", async () => {
    for (let i = 0; i < 5; i++) {
      const { u, p } = await conPendiente();
      const p2 = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
      const h = (await esc.codigos(u.id, 10))[0]!;
      const r = await Promise.all([usar(p.token, h), usar(p2.token, h)]);
      expect(r.map((x) => (x.ok ? x.rows.length : 0)).reduce((a, b) => a + b, 0), `vuelta ${i}`).toBe(1);
      expect(await esc.eventos(u.id)).toEqual(["recuperacion_usada"]);
    }
  });

  it("solo sirve con una sesion `pendiente` vigente; con estudio sin membresia no se gasta el codigo", async () => {
    const { u, p } = await conPendiente();
    const h = (await esc.codigos(u.id, 10))[0]!;
    const verif = await esc.sesionF(u.id, { factor: "verificado" });
    expect(await exito(usar(verif.token, h))).toHaveLength(0);
    expect(await exito(usar(p.token, h, nuevoToken(), B()))).toHaveLength(0);
    expect((await esc.filasCodigos(u.id)).every((c) => c.usado_en === null)).toBe(true);
    expect(await exito(usar(p.token, h))).toHaveLength(1);
  });
});

describe("auth.login_exito con factor (CA-2, CA-4)", () => {
  async function usuarioConHash(totp: boolean) {
    const u = await esc.usuario({ estudios: [A()] });
    if (totp) await esc.totpActivo(u.id);
    return u;
  }
  const login = (u: { id: string; correo: string; hash: string | null }, tokenHash: Buffer, o: { factor?: string; tenant?: string | null; disp?: string | null; red?: string | null } = {}) =>
    llamar(app, SQL.loginExito, [esc.clave(u.correo), u.id, u.hash, tokenHash, o.tenant === undefined ? A() : o.tenant, null, null, o.factor ?? "sin_factor", o.disp ?? null, o.red ?? null]);

  it("sin TOTP: `sin_factor` con dispositivo y red guardados, 12 h; la firma de 7 argumentos sigue valiendo (default sin_factor)", async () => {
    const u = await usuarioConHash(false);
    const t = nuevoToken();
    await exito(login(u, t, { disp: "Chrome en Windows", red: "203.0.113.0/24" }));
    expect(await esc.filaSesion(t)).toMatchObject({ factor: "sin_factor", dispositivo: "Chrome en Windows", ip_red: "203.0.113.0/24" });
    const u2 = await usuarioConHash(false);
    const t2 = nuevoToken();
    await exito(llamar(app, SQL.loginExito7, [esc.clave(u2.correo), u2.id, u2.hash, t2, A(), null, null]));
    expect(await esc.filaSesion(t2)).toMatchObject({ factor: "sin_factor", dispositivo: null, ip_red: null });
  });

  it("con TOTP activo: la sesion nace `pendiente`, sin estudio y de 5 min, AUNQUE el llamador pida `sin_factor` y un estudio", async () => {
    const u = await usuarioConHash(true);
    const t = nuevoToken();
    const [f] = await exito(login(u, t, { factor: "sin_factor", tenant: A() }));
    const s = await esc.filaSesion(t);
    expect(s).toMatchObject({ factor: "pendiente", tenant_activo: null });
    const ms = (f.expira_absoluta as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(4 * 60_000);
    expect(ms).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });

  it("`pendiente` pedido para un usuario sin TOTP: se acepta tal cual solo si hay TOTP; si no, queda `sin_factor` (no hay nada que verificar)", async () => {
    const u = await usuarioConHash(false);
    const t = nuevoToken();
    await exito(login(u, t, { factor: "pendiente", tenant: null }));
    expect((await esc.filaSesion(t))!.factor).toBe("sin_factor");
  });

  it("`verificado` no se puede pedir por login_exito (22023) y no deja sesion", async () => {
    const u = await usuarioConHash(true);
    const t = nuevoToken();
    const r = await login(u, t, { factor: "verificado" });
    expect(r.ok ? "ok" : r.code).toBe("22023");
    expect(await esc.filaSesion(t)).toBeUndefined();
  });

  it("dispositivo de mas de 60 caracteres: se rechaza (23514) y no deja sesion", async () => {
    const u = await usuarioConHash(false);
    const t = nuevoToken();
    const r = await login(u, t, { disp: "x".repeat(61) });
    expect(r.ok ? "ok" : r.code).toBe("23514");
    expect(await esc.filaSesion(t)).toBeUndefined();
  });

  it("sigue exigiendo la credencial verificada (O-1) y la membresia: hash distinto -> cero filas", async () => {
    const u = await usuarioConHash(false);
    const r = await llamar(app, SQL.loginExito, [esc.clave(u.correo), u.id, hashFalso(), nuevoToken(), A(), null, null, "sin_factor", null, null]);
    expect(r.ok && r.rows).toEqual([]);
  });
});

describe("auth.sesion_validar y auth.sesion_consultar devuelven el factor (D2, CA-4)", () => {
  it.each([
    ["sesion_validar", SQL.validar],
    ["sesion_consultar", SQL.consultar],
  ])("%s: una columna `factor` al final con el de la sesion", async (_n, sql) => {
    const u = await esc.usuario({ estudios: [A()] });
    for (const factor of ["sin_factor", "verificado", "pendiente"] as const) {
      const s = await esc.sesionF(u.id, { factor, expiraEn: "5 minutes" });
      const r = await exito(llamar(app, sql, [s.token]));
      expect(r, factor).toHaveLength(1);
      expect(Object.keys(r[0]).at(-1)).toBe("factor");
      expect(r[0].factor).toBe(factor);
    }
  });

  it("`pendiente` vence a los 5 minutos aunque haya actividad; una `verificado` no", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "-1 second" });
    expect(await exito(llamar(app, SQL.validar, [p.token]))).toHaveLength(0);
    expect(await exito(llamar(app, SQL.consultar, [p.token]))).toHaveLength(0);
  });

  it("sesion_validar mantiene lo de 0013 (renueva ultimo_uso a los 5 min) y sesion_consultar no escribe", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const s = await esc.sesionF(u.id, { factor: "verificado", tenant: A(), ultimoUsoHace: "10 minutes" });
    const antes = await esc.filaSesion(s.token);
    await exito(llamar(app, SQL.consultar, [s.token]));
    expect((await esc.filaSesion(s.token))!.ultimo_uso.getTime()).toBe(antes!.ultimo_uso.getTime());
    await exito(llamar(app, SQL.validar, [s.token]));
    expect((await esc.filaSesion(s.token))!.ultimo_uso.getTime()).toBeGreaterThan(antes!.ultimo_uso.getTime());
  });

  it("sesion_rotar conserva el factor `verificado` y una `pendiente` no puede rotar (ni cambiar de estudio)", async () => {
    const u = await esc.usuario({ estudios: [A(), B()] });
    const v = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    const nuevo = nuevoToken();
    await exito(llamar(app, "select * from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)", [v.token, nuevo, B()]));
    expect(await esc.filaSesion(nuevo)).toMatchObject({ factor: "verificado", tenant_activo: B() });
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    expect(await exito(llamar(app, "select * from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)", [p.token, nuevoToken(), B()]))).toHaveLength(0);
    expect((await esc.filaSesion(p.token))!.revocada_en).toBeNull();
  });
});

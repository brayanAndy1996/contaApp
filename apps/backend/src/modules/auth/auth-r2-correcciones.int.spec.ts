/* eslint-disable @typescript-eslint/no-explicit-any -- filas de auth.sesion sin tipo en pruebas */
// Spec 004 · T18: correcciones de la ronda adversarial 2 (migración 0009_auth_ronda2). Complementa
// `auth-r2b.adv.int.spec.ts` (cerrar-todas y restablecer frente a una rotación retenida) con las otras dos
// vías: el cambio de contraseña del titular mientras la cookie robada rota, y la rotación que llega
// mientras "cerrar todas" está en vuelo (debe perder: no crea una sesión nueva).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirHarness, COOKIE, ipUnica, pausa, seedAuth, type Harness } from "../../../test/soporte.js";
import { generarToken, hashToken } from "./sesion/token.js";

let h: Harness;
const S = seedAuth();
const sujetos: string[] = [];
const ip = (): string => {
  const v = ipUnica();
  sujetos.push(v);
  return v;
};

beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  if (h) {
    await h.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [sujetos]).catch(() => undefined);
    await h.cerrar();
  }
});

/** Ejecuta `fn` en una transacción `withAuth` y la deja abierta hasta `soltar()`. */
async function retenida<T>(fn: (a: any) => Promise<T>) {
  let soltar!: () => void;
  const compuerta = new Promise<void>((r) => (soltar = r));
  let hecho = false;
  let valor: T | undefined;
  const fin = h.dbBackend.withAuth(async (a) => {
    valor = await fn(a);
    hecho = true;
    await compuerta;
    return valor;
  });
  const limite = Date.now() + 5000;
  while (!hecho && Date.now() < limite) await pausa(10);
  expect(hecho, "la operación retenida no llegó a ejecutarse").toBe(true);
  return { soltar, fin, valor: () => valor };
}

/** Espera a que `terminada()` o a que alguna conexión quede esperando un lock (máx. 4 s). */
async function esperarBloqueo(terminada: () => boolean): Promise<void> {
  const limite = Date.now() + 4000;
  while (!terminada() && Date.now() < limite) {
    const [f] = await h.sql<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if ((f?.n ?? 0) > 0) return;
    await pausa(20);
  }
}

describe("T18 · rotación serializada con las revocaciones masivas", () => {
  it("cambiar la contraseña mientras la cookie robada rota revoca también la sesión rotada", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const robada = await h.entrar(u, { ip: ip() });
    const titular = await h.entrar(u, { ip: ip() });

    const nuevo = generarToken();
    const rot = await retenida((a) => a.sesionRotar(hashToken(robada.valor), hashToken(nuevo), S.tenantA));
    expect(rot.valor(), "la rotación retenida emitió sesión").not.toBeNull();
    let terminada = false;
    const cambio = h
      .pedir({
        ruta: "/auth/contrasena",
        cuerpo: { actual: u.contrasena, nueva: `t18-${randomBytes(8).toString("hex")}-Larga` },
        cookie: titular.cookie,
        csrf: titular.csrf,
        ip: ip(),
      })
      .finally(() => (terminada = true));
    await esperarBloqueo(() => terminada);
    rot.soltar();
    await rot.fin;
    expect((await cambio).status, "cambio de contraseña").toBe(204);

    const despues = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${nuevo}`, ip: ip() });
    expect(despues.status, "la cookie rotada durante el cambio de contraseña sigue autenticando").toBe(401);
    // Solo queda viva la sesión nueva del titular (la que emite el propio cambio).
    const vivas = (await h.sesiones(u.id)).filter((s: any) => s.revocada_en === null);
    expect(vivas.length).toBe(1);
  });

  it("una rotación que llega con 'cerrar todas' en vuelo pierde: no emite sesión y la cookie queda muerta", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const robada = await h.entrar(u, { ip: ip() });
    const titular = await h.entrar(u, { ip: ip() });

    const cierre = await retenida((a) => a.sesionesCerrarTodas(hashToken(titular.valor)));
    expect(cierre.valor()).toBe(2);
    const nuevo = generarToken();
    let terminada = false;
    const rotacion = h.dbBackend
      .withAuth((a) => a.sesionRotar(hashToken(robada.valor), hashToken(nuevo), S.tenantB))
      .finally(() => (terminada = true));
    await esperarBloqueo(() => terminada);
    cierre.soltar();
    await cierre.fin;
    expect(await rotacion, "la rotación tras el cierre no debe emitir sesión").toBeNull();

    const despues = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${nuevo}`, ip: ip() });
    expect(despues.status).toBe(401);
    const vivas = (await h.sesiones(u.id)).filter((s: any) => s.revocada_en === null);
    expect(vivas.length).toBe(0);
  });
});

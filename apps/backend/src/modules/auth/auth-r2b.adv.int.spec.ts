/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas adversariales */
// Spec 004 · ronda adversarial 2b (T17b: ataques nuevos contra las correcciones y huecos restantes).
// Solo afirma el comportamiento seguro esperado; si una prueba falla es un hallazgo (tasks.md, T17b).
// Usuarios, IPs y sujetos únicos por ejecución; limpia sus filas de limite_tasa (el harness, el resto).
import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearApp } from "../../app.js";
import {
  abrirHarness,
  capturarLogs,
  claveCorreo,
  COOKIE,
  CorreoMemoria,
  crearHasherEspia,
  ipUnica,
  ORIGEN,
  pausa,
  seedAuth,
  type Harness,
} from "../../../test/soporte.js";
import { generarToken, hashToken } from "./sesion/token.js";

let h: Harness;
const S = seedAuth();
const sujetos: string[] = [];
const ip = (): string => {
  const v = ipUnica();
  sujetos.push(v);
  return v;
};
const NUEVA = `r2b-${randomBytes(8).toString("hex")}-Larga`;

beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  if (h) {
    await h.sql("delete from auth.limite_tasa where sujeto = any($1::text[])", [sujetos]).catch(() => undefined);
    await h.cerrar();
  }
});

/**
 * Abre por la vía real (`withAuth` -> `auth.sesion_rotar`, lo que hace POST /auth/estudio) una rotación
 * y deja su transacción abierta hasta `soltar()`: ensancha de forma determinista la ventana de carrera
 * entre la rotación y otra operación que revoca "todas las sesiones del usuario".
 */
async function rotacionRetenida(tokenViejo: string, tenant: string) {
  const nuevo = generarToken();
  let soltar!: () => void;
  const compuerta = new Promise<void>((r) => (soltar = r));
  let rotada = false;
  const fin = h.dbBackend.withAuth(async (a) => {
    const e = await a.sesionRotar(hashToken(tokenViejo), hashToken(nuevo), tenant);
    rotada = true;
    await compuerta;
    return e;
  });
  const limite = Date.now() + 5000;
  while (!rotada && Date.now() < limite) await pausa(10);
  expect(rotada, "la rotación retenida no llegó a ejecutarse").toBe(true);
  return { nuevo, soltar, fin };
}

/** Espera a que la petición termine o quede esperando un lock de PostgreSQL (máx. 4 s). */
async function esperarBloqueoO(terminada: () => boolean): Promise<void> {
  const limite = Date.now() + 4000;
  while (!terminada() && Date.now() < limite) {
    const [f] = await h.sql<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if ((f?.n ?? 0) > 0) return;
    await pausa(20);
  }
}

describe("T17b · ronda adversarial 2b", () => {
  it("R2b-01 cerrar-todas concurrente con un cambio de estudio de otra sesión no deja viva la sesión rotada (P2, CA-5)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA, S.tenantB] });
    const robada = await h.entrar(u, { ip: ip() });
    const titular = await h.entrar(u, { ip: ip() });

    const rot = await rotacionRetenida(robada.valor, S.tenantA);
    let terminada = false;
    const cierre = h
      .pedir({ ruta: "/auth/sesiones/cerrar-todas", cuerpo: {}, cookie: titular.cookie, csrf: titular.csrf, ip: ip() })
      .finally(() => (terminada = true));
    await esperarBloqueoO(() => terminada);
    rot.soltar();
    await rot.fin;
    const ct = await cierre;
    expect(ct.status, "cerrar-todas").toBe(204);

    // Tras "cerrar todas mis sesiones" ninguna sesión del usuario puede seguir valiendo.
    const despues = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${rot.nuevo}`, ip: ip() });
    const vivas = (await h.sesiones(u.id)).filter((s: any) => s.revocada_en === null);
    expect.soft(vivas.length, "sesiones sin revocar tras cerrar-todas").toBe(0);
    expect(despues.status, "la cookie rotada durante cerrar-todas sigue autenticando").toBe(401);
  });

  it("R2b-02 restablecer concurrente con un cambio de estudio de la cookie robada revoca también la sesión rotada (CA-6)", async () => {
    const u = await h.crearUsuario({ estudios: [S.tenantA] });
    sujetos.push(claveCorreo(u.correo).toString("hex"));
    const robada = await h.entrar(u, { ip: ip() });
    const pedido = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo: u.correo }, ip: ip() });
    expect(pedido.status).toBe(202);
    await h.correo.esperar(u.correo, 1);
    const token = h.correo.tokenDe(u.correo);

    const rot = await rotacionRetenida(robada.valor, S.tenantA);
    let terminada = false;
    const restab = h
      .pedir({ ruta: "/auth/recuperar/restablecer", cuerpo: { token, contrasena: NUEVA }, ip: ip() })
      .finally(() => (terminada = true));
    await esperarBloqueoO(() => terminada);
    rot.soltar();
    await rot.fin;
    const r = await restab;
    expect(r.status, "restablecer").toBe(204);

    const despues = await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${rot.nuevo}`, ip: ip() });
    const vivas = (await h.sesiones(u.id)).filter((s: any) => s.revocada_en === null);
    expect.soft(vivas.length, "sesiones sin revocar tras restablecer").toBe(0);
    expect(despues.status, "la cookie robada sobrevive al restablecimiento rotando a la vez").toBe(401);
  });

  it("R2b-03 con la BD caída falla cerrado: 500 genérico, sin cookie, sin URL ni contraseña en respuesta o logs", async () => {
    const canario = `CanarioBD${randomBytes(6).toString("hex")}`;
    const url = `postgresql://contapp_app:${canario}@127.0.0.1:1/contapp_r2b`;
    const app = await crearApp({
      correo: new CorreoMemoria(),
      hasher: await crearHasherEspia(),
      env: { ...process.env, DATABASE_URL: url },
    });
    const srv = app.getHttpServer();
    try {
      const cookieFalsa = `${COOKIE}=${generarToken()}`;
      const { resultado, logs } = await capturarLogs(async () => [
        await request(srv).post("/auth/login").set("Origin", ORIGEN).send({ correo: "x@t004.contapp.test", contrasena: canario }),
        await request(srv).get("/auth/sesion").set("Cookie", cookieFalsa),
        await request(srv).get("/auth/estudios").set("Cookie", cookieFalsa),
        await request(srv).post("/auth/estudio").set("Origin", ORIGEN).set("Cookie", cookieFalsa).send({ tenantId: S.tenantA }),
        await request(srv).post("/auth/recuperar").set("Origin", ORIGEN).send({ correo: "x@t004.contapp.test" }),
        await request(srv).post("/auth/recuperar/restablecer").set("Origin", ORIGEN).send({ token: generarToken(), contrasena: NUEVA }),
      ]);
      for (const r of resultado) {
        const ruta = `${r.req.method} ${r.req.path}`;
        expect.soft(r.status >= 500 || r.status === 401 || r.status === 403, `${ruta} no falla cerrado (${r.status})`).toBe(true);
        expect.soft(r.status < 200 || r.status >= 300, `${ruta} responde 2xx con la BD caída`).toBe(true);
        expect.soft(r.headers["set-cookie"] ?? [], `${ruta} emite cookie`).toEqual([]);
        if (r.status >= 500) expect.soft(r.body, `${ruta} cuerpo`).toEqual({ codigo: "error_interno" });
        const texto = `${r.text}\n${JSON.stringify(r.headers)}`;
        for (const fuga of [canario, "127.0.0.1:1", "ECONNREFUSED", "contapp_r2b", "postgresql://"]) {
          expect.soft(texto, `${ruta} filtra ${fuga}`).not.toContain(fuga);
        }
      }
      for (const fuga of [canario, "contapp_r2b", "postgresql://"]) {
        expect(logs, `los logs filtran ${fuga}`).not.toContain(fuga);
      }
    } finally {
      await app.close();
    }
  });

  it("R2b-04 correo de recuperación: enlace solo a APP_ORIGIN aunque Host/X-Forwarded-Host sean hostiles, sin inyección de cabeceras y sin token en logs", async () => {
    const u = await h.crearUsuario();
    sujetos.push(claveCorreo(u.correo).toString("hex"));
    const antes = h.correo.enviados.length;

    // Inyección de cabeceras SMTP por el campo correo: se rechaza y no sale ningún correo.
    for (const correo of [`${u.correo}\r\nBcc: espia@evil.example`, `${u.correo}\nSubject: x`, `${u.correo},espia@evil.example`]) {
      const r = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo }, ip: ip() });
      expect.soft([400, 202], `recuperar con ${JSON.stringify(correo)}`).toContain(r.status);
    }
    await pausa(200);
    expect(h.correo.enviados.length, "un correo con cabeceras inyectadas generó envíos").toBe(antes);

    const { logs } = await capturarLogs(async () => {
      const r = await h.pedir({
        ruta: "/auth/recuperar",
        cuerpo: { correo: `  ${u.correo.toUpperCase()} ` },
        ip: ip(),
        cabeceras: { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
      });
      expect(r.status).toBe(202);
      await h.correo.esperar(u.correo, 1);
      await pausa(50);
    });
    const nuevos = h.correo.enviados.slice(antes);
    expect(nuevos.length, "correos enviados").toBe(1);
    const m = nuevos[0]!;
    expect(m.para).toBe(u.correo);
    for (const campo of [m.para, m.asunto]) expect(campo).not.toMatch(/[\r\n,;]/);
    const enlaces = m.texto.match(/[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? [];
    expect(enlaces.length, "enlaces en el correo").toBe(1);
    expect(enlaces[0]!.startsWith(`${ORIGEN}/recuperar/nueva#t=`), "el enlace no apunta a APP_ORIGIN").toBe(true);
    expect(m.texto).not.toContain("evil.example");
    expect(m.texto).not.toMatch(/<[a-z!/]/i); // texto plano, sin HTML
    const token = h.correo.tokenDe(u.correo);
    expect(logs, "el token de recuperación aparece en los logs").not.toContain(token);
  });
});

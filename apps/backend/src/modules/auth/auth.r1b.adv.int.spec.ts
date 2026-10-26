/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas adversariales */
// Spec 004 · ronda adversarial 1b (escenarios nuevos, caja blanca). Solo afirma el comportamiento seguro
// esperado; si una prueba falla es un hallazgo (ver tasks.md, sección T15b). Cada prueba usa IPs, correos y
// usuarios únicos por ejecución y limpia sus filas (limite_tasa por sujeto; el harness borra el resto).
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearApp } from "../../app.js";
import {
  abrirHarness,
  COOKIE,
  CorreoMemoria,
  claveCorreo,
  cookieSesion,
  crearHasherEspia,
  ipUnica,
  mediana,
  ORIGEN,
  seedAuth,
  type Harness,
  type SesionPrueba,
} from "../../../test/soporte.js";

let h: Harness;
const sujetos: string[] = []; // sujetos de auth.limite_tasa creados por estas pruebas
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

/** Petición HTTP cruda: cabeceras repetidas y dirección local de origen (para IPs de socket únicas). */
function crudo(o: {
  puerto: number;
  ruta: string;
  metodo?: string;
  cabeceras?: [string, string][];
  cuerpo?: string;
  desde?: string;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const planas: string[] = ["Host", `127.0.0.1:${o.puerto}`];
    for (const [k, v] of o.cabeceras ?? []) planas.push(k, v);
    if (o.cuerpo !== undefined) planas.push("Content-Length", String(Buffer.byteLength(o.cuerpo)));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: o.puerto,
        path: o.ruta,
        method: o.metodo ?? (o.cuerpo === undefined ? "GET" : "POST"),
        headers: planas as unknown as http.OutgoingHttpHeaders,
        localAddress: o.desde,
      },
      (res) => {
        const trozos: Buffer[] = [];
        res.on("data", (c: Buffer) => trozos.push(c));
        res.on("end", () => {
          const texto = Buffer.concat(trozos).toString("utf8");
          let body: any = {};
          try {
            body = texto ? JSON.parse(texto) : {};
          } catch {
            body = { crudo: texto };
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (o.cuerpo !== undefined) req.write(o.cuerpo);
    req.end();
  });
}
const puertoDe = (app: INestApplication): number => (app.getHttpServer().address() as { port: number }).port;
const csrfDe = async (cookie: string): Promise<string> => (await h.pedir({ ruta: "/auth/sesion", cookie })).body.csrf;

describe("r1b · límite por IP con X-Forwarded-For falsificado (D7)", () => {
  it("desde un salto no confiable, X-Forwarded-For rotado no evade el límite: el 21.º intento por socket da 429", async () => {
    // TRUST_PROXY sin loopback: el cliente (127.0.0.N) no es un proxy de confianza y su XFF no debe contar.
    const app = await crearApp({
      correo: new CorreoMemoria(),
      hasher: await crearHasherEspia(),
      env: { ...process.env, TRUST_PROXY: "192.0.2.1" },
    });
    await app.listen(0, "127.0.0.1");
    const desde = `127.0.${1 + (randomBytes(1)[0] ?? 0) % 250}.${2 + (randomBytes(1)[0] ?? 0) % 250}`;
    sujetos.push(desde);
    await h.sql("delete from auth.limite_tasa where tipo = 'login_ip' and sujeto = $1", [desde]);
    try {
      const estados: number[] = [];
      for (let i = 0; i < 21; i++) {
        const r = await crudo({
          puerto: puertoDe(app),
          desde,
          ruta: "/auth/login",
          cabeceras: [
            ["Content-Type", "application/json"],
            ["Origin", ORIGEN],
            ["X-Forwarded-For", `198.51.100.${i + 1}`],
          ],
          cuerpo: JSON.stringify({ correo: h.correoInexistente(), contrasena: "Contrasena-cualquiera-1" }),
        });
        estados.push(r.status);
      }
      expect(estados.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(estados[20]).toBe(429);
      const filas = await h.sql("select sujeto from auth.limite_tasa where tipo = 'login_ip' and sujeto like '198.51.100.%'");
      expect(filas).toEqual([]); // el XFF forjado no llegó a ser sujeto
    } finally {
      await app.close();
    }
  });
});

describe("r1b · cabeceras hostiles: cookies y X-Estudio", () => {
  it("cookie duplicada en dos cabeceras, entre comillas o con prefijo en otra caja no autentica; X-Estudio en mayúsculas o duplicado no pasa", async () => {
    const A = seedAuth().tenantA;
    const u = await h.crearUsuario({ estudios: [A] });
    const s = await h.entrar(u, { ip: ip() });
    const puerto = puertoDe(h.app);
    const get = (ruta: string, cabeceras: [string, string][]) => crudo({ puerto, ruta, cabeceras });

    expect((await get("/auth/sesion", [["Cookie", s.cookie]])).status).toBe(200); // control
    const variantes: [string, [string, string][]][] = [
      ["dos cabeceras Cookie", [["Cookie", s.cookie], ["Cookie", s.cookie]]],
      ["valor entre comillas", [["Cookie", `${COOKIE}="${s.valor}"`]]],
      ["prefijo __HOST- en mayúsculas", [["Cookie", `__HOST-contapp_sid=${s.valor}`]]],
      ["prefijo __Secure-", [["Cookie", `__Secure-contapp_sid=${s.valor}`]]],
      ["valor con basura detrás", [["Cookie", `${COOKIE}=${s.valor},x=1`]]],
      ["valor codificado", [["Cookie", `${COOKIE}=%${s.valor.charCodeAt(0).toString(16).toUpperCase()}${s.valor.slice(1)}`]]],
    ];
    for (const [nombre, cab] of variantes) {
      const r = await get("/auth/sesion", cab);
      expect.soft(r.status, nombre).toBe(401);
    }

    const conEstudio = (x: string[]) =>
      get("/estudio/actual", [["Cookie", s.cookie], ...x.map((v) => ["X-Estudio", v] as [string, string])]);
    expect((await conEstudio([A])).status).toBe(200); // control
    expect.soft((await conEstudio([A.toUpperCase()])).status, "X-Estudio en mayúsculas").toBe(409);
    expect.soft((await conEstudio([A, seedAuth().tenantB])).status, "X-Estudio duplicado").toBe(409);
    expect.soft((await conEstudio([])).status, "X-Estudio ausente").toBe(409);
  });
});

describe("r1b · carreras sobre la misma sesión (D4)", () => {
  it("6 cambios de estudio simultáneos con la misma cookie: uno solo gana y queda una sola sesión viva", async () => {
    const { tenantA: A, tenantB: B } = seedAuth();
    const u = await h.crearUsuario({ estudios: [A, B] });
    const s = await h.entrar(u, { ip: ip() });
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId: i % 2 ? A : B }, cookie: s.cookie, csrf: s.csrf }),
      ),
    );
    const ganadoras = rs.filter((r) => r.status === 200);
    expect(ganadoras).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) {
      expect(cookieSesion(r)?.valor ?? "").toBe(""); // los perdedores no emiten token
    }
    const vivas = (await h.sesiones(u.id)).filter((f) => f.revocada_en === null);
    expect(vivas).toHaveLength(1);
    const nueva = cookieSesion(ganadoras[0]!)!;
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: `${COOKIE}=${nueva.valor}` })).status).toBe(200);
    expect((await h.pedir({ ruta: "/auth/sesion", cookie: s.cookie })).status).toBe(401);
  });

  it("cambiar la contraseña 5 veces seguidas con la actual correcta no bloquea la cuenta (un éxito reinicia, CA-3)", async () => {
    const u = await h.crearUsuario();
    let ses: Pick<SesionPrueba, "cookie" | "csrf"> = await h.entrar(u, { ip: ip() });
    let actual = u.contrasena;
    for (let i = 0; i < 5; i++) {
      const nueva = `Frase-adv-r1b-${i}-${randomBytes(4).toString("hex")}`;
      const r = await h.pedir({ ruta: "/auth/contrasena", cuerpo: { actual, nueva }, cookie: ses.cookie, csrf: ses.csrf });
      expect(r.status, `cambio ${i + 1}`).toBe(204);
      const c = cookieSesion(r)!;
      const cookie = `${COOKIE}=${c.valor}`;
      ses = { cookie, csrf: await csrfDe(cookie) };
      actual = nueva;
    }
    const l = await h.login(u.correo, actual, { ip: ip() });
    const [fila] = await h.sql("select fallos, bloqueado_hasta is not null as bloqueada from auth.intento_login where clave = $1", [claveCorreo(u.correo)]);
    expect(l.status, `intento_login tras 5 cambios: ${JSON.stringify(fila)}`).toBe(200);
  });
});

describe("r1b · DoS de Argon2 sin autenticar (D1, D7)", () => {
  it("restablecer con tokens inexistentes desde una IP no permite calcular Argon2 sin límite", async () => {
    const desde = ip();
    const antes = h.hasher.calculos;
    const estados: number[] = [];
    for (let i = 0; i < 25; i++) {
      const token = randomBytes(32).toString("base64url");
      const r = await h.pedir({
        ruta: "/auth/recuperar/restablecer",
        cuerpo: { token, contrasena: `Frase-adv-r1b-dos-${i}-larga` },
        ip: desde,
      });
      estados.push(r.status);
    }
    const calculos = h.hasher.calculos - antes;
    // Seguro: no se calcula Argon2 para un token que no existe, o la IP queda limitada (429).
    expect(calculos === 0 || estados.includes(429), `${calculos} cálculos Argon2 en 25 peticiones; estados ${[...new Set(estados)].join(",")}`).toBe(true);
  });
});

describe("r1b · cuerpos hostiles (16 kB, JSON profundo, __proto__, charset)", () => {
  it("no contamina prototipos, rechaza sin 500 y sin eco, y respeta el límite exacto de 16 kB", async () => {
    const login = (crudoJson: string) => h.pedir({ ruta: "/auth/login", crudo: crudoJson, ip: ip() });
    const soloCodigo = (b: any) => expect.soft(Object.keys(b ?? {}), "cuerpo solo {codigo}").toEqual(["codigo"]);

    const proto = await login('{"__proto__":{"correo":"x@y.z","contrasena":"y","r1bContaminado":1}}');
    expect.soft(proto.status, "__proto__").toBe(400);
    const ctor = await login('{"constructor":{"prototype":{"r1bContaminado":1}},"correo":1}');
    expect.soft(ctor.status, "constructor.prototype").toBe(400);
    expect(({} as any).r1bContaminado).toBeUndefined();
    expect((Object.prototype as any).correo).toBeUndefined();

    const n = 7000;
    const profundo = await login(`{"correo":${"[".repeat(n)}${"]".repeat(n)},"contrasena":"x"}`);
    expect.soft(profundo.status, "JSON profundo").toBe(400);
    soloCodigo(profundo.body);

    const base = JSON.stringify({ correo: h.correoInexistente(), contrasena: "Contrasena-cualquiera-1", r: "" });
    const relleno = (bytes: number) => base.replace('"r":""', `"r":"${"a".repeat(bytes - Buffer.byteLength(base))}"`);
    const justo = await login(relleno(16 * 1024));
    expect.soft(justo.status, "16384 B exactos").toBe(401);
    const pasado = await login(relleno(16 * 1024 + 1));
    expect.soft(pasado.status, "16385 B").toBe(413);
    expect.soft(pasado.body).toEqual({ codigo: "solicitud_demasiado_grande" });

    // Errores del analizador que no son 400/413 (charset o codificación no soportados): 4xx con {codigo}, no 500.
    const analizador = (cab: [string, string][]) =>
      crudo({
        puerto: puertoDe(h.app),
        ruta: "/auth/login",
        cabeceras: [["Origin", ORIGEN], ["X-Forwarded-For", ip()], ...cab],
        cuerpo: '{"correo":"a@b.c","contrasena":"x"}',
      });
    const charset = await analizador([["Content-Type", "application/json; charset=latin1"]]);
    expect.soft(charset.status, "charset no soportado").toBeLessThan(500);
    soloCodigo(charset.body);
    const codif = await analizador([["Content-Type", "application/json"], ["Content-Encoding", "compress"]]);
    expect.soft(codif.status, "Content-Encoding no soportado").toBeLessThan(500);

    // El servidor sigue sano.
    expect((await h.login(h.correoInexistente(), "Contrasena-cualquiera-1", { ip: ip() })).status).toBe(401);
  });
});

describe("r1b · tiempos de la recuperación (CA-8)", () => {
  it("solicitar recuperación tarda lo mismo con correo existente o inexistente (medianas intercaladas)", async () => {
    const N = 30;
    const phc = await h.hasher.calcular("Frase-adv-r1b-tiempos-1");
    const usuarios = [];
    for (let i = 0; i < N; i++) usuarios.push(await h.crearUsuario({ hash: phc }));
    const pedir = async (correo: string) => {
      sujetos.push(claveCorreo(correo).toString("hex"));
      const r = await h.pedir({ ruta: "/auth/recuperar", cuerpo: { correo }, ip: ip() });
      expect(r.status).toBe(202);
      return r.ms;
    };
    for (let i = 0; i < 5; i++) await pedir(h.correoInexistente()); // calentamiento
    const existe: number[] = [];
    const noExiste: number[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 2) {
        existe.push(await pedir(usuarios[i]!.correo));
        noExiste.push(await pedir(h.correoInexistente()));
      } else {
        noExiste.push(await pedir(h.correoInexistente()));
        existe.push(await pedir(usuarios[i]!.correo));
      }
    }
    const [me, mn] = [mediana(existe), mediana(noExiste)];
    expect(Math.abs(me - mn), `mediana existe ${me.toFixed(1)} ms, no existe ${mn.toFixed(1)} ms`).toBeLessThanOrEqual(
      Math.max(5, 0.1 * mn),
    );
  });
});

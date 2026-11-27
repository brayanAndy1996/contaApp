import { afterEach, describe, expect, it } from "vitest";
import { iniciarServidorSireFalso, type ServidorSireFalso } from "./servidor-sire-falso.js";

// Prueba del servidor falso (spec 041, T3). Solo 127.0.0.1; nada duerme: la retención se controla con una promesa.
let abiertos: ServidorSireFalso[] = [];
async function nuevo(): Promise<ServidorSireFalso> {
  const s = await iniciarServidorSireFalso();
  abiertos.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(abiertos.map((s) => s.cerrar()));
  abiertos = [];
});

describe("servidor-sire-falso", () => {
  it("escucha solo en 127.0.0.1 con puerto efímero", async () => {
    const s = await nuevo();
    expect(s.origen).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("sirve json con estado y cabeceras, y registra la petición (query, cabeceras en minúsculas)", async () => {
    const s = await nuevo();
    s.guionar("GET", "/a/b", { estado: 201, json: { ok: true }, cabeceras: { "x-prueba": "1" } });
    const r = await fetch(`${s.origen}/a/b?x=1&y=dos%20tres`, { headers: { Authorization: "Bearer T" } });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-prueba")).toBe("1");
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ ok: true });
    expect(s.peticiones).toHaveLength(1);
    const p = s.peticiones[0]!;
    expect(p).toMatchObject({ n: 1, metodo: "GET", ruta: "/a/b", queryCruda: "x=1&y=dos%20tres", formulario: null });
    expect(p.query).toEqual({ x: "1", y: "dos tres" });
    expect(p.cabeceras["authorization"]).toBe("Bearer T");
  });

  it("decodifica el formulario x-www-form-urlencoded y conserva la barra final de la ruta", async () => {
    const s = await nuevo();
    s.guionar("POST", "/v1/token/", { json: { access_token: "t" } });
    await fetch(`${s.origen}/v1/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: "20100000001USER" }),
    });
    const p = s.peticionesDe("POST", "/v1/token/")[0]!;
    expect(p.formulario).toEqual({ grant_type: "password", username: "20100000001USER" });
    expect(p.cuerpo).toBe("grant_type=password&username=20100000001USER");
    // sin la barra final es otra ruta: sin guion
    const r = await fetch(`${s.origen}/v1/token`, { method: "POST" });
    expect(r.status).toBe(501);
  });

  it("consume las respuestas en orden y repite la última; admite funciones", async () => {
    const s = await nuevo();
    s.guionar(
      "GET",
      "/c",
      { estado: 500 },
      (p) => ({ estado: 200, texto: `n=${p.n}` }),
      { estado: 429 },
    );
    const estados: number[] = [];
    const cuerpos: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${s.origen}/c`);
      estados.push(r.status);
      cuerpos.push(await r.text());
    }
    expect(estados).toEqual([500, 200, 429, 429]);
    expect(cuerpos[1]).toBe("n=2");
  });

  it("guionar de nuevo la misma ruta reemplaza el guion; reiniciar vacía todo", async () => {
    const s = await nuevo();
    s.guionar("GET", "/d", { estado: 200 });
    s.guionar("GET", "/d", { estado: 202 });
    expect((await fetch(`${s.origen}/d`)).status).toBe(202);
    s.reiniciar();
    expect(s.peticiones).toHaveLength(0);
    expect((await fetch(`${s.origen}/d`)).status).toBe(501);
  });

  it("acepta una RegExp como ruta; peticionesDe filtra por método y ruta", async () => {
    const s = await nuevo();
    s.guionar("GET", /^\/rce\/[0-9]{6}\/x$/, { texto: "ok" });
    expect(await (await fetch(`${s.origen}/rce/202610/x`)).text()).toBe("ok");
    await fetch(`${s.origen}/rce/202611/x`);
    expect(s.peticionesDe("GET", /^\/rce\//)).toHaveLength(2);
    expect(s.peticionesDe("POST", /^\/rce\//)).toHaveLength(0);
    expect(s.peticionesDe("GET", "/rce/202610/x")).toHaveLength(1);
  });

  it("una ruta sin guion responde 501 y queda en sinGuion", async () => {
    const s = await nuevo();
    const r = await fetch(`${s.origen}/nada`);
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: "sin_guion" });
    expect(s.sinGuion.map((p) => p.ruta)).toEqual(["/nada"]);
  });

  it("sirve bytes tal cual (ZIP) y no sigue redirecciones por su cuenta", async () => {
    const s = await nuevo();
    const otro = await nuevo();
    otro.guionar("GET", "/destino", { texto: "no debía llegar" });
    s.guionar("GET", "/bin", { bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff]) });
    s.guionar("GET", "/salto", { estado: 302, cabeceras: { location: `${otro.origen}/destino` } });
    const b = new Uint8Array(await (await fetch(`${s.origen}/bin`)).arrayBuffer());
    expect(Array.from(b)).toEqual([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const r = await fetch(`${s.origen}/salto`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${otro.origen}/destino`);
    expect(otro.peticiones).toHaveLength(0);
  });

  it("repetirBytes genera el cuerpo al vuelo; sinContentLength quita el encabezado", async () => {
    const s = await nuevo();
    s.guionar("GET", "/g", { repetirBytes: { byte: 0x41, total: 200_000 } });
    s.guionar("GET", "/h", { repetirBytes: { byte: 0x42, total: 10 }, sinContentLength: true });
    const g = await fetch(`${s.origen}/g`);
    expect(g.headers.get("content-length")).toBe("200000");
    expect((await g.arrayBuffer()).byteLength).toBe(200_000);
    const h = await fetch(`${s.origen}/h`);
    expect(h.headers.get("content-length")).toBeNull();
    expect(await h.text()).toBe("BBBBBBBBBB");
  });

  it("hasta retiene la respuesta sin dormir: no sale hasta que la promesa se cumple", async () => {
    const s = await nuevo();
    let liberar!: () => void;
    const puerta = new Promise<void>((r) => (liberar = r));
    s.guionar("GET", "/lenta", { texto: "lista", hasta: puerta });
    let terminada = false;
    const pendiente = fetch(`${s.origen}/lenta`).then(async (r) => {
      const t = await r.text();
      terminada = true;
      return t;
    });
    while (s.peticiones.length === 0) await new Promise<void>((r) => setImmediate(r));
    expect(terminada).toBe(false);
    liberar();
    expect(await pendiente).toBe("lista");
  });

  it("cortar destruye el socket (el cliente ve un error de red) y colgar se corta al cerrar", async () => {
    const s = await nuevo();
    s.guionar("GET", "/corta", { cortar: true });
    s.guionar("GET", "/cuelga", { colgar: true });
    await expect(fetch(`${s.origen}/corta`)).rejects.toThrow();
    const colgada = fetch(`${s.origen}/cuelga`);
    const resultado = expect(colgada).rejects.toThrow();
    while (s.peticionesDe("GET", "/cuelga").length === 0) await new Promise<void>((r) => setImmediate(r));
    await s.cerrar();
    await resultado;
  });

  it("guionar sin respuestas lanza", async () => {
    const s = await nuevo();
    expect(() => s.guionar("GET", "/x")).toThrow();
  });
});

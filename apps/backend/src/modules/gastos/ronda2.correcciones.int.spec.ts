/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Spec 027 · T19 (rojo; correcciones de la ronda adversarial 2, HTTP y BD). Decisiones del usuario 2026-11-23, una prueba por cada una:
//  H-027-2-1  la propia en la OTRA forma de una global activa se rechaza (409 `palabra_existente`, CA420 en SQL), también al aprender
//             (`omitidas`); una global desactivada por el estudio no bloquea. La MISMA forma de una global sigue reemplazándola (201).
//  H-027-2-3  se mantiene el plural en ambos sentidos y se agregan FRASES DE EXCEPCIÓN a las palabras cuyo singular/plural es otra palabra
//             («medias» → «MEDIA PULGADA», «lentes» → «LENTE DE CAMARA»): la propuesta de «Aprender» las trae (cuando aplican) y el guardado
//             las recibe. La lista concreta la propone T20 y la revisa un contador del equipo; aquí solo los dos casos conocidos.
//             CONTRATO que fija T19 (T20/T20b lo implementan, el arquitecto puede renombrar):
//               GET …/aprender/:compraId -> 200 `{terminos: string[], excepciones?: {[termino]: string[]}}` (`excepciones` solo si algún término
//                 la tiene, solo con los términos de `terminos`, de 1 a 5 frases de 1 a 3 palabras ya normalizadas);
//               POST …/aprender/:compraId `{terminos: {termino, categoria, excepciones?: string[]}[]}` (mismas reglas que `excepciones` de
//                 POST /palabras: ≤ 5 frases de 1 a 3 palabras, se normalizan) -> la propia aprendida las guarda (`gnd_aprender` en 0072).
//  H-027-2-8  «Volver a evaluar» con un trabajo EN COLA se comparte (CA-12); con uno EJECUTÁNDOSE se encola uno NUEVO que corre al terminar.
//             Hoy el dedupe de 008 (índice único por `tenant_id, clave_dedupe` con `en_cola` o `ejecutando`) lo absorbe: T20 lo cambia para 027.
// No repite T16 (`plural.int.spec.ts`), T18 (`ronda2.adv.int.spec.ts`: el caso feliz de H-027-2-8) ni T6 (`reevaluar.int.spec.ts`).
import { DiccionarioGlosas } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  base,
  compraConXml,
  GLOSA_XML,
  PERIODO,
  RUTA_GASTOS,
  rutaAprender,
  rutaPalabras,
  rutaReevaluar,
  type Actor,
  type BancoGastos,
  type Estudio,
  type OpcionesCompraXml,
} from "../../../test/soporte-gastos.js";
import { prepararStorage, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoGastos;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoGastos();
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

interface Banco {
  est: Estudio;
  contador: Actor;
  admin: Actor;
}
const abrir = async (): Promise<Banco> => {
  const est = await v.estudio();
  const p = v.b.c.p.b;
  return { est, contador: await p.miembro(est.tenantId, "contador"), admin: await p.miembro(est.tenantId, "admin") };
};
const compra = async (b: Banco, glosa: string, o: { excluir?: boolean } & Omit<OpcionesCompraXml, "cambios"> = {}) => {
  const { excluir = true, ...resto } = o;
  const x = await compraConXml(v, b.est, b.contador, { ...resto, cambios: [[GLOSA_XML[resto.xml ?? "5070"], glosa]] });
  if (excluir) {
    const r = await v.llamar(b.contador, "POST", `${base(x.c.id)}/${x.id}/excluir`, { versionBase: 1 });
    expect(r.status, r.text).toBe(200);
  }
  return x;
};
type Compra = Awaited<ReturnType<typeof compra>>;
const proponer = (a: Actor, x: Compra) => v.http(a, "GET", rutaAprender(x.c.id, PERIODO, x.id));
const aprender = (a: Actor, x: Compra, terminos: { termino: string; categoria?: string; excepciones?: string[] }[]) =>
  v.http(a, "POST", rutaAprender(x.c.id, PERIODO, x.id), {
    terminos: terminos.map(({ categoria, ...t }) => ({ ...t, categoria: categoria ?? "entretenimiento" })),
  });
const propiaDe = async (b: Banco, palabra: string) => (await v.propiasBd(b.est.tenantId)).find((p: any) => p.palabra === palabra);

describe("T19 · H-027-2-1 (decisión 2026-11-23): la otra forma de una global activa se rechaza al agregar y se omite al aprender", () => {
  it("POST /palabras con la otra forma de una global (con otra grafía también): 409 palabra_existente y no se guarda ni se audita nada", async () => {
    const b = await abrir();
    const antes = await v.fotoGastos(b.est.tenantId);
    for (const palabra of ["zapatillas", "Zapatillas", "ZAPATOS", "pantalones", "Perfumes"]) {
      const r = await v.http(b.admin, "POST", rutaPalabras(), { palabra, categoria: "entretenimiento", excepciones: [] });
      expect(r.status, `${palabra}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "palabra_existente" });
    }
    expect(await v.fotoGastos(b.est.tenantId)).toEqual(antes);
  });

  it("si el estudio desactiva la global, su otra forma se agrega (201); otro estudio, con la global activa, sigue recibiendo 409", async () => {
    const b = await abrir();
    const otro = await abrir();
    await v.desactivarGlobalBd(b.est.tenantId, "zapatilla", b.admin.id);
    const r = await v.http(b.admin, "POST", rutaPalabras(), { palabra: "zapatillas", categoria: "entretenimiento" });
    expect(r.status, r.text).toBe(201);
    const ajeno = await v.http(otro.admin, "POST", rutaPalabras(), { palabra: "zapatillas", categoria: "entretenimiento" });
    expect(ajeno.status, ajeno.text).toBe(409);
    expect(ajeno.body).toEqual({ codigo: "palabra_existente" });
  });

  it("regresión: la MISMA forma de una global se agrega y la reemplaza (201) y sin raíces ni prefijos («perfum», «polonia») se agrega", async () => {
    const b = await abrir();
    for (const palabra of ["zapatilla", "perfum", "polonia"]) {
      const r = await v.http(b.admin, "POST", rutaPalabras(), { palabra, categoria: "entretenimiento" });
      expect(r.status, `${palabra}: ${r.text}`).toBe(201);
    }
  });

  it("aprender: la otra forma de una global (en los dos sentidos) va a omitidas; si el estudio la desactiva, se guarda", async () => {
    const b = await abrir();
    const x = await compra(b, "PANTALONES ZAPATO ALFOMBRA");
    const r = await aprender(b.contador, x, [{ termino: "pantalones", categoria: "calzado-ropa" }, { termino: "zapatos", categoria: "calzado-ropa" }, { termino: "alfombra" }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["alfombra"], omitidas: ["pantalones", "zapatos"] });
    await v.desactivarGlobalBd(b.est.tenantId, "pantalon", b.admin.id);
    const otra = await aprender(b.contador, x, [{ termino: "pantalones", categoria: "calzado-ropa" }]);
    expect(otra.body).toEqual({ guardadas: ["pantalones"], omitidas: [] });
  });
});

describe("T19 · H-027-2-3 (decisión 2026-11-23): «Aprender» propone frases de excepción para las palabras cuyo singular o plural es otra palabra", () => {
  const dic = (palabra: string, categoria: string, excepciones: string[]) =>
    DiccionarioGlosas.desde([{ categoria, palabras: [palabra], excepciones }]);
  const marca = (d: DiccionarioGlosas, glosa: string): boolean => d.coincidenciasPorItem([glosa]).length > 0;
  const FRASE = /^[a-z0-9]+( [a-z0-9]+){0,2}$/;

  it("la propuesta de «MEDIAS LENTES AUDIFONOS» trae `excepciones` solo para «medias» y «lentes», de 1 a 5 frases válidas, y con ellas el singular de la otra palabra no marca", async () => {
    const b = await abrir();
    const x = await compra(b, "MEDIAS LENTES AUDIFONOS T-M");
    const r = await proponer(b.contador, x);
    expect(r.status, r.text).toBe(200);
    expect(r.body.terminos).toEqual(["medias", "lentes", "audifonos"]);
    const ex: Record<string, string[]> = r.body.excepciones;
    expect(Object.keys(ex ?? {}).sort(), "solo los términos que lo necesitan").toEqual(["lentes", "medias"]);
    for (const t of ["medias", "lentes"]) {
      expect(ex[t]!.length).toBeGreaterThanOrEqual(1);
      expect(ex[t]!.length).toBeLessThanOrEqual(5);
      for (const f of ex[t]!) expect(f, `${t}: «${f}»`).toMatch(FRASE);
    }
    // Los dos casos conocidos: «media pulgada» (ferretería) y «lente de cámara» (fotografía) dejan de marcar; el consumo personal sigue marcando.
    const medias = dic("medias", "calzado-ropa", ex.medias!);
    expect(marca(medias, "CODO PVC MEDIA PULGADA")).toBe(false);
    expect(marca(medias, "MEDIAS DEPORTIVAS T-M")).toBe(true);
    expect(marca(medias, "MEDIA DEPORTIVA T-M")).toBe(true);
    const lentes = dic("lentes", "cuidado-personal", ex.lentes!);
    expect(marca(lentes, "LENTE DE CAMARA FOTOGRAFICA")).toBe(false);
    expect(marca(lentes, "LENTES DE SOL POLARIZADOS")).toBe(true);
  });

  it("sin términos que lo necesiten, `excepciones` no aparece (la forma de la respuesta de siempre) y una compra sin «medias» ni «lentes» tampoco las trae", async () => {
    const b = await abrir();
    const x = await compra(b, "AUDIFONOS BLUETOOTH JBL");
    const r = await proponer(b.contador, x);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ terminos: ["audifonos", "bluetooth", "jbl"] });
  });

  it("también cuando la glosa trae la otra forma («MEDIA», «LENTE»): el término propuesto sigue llevando sus excepciones", async () => {
    const b = await abrir();
    const x = await compra(b, "MEDIA LENTE");
    const r = await proponer(b.contador, x);
    expect(r.status, r.text).toBe(200);
    expect(r.body.terminos).toEqual(["media", "lente"]);
    expect(Object.keys(r.body.excepciones ?? {}).sort()).toEqual(["lente", "media"]);
  });

  it("de punta a punta: aprender «medias» y «lentes» con las excepciones propuestas las guarda y la siguiente compra con «MEDIA PULGADA» o «LENTE DE CAMARA» no se marca, la de «MEDIAS» sí", async () => {
    const b = await abrir();
    const origen = await compra(b, "MEDIAS LENTES AUDIFONOS T-M");
    const propuesta = await proponer(b.contador, origen);
    expect(propuesta.status, propuesta.text).toBe(200);
    expect(Object.keys(propuesta.body.excepciones ?? {}).sort()).toEqual(["lentes", "medias"]);
    const ex: Record<string, string[]> = propuesta.body.excepciones;
    const r = await aprender(b.contador, origen, [
      { termino: "medias", categoria: "calzado-ropa", excepciones: ex.medias! },
      { termino: "lentes", categoria: "cuidado-personal", excepciones: ex.lentes! },
      { termino: "audifonos" },
    ]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["medias", "lentes", "audifonos"], omitidas: [] });
    expect((await propiaDe(b, "medias"))?.excepciones).toEqual(ex.medias);
    expect((await propiaDe(b, "lentes"))?.excepciones).toEqual(ex.lentes);
    expect((await propiaDe(b, "audifonos"))?.excepciones).toEqual([]);

    const ferreteria = await compra(b, "CODO PVC MEDIA PULGADA", { xml: "3064", excluir: false });
    const camara = await compra(b, "LENTE DE CAMARA FOTOGRAFICA", { xml: "3064", excluir: false });
    const calcetines = await compra(b, "MEDIAS DEPORTIVAS T-M", { xml: "3064", excluir: false });
    expect(await v.hallazgosGp(ferreteria.id), "«media pulgada» no es consumo personal").toEqual([]);
    expect(await v.hallazgosGp(camara.id), "«lente de cámara» no es consumo personal").toEqual([]);
    const gp = await v.hallazgosGp(calcetines.id);
    expect(gp).toHaveLength(1);
    expect(gp[0].sugerencia).toMatchObject({ tipo: "excluir", palabra: "medias", categoria: "calzado-ropa" });
  });

  it("POST con `excepciones`: se normalizan como las de POST /palabras (mayúsculas, tildes) y se rechazan las que no valen (más de 5, de 4 palabras, no lista) sin guardar nada", async () => {
    const b = await abrir();
    const x = await compra(b, "MEDIAS LENTES AUDIFONOS");
    const antes = await v.fotoGastos(b.est.tenantId);
    for (const excepciones of [
      ["uno", "dos", "tres", "cuatro", "cinco", "seis"],
      ["una frase de cuatro"],
      [""],
      "media pulgada",
      [42],
    ]) {
      const r = await v.http(b.contador, "POST", rutaAprender(x.c.id, PERIODO, x.id), {
        terminos: [{ termino: "medias", categoria: "calzado-ropa", excepciones }],
      });
      expect(r.status, JSON.stringify(excepciones)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await v.fotoGastos(b.est.tenantId)).toEqual(antes);
    const ok = await aprender(b.contador, x, [{ termino: "medias", categoria: "calzado-ropa", excepciones: ["Media PULGADA", "media presión", "MEDIA pulgada"] }]);
    expect(ok.status, ok.text).toBe(200);
    expect((await propiaDe(b, "medias"))?.excepciones).toEqual(["media pulgada", "media presion"]);
  });

  it("un estudio que ya guardó «medias» sin excepciones las conserva tal cual (no se migra el diccionario existente): la propuesta no las vuelve a ofrecer porque «medias» ya no se propone", async () => {
    const b = await abrir();
    await v.sembrarPropia(b.est.tenantId, { palabra: "medias", categoria: "calzado-ropa", creadoPor: b.admin.id });
    const x = await compra(b, "MEDIAS DEPORTIVAS");
    const r = await proponer(b.contador, x);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ terminos: ["deportivas"] });
    expect((await propiaDe(b, "medias"))?.excepciones).toEqual([]);
    const lista = await v.http(b.admin, "GET", RUTA_GASTOS);
    expect(lista.body.propias.find((p: any) => p.palabra === "medias").excepciones).toEqual([]);
  });
});

describe("T19 · H-027-2-8 (decisión 2026-11-23): «Volver a evaluar» comparte el trabajo en cola y encola uno nuevo si el vivo ya se ejecuta", () => {
  const nuevoCliente = async (b: Banco) => v.cliente(b.est, { responsable: b.contador.id });
  const pedir = (b: Banco, c: { id: string }) => v.http(b.contador, "POST", rutaReevaluar(c.id, PERIODO), {});
  const estados = async (b: Banco, c: { id: string }) => (await v.trabajosReevaluar(b.est.tenantId, c.id)).map((t: any) => t.estado);

  it("con el trabajo EN COLA, otros pedidos devuelven el mismo trabajoId y no hay otro trabajo (CA-12 «dos pedidos comparten trabajo»)", async () => {
    const b = await abrir();
    const c = await nuevoCliente(b);
    const a = await pedir(b, c);
    expect(a.status, a.text).toBe(202);
    for (let i = 0; i < 3; i++) {
      const otro = await pedir(b, c);
      expect(otro.status, otro.text).toBe(202);
      expect(otro.body.trabajoId).toBe(a.body.trabajoId);
    }
    expect(await estados(b, c)).toEqual(["en_cola"]);
  });

  it("con el trabajo EJECUTÁNDOSE, el pedido encola uno nuevo (id distinto) y el que se ejecuta no se toca", async () => {
    const b = await abrir();
    const c = await nuevoCliente(b);
    const a = await pedir(b, c);
    await v.b.sql("update job_registro set estado = 'ejecutando', iniciado_en = now() where id = $1", [a.body.trabajoId]);
    const nuevo = await pedir(b, c);
    expect(nuevo.status, nuevo.text).toBe(202);
    expect(nuevo.body.trabajoId).not.toBe(a.body.trabajoId);
    const filas = await v.trabajosReevaluar(b.est.tenantId, c.id);
    expect(filas.map((t: any) => [t.id, t.estado])).toEqual([[a.body.trabajoId, "ejecutando"], [nuevo.body.trabajoId, "en_cola"]]);
    expect(filas[0].iniciado_en).not.toBeNull();
    expect(filas[1].parametros).toEqual({ periodo: PERIODO });
  });

  it("mientras uno se ejecuta, varios pedidos comparten el MISMO trabajo nuevo en cola (nunca más de uno ejecutándose y uno en cola)", async () => {
    const b = await abrir();
    const c = await nuevoCliente(b);
    const a = await pedir(b, c);
    await v.b.sql("update job_registro set estado = 'ejecutando', iniciado_en = now() where id = $1", [a.body.trabajoId]);
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => pedir(b, c)));
    expect(respuestas.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(new Set(respuestas.map((r) => r.body.trabajoId)).size, "un solo trabajo nuevo compartido").toBe(1);
    expect(respuestas[0]!.body.trabajoId).not.toBe(a.body.trabajoId);
    expect((await estados(b, c)).sort()).toEqual(["en_cola", "ejecutando"]);
  });

  it("cuando el que se ejecutaba termina, un pedido nuevo comparte el que sigue en cola; y si ya no queda ninguno vivo, encola otro", async () => {
    const b = await abrir();
    const c = await nuevoCliente(b);
    const a = await pedir(b, c);
    await v.b.sql("update job_registro set estado = 'ejecutando', iniciado_en = now() where id = $1", [a.body.trabajoId]);
    const siguiente = await pedir(b, c);
    await v.b.sql("update job_registro set estado = 'completado', terminado_en = now() where id = $1", [a.body.trabajoId]);
    const compartido = await pedir(b, c);
    expect(compartido.body.trabajoId).toBe(siguiente.body.trabajoId);
    await v.b.sql("update job_registro set estado = 'completado', terminado_en = now() where id = $1", [siguiente.body.trabajoId]);
    const otro = await pedir(b, c);
    expect(otro.status, otro.text).toBe(202);
    expect(otro.body.trabajoId).not.toBe(siguiente.body.trabajoId);
    expect((await estados(b, c)).sort()).toEqual(["completado", "completado", "en_cola"]);
  });

  it("el trabajo ejecutándose de otro cliente no se mezcla: cada cliente tiene su propia cola (regresión)", async () => {
    const b = await abrir();
    const c1 = await nuevoCliente(b);
    const c2 = await nuevoCliente(b);
    const a = await pedir(b, c1);
    await v.b.sql("update job_registro set estado = 'ejecutando', iniciado_en = now() where id = $1", [a.body.trabajoId]);
    const deOtro = await pedir(b, c2);
    expect(deOtro.status, deOtro.text).toBe(202);
    expect(deOtro.body.trabajoId).not.toBe(a.body.trabajoId);
    expect(await estados(b, c1)).toEqual(["ejecutando"]);
    expect(await estados(b, c2)).toEqual(["en_cola"]);
  });
});

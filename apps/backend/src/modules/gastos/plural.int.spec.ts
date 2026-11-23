/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Spec 027 · T16 (rojo; corrección de H-027-1-1, decisión del usuario 2026-11-23): plural simple (+s / +es) en ambos sentidos, de punta a punta por
// HTTP. CA-9: aprender «audifonos» (el término tal como lo propone la glosa) y que la siguiente compra con «AUDÍFONO» (singular) se marque con la
// palabra guardada; «Aprender» no vuelve a proponer ni guarda la otra forma (omitidas) y agregar la otra forma a mano es 409 `palabra_existente`.
// No se migra el diccionario existente. Rutas y formas: las de `aprender.int.spec.ts` y `diccionario.int.spec.ts` (T6).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  base,
  compraConXml,
  GLOSA_XML,
  rutaAprender,
  rutaPalabras,
  PERIODO,
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
const proponer = (a: Actor, x: { c: { id: string }; id: string }) => v.http(a, "GET", rutaAprender(x.c.id, PERIODO, x.id));
const aprender = (a: Actor, x: { c: { id: string }; id: string }, terminos: { termino: string; categoria?: string }[]) =>
  v.http(a, "POST", rutaAprender(x.c.id, PERIODO, x.id), {
    terminos: terminos.map((t) => ({ termino: t.termino, categoria: t.categoria ?? "entretenimiento" })),
  });
const palabrasPropias = async (tenantId: string) => (await v.propiasBd(tenantId)).map((p: any) => p.palabra).sort();

describe("T16 · CA-9 de punta a punta: aprender «audifonos» y luego «AUDÍFONO» marca (H-027-1-1)", () => {
  it("proponer → aprender «audifonos» → una compra posterior con «AUDÍFONO INALÁMBRICO BT» (singular) tiene R-GP con la palabra guardada", async () => {
    const b = await abrir();
    const origen = await compra(b, "AUDIFONOS BLUETOOTH JBL X2 UND 2.00");
    const propuesta = await proponer(b.contador, origen);
    expect(propuesta.status, propuesta.text).toBe(200);
    expect(propuesta.body.terminos).toEqual(["audifonos", "bluetooth", "jbl"]);

    const sin = await compra(b, "AUDÍFONO INALÁMBRICO BT", { xml: "3064", excluir: false });
    expect(await v.hallazgosGp(sin.id), "control: antes de aprender no hay hallazgo").toEqual([]);

    const r = await aprender(b.contador, origen, [{ termino: "audifonos" }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["audifonos"], omitidas: [] });

    const siguiente = await compra(b, "AUDÍFONO INALÁMBRICO BT", { xml: "3064", excluir: false });
    const gp = await v.hallazgosGp(siguiente.id);
    expect(gp).toHaveLength(1);
    expect(gp[0]).toMatchObject({ requiere_confirmacion: true, sugerencia: { tipo: "excluir", palabra: "audifonos", categoria: "entretenimiento" } });
    expect(gp[0].sugerencia.puntaje).toBeGreaterThanOrEqual(3);
  });

  it("y al revés: aprender «audifono» marca la glosa en plural «AUDÍFONOS» (ya funcionaba; queda como regresión)", async () => {
    const b = await abrir();
    const origen = await compra(b, "AUDIFONO BLUETOOTH JBL");
    expect((await aprender(b.contador, origen, [{ termino: "audifono" }])).status).toBe(200);
    const siguiente = await compra(b, "AUDÍFONOS INALÁMBRICOS BT", { xml: "3064", excluir: false });
    const gp = await v.hallazgosGp(siguiente.id);
    expect(gp).toHaveLength(1);
    expect(gp[0].sugerencia).toMatchObject({ palabra: "audifono", categoria: "entretenimiento" });
  });
});

describe("T16 · la propuesta de «Aprender» no ofrece la palabra que ya está en la otra forma (H-027-1-1)", () => {
  it("con la propia «parlantes» y «portatiles» (aprendidas de la glosa en plural): «PARLANTE PORTATIL» ya no propone nada; con una sola, el resto", async () => {
    const b = await abrir();
    const x = await compra(b, "PARLANTE PORTATIL");
    await v.sembrarPropia(b.est.tenantId, { palabra: "parlantes", categoria: "entretenimiento", creadoPor: b.admin.id });
    expect((await proponer(b.contador, x)).body.terminos).toEqual(["portatil"]);
    await v.sembrarPropia(b.est.tenantId, { palabra: "portatiles", categoria: "entretenimiento", creadoPor: b.admin.id });
    const r = await proponer(b.contador, x);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ terminos: [] });
  });

  it("la propia en singular y la glosa en plural tampoco se vuelve a proponer (011), y una propia desactivada no cuenta", async () => {
    const b = await abrir();
    const x = await compra(b, "PARLANTES PORTATILES");
    await v.sembrarPropia(b.est.tenantId, { palabra: "parlante", categoria: "entretenimiento", creadoPor: b.admin.id });
    expect((await proponer(b.contador, x)).body.terminos).toEqual(["portatiles"]);
    await v.sembrarPropia(b.est.tenantId, { palabra: "portatil", categoria: "entretenimiento", creadoPor: b.admin.id, activa: false });
    expect((await proponer(b.contador, x)).body.terminos).toEqual(["portatiles"]);
  });

  it("después de aprender «audifonos», otra compra con «AUDIFONO SONY» propone solo «sony»", async () => {
    const b = await abrir();
    const origen = await compra(b, "AUDIFONOS BLUETOOTH JBL");
    expect((await aprender(b.contador, origen, [{ termino: "audifonos" }])).status).toBe(200);
    const otra = await compra(b, "AUDIFONO SONY");
    expect((await proponer(b.contador, otra)).body.terminos).toEqual(["sony"]);
  });
});

describe("T16 · guardar la otra forma es un duplicado: omitidas, nunca dos formas de la misma palabra (H-027-1-1)", () => {
  it("aprender «audifono» con «audifonos» ya propia: 200 {guardadas: [], omitidas: [«audifono»]} y el diccionario no cambia", async () => {
    const b = await abrir();
    const x = await compra(b, "AUDIFONO SONY");
    await v.sembrarPropia(b.est.tenantId, { palabra: "audifonos", categoria: "juguetes", creadoPor: b.admin.id });
    const antes = (await v.auditoria027(b.est.tenantId)).length;
    const r = await aprender(b.contador, x, [{ termino: "audifono" }, { termino: "sony" }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["sony"], omitidas: ["audifono"] });
    expect(await palabrasPropias(b.est.tenantId)).toEqual(["audifonos", "sony"]);
    expect((await v.propiasBd(b.est.tenantId)).find((p: any) => p.palabra === "audifonos")).toMatchObject({ categoria: "juguetes", origen: "manual" });
    expect((await v.auditoria027(b.est.tenantId)).length - antes, "una sola palabra aprendida (sony)").toBe(1);
  });

  it("una global en la otra forma («ZAPATILLAS» ya la cubre la global «zapatilla»): se omite; si el estudio la desactiva, se guarda", async () => {
    const b = await abrir();
    const x = await compra(b, "ZAPATILLAS URBANAS");
    const r = await aprender(b.contador, x, [{ termino: "zapatillas", categoria: "calzado-ropa" }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: [], omitidas: ["zapatillas"] });
    await v.desactivarGlobalBd(b.est.tenantId, "zapatilla", b.admin.id);
    const otra = await aprender(b.contador, x, [{ termino: "zapatillas", categoria: "calzado-ropa" }]);
    expect(otra.body).toEqual({ guardadas: ["zapatillas"], omitidas: [] });
  });

  it("dos formas en la misma petición: guarda la primera y omite la otra", async () => {
    const b = await abrir();
    const x = await compra(b, "AUDIFONO AUDIFONOS JBL");
    const r = await aprender(b.contador, x, [{ termino: "audifono" }, { termino: "audifonos" }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["audifono"], omitidas: ["audifonos"] });
  });

  it("agregar a mano la otra forma de una propia (activa o desactivada): 409 palabra_existente y nada se guarda ni se audita", async () => {
    const b = await abrir();
    await v.sembrarPropia(b.est.tenantId, { palabra: "audifonos", categoria: "juguetes", creadoPor: b.admin.id });
    await v.sembrarPropia(b.est.tenantId, { palabra: "parlantes", categoria: "juguetes", creadoPor: b.admin.id, activa: false });
    const antes = await v.fotoGastos(b.est.tenantId);
    for (const palabra of ["Audífono", "AUDIFONO", "parlante"]) {
      const r = await v.http(b.admin, "POST", rutaPalabras(), { palabra, categoria: "entretenimiento" });
      expect(r.status, `${palabra}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "palabra_existente" });
    }
    expect(await v.fotoGastos(b.est.tenantId)).toEqual(antes);
  });

  it("sin raíces ni prefijos: «lapices» con «lapiz» propia y «audifonera» con «audifonos» propia sí se agregan", async () => {
    const b = await abrir();
    await v.sembrarPropia(b.est.tenantId, { palabra: "lapiz", categoria: "utiles-escolares", creadoPor: b.admin.id });
    await v.sembrarPropia(b.est.tenantId, { palabra: "audifonos", categoria: "entretenimiento", creadoPor: b.admin.id });
    for (const palabra of ["lapices", "audifonera"]) {
      const r = await v.http(b.admin, "POST", rutaPalabras(), { palabra, categoria: "utiles-escolares" });
      expect(r.status, `${palabra}: ${r.text}`).toBe(201);
    }
  });
});

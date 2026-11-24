// Spec 027 (T6, rojo): «Aprender estas palabras» por HTTP (RF-118, HU-42, R-7, R-5, U-11; CA-9, CA-11, CA-14).
// Contrato (plan 027, «Contratos: HTTP» y `@contapp/shared`: `propuestaAprenderVistaSchema`, `aprenderSchema`, `aprenderRespuestaSchema`):
//  - `GET /clientes/:clienteId/periodos/:periodo/gastos/aprender/:compraId` (`reglas.gestionar`, cliente visible) -> 200 `{terminos}`: hasta 10
//    tokens normalizados de las glosas del XML vigente, sin punto final, sin números, unidades (und, kg…), palabras vacías ni términos ya activos
//    en el diccionario efectivo del estudio, en orden de primera aparición. Compra sin versión vigente excluida 409 `compra_no_excluida`;
//    excluida pero sin XML vigente 409 `compra_sin_xml`; compra que no es del cliente 404 `no_encontrado`.
//  - `POST …/aprender/:compraId {terminos: [{termino, categoria}] (1 a 10)}` -> 200 `{guardadas, omitidas}` (palabras normalizadas): las guarda como
//    propias «aprendidas» (usuario, compra de origen, versión 1, activas); un término que ya existe en el diccionario del estudio se omite y se
//    informa; todo o nada ante un término inválido (400) o el límite de 2.000 (409 `limite_palabras`); mismos 409 que el GET y `cliente_archivado`.
//  - Auditoría (017): una `gnd.palabra_aprendida` por guardada con `{palabra, categoria, compraId}` y el cliente de la compra; nunca glosas.
//  - Nunca deshace ni bloquea la exclusión: la versión vigente de la compra no cambia.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  base,
  CANARIO_GLOSA,
  CATEGORIAS,
  compraConXml,
  cumple,
  GLOSA_XML,
  inexistente,
  LIMITE_PROPIAS,
  NO_ENCONTRADO,
  PERIODO,
  rutaAprender,
  SOLICITUD_INVALIDA,
  type Actor,
  type BancoGastos,
  type Estudio,
  type OpcionesCompraXml,
} from "../../../test/soporte-gastos.js";
import { prepararStorage, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoGastos;
let E: Estudio;
let F: Estudio;
let L: Estudio; // estudio del límite de 2.000
let contador: Actor;
let admin: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoGastos();
  E = await v.estudio();
  F = await v.estudio();
  L = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  admin = await p.miembro(E.tenantId, "admin");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

const GLOSA_AUDIFONOS = "AUDIFONOS BLUETOOTH JBL X2 UND 2.00";
const proponer = (a: Actor, c: { id: string }, compraId: string, periodo = PERIODO) => v.http(a, "GET", rutaAprender(c.id, periodo, compraId));
const aprender = (a: Actor, c: { id: string }, compraId: string, cuerpo: unknown, periodo = PERIODO) =>
  v.http(a, "POST", rutaAprender(c.id, periodo, compraId), cuerpo);
const termino = (t: string, categoria = "entretenimiento") => ({ termino: t, categoria });

/** Una compra de la zapatilla con otra glosa en su XML (con el XML subido y, por omisión, excluida por el contador). */
async function compra(o: { glosa?: string; excluir?: boolean; estudio?: Estudio; actor?: Actor } & Omit<OpcionesCompraXml, "cambios"> = {}) {
  const { glosa = GLOSA_AUDIFONOS, excluir = true, estudio = E, actor = contador, ...resto } = o;
  const x = await compraConXml(v, estudio, actor, { ...resto, cambios: [[GLOSA_XML[resto.xml ?? "5070"], glosa]] });
  if (excluir) {
    const r = await v.llamar(actor, "POST", `${base(x.c.id)}/${x.id}/excluir`, { versionBase: 1 });
    expect(r.status, r.text).toBe(200);
  }
  return x;
}

describe("GET …/gastos/aprender/:compraId (R-7, CA-9)", () => {
  it("CA-9 · «AUDIFONOS BLUETOOTH JBL X2 UND 2.00» propone audifonos, bluetooth y jbl (no x2, und ni 2.00), con la forma de propuestaAprenderVistaSchema", async () => {
    const x = await compra();
    const r = await proponer(contador, x.c, x.id);
    expect(r.status, r.text).toBe(200);
    expect(cumple("propuestaAprenderVistaSchema", r.body), r.text).toBe(true);
    expect(r.body).toEqual({ terminos: ["audifonos", "bluetooth", "jbl"] });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("los términos van normalizados (sin tildes ni mayúsculas ni punto final) y en orden de primera aparición, sin repetir", async () => {
    const x = await compra({ glosa: "Cámara WEB Inalámbrica. Cámara Logitech" });
    const r = await proponer(contador, x.c, x.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.terminos).toEqual(["camara", "web", "inalambrica", "logitech"]);
  });

  it("no propone lo que ya está activo en el diccionario efectivo: una global («zapatillas» → zapatilla) ni una propia; una global desactivada por el estudio sí", async () => {
    const x = await compra({ glosa: "ZAPATILLAS DEPORTIVAS JBL BLUETOOTH" });
    const antes = await proponer(contador, x.c, x.id);
    expect(antes.body.terminos).toEqual(["deportivas", "jbl", "bluetooth"]);
    await v.sembrarPropia(E.tenantId, { palabra: "jbl", creadoPor: admin.id });
    expect((await proponer(contador, x.c, x.id)).body.terminos).toEqual(["deportivas", "bluetooth"]);
    await v.desactivarGlobalBd(E.tenantId, "zapatilla", admin.id);
    expect((await proponer(contador, x.c, x.id)).body.terminos).toEqual(["zapatillas", "deportivas", "bluetooth"]);
    await v.b.sql("delete from gnd_global_desactivada where tenant_id = $1", [E.tenantId]);
    await v.b.sql("delete from gnd_palabra_estudio where tenant_id = $1 and palabra = 'jbl'", [E.tenantId]);
  });

  it("como mucho 10 términos, los primeros en orden de aparición", async () => {
    const x = await compra({ glosa: "alfa bravo charlie delta eco foxtrot golf hotel india juliet kilo lima" });
    const r = await proponer(contador, x.c, x.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.terminos).toEqual(["alfa", "bravo", "charlie", "delta", "eco", "foxtrot", "golf", "hotel", "india", "juliet"]);
  });

  it("una glosa sin nada que proponer (todo palabras vacías, unidades o números): 200 con la lista vacía", async () => {
    const x = await compra({ glosa: "DE LA 12 UND 5.00 KG" });
    const r = await proponer(contador, x.c, x.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ terminos: [] });
  });

  it("una compra que no está excluida: 409 compra_no_excluida (también si se restauró después); el cuerpo es solo el código", async () => {
    const x = await compra({ excluir: false });
    const sinExcluir = await proponer(contador, x.c, x.id);
    expect(sinExcluir.status, sinExcluir.text).toBe(409);
    expect(sinExcluir.body).toEqual({ codigo: "compra_no_excluida" });
    expect((await v.llamar(contador, "POST", `${base(x.c.id)}/${x.id}/excluir`, { versionBase: 1 })).status).toBe(200);
    expect((await v.llamar(contador, "POST", `${base(x.c.id)}/${x.id}/restaurar`, { versionBase: 2 })).status).toBe(200);
    const restaurada = await proponer(contador, x.c, x.id);
    expect(restaurada.status, restaurada.text).toBe(409);
    expect(restaurada.body).toEqual({ codigo: "compra_no_excluida" });
  });

  it("una compra excluida sin XML vigente: 409 compra_sin_xml (CA-11: ni rastro de glosa en el error)", async () => {
    const x = await compra({ sinXml: true });
    const r = await proponer(contador, x.c, x.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "compra_sin_xml" });
    expect(r.text).not.toContain(CANARIO_GLOSA);
  });

  it("una compra de otro cliente del estudio, de otro estudio o inexistente: el mismo 404 no_encontrado", async () => {
    const x = await compra();
    const otro = await compra();
    const deF = await compra({ estudio: F, actor: F.titular });
    expect((await proponer(contador, x.c, x.id)).status, "control: la compra propia y excluida sí se propone").toBe(200);
    const referencia = await proponer(contador, x.c, inexistente());
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const id of [otro.id, deF.id]) {
      const r = await proponer(contador, x.c, id);
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
  });

  it("solo lee: no guarda nada ni audita", async () => {
    const x = await compra();
    const antes = await v.fotoGastos(E.tenantId);
    expect((await proponer(contador, x.c, x.id)).status).toBe(200);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("sin sesión: 401", async () => {
    const x = await compra();
    const r = await v.sinSesion("GET", rutaAprender(x.c.id, PERIODO, x.id));
    expect(r.status, r.text).toBe(401);
  });
});

describe("POST …/gastos/aprender/:compraId (R-7, CA-9, CA-14)", () => {
  it("CA-9 · elegir «audifonos» → entretenimiento: 200 {guardadas, omitidas}; queda propia «aprendida» con el usuario y la compra; la exclusión no cambia", async () => {
    const x = await compra();
    const antes = await v.versiones(x.id);
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("audifonos")] });
    expect(r.status, r.text).toBe(200);
    expect(cumple("aprenderRespuestaSchema", r.body), r.text).toBe(true);
    expect(r.body).toEqual({ guardadas: ["audifonos"], omitidas: [] });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const fila = (await v.propiasBd(E.tenantId)).find((p) => p.palabra === "audifonos");
    expect(fila).toMatchObject({
      categoria: "entretenimiento",
      origen: "aprendida",
      activa: true,
      version: 1,
      creado_por: contador.id,
      compra_origen_id: x.id,
      excepciones: [],
    });
    expect(await v.versiones(x.id)).toEqual(antes); // ni versión nueva ni exclusión deshecha
    await v.b.sql("delete from gnd_palabra_estudio where tenant_id = $1 and palabra = 'audifonos'", [E.tenantId]);
  });

  it("CA-9 · la siguiente evaluación de una compra con «AUDÍFONOS» la marca (R-GP «Posible gasto no deducible» con la palabra aprendida); sin la palabra no", async () => {
    const sin = await compra({ xml: "3064", glosa: "AUDÍFONOS INALÁMBRICOS BT", excluir: false });
    expect(await v.hallazgosGp(sin.id), "control: sin la palabra aprendida no hay hallazgo").toEqual([]);
    const x = await compra();
    expect((await aprender(contador, x.c, x.id, { terminos: [termino("audifonos")] })).status).toBe(200);
    const siguiente = await compra({ xml: "3064", glosa: "AUDÍFONOS INALÁMBRICOS BT", excluir: false });
    const gp = await v.hallazgosGp(siguiente.id);
    expect(gp).toHaveLength(1);
    expect(gp[0]).toMatchObject({ requiere_confirmacion: true, sugerencia: { tipo: "excluir", palabra: "audifonos", categoria: "entretenimiento" } });
    expect(gp[0].sugerencia.puntaje).toBeGreaterThanOrEqual(3);
    await v.b.sql("delete from gnd_palabra_estudio where tenant_id = $1 and palabra = 'audifonos'", [E.tenantId]);
  });

  it("varios términos con su categoría: se guardan todos, normalizados (el contador puede corregir el texto: «JbL» → jbl)", async () => {
    const x = await compra({ glosa: "AUDIFONOS BLUETOOTH JBL" });
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("AUDÍFONOS"), termino("Bluetooth", "juguetes"), termino("JbL", "cuidado-personal")] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["audifonos", "bluetooth", "jbl"], omitidas: [] });
    const filas = await v.propiasBd(E.tenantId);
    expect(filas.filter((p) => ["audifonos", "bluetooth", "jbl"].includes(p.palabra)).map((p) => [p.palabra, p.categoria, p.origen, p.compra_origen_id])).toEqual([
      ["audifonos", "entretenimiento", "aprendida", x.id],
      ["bluetooth", "juguetes", "aprendida", x.id],
      ["jbl", "cuidado-personal", "aprendida", x.id],
    ]);
    await v.b.sql("delete from gnd_palabra_estudio where tenant_id = $1 and palabra = any($2::text[])", [E.tenantId, ["audifonos", "bluetooth", "jbl"]]);
  });

  it("un término que ya existe en el diccionario del estudio se omite y se informa; el resto se guarda", async () => {
    const x = await compra({ glosa: "TECLADO MECANICO GAMER" });
    await v.sembrarPropia(E.tenantId, { palabra: "teclado", categoria: "juguetes", creadoPor: admin.id });
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("teclado"), termino("gamer", "entretenimiento")] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ guardadas: ["gamer"], omitidas: ["teclado"] });
    const filas = await v.propiasBd(E.tenantId);
    expect(filas.find((p) => p.palabra === "teclado")).toMatchObject({ categoria: "juguetes", origen: "manual", version: 1 }); // la existente no cambia
    expect(filas.find((p) => p.palabra === "gamer")).toMatchObject({ origen: "aprendida" });
  });

  it("CA-14 · audita una gnd.palabra_aprendida por guardada, con el usuario, el cliente de la compra y {palabra, categoria, compraId}; nunca glosas (CA-11)", async () => {
    const x = await compra({ glosa: `PANTALLA OLED ${CANARIO_GLOSA}` });
    const antes = (await v.auditoria027(E.tenantId)).length;
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("pantalla"), termino("oled", "juguetes")] });
    expect(r.status, r.text).toBe(200);
    const nuevas = (await v.auditoria027(E.tenantId)).slice(antes);
    expect(nuevas).toHaveLength(2);
    const porPalabra = Object.fromEntries(nuevas.map((f) => [f.datos.palabra, f]));
    for (const f of nuevas) {
      expect(f).toMatchObject({ accion: "gnd.palabra_aprendida", actor_tipo: "usuario", usuario_id: contador.id, cliente_id: x.c.id, entidad: "gnd_palabra_estudio" });
    }
    expect(porPalabra.pantalla.datos).toEqual({ palabra: "pantalla", categoria: "entretenimiento", compraId: x.id });
    expect(porPalabra.oled.datos).toEqual({ palabra: "oled", categoria: "juguetes", compraId: x.id });
    const propias = await v.propiasBd(E.tenantId);
    expect(porPalabra.pantalla.entidad_id).toBe(propias.find((p) => p.palabra === "pantalla").id);
    const texto = JSON.stringify(nuevas.map((f) => f.datos)) + r.text;
    expect(texto).not.toContain(CANARIO_GLOSA);
    expect(texto).not.toContain(x.c.ruc);
  });

  it.each([
    ["un término con espacios", [termino("dos palabras")]],
    ["un término de 2 letras", [termino("ab")]],
    ["un término de 41 letras", [termino("a".repeat(41))]],
    ["un término con signos", [termino("a$b$c")]],
    ["un término con etiqueta", [termino("<script>")]],
    ["una categoría fuera de las 6", [{ termino: "valido", categoria: "personal" }]],
    ["una categoría ausente (es obligatoria)", [{ termino: "valido" }]],
    ["un término ausente", [{ categoria: "juguetes" }]],
    ["ningún término", []],
    ["más de 10 términos", Array.from({ length: 11 }, (_, i) => termino(`termino${i}x`))],
    ["una clave extra en el término", [{ termino: "valido", categoria: "juguetes", palabra: "x" }]],
  ])("CA-9 · %s: 400 solicitud_invalida y no se guarda nada", async (_n, terminos) => {
    const x = await compra();
    const antes = await v.fotoGastos(E.tenantId);
    const r = await aprender(contador, x.c, x.id, { terminos });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("todo o nada: un término inválido junto a uno válido no guarda ninguno", async () => {
    const x = await compra();
    const antes = await v.fotoGastos(E.tenantId);
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("valido"), termino("x")] });
    expect(r.status, r.text).toBe(400);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it.each([
    ["clave extra tenantId", { terminos: [termino("valido")], tenantId: "x" }],
    ["clave extra clienteId", { terminos: [termino("valido")], clienteId: "x" }],
    ["sin terminos", {}],
    ["terminos que no es lista", { terminos: "valido" }],
  ])("400 solicitud_invalida y no se guarda nada: cuerpo con %s", async (_n, cuerpo) => {
    const x = await compra();
    const antes = await v.fotoGastos(E.tenantId);
    const r = await aprender(contador, x.c, x.id, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("acepta cada una de las 6 categorías", async () => {
    const x = await compra({ glosa: "uno dos tres cuatro cinco seis" });
    const r = await aprender(contador, x.c, x.id, { terminos: CATEGORIAS.map((categoria, i) => ({ termino: `cat${i}${categoria.slice(0, 3)}`, categoria })) });
    expect(r.status, r.text).toBe(200);
    expect(r.body.guardadas).toHaveLength(6);
  });

  it("una compra no excluida o excluida sin XML: 409 compra_no_excluida / compra_sin_xml y no se guarda nada", async () => {
    const sinExcluir = await compra({ excluir: false });
    const sinXml = await compra({ sinXml: true });
    const antes = await v.fotoGastos(E.tenantId);
    const a = await aprender(contador, sinExcluir.c, sinExcluir.id, { terminos: [termino("valido")] });
    expect(a.status, a.text).toBe(409);
    expect(a.body).toEqual({ codigo: "compra_no_excluida" });
    const b = await aprender(contador, sinXml.c, sinXml.id, { terminos: [termino("valido")] });
    expect(b.status, b.text).toBe(409);
    expect(b.body).toEqual({ codigo: "compra_sin_xml" });
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("un cliente archivado: 409 cliente_archivado y no se guarda nada", async () => {
    const x = await compra();
    await v.archivar(x.c.id);
    const antes = await v.fotoGastos(E.tenantId);
    const r = await aprender(contador, x.c, x.id, { terminos: [termino("valido")] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("una compra de otro cliente, de otro estudio o inexistente: el mismo 404 no_encontrado y no se guarda nada", async () => {
    const x = await compra();
    const otro = await compra();
    const deF = await compra({ estudio: F, actor: F.titular });
    const antesE = await v.fotoGastos(E.tenantId);
    const antesF = await v.fotoGastos(F.tenantId);
    expect((await proponer(contador, x.c, x.id)).status, "control: la compra propia y excluida sí existe para la ruta").toBe(200);
    const referencia = await aprender(contador, x.c, inexistente(), { terminos: [termino("valido")] });
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const id of [otro.id, deF.id]) {
      const r = await aprender(contador, x.c, id, { terminos: [termino("valido")] });
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antesE);
    expect(await v.fotoGastos(F.tenantId)).toEqual(antesF);
  });

  it("R-4 · con 2.000 propias activas: 409 limite_palabras y no se guarda ninguna (todo o nada)", async () => {
    const actor = L.titular;
    const x = await compra({ estudio: L, actor });
    await v.sembrarPropiasMasivas(L.tenantId, LIMITE_PROPIAS, actor.id);
    const antes = await v.fotoGastos(L.tenantId);
    const r = await aprender(actor, x.c, x.id, { terminos: [termino("audifonos"), termino("bluetooth")] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "limite_palabras" });
    expect(await v.fotoGastos(L.tenantId)).toEqual(antes);
  });

  it("el estudio es el de la sesión: lo aprendido en uno no se ve en otro (CA-7)", async () => {
    const x = await compra();
    expect((await aprender(contador, x.c, x.id, { terminos: [termino("aislado")] })).status).toBe(200);
    expect((await v.propiasBd(F.tenantId)).map((p) => p.palabra)).not.toContain("aislado");
    expect((await v.propiasBd(E.tenantId)).map((p) => p.palabra)).toContain("aislado");
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 027 (T6, rojo): el contexto del estudio llega a las evaluaciones del backend (D-5, R-1, R-3, R-5, R-8, R-11; CA-1, CA-3, CA-4, CA-7, CA-10 a CA-13).
// Contrato (plan 027, «Contratos: HTTP» último párrafo): `apps/backend/src/modules/gastos/contexto.ts` arma el contexto (diccionario efectivo del estudio,
// umbral, categorías del cliente, CIIU de la caché e historial) y lo usan, igual, las acciones de la grilla y la subida del XML (`compras/escritura.ts`),
// la prevalidación de 012 (`archivos/previo.ts`) y la aceptación de R-GP. El backend nunca consulta el CIIU: lo lee de `gnd_ciiu`, que aquí se siembra.
//  - Hallazgo R-GP: `{regla: "R-GP", requiereConfirmacion: true, masiva: false, explicacion: "Posible gasto no deducible", sugerencia: {tipo: "excluir",
//    palabra, categoria, puntaje, senales}}`; señales en orden S1…S7 con sus puntos; solo con XML vigente; solo si `puntaje >= umbral`.
//  - Evaluar no crea versiones ni excluye (R-1): la versión vigente de la compra no cambia.
//  - Aceptar R-GP: sin `confirmar` 422 `requiere_confirmacion`; en masa `no_masiva`; si el contexto cambió desde la evaluación (diccionario o umbral)
//    la sugerencia es obsoleta: 409 `revisar_de_nuevo` (el código HTTP de 011 para «sugerencia obsoleta») y no escribe.
//  - Ninguna explicación, sugerencia ni auditoría lleva texto de la glosa salvo la palabra del diccionario (R-5, CA-11).
// Rojo: hasta T12 el motor de 011 sigue sin puntaje, sin diccionario del estudio y sin contexto en 012.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  base,
  CANARIO_GLOSA,
  compraConXml,
  cumple,
  GLOSA_XML,
  type Actor,
  type BancoGastos,
  type Estudio,
  type OpcionesCompraXml,
} from "../../../test/soporte-gastos.js";
import { prepararStorage, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoGastos;

interface Banco027 {
  est: Estudio;
  contador: Actor;
}
/** Un estudio con su contador: cada grupo de pruebas usa el suyo para que los diccionarios y umbrales no se crucen. */
const abrir = async (): Promise<Banco027> => {
  const est = await v.estudio();
  return { est, contador: await v.b.c.p.b.miembro(est.tenantId, "contador") };
};
let LIMPIO: Banco027; // CA-1: sin diccionario propio, umbral 3
let UMBRAL: Banco027; // CA-10
let DICC_A: Banco027; // CA-7 (estudio A)
let DICC_B: Banco027; // CA-7 (estudio B, sin cambios)
let APAGADA: Banco027; // CA-12: R-GP apagada
let ACEPTAR: Banco027; // CA-3
let PREVIO: Banco027; // CA-13: 012

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoGastos();
  [LIMPIO, UMBRAL, DICC_A, DICC_B, APAGADA, ACEPTAR, PREVIO] = [await abrir(), await abrir(), await abrir(), await abrir(), await abrir(), await abrir(), await abrir()];
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const FERRETERIA = "4752"; // comercio al por menor de ferretería: sección G (D-6: ninguna categoría permitida)
const TIENDA_ROPA = "4771"; // comercio minorista de prendas: rubro de consumo personal (S2)

const compra = (b: Banco027, o: OpcionesCompraXml = {}) => compraConXml(v, b.est, b.contador, o);
/** Una compra de la zapatilla con otra glosa en su XML. */
const conGlosa = (b: Banco027, glosa: string, o: OpcionesCompraXml = {}) => compra(b, { ...o, cambios: [[GLOSA_XML[o.xml ?? "5070"], glosa]] });
const detalle = (b: Banco027, c: Cliente, id: string) => v.llamar(b.contador, "GET", `${base(c.id)}/${id}/detalle`);
const gpDe = (d: any) => (d.body.hallazgos as any[]).find((h) => h.regla === "R-GP");
const puntos = (sug: any) => (sug.senales as any[]).map((s) => [s.codigo, s.puntos]);
const GP = "Posible gasto no deducible";
/** El único hallazgo R-GP de la última evaluación de la compra (falla con un mensaje claro si no hay ninguno). */
const unicoGp = async (compraId: string): Promise<any> => {
  const gp = await v.hallazgosGp(compraId);
  expect(gp, "hallazgos R-GP de la compra").toHaveLength(1);
  return gp[0];
};

describe("CA-1 · la zapatilla de la ferretería: puntaje y señales (HU-41, R-3)", () => {
  it("ferretería (4752) y tienda de ropa (4771) con «ZAPATILLA URBANA T42» un miércoles: R-GP con puntaje 8 y las señales S1 (1 de 1 ítems), S2 y S3 (calzado-ropa)", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    const d = await detalle(LIMPIO, x.c, x.id);
    expect(d.status, d.text).toBe(200);
    const gp = gpDe(d);
    expect(gp, d.text).toBeDefined();
    expect(cumple("hallazgoVistaSchema", gp), JSON.stringify(gp)).toBe(true);
    expect(gp).toMatchObject({ regla: "R-GP", explicacion: GP, requiereConfirmacion: true, masiva: false });
    expect(gp.sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
    expect(puntos(gp.sugerencia)).toEqual([["S1", 3], ["S2", 3], ["S3", 2]]);
    expect(gp.sugerencia.senales[0]).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa", items: { coinciden: 1, total: 1 } });
    expect(gp.sugerencia.senales[2]).toMatchObject({ categoria: "calzado-ropa" });
  });

  it("la versión vigente no cambia al evaluar: sigue la 1, sin versiones nuevas ni exclusión (R-1)", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    expect((await unicoGp(x.id)).sugerencia.puntaje).toBe(8);
    const versiones = await v.versiones(x.id);
    expect(versiones.map((vv) => [vv.n, vv.excluida])).toEqual([[1, false]]);
    expect((await v.compras(x.c.id)).find((c) => c.id === x.id)!.version_vigente).toBe(1);
  });

  it("con un proveedor nuevo (sin historial, S5) el puntaje es 9", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, conocidos: false });
    const gp = (await unicoGp(x.id));
    expect(gp.sugerencia.puntaje).toBe(9);
    expect(puntos(gp.sugerencia)).toEqual([["S1", 3], ["S2", 3], ["S3", 2], ["S5", 1]]);
  });

  it("con calzado-ropa permitida al cliente en su ajuste el puntaje es 6 y no hay S3", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", {
      ciiuCliente: FERRETERIA,
      ciiuProveedor: TIENDA_ROPA,
      categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] },
    });
    const gp = (await unicoGp(x.id));
    expect(gp.sugerencia.puntaje).toBe(6);
    expect(puntos(gp.sugerencia)).toEqual([["S1", 3], ["S2", 3]]);
  });

  it("sin CIIU en la caché solo cuenta la palabra clave: puntaje 3 con S1 y nada más (S2, S3 y S4 en 0), y marca con el umbral por defecto", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42");
    const gp = (await unicoGp(x.id));
    expect(gp.sugerencia.puntaje).toBe(3);
    expect(puntos(gp.sugerencia)).toEqual([["S1", 3]]);
  });

  it("el proveedor sin CIIU («sin dato») no suma S2: la misma compra baja a 5 (S1 y S3)", async () => {
    const x = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: null });
    const gp = (await unicoGp(x.id));
    expect(gp.sugerencia.puntaje).toBe(5);
    expect(puntos(gp.sugerencia)).toEqual([["S1", 3], ["S3", 2]]);
  });
});

describe("CA-4 · coincidencias y excepciones del caso real (R-4)", () => {
  it.each([
    ["ZAPATILLAS URBANAS T-42"],
    ["zapat. dep."],
    ["ZAPATILLAS.38"],
  ])("«%s» puntúa S1 y deja el hallazgo", async (glosa) => {
    const x = await conGlosa(LIMPIO, glosa);
    const gp = await v.hallazgosGp(x.id);
    expect(gp, glosa).toHaveLength(1);
    expect(gp[0].sugerencia).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 3 });
  });

  it("la glosa de F001-5070 de 016 («Par de zapatillas deportivas de prueba (PRUEBA)») puntúa S1 y deja el hallazgo", async () => {
    const x = await compra(LIMPIO);
    const gp = await v.hallazgosGp(x.id);
    expect(gp).toHaveLength(1);
    expect(gp[0].sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 3 });
    expect(puntos(gp[0].sugerencia)).toEqual([["S1", 3]]);
  });

  it.each([["zapata de concreto"], ["zapatilla de seguridad"], ["polo a tierra"], ["zapatilla con punta de acero"]])("«%s» no puntúa: sin hallazgo R-GP", async (glosa) => {
    const x = await conGlosa(LIMPIO, glosa);
    expect(await v.hallazgosGp(x.id), glosa).toEqual([]);
  });
});

describe("CA-10 · el umbral del estudio (R-11)", () => {
  it("con el umbral en 9 la zapatilla de puntaje 8 ya no se marca; en 8 sí; el umbral de otro estudio no cuenta", async () => {
    const opciones: OpcionesCompraXml = { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA };
    await v.sembrarConfig(UMBRAL.est.tenantId, 9, 1);
    const alto = await conGlosa(UMBRAL, "ZAPATILLA URBANA T42", opciones);
    expect(await v.hallazgosGp(alto.id)).toEqual([]);
    await v.sembrarConfig(UMBRAL.est.tenantId, 8, 2);
    const justo = await conGlosa(UMBRAL, "ZAPATILLA URBANA T42", opciones);
    expect((await unicoGp(justo.id)).sugerencia.puntaje).toBe(8);
    const otro = await conGlosa(LIMPIO, "ZAPATILLA URBANA T42", opciones);
    expect(await v.hallazgosGp(otro.id)).toHaveLength(1);
  });

  it("con el umbral en 20 nada se marca por una sola palabra; en 1 se marca todo lo que puntúe 1 o más", async () => {
    await v.sembrarConfig(UMBRAL.est.tenantId, 20, 3);
    const alto = await conGlosa(UMBRAL, "ZAPATILLA URBANA T42");
    expect(await v.hallazgosGp(alto.id)).toEqual([]);
    await v.sembrarConfig(UMBRAL.est.tenantId, 1, 4);
    const bajo = await conGlosa(UMBRAL, "ZAPATILLA URBANA T42", { conocidos: false });
    expect((await unicoGp(bajo.id)).sugerencia.puntaje).toBe(4);
  });
});

describe("CA-7 · el diccionario es del estudio (RF-117, R-6)", () => {
  it("A agrega «audifono» y desactiva «polo»: AUDÍFONOS se marca y POLO no en A; en B (sin cambios) al revés", async () => {
    await v.sembrarPropia(DICC_A.est.tenantId, { palabra: "audifono", categoria: "entretenimiento", creadoPor: DICC_A.est.titular.id });
    await v.desactivarGlobalBd(DICC_A.est.tenantId, "polo", DICC_A.est.titular.id);
    const audifonosA = await conGlosa(DICC_A, "AUDÍFONOS INALÁMBRICOS BT");
    const poloA = await conGlosa(DICC_A, "POLO AZUL TALLA M");
    const audifonosB = await conGlosa(DICC_B, "AUDÍFONOS INALÁMBRICOS BT");
    const poloB = await conGlosa(DICC_B, "POLO AZUL TALLA M");
    expect((await unicoGp(audifonosA.id)).sugerencia).toMatchObject({ palabra: "audifono", categoria: "entretenimiento" });
    expect(await v.hallazgosGp(poloA.id)).toEqual([]);
    expect(await v.hallazgosGp(audifonosB.id)).toEqual([]);
    expect((await unicoGp(poloB.id)).sugerencia).toMatchObject({ palabra: "polo", categoria: "calzado-ropa" });
  });

  it("una palabra propia inactiva no puntúa, y una propia con el texto de una global reemplaza la categoría de la global", async () => {
    await v.sembrarPropia(DICC_A.est.tenantId, { palabra: "mochilita", categoria: "utiles-escolares", creadoPor: DICC_A.est.titular.id, activa: false });
    expect(await v.hallazgosGp((await conGlosa(DICC_A, "MOCHILITA ROJA")).id)).toEqual([]);
    await v.sembrarPropia(DICC_A.est.tenantId, { palabra: "perfume", categoria: "juguetes", creadoPor: DICC_A.est.titular.id });
    const x = await conGlosa(DICC_A, "PERFUME 100ML");
    expect((await unicoGp(x.id)).sugerencia).toMatchObject({ palabra: "perfume", categoria: "juguetes" });
  });
});

describe("CA-11 · sin XML no se evalúa, y la glosa no sale (R-5, U-9)", () => {
  it("sin XML no hay hallazgo R-GP ni puntaje aunque el umbral sea 1 y el proveedor sea de consumo personal", async () => {
    await v.sembrarConfig(UMBRAL.est.tenantId, 1, 5);
    const x = await compra(UMBRAL, { sinXml: true, ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, conocidos: false });
    expect(await v.hallazgosGp(x.id)).toEqual([]);
    const d = await detalle(UMBRAL, x.c, x.id);
    expect(d.status, d.text).toBe(200);
    expect(gpDe(d)).toBeUndefined();
    expect(d.text).not.toContain("Posible gasto no deducible");
  });

  it("una glosa con <script> y un canario: el hallazgo lleva la palabra y las señales de texto fijo, nunca la glosa (CA-11)", async () => {
    const glosa = `&lt;script&gt;alert(1)&lt;/script&gt; ZAPATILLAS ${CANARIO_GLOSA}`;
    const x = await conGlosa(LIMPIO, glosa, { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    const gp = (await unicoGp(x.id));
    expect(gp.sugerencia).toMatchObject({ palabra: "zapatilla" });
    const texto = JSON.stringify(gp);
    expect(texto).not.toContain(CANARIO_GLOSA);
    expect(texto).not.toMatch(/script|alert/i);
    const d = await detalle(LIMPIO, x.c, x.id);
    expect(JSON.stringify(gpDe(d))).not.toContain(CANARIO_GLOSA);
    expect(gpDe(d).explicacion).toBe(GP);
    expect(JSON.stringify((await v.auditoria027(LIMPIO.est.tenantId)).map((f) => f.datos))).not.toContain(CANARIO_GLOSA);
  });
});

describe("CA-12 · R-GP apagada en «Reglas del motor» no evalúa ni puntúa", () => {
  it("con R-GP apagada la zapatilla no deja hallazgo; al encenderla, sí", async () => {
    await v.fijarMotorBd(APAGADA.est.tenantId, "R-GP", false, APAGADA.est.titular.id);
    const apagada = await conGlosa(APAGADA, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    expect(await v.hallazgosGp(apagada.id)).toEqual([]);
    await v.fijarMotorBd(APAGADA.est.tenantId, "R-GP", true, APAGADA.est.titular.id);
    const encendida = await conGlosa(APAGADA, "ZAPATILLA URBANA T42", { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA });
    expect((await unicoGp(encendida.id)).sugerencia.puntaje).toBe(8);
  });
});

describe("CA-13 · una acción de la grilla evalúa con el diccionario del estudio (D-5)", () => {
  it("tras desactivar «zapatilla» en el estudio, clasificar (versión 2) ya no deja R-GP; en un estudio sin cambios, sí", async () => {
    const A = await abrir();
    const B = await abrir();
    const a = await conGlosa(A, "ZAPATILLA URBANA T42");
    const b = await conGlosa(B, "ZAPATILLA URBANA T42");
    expect(await v.hallazgosGp(a.id)).toHaveLength(1);
    await v.desactivarGlobalBd(A.est.tenantId, "zapatilla", A.est.titular.id);
    for (const [banco, x] of [[A, a], [B, b]] as const) {
      const r = await v.llamar(banco.contador, "POST", `${base(x.c.id)}/${x.id}/clasificar`, { versionBase: 1, destino: "DNG" });
      expect(r.status, r.text).toBe(200);
      expect(r.body.fila).toMatchObject({ id: x.id, version: 2 });
    }
    expect(await v.hallazgosGp(a.id)).toEqual([]); // el diccionario del estudio A ya no tiene «zapatilla»
    expect((await unicoGp(b.id)).sugerencia).toMatchObject({ palabra: "zapatilla", puntaje: 3 });
  });

  it("una acción de la grilla con una propia nueva marca la compra con la palabra del estudio (misma evaluación que la descarga)", async () => {
    const A = await abrir();
    const x = await conGlosa(A, "AUDÍFONOS INALÁMBRICOS BT");
    expect(await v.hallazgosGp(x.id)).toEqual([]);
    await v.sembrarPropia(A.est.tenantId, { palabra: "audifonos", categoria: "entretenimiento", creadoPor: A.est.titular.id });
    const r = await v.llamar(A.contador, "POST", `${base(x.c.id)}/${x.id}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect(r.status, r.text).toBe(200);
    expect((await unicoGp(x.id)).sugerencia).toMatchObject({ palabra: "audifonos", categoria: "entretenimiento", puntaje: 3 });
  });
});

describe("CA-3 · aceptar R-GP exige confirmación y re-evalúa con el mismo contexto (R-1, D-5)", () => {
  const aceptar = (x: { c: Cliente; id: string }, o: Record<string, unknown> = {}) =>
    v.llamar(ACEPTAR.contador, "POST", `${base(x.c.id)}/${x.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-GP", confirmar: true, ...o });
  const opciones: OpcionesCompraXml = { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA };

  it("sin confirmar: 422 requiere_confirmacion y no escribe; con confirmar: 200, versión 2 excluida y los montos intactos", async () => {
    const x = await conGlosa(ACEPTAR, "ZAPATILLA URBANA T42", opciones);
    const antes = await v.foto(x.c.id);
    const sin = await aceptar(x, { confirmar: false });
    expect(sin.status, sin.text).toBe(422);
    expect(sin.body).toEqual({ codigo: "requiere_confirmacion" });
    expect(await v.foto(x.c.id)).toEqual(antes);
    const ok = await aceptar(x);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.fila).toMatchObject({ id: x.id, version: 2, excluida: true });
    const vs = await v.versiones(x.id);
    expect(vs.map((vv) => vv.n)).toEqual([1, 2]);
    expect(vs[1]).toMatchObject({ accion: "sugerencia", excluida: true, biDg: vs[0]!.biDg, igvDg: vs[0]!.igvDg, total: vs[0]!.total });
  });

  it("en masa: rechazada como no_masiva y no escribe", async () => {
    const x = await conGlosa(ACEPTAR, "ZAPATILLA URBANA T42", opciones);
    const antes = await v.foto(x.c.id);
    const r = await v.llamar(ACEPTAR.contador, "POST", `${base(x.c.id)}/masivas/aceptar`, { items: [{ compraId: x.id, versionBase: 1 }], regla: "R-GP" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(0);
    expect(r.body.rechazadas).toEqual([{ compraId: x.id, codigo: "no_masiva" }]);
    expect(await v.foto(x.c.id)).toEqual(antes);
  });

  it("si el diccionario cambió desde la evaluación («zapatilla» desactivada): la sugerencia es obsoleta, 409 revisar_de_nuevo y no escribe", async () => {
    const A = await abrir();
    const x = await conGlosa(A, "ZAPATILLA URBANA T42", opciones);
    await v.desactivarGlobalBd(A.est.tenantId, "zapatilla", A.est.titular.id);
    const antes = await v.foto(x.c.id);
    const r = await v.llamar(A.contador, "POST", `${base(x.c.id)}/${x.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-GP", confirmar: true });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(x.c.id)).toEqual(antes);
  });

  it("si el umbral subió por encima del puntaje (8 → 9): obsoleta, 409 revisar_de_nuevo y no escribe", async () => {
    const A = await abrir();
    const x = await conGlosa(A, "ZAPATILLA URBANA T42", opciones);
    expect((await unicoGp(x.id)).sugerencia.puntaje).toBe(8);
    await v.sembrarConfig(A.est.tenantId, 9, 1);
    const antes = await v.foto(x.c.id);
    const r = await v.llamar(A.contador, "POST", `${base(x.c.id)}/${x.id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-GP", confirmar: true });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(x.c.id)).toEqual(antes);
  });

  it("sin XML no hay R-GP que aceptar: 409 revisar_de_nuevo y no escribe", async () => {
    const x = await compra(ACEPTAR, { sinXml: true });
    const antes = await v.foto(x.c.id);
    const r = await aceptar(x);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(x.c.id)).toEqual(antes);
  });

  it("ninguna evaluación, descarga ni subida de XML crea una versión excluida (R-1): todas las compras del fixture siguen en la versión 1", async () => {
    const x = await conGlosa(ACEPTAR, "ZAPATILLA URBANA T42", opciones);
    for (const id of Object.values(x.ids)) expect((await v.versiones(id)).filter((vv) => vv.excluida)).toEqual([]);
  });
});

describe("CA-13 · la prevalidación de 012 usa el diccionario y el contexto del estudio; R-GP solo avisa (D-5)", () => {
  const previo = (c: Cliente) => v.llamar(PREVIO.contador, "GET", `/clientes/${c.id}/periodos/202610/compras/archivos/previo`);
  const avisosGp = (r: any) => (r.body.avisos as any[]).filter((a) => a.codigo === "R-GP");

  it("con el XML de la zapatilla subido, el previo trae el aviso R-GP «Posible gasto no deducible» de F001-5070, sin errores nuevos y apto", async () => {
    const x = await compra(PREVIO, { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, corregido: true });
    const r = await previo(x.c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("previoArchivoSchema", r.body), r.text).toBe(true);
    expect(avisosGp(r)).toEqual([{ filaId: x.id, comprobante: "F001-5070", codigo: "R-GP", explicacion: GP }]);
    expect(r.body.errores).toEqual([]);
    expect(r.body).toMatchObject({ apto: true, generable: true });
  });

  it("el aviso sigue el diccionario del estudio: con «zapatilla» desactivada para el estudio el previo no trae R-GP y el resto no cambia", async () => {
    const A = await abrir();
    // Sin CIIU del proveedor: sin S1 la única señal restante sería S2 (+3), que por sí sola alcanza el umbral 3; así el aviso depende solo de la palabra.
    const x = await compra(A, { ciiuCliente: FERRETERIA, corregido: true });
    const rutaPrevio = `/clientes/${x.c.id}/periodos/202610/compras/archivos/previo`;
    const con = await v.llamar(A.contador, "GET", rutaPrevio);
    expect(avisosGp(con)).toHaveLength(1);
    await v.desactivarGlobalBd(A.est.tenantId, "zapatilla", A.est.titular.id);
    const sin = await v.llamar(A.contador, "GET", rutaPrevio);
    expect(sin.status, sin.text).toBe(200);
    expect(avisosGp(sin)).toEqual([]);
    expect(sin.body.errores).toEqual(con.body.errores);
    expect(sin.body.apto).toBe(con.body.apto);
  });

  it("el aviso sigue el umbral: con el umbral en 9 y puntaje 8 el previo no trae R-GP, y nunca bloquea (apto igual)", async () => {
    const A = await abrir();
    const control = await compra(A, { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, corregido: true });
    const rutaControl = `/clientes/${control.c.id}/periodos/202610/compras/archivos/previo`;
    expect(avisosGp(await v.llamar(A.contador, "GET", rutaControl)), "control: con el umbral por defecto (3) el aviso sí está").toHaveLength(1);
    await v.sembrarConfig(A.est.tenantId, 9, 1);
    const x = await compra(A, { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, corregido: true });
    const r = await v.llamar(A.contador, "GET", `/clientes/${x.c.id}/periodos/202610/compras/archivos/previo`);
    expect(r.status, r.text).toBe(200);
    expect(avisosGp(r)).toEqual([]);
    expect(r.body.apto).toBe(true);
  });

  it("sin XML el previo no trae R-GP (R-5)", async () => {
    const control = await compra(PREVIO, { ciiuCliente: FERRETERIA, ciiuProveedor: TIENDA_ROPA, corregido: true });
    expect(avisosGp(await previo(control.c)), "control: con el XML subido el aviso sí está").toHaveLength(1);
    const x = await compra(PREVIO, { sinXml: true, corregido: true });
    const r = await previo(x.c);
    expect(r.status, r.text).toBe(200);
    expect(avisosGp(r)).toEqual([]);
  });
});

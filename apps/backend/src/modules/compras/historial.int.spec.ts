/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 (T5, rojo): «Según historial» en compras por HTTP (D-1, D-7, P-3, P-6; CA-2, CA-3, CA-8, CA-12, CA-13).
// Contrato (plan 021, «Contratos: HTTP» y «Backend»; formas de `filaCompraVistaSchema`, `detalleCompraSchema` y `listarComprasSchema`):
//  - El listado y el detalle (`GET …/compras` y `GET …/compras/:compraId`, fila vigente) suman `segunHistorial: {reglaId} | null`:
//    `{reglaId}` cuando la versión vigente tiene `accion = historial`, `null` en cualquier otro caso; solo viaja el id de la regla.
//  - El listado suma el filtro `segunHistorial=true|false` (como `alertas` y `proveedorNuevo`; otro valor es 400 `solicitud_invalida`).
//  - Volver a clasificar una fila «Según historial» (una, o en masa con los ids que da el filtro) crea otra versión con el destino
//    elegido y quita la etiqueta; el resumen ve el destino vigente (CA-3). La versión `historial` y la 1 no se tocan (RNF-052).
//  - R-HIS no es hallazgo ni se evalúa fuera de la descarga (plan, «Backend»): corregir, aceptar una sugerencia o clasificar en masa
//    nunca escribe una versión `historial` ni cambia la regla (P-3, CA-12).
//  - Los interruptores del estudio (`PUT /estudio/reglas-motor/:codigo`) llegan a las evaluaciones de aceptar, la masiva y las
//    acciones por fila (`entornoDeReglas`): con la regla apagada su hallazgo no sale en la evaluación siguiente, no se puede aceptar
//    (409 `revisar_de_nuevo`; en masa, rechazada) y los hallazgos ya guardados no se borran (CA-8).
//  - La versión `historial` se audita como `compra.historial` (actor `sistema`, `{compraId, reglaId, periodo}`), sin datos del proveedor.
// Las compras «Según historial» se siembran como las deja el worker (`aplicar_regla_historial`, único camino que la BD admite).
// Rojo: faltan `segunHistorial`, el filtro y las rutas de reglas (T11 y T12), y las tablas de 021 (T9).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoReglas, base, cumple, hallazgoIscSinXml, hallazgoIscXml, montos, PERIODO, rutaReglas, RUTA_MOTOR, type Actor, type BancoReglas, type Estudio } from "../../../test/soporte-reglas.js";
import { bytes, pedirXml, prepararStorage, xmlDe, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoReglas;
let E: Estudio; // reglas del cliente y filas «Según historial»
let G: Estudio; // interruptores del estudio: su propio estudio, para no apagar reglas a las demás pruebas
let contador: Actor;
let asistente: Actor;
let adminG: Actor;
let contadorG: Actor;

const PROV = "20700000011";
const RAZON = "CANARIO RAZON SOCIAL SAC";

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoReglas();
  E = await v.estudio();
  G = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  adminG = await p.miembro(G.tenantId, "admin");
  contadorG = await p.miembro(G.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const listar = (a: Actor, c: Cliente, query = "") => v.llamar(a, "GET", `${base(c.id)}${query}`);
const detalle = (a: Actor, c: Cliente, id: string) => v.llamar(a, "GET", `${base(c.id)}/${id}`);
const resumen = (a: Actor, c: Cliente) => v.llamar(a, "GET", `${base(c.id)}/resumen`);
const post = (a: Actor, c: Cliente, ruta: string, cuerpo: unknown) => v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo);
const masiva = (a: Actor, c: Cliente, cual: string, cuerpo: unknown) => post(a, c, `/masivas/${cual}`, cuerpo);
const filasDe = (r: { body: any }): any[] => r.body.filas as any[];
const idsDe = (r: { body: any }): string[] => filasDe(r).map((f) => f.id);

/** Regla aprendida del proveedor PROV en el cliente (periodo aprendido 202609: la descarga de 202610 la aplica). */
const regla = (c: Cliente, destino: "DG" | "DGNG" | "DNG" = "DNG", o: { docNumero?: string } = {}) =>
  v.sembrarRegla(E.tenantId, c.id, { destino, usuarioId: u(), ...(o.docNumero === undefined ? {} : { docNumero: o.docNumero }) });

/** `n` compras «Según historial» de la regla (F001-1 a F001-n, BI 100.00 + IGV 18.00 en el SIRE) y devuelve sus ids. */
async function segunHistorial(c: Cliente, reglaId: string, n: number, primero = 1): Promise<string[]> {
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: n, usuarioId: u() });
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push(await v.sembrarSegunHistorial(E.tenantId, c.id, reglaId, { serie: "F001", numero: String(primero + i), razonSocial: RAZON, propuestaId, usuarioId: u() }));
  return ids;
}
/** Una compra normal del SIRE (sin versión `historial`) de otro proveedor. */
const normal = (c: Cliente, numero: string, o: { doc?: string; montos?: Parameters<BancoReglas["sembrarCompra"]>[2]["montos"]; hallazgos?: Parameters<BancoReglas["sembrarCompra"]>[2]["hallazgos"] } = {}) =>
  v.sembrarCompra(E.tenantId, c.id, {
    serie: "F002",
    numero,
    doc: o.doc ?? "20700000045",
    usuarioId: u(),
    ...(o.montos === undefined ? {} : { montos: o.montos }),
    ...(o.hallazgos === undefined ? {} : { hallazgos: o.hallazgos }),
  });
const reglaDe = async (a: Actor, c: Cliente, id: string) => ((await v.http(a, "GET", rutaReglas(c.id))).body as any[]).find((x) => x.id === id);
const acciones = async (id: string) => (await v.versiones(id)).map((x) => x.accion);

const EN_DNG = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "100.00", igvDng: "18.00" };

// --- CA-2 · el listado y el detalle ------------------------------------------------------------------------------------------

describe("CA-2 · segunHistorial en el listado y en el detalle de la fila", () => {
  it("cada fila trae segunHistorial: {reglaId} en las de la regla y null en las demás; solo viaja el id", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const [a, b] = await segunHistorial(c, reglaId, 2);
    const otra = await normal(c, "1");
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("listadoComprasSchema", r.body), r.text).toBe(true);
    const por = new Map(filasDe(r).map((f) => [f.id as string, f]));
    for (const f of filasDe(r)) expect("segunHistorial" in f, f.id).toBe(true);
    for (const id of [a!, b!]) {
      expect(por.get(id)!.segunHistorial).toEqual({ reglaId });
      expect(Object.keys(por.get(id)!.segunHistorial)).toEqual(["reglaId"]);
      expect(por.get(id)).toMatchObject({ version: 2, clasificada: true, montos: expect.objectContaining(EN_DNG) });
    }
    expect(por.get(otra)!.segunHistorial).toBeNull();
    expect(por.get(otra)).toMatchObject({ version: 1, clasificada: false });
  });

  it("la fila corregida a mano o la de otro proveedor no se marcan: solo la versión vigente con accion historial cuenta", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const [conEtiqueta, corregida] = await segunHistorial(c, reglaId, 2);
    expect((await post(contador, c, `/${corregida}/clasificar`, { versionBase: 2, destino: "DG" })).status).toBe(200);
    const r = await listar(contador, c);
    const por = new Map(filasDe(r).map((f) => [f.id as string, f]));
    expect(por.get(conEtiqueta!)!.segunHistorial).toEqual({ reglaId });
    expect(por.get(corregida!)!.segunHistorial).toBeNull();
  });

  it("filtro segunHistorial=true deja solo las filas con la etiqueta y =false las demás", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const con = await segunHistorial(c, reglaId, 3);
    const sin = [await normal(c, "1"), await normal(c, "2")];
    const si = await listar(contador, c, "?segunHistorial=true");
    expect(si.status, si.text).toBe(200);
    expect(idsDe(si).sort()).toEqual([...con].sort());
    const no = await listar(contador, c, "?segunHistorial=false");
    expect(no.status, no.text).toBe(200);
    expect(idsDe(no).sort()).toEqual([...sin].sort());
    expect(idsDe(await listar(contador, c)).sort()).toEqual([...con, ...sin].sort());
  });

  it("el filtro se combina con los demás (alertas=false) y con la vista", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const con = await segunHistorial(c, reglaId, 2);
    await normal(c, "1");
    const r = await listar(contador, c, "?segunHistorial=true&alertas=false&vista=con_igv");
    expect(r.status, r.text).toBe(200);
    expect(idsDe(r).sort()).toEqual([...con].sort());
  });

  it.each(["talvez", "1", "TRUE", ""])("segunHistorial=%s es 400 solicitud_invalida", async (valor) => {
    const c = await nuevoCliente();
    const r = await listar(contador, c, `?segunHistorial=${valor}`);
    expect(r.status, r.text).toBe(400);
  });

  it("CA-5 · la etiqueta de un cliente no sale en otro cliente del mismo estudio, aunque el proveedor sea el mismo", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    await segunHistorial(a, await regla(a), 1);
    await v.sembrarCompra(E.tenantId, b.id, { serie: "F001", numero: "1", doc: PROV, usuarioId: u() });
    const r = await listar(contador, b);
    expect(r.status, r.text).toBe(200);
    expect(filasDe(r).map((f) => f.segunHistorial)).toEqual([null]);
    expect(idsDe(await listar(contador, b, "?segunHistorial=true"))).toEqual([]);
  });

  it("el detalle trae segunHistorial en la versión vigente y la versión 2 con accion historial; la 1 sigue como llegó del SIRE", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const [id] = await segunHistorial(c, reglaId, 1);
    const r = await detalle(contador, c, id!);
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleCompraSchema", r.body), r.text).toBe(true);
    expect(r.body.vigente).toMatchObject({ id, version: 2, segunHistorial: { reglaId } });
    expect((r.body.versiones as any[]).map((x) => x.accion)).toEqual(["original", "historial"]);
    expect(r.body.versiones[1]).toMatchObject({ n: 2, clasificada: true, usuarioId: null, operacionId: null });
    expect(r.body.original).toMatchObject({ n: 1, accion: "original", clasificada: false });
    expect(r.body.original.montos).toMatchObject({ biDg: "100.00", igvDg: "18.00", biDng: "0.00", igvDng: "0.00", total: "118.00" });
    const bd = await v.versiones(id!);
    expect(bd[0]).toMatchObject({ n: 1, accion: "original", biDg: "100.00", igvDg: "18.00", biDng: "0.00", usuario_id: null });
    expect(bd[1]).toMatchObject({ n: 2, accion: "historial", ...EN_DNG, usuario_id: null, operacion_id: null });
  });

  it("el detalle de una fila sin versión historial trae segunHistorial null", async () => {
    const c = await nuevoCliente();
    const id = await normal(c, "1");
    const r = await detalle(contador, c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.vigente.segunHistorial).toBeNull();
  });

  it("P-9 · eliminar la regla no quita la etiqueta de las filas ya cargadas: conservan su «Según historial»", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const [id] = await segunHistorial(c, reglaId, 1);
    const baja = await v.http(contador, "DELETE", `${rutaReglas(c.id)}/${reglaId}?versionBase=1`);
    expect(baja.status, baja.text).toBe(204);
    const r = await listar(contador, c);
    expect(filasDe(r).find((f) => f.id === id)!.segunHistorial).toEqual({ reglaId });
    expect((await detalle(contador, c, id!)).body.vigente.segunHistorial).toEqual({ reglaId });
    expect(await acciones(id!)).toEqual(["original", "historial"]);
  });

  it("CA-13 · la auditoría de la versión historial es del sistema, con el id de la regla y sin datos del proveedor ni montos", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c);
    const [id] = await segunHistorial(c, reglaId, 1);
    const aud = (await v.auditoriaDe(E.tenantId, "compra.historial")).filter((a) => a.entidad_id === id || a.datos.compraId === id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ actor_tipo: "sistema", usuario_id: null, cliente_id: c.id });
    expect(aud[0].datos).toEqual({ compraId: id, reglaId, periodo: PERIODO });
    const texto = JSON.stringify(aud[0]);
    expect(texto).not.toContain(PROV);
    expect(texto).not.toContain(RAZON);
    expect(texto).not.toMatch(/\d+\.\d{2}/);
  });
});

// --- CA-3 · volver a clasificar ---------------------------------------------------------------------------------------------

describe("CA-3 · clasificar de nuevo una fila «Según historial» (una o en masa por el filtro)", () => {
  it("una fila: crea la versión 3 con el destino elegido, quita la etiqueta y deja intactas la 1 y la 2", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c, "DNG");
    const [id] = await segunHistorial(c, reglaId, 1);
    const antes = await v.versiones(id!);
    const r = await post(contador, c, `/${id}/clasificar`, { versionBase: 2, destino: "DG" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.fila).toMatchObject({ id, version: 3, clasificada: true, segunHistorial: null });
    expect(r.body.fila.montos).toMatchObject({ biDg: "100.00", igvDg: "18.00", biDng: "0.00", igvDng: "0.00" });
    const despues = await v.versiones(id!);
    expect(despues.map((x) => x.accion)).toEqual(["original", "historial", "clasificar"]);
    expect(despues[0]).toEqual(antes[0]);
    expect(despues[1]).toEqual(antes[1]);
    expect(despues[2]).toMatchObject({ n: 3, usuario_id: contador.id, biDg: "100.00" });
    expect(idsDe(await listar(contador, c, "?segunHistorial=true"))).toEqual([]);
    expect((await detalle(contador, c, id!)).body.vigente.segunHistorial).toBeNull();
  });

  it("clasificar al mismo destino de la regla también quita la etiqueta (el contador la confirma como suya)", async () => {
    const c = await nuevoCliente();
    const [id] = await segunHistorial(c, await regla(c, "DNG"), 1);
    const r = await post(contador, c, `/${id}/clasificar`, { versionBase: 2, destino: "DNG" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.fila).toMatchObject({ version: 3, segunHistorial: null });
    expect(await acciones(id!)).toEqual(["original", "historial", "clasificar"]);
  });

  it("el resumen ve el destino vigente: antes en DNG, después en DG; el original del SIRE no cambia", async () => {
    const c = await nuevoCliente();
    const [id] = await segunHistorial(c, await regla(c, "DNG"), 1);
    const antes = await resumen(contador, c);
    expect(antes.status, antes.text).toBe(200);
    expect(antes.body.casilleros.vigente).toMatchObject({ biDg: "0.00", biDng: "100.00", igvDng: "18.00" });
    expect(antes.body.casilleros.original).toMatchObject({ biDg: "100.00", biDng: "0.00" });
    expect((await post(contador, c, `/${id}/clasificar`, { versionBase: 2, destino: "DG" })).status).toBe(200);
    const despues = await resumen(contador, c);
    expect(despues.body.casilleros.vigente).toMatchObject({ biDg: "100.00", igvDg: "18.00", biDng: "0.00", igvDng: "0.00" });
    expect(despues.body.casilleros.original).toEqual(antes.body.casilleros.original);
  });

  it("en masa por el filtro: las filas con la etiqueta se reclasifican de una vez y la fila normal no se toca", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c, "DNG");
    const con = await segunHistorial(c, reglaId, 4);
    const otra = await normal(c, "1", { montos: { biDg: "100.00", igvDg: "18.00" } });
    const filtro = await listar(contador, c, "?segunHistorial=true");
    expect(idsDe(filtro).sort()).toEqual([...con].sort());
    const items = filasDe(filtro).map((f) => ({ compraId: f.id as string, versionBase: f.version as number }));
    const r = await masiva(contador, c, "clasificar", { items, destino: "DGNG" });
    expect(r.status, r.text).toBe(200);
    expect(cumple("informeMasivaSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ aplicadas: 4, rechazadas: [] });
    expect(idsDe(await listar(contador, c, "?segunHistorial=true"))).toEqual([]);
    for (const id of con) {
      expect(await acciones(id)).toEqual(["original", "historial", "clasificar"]);
      expect((await v.versiones(id)).at(-1)).toMatchObject({ biDgng: "100.00", igvDgng: "18.00", biDng: "0.00" });
    }
    expect(await acciones(otra)).toEqual(["original"]);
    const vigente = (await resumen(contador, c)).body.casilleros.vigente;
    expect(vigente).toMatchObject({ biDgng: "400.00", igvDgng: "72.00", biDng: "0.00", biDg: "100.00" });
  });

  it("en masa con la versión del SIRE (1) en vez de la vigente (2): se rechaza version_obsoleta y no se escribe", async () => {
    const c = await nuevoCliente();
    const [id] = await segunHistorial(c, await regla(c), 1);
    const antes = await v.foto(c.id);
    const r = await masiva(contador, c, "clasificar", { items: [{ compraId: id!, versionBase: 1 }], destino: "DG" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(0);
    expect(r.body.rechazadas).toEqual([{ compraId: id, codigo: "version_obsoleta" }]);
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

// --- CA-12 · corregir una fila «Según historial» (P-3) ----------------------------------------------------------------------

describe("CA-12 · tras corregir, R-HIS no vuelve a sugerir ni a aplicar y la regla queda igual", () => {
  it("corregir la fila no escribe otra versión historial, no cambia la regla ni sus contadores", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c, "DNG");
    const [id] = await segunHistorial(c, reglaId, 1);
    const antes = await reglaDe(contador, c, reglaId);
    expect(antes).toMatchObject({ destino: "DNG", version: 1, activa: true, aplicada: 1, aceptada: 0 });
    expect((await post(contador, c, `/${id}/clasificar`, { versionBase: 2, destino: "DG" })).status).toBe(200);
    // Las acciones siguientes sobre la fila tampoco la devuelven al destino de la regla ni la vuelven a marcar.
    expect((await post(contador, c, `/${id}/excluir`, { versionBase: 3 })).status).toBe(200);
    expect((await post(contador, c, `/${id}/restaurar`, { versionBase: 4 })).status).toBe(200);
    expect(await acciones(id!)).toEqual(["original", "historial", "clasificar", "excluir", "restaurar"]);
    const fila = filasDe(await listar(contador, c)).find((f) => f.id === id)!;
    expect(fila.segunHistorial).toBeNull();
    expect(fila.montos).toMatchObject({ biDg: "100.00", biDng: "0.00" });
    const despues = await reglaDe(contador, c, reglaId);
    expect(despues).toMatchObject({ destino: "DNG", version: 1, activa: true, aplicada: 1, aceptada: 0, actualizadaEn: antes.actualizadaEn });
  });

  it("se ofrece «Recordar» con el destino nuevo: con la versionBase de la regla actualiza el destino (versión 2) y no toca ninguna fila", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c, "DNG");
    const [id] = await segunHistorial(c, reglaId, 1);
    expect((await post(contador, c, `/${id}/clasificar`, { versionBase: 2, destino: "DG" })).status).toBe(200);
    const antes = await v.foto(c.id);
    const r = await v.http(contador, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds: [id], destino: "DG", versionBase: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ id: reglaId, destino: "DG", version: 2 });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("aceptar una sugerencia y la masiva de aceptar sobre filas del proveedor de una regla activa no traen R-HIS: nunca una versión historial ni el destino de la regla", async () => {
    const c = await nuevoCliente();
    const reglaId = await regla(c, "DNG"); // PROV tiene una regla activa en DNG
    const m = montos({ biDg: "500.00" });
    const una = await v.sembrarCompra(E.tenantId, c.id, { serie: "F003", numero: "1", doc: PROV, usuarioId: u(), montos: { biDg: "500.00" }, hallazgos: [hallazgoIscSinXml(m)] });
    const lote = await v.sembrarCompra(E.tenantId, c.id, { serie: "F003", numero: "2", doc: PROV, usuarioId: u(), montos: { biDg: "500.00" }, hallazgos: [hallazgoIscXml(m, "500.00")] });
    const a = await post(contador, c, `/${una}/sugerencias/aceptar`, { versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(a.status, a.text).toBe(200);
    expect(a.body.fila).toMatchObject({ version: 2, segunHistorial: null });
    expect(a.body.fila.montos).toMatchObject({ biDg: "0.00", isc: "500.00", biDng: "0.00", igvDng: "0.00" });
    const b = await masiva(contador, c, "aceptar", { items: [{ compraId: lote, versionBase: 1 }], regla: "R-ISC" });
    expect(b.status, b.text).toBe(200);
    expect(b.body).toMatchObject({ aplicadas: 1, rechazadas: [] });
    for (const id of [una, lote]) {
      expect(await acciones(id)).toEqual(["original", "sugerencia"]);
      expect((await v.versiones(id)).at(-1)).toMatchObject({ biDg: "0.00", isc: "500.00", biDng: "0.00" });
    }
    expect(idsDe(await listar(contador, c, "?segunHistorial=true"))).toEqual([]);
    expect(await reglaDe(contador, c, reglaId)).toMatchObject({ destino: "DNG", version: 1, aplicada: 0, aceptada: 0 });
  });
});

// --- CA-8 · interruptores del estudio en las evaluaciones -----------------------------------------------------------------------

describe("CA-8 · una regla apagada por el estudio no llega a aceptar, a la masiva ni a las acciones por fila", () => {
  const clienteG = () => v.cliente(G, { responsable: contadorG.id });
  const apagar = (codigo: string, activa: boolean) => v.http(adminG, "PUT", `${RUTA_MOTOR}/${codigo}`, { activa });
  const postG = (c: Cliente, ruta: string, cuerpo: unknown) => v.llamar(contadorG, "POST", `${base(c.id)}${ruta}`, cuerpo);
  const subirXml = async (c: Cliente, id: string, nombre: "2056" | "5070") => {
    const r = await pedirXml(v, contadorG, "POST", `${base(c.id)}/${id}/xml`, bytes(xmlDe(nombre, c.ruc)));
    expect(r.status, r.texto).toBe(200);
  };
  const reglasDe = (r: { body: any }): string[] => (r.body.fila.hallazgos as any[]).map((h) => h.regla);

  it("R-GP encendida (control): la evaluación de otra acción sobre la zapatilla la sigue produciendo", async () => {
    const c = await clienteG();
    const ids = await v.sembrarFixture(G.tenantId, c.id, { usuarioId: G.titular.id });
    const id = ids["F001-5070"]!;
    await subirXml(c, id, "5070");
    const clasificar = await postG(c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });
    expect(clasificar.status, clasificar.text).toBe(200);
    expect(reglasDe(clasificar)).toContain("R-GP");
    expect((await v.hallazgosDe(id, 2)).map((h) => h.regla)).toContain("R-GP");
  });

  it("R-GP apagada: la acción siguiente no la evalúa y lo ya guardado se conserva", async () => {
    const c = await clienteG();
    const ids = await v.sembrarFixture(G.tenantId, c.id, { usuarioId: G.titular.id });
    const id = ids["F001-5070"]!;
    await subirXml(c, id, "5070");
    expect((await v.hallazgosDe(id, 1)).map((h) => h.regla)).toContain("R-GP"); // guardado con la regla encendida
    const off = await apagar("R-GP", false);
    expect(off.status, off.text).toBe(200);
    try {
      const clasificar = await postG(c, `/${id}/clasificar`, { versionBase: 1, destino: "DNG" });
      expect(clasificar.status, clasificar.text).toBe(200);
      expect(reglasDe(clasificar)).not.toContain("R-GP");
      expect((await v.hallazgosDe(id, 2)).map((h) => h.regla)).not.toContain("R-GP");
      expect((await v.hallazgosDe(id, 1)).map((h) => h.regla)).toContain("R-GP"); // solo inserción: no se borra lo guardado
    } finally {
      await apagar("R-GP", true);
    }
  });

  it("aceptar una sugerencia con XML: con R-MIX encendida se aplica y apagada es 409 revisar_de_nuevo sin escribir", async () => {
    const encendida = await clienteG();
    const idsOn = await v.sembrarFixture(G.tenantId, encendida.id, { usuarioId: G.titular.id });
    await subirXml(encendida, idsOn["F001-2056"]!, "2056");
    const on = await postG(encendida, `/${idsOn["F001-2056"]!}/sugerencias/aceptar`, { versionBase: 1, regla: "R-MIX" });
    expect(on.status, on.text).toBe(200);

    const apagada = await clienteG();
    const idsOff = await v.sembrarFixture(G.tenantId, apagada.id, { usuarioId: G.titular.id });
    await subirXml(apagada, idsOff["F001-2056"]!, "2056");
    expect((await apagar("R-MIX", false)).status).toBe(200);
    try {
      const antes = await v.foto(apagada.id);
      const off = await postG(apagada, `/${idsOff["F001-2056"]!}/sugerencias/aceptar`, { versionBase: 1, regla: "R-MIX" });
      expect(off.status, off.text).toBe(409);
      expect(off.body).toEqual({ codigo: "revisar_de_nuevo" });
      expect(await v.foto(apagada.id)).toEqual(antes);
    } finally {
      await apagar("R-MIX", true);
    }
  });

  it("la masiva de aceptar: con R-MIX encendida aplica la separación exacta del XML y apagada la rechaza (revisar_de_nuevo) sin escribir", async () => {
    const encendida = await clienteG();
    const idsOn = await v.sembrarFixture(G.tenantId, encendida.id, { usuarioId: G.titular.id });
    await subirXml(encendida, idsOn["F001-2056"]!, "2056");
    const on = await v.llamar(contadorG, "POST", `${base(encendida.id)}/masivas/aceptar`, { items: [{ compraId: idsOn["F001-2056"]!, versionBase: 1 }], regla: "R-MIX" });
    expect(on.status, on.text).toBe(200);
    expect(on.body).toMatchObject({ aplicadas: 1, rechazadas: [] });

    const apagada = await clienteG();
    const idsOff = await v.sembrarFixture(G.tenantId, apagada.id, { usuarioId: G.titular.id });
    const id = idsOff["F001-2056"]!;
    await subirXml(apagada, id, "2056");
    expect((await apagar("R-MIX", false)).status).toBe(200);
    try {
      const antes = await v.foto(apagada.id);
      const off = await v.llamar(contadorG, "POST", `${base(apagada.id)}/masivas/aceptar`, { items: [{ compraId: id, versionBase: 1 }], regla: "R-MIX" });
      expect(off.status, off.text).toBe(200);
      expect(off.body.aplicadas).toBe(0);
      expect(off.body.rechazadas).toEqual([{ compraId: id, codigo: "revisar_de_nuevo" }]);
      expect(await v.foto(apagada.id)).toEqual(antes);
    } finally {
      await apagar("R-MIX", true);
    }
  });

  it("R-ISC apagada: la evaluación de la acción siguiente sobre San Juan no la vuelve a producir; encendida sí", async () => {
    const control = await clienteG();
    const idsOn = await v.sembrarFixture(G.tenantId, control.id, { usuarioId: G.titular.id });
    const on = await postG(control, `/${idsOn["F001-1040"]!}/clasificar`, { versionBase: 1, destino: "DG" });
    expect(on.status, on.text).toBe(200);
    expect(reglasDe(on)).toContain("R-ISC");

    const c = await clienteG();
    const ids = await v.sembrarFixture(G.tenantId, c.id, { usuarioId: G.titular.id });
    const id = ids["F001-1040"]!;
    expect((await apagar("R-ISC", false)).status).toBe(200);
    try {
      const r = await postG(c, `/${id}/clasificar`, { versionBase: 1, destino: "DG" });
      expect(r.status, r.text).toBe(200);
      expect(reglasDe(r)).not.toContain("R-ISC");
      expect((await v.hallazgosDe(id, 1)).map((h) => h.regla)).toContain("R-ISC");
      expect((await v.hallazgosDe(id, 2)).map((h) => h.regla)).not.toContain("R-ISC");
    } finally {
      await apagar("R-ISC", true);
    }
  });
});

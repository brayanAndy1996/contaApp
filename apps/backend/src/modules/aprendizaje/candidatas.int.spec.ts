/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 (T6, rojo): candidatas del historial por HTTP: listar, activar, reemplazar y descartar (D-4 a D-7, D-10, D-11; U-8; CA-3, CA-4, CA-12).
// Contrato (plan 025, «Contratos: HTTP» y «shared»; formas de `candidataVistaSchema`, `activarCandidatasSchema`, `respuestaActivarSchema`,
// `reemplazarCandidataSchema` y `descartarCandidatasSchema` de `@contapp/shared`; semántica de las funciones de 0062 según T4):
//  - `GET …/reglas/candidatas?grupo&cursor&limite` (`reglas.ver`) -> 200 `{candidatas: CandidataVista[], siguiente: string | null}` de la
//    ÚLTIMA importación `completada` del cliente (una anterior, una fallida posterior o una en curso no cambian el listado); orden por
//    (doc_tipo, doc_numero); `siguiente` es un cursor opaco (valor, no desplazamiento). Grupos: `propuestas` (pendientes con destino y
//    sin regla viva del proveedor), `sin_criterio` (pendientes sin destino), `conflicto` (pendientes con destino y regla viva: `ya_aprendida`
//    si el destino coincide, `distinto` si no) y `resueltas` (activada o descartada). `limite` 1..200 (100). Query inválida: 400.
//  - `POST …/candidatas/activar` (`reglas.gestionar`) con `{items: [{id, destino?}]}` o `{todas: true, importacionId}` -> 200
//    `{activadas, omitidas: [{id, motivo}]}`; motivos `no_pendiente`, `sin_criterio` (sin destino propuesto ni elegido, U-8), `ya_aprendida`
//    (regla viva con el mismo destino) y `conflicto` (regla viva con otro destino: no se sobrescribe, D-6). `todas` solo toma las pendientes
//    con destino propuesto de la última importación completada: informa los conflictos como omitidas y NUNCA incluye las sin criterio (U-8);
//    con otra importación: 400 o 404 (no es la última). Activar crea la regla de 021 (activa, versión 1, `origen = 'importacion'`,
//    `periodo_aprendido` = el último periodo importado, autor = quien activa), la candidata pasa a `activada` con su `regla` y no se escribe
//    `regla_confirmacion` (D-7). Un id de otro cliente, de otro estudio o inexistente da 404 a TODO el lote (nada se activa).
//  - `POST …/candidatas/:candidataId/reemplazar {destino?, versionRegla}` (`reglas.gestionar`) -> 200 `{regla: ReglaVista}`; solo con
//    conflicto `distinto`; la versión es la de la REGLA: distinta -> 409 `regla_cambiada` sin cambios.
//  - `POST …/candidatas/descartar {ids}` -> 200 `{descartadas: id[], omitidas: id[]}` (las no pendientes se omiten); audita
//    `regla.candidata_descartada` `{candidataId, importacionId}` por candidata y no crea reglas.
//  - Cliente archivado: 409 `cliente_archivado` en toda escritura. Cliente de otro estudio, no visible o inexistente, y candidata de otro
//    cliente o estudio: el mismo 404 `{codigo:"no_encontrado"}`. Cuerpo inválido: 400 `solicitud_invalida`. `Cache-Control: no-store`.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente. Las tablas son de T10.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturarLogs } from "../../../test/soporte.js";
import {
  abrirBancoAprendizaje,
  CLAVES_CANDIDATA,
  conteosPara,
  cumple,
  inexistente,
  NO_ENCONTRADO,
  rutaActivar,
  rutaCandidatas,
  rutaDescartar,
  rutaReemplazar,
  rutaReglas,
  type Actor,
  type BancoAprendizaje,
  type CandidataSembrada,
  type Destino,
  type Estudio,
} from "../../../test/soporte-aprendizaje.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let v: BancoAprendizaje;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let contadorAjeno: Actor;

const CANARIO_RAZON = "CANARIO RAZON SOCIAL SAC";
const CANARIO_RUC = "20700000011";

beforeAll(async () => {
  v = await abrirBancoAprendizaje();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  contadorAjeno = await p.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id], ...o });
/** Documentos de proveedor ordenables como texto: `doc(3)` < `doc(12)`. */
const doc = (n: number): string => `20700${String(n).padStart(6, "0")}`;

const listar = (a: Actor, c: { id: string }, query = "") => v.http(a, "GET", `${rutaCandidatas(c.id)}${query}`);
const activar = (a: Actor, c: { id: string }, cuerpo: unknown) => v.http(a, "POST", rutaActivar(c.id), cuerpo);
const descartar = (a: Actor, c: { id: string }, cuerpo: unknown) => v.http(a, "POST", rutaDescartar(c.id), cuerpo);
const reemplazar = (a: Actor, c: { id: string }, candidataId: string, cuerpo: unknown) => v.http(a, "POST", rutaReemplazar(c.id, candidataId), cuerpo);
const reglasDe = (a: Actor, c: { id: string }) => v.http(a, "GET", rutaReglas(c.id));
const ids = (r: { body: any }): string[] => (r.body.candidatas as any[]).map((x) => x.id);
const ordenados = (xs: string[]): string[] => [...xs].sort();
const idsDe = (xs: { id: string }[]): string[] => xs.map((x) => x.id);

/** Una importación completada (6 periodos, 202610 el último) con las candidatas dadas y las reglas vivas que hagan falta. */
async function conImportacion(
  c: Cliente,
  specs: Parameters<BancoAprendizaje["sembrarCandidatas"]>[3],
  o: { reglas?: Parameters<BancoAprendizaje["sembrarReglasVivas"]>[2] } = {},
): Promise<{ importacionId: string; cs: CandidataSembrada[]; reglaIds: string[] }> {
  const reglaIds = await v.sembrarReglasVivas(E.tenantId, c.id, o.reglas ?? [], u());
  const importacionId = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: contador.id, candidatas: specs.length, solicitadaHace: "1 hour" });
  const cs = await v.sembrarCandidatas(E.tenantId, c.id, importacionId, specs, u());
  return { importacionId, cs, reglaIds };
}

/**
 * Escenario de los siete tipos, con documentos en orden creciente:
 *   p1 DNG, p2 DGNG (propuestas) · s1 (sin criterio) · ya (regla viva DNG = propuesta) · dis (regla viva DG v3, propuesta DNG) ·
 *   act (activada, con su regla) · des (descartada).
 */
async function escenario() {
  const c = await nuevoCliente();
  const [idYa, idDis, idAct] = [randomUUID(), randomUUID(), randomUUID()];
  const { importacionId, cs } = await conImportacion(
    c,
    [
      { docNumero: doc(1), razonSocial: "PROVEEDOR UNO SAC", destinoPropuesto: "DNG" },
      { docNumero: doc(2), razonSocial: "PROVEEDOR DOS SAC", destinoPropuesto: "DGNG" },
      { docNumero: doc(3), razonSocial: null, destinoPropuesto: null },
      { docNumero: doc(4), destinoPropuesto: "DNG" },
      { docNumero: doc(5), destinoPropuesto: "DNG" },
      { docNumero: doc(6), destinoPropuesto: "DGNG", estado: "activada", reglaId: idAct },
      { docNumero: doc(7), destinoPropuesto: "DNG", estado: "descartada" },
    ],
    {
      reglas: [
        { id: idYa, docNumero: doc(4), destino: "DNG" },
        { id: idDis, docNumero: doc(5), destino: "DG", version: 3 },
        { id: idAct, docNumero: doc(6), destino: "DGNG" },
      ],
    },
  );
  const [p1, p2, s1, ya, dis, act, des] = cs as [CandidataSembrada, CandidataSembrada, CandidataSembrada, CandidataSembrada, CandidataSembrada, CandidataSembrada, CandidataSembrada];
  return { c, importacionId, p1, p2, s1, ya, dis, act, des, reglaYa: idYa, reglaDis: idDis, reglaAct: idAct };
}

/** Compara dos fotos de lo que 025 guarda de un cliente: un intento rechazado no cambia nada. */
const foto = (c: Cliente) => v.fotoAprendizaje(E.tenantId, c.id);

// --- GET candidatas -----------------------------------------------------------------------------------------------------------

describe("GET …/reglas/candidatas · grupos y forma (CA-3, CA-4; D-4, D-6, U-8)", () => {
  it("sin importación completada: 200 { candidatas: [], siguiente: null } y Cache-Control: no-store", async () => {
    const c = await nuevoCliente();
    const r = await listar(contador, c, "?grupo=propuestas");
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ candidatas: [], siguiente: null });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("cada grupo trae solo lo suyo, con la forma de candidataVistaSchema y en orden de documento", async () => {
    const e = await escenario();
    const g = async (grupo: string) => {
      const r = await listar(contador, e.c, `?grupo=${grupo}`);
      expect(r.status, r.text).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["candidatas", "siguiente"]);
      for (const x of r.body.candidatas) {
        expect(cumple("candidataVistaSchema", x), JSON.stringify(x)).toBe(true);
        expect(Object.keys(x).sort()).toEqual(CLAVES_CANDIDATA);
      }
      return r;
    };
    expect(ids(await g("propuestas"))).toEqual([e.p1.id, e.p2.id]);
    expect(ids(await g("sin_criterio"))).toEqual([e.s1.id]);
    expect(ids(await g("conflicto"))).toEqual([e.ya.id, e.dis.id]);
    expect(ids(await g("resueltas"))).toEqual([e.act.id, e.des.id]);
  });

  it("una propuesta lleva proveedor, destino propuesto, conteos, frecuencia y periodos leídos de la importación; sin regla ni elección", async () => {
    const e = await escenario();
    const r = await listar(contador, e.c, "?grupo=propuestas");
    expect(r.body.candidatas[0]).toEqual({
      id: e.p1.id,
      proveedor: { tipo: "6", numero: doc(1), razonSocial: "PROVEEDOR UNO SAC" },
      destinoPropuesto: "DNG",
      conteos: e.p1.conteos,
      periodosConProveedor: e.p1.periodosConProveedor,
      periodosLeidos: 5, // 6 periodos pedidos, 1 sin datos
      estado: "pendiente",
      destinoElegido: null,
      regla: null,
      conflicto: "ninguno",
    });
    expect(r.body.candidatas[0].conteos).toEqual(conteosPara("DNG", 0));
  });

  it("sin criterio: destino propuesto null y razón social null se muestran como son", async () => {
    const e = await escenario();
    const r = await listar(contador, e.c, "?grupo=sin_criterio");
    expect(r.body.candidatas).toHaveLength(1);
    expect(r.body.candidatas[0]).toMatchObject({ destinoPropuesto: null, proveedor: { numero: doc(3), razonSocial: null }, estado: "pendiente", conflicto: "ninguno", regla: null });
  });

  it("conflicto: ya_aprendida (mismo destino) y distinto (otro destino), cada uno con la regla viva (id, destino, versión)", async () => {
    const e = await escenario();
    const r = await listar(contador, e.c, "?grupo=conflicto");
    expect(r.body.candidatas).toHaveLength(2);
    expect(r.body.candidatas[0]).toMatchObject({ id: e.ya.id, conflicto: "ya_aprendida", destinoPropuesto: "DNG", regla: { id: e.reglaYa, destino: "DNG", version: 1 } });
    expect(r.body.candidatas[1]).toMatchObject({ id: e.dis.id, conflicto: "distinto", destinoPropuesto: "DNG", regla: { id: e.reglaDis, destino: "DG", version: 3 } });
  });

  it("resueltas: la activada con su regla y destino elegido; la descartada sin regla", async () => {
    const e = await escenario();
    const r = await listar(contador, e.c, "?grupo=resueltas");
    expect(r.body.candidatas[0]).toMatchObject({ id: e.act.id, estado: "activada", destinoElegido: "DGNG", regla: { id: e.reglaAct, destino: "DGNG" } });
    expect(r.body.candidatas[1]).toMatchObject({ id: e.des.id, estado: "descartada", regla: null });
  });

  it("lista la ÚLTIMA importación completada: ni una anterior (reemplazada), ni una fallida o en curso posterior aportan candidatas", async () => {
    const c = await nuevoCliente();
    const vieja = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "5 days" });
    await v.sembrarCandidatas(E.tenantId, c.id, vieja, [{ docNumero: doc(90), estado: "reemplazada" }, { docNumero: doc(91) }], u());
    const vigente = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "3 days" });
    const [a] = await v.sembrarCandidatas(E.tenantId, c.id, vigente, [{ docNumero: doc(1) }], u());
    await v.sembrarImportacion(E.tenantId, c.id, { estado: "fallida", usuarioId: u(), solicitadaHace: "2 days" });
    await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), solicitadaHace: "1 minute" });
    const todas = await Promise.all(["propuestas", "sin_criterio", "conflicto", "resueltas"].map((g) => listar(contador, c, `?grupo=${g}`)));
    expect(ids(todas[0]!)).toEqual([a!.id]);
    for (const r of todas.slice(1)) expect(r.body.candidatas).toEqual([]);
  });

  it("la candidata de un cliente no aparece en otro del mismo estudio ni en otro estudio", async () => {
    const e = await escenario();
    const otro = await nuevoCliente();
    const ajeno = await v.cliente(F, {});
    expect((await listar(contador, otro, "?grupo=propuestas")).body).toEqual({ candidatas: [], siguiente: null });
    const r = await listar(contador, ajeno, "?grupo=propuestas");
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
    expect(ids(await listar(contador, e.c, "?grupo=propuestas")).length).toBe(2);
  });

  it("los roles con reglas.ver la leen (asistente colaborador, 200) y un contador sin el cliente asignado recibe el mismo 404 que un inexistente", async () => {
    const e = await escenario();
    const a = await listar(asistente, e.c, "?grupo=propuestas");
    expect(a.status, a.text).toBe(200);
    expect(ids(a)).toHaveLength(2);
    const noVisible = await listar(contadorAjeno, e.c, "?grupo=propuestas");
    const noExiste = await listar(contador, { id: inexistente() }, "?grupo=propuestas");
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noVisible.status, noVisible.text).toBe(404);
    expect(noVisible.text).toBe(noExiste.text);
  });

  it.each([
    ["grupo desconocido", "?grupo=todas"],
    ["grupo en mayúsculas", "?grupo=Propuestas"],
    ["limite 0", "?grupo=propuestas&limite=0"],
    ["limite 201", "?grupo=propuestas&limite=201"],
    ["limite decimal", "?grupo=propuestas&limite=2.5"],
    ["limite no numérico", "?grupo=propuestas&limite=abc"],
    ["clave desconocida", "?grupo=propuestas&clienteId=x"],
    ["cursor mal formado", "?grupo=propuestas&cursor=%25%25basura"],
    ["cursor de 257 caracteres", `?grupo=propuestas&cursor=${"a".repeat(257)}`],
  ])("consulta inválida (%s): 400 solicitud_invalida", async (_n, query) => {
    const e = await escenario();
    const r = await listar(contador, e.c, query);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });
});

describe("GET …/reglas/candidatas · paginación por cursor (CA-13; plan: cursor por (doc_tipo, doc_numero))", () => {
  async function veinticinco() {
    const c = await nuevoCliente();
    const specs = Array.from({ length: 25 }, (_, i) => ({ docNumero: doc(100 + i), destinoPropuesto: (["DG", "DGNG", "DNG"] as const)[i % 3] }));
    const { cs } = await conImportacion(c, specs);
    return { c, cs };
  }
  const paginar = async (c: Cliente, limite: number, alVuelo?: (pagina: number, ids: string[]) => Promise<void>) => {
    const vistas: string[] = [];
    let cursor: string | null = null;
    for (let pagina = 1; pagina <= 20; pagina++) {
      const q: string = `?grupo=propuestas&limite=${limite}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const r = await listar(contador, c, q);
      expect(r.status, r.text).toBe(200);
      expect(r.body.candidatas.length).toBeLessThanOrEqual(limite);
      vistas.push(...ids(r));
      if (alVuelo) await alVuelo(pagina, ids(r));
      cursor = r.body.siguiente;
      if (cursor === null) return vistas;
      expect(typeof cursor).toBe("string");
      expect(cursor.length).toBeLessThanOrEqual(256);
    }
    throw new Error("el cursor no termina");
  };

  it("límite 7 recorre las 25 sin repetir ni omitir y en orden de documento; la última página trae `siguiente: null`", async () => {
    const { c, cs } = await veinticinco();
    const vistas = await paginar(c, 7);
    expect(vistas).toEqual(idsDe(cs)); // sembradas en orden de documento
    expect(new Set(vistas).size).toBe(25);
  });

  it("sin `limite` son 100 por página; una lista exacta del tamaño del límite no deja un `siguiente` vacío", async () => {
    const { c } = await veinticinco();
    const r = await listar(contador, c, "?grupo=propuestas");
    expect(r.body.candidatas).toHaveLength(25);
    expect(r.body.siguiente).toBeNull();
    const exacta = await listar(contador, c, "?grupo=propuestas&limite=25");
    expect(exacta.body.candidatas).toHaveLength(25);
    expect(exacta.body.siguiente).toBeNull();
  });

  it("activando las ya vistas a mitad del recorrido no repite ni omite ninguna de las restantes (el cursor es un valor, no un desplazamiento)", async () => {
    const { c, cs } = await veinticinco();
    const vistas = await paginar(c, 7, async (pagina, de) => {
      if (pagina === 1) {
        const a = await activar(contador, c, { items: de.map((id) => ({ id })) });
        expect(a.status, a.text).toBe(200);
        expect(ordenados(a.body.activadas)).toEqual(ordenados(de));
      }
    });
    expect(vistas).toEqual(idsDe(cs));
    expect(await listar(contador, c, "?grupo=resueltas&limite=200").then((r) => ids(r).length)).toBe(7);
  });
});

// --- POST activar ---------------------------------------------------------------------------------------------------------------

describe("POST …/candidatas/activar · activar una, varias o todas (CA-3, CA-4; D-5, D-6, D-7; U-8)", () => {
  it("una propuesta: crea la regla de 021 activa, versión 1, origen importacion, periodo_aprendido = último periodo, autor = quien activa", async () => {
    const e = await escenario();
    const r = await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(r.status, r.text).toBe(200);
    expect(cumple("respuestaActivarSchema", r.body), r.text).toBe(true);
    expect(r.body).toEqual({ activadas: [e.p1.id], omitidas: [] });
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const reglas = (await v.reglasConOrigen(e.c.id)).filter((x) => x.doc_numero === doc(1));
    expect(reglas).toHaveLength(1);
    expect(reglas[0]).toMatchObject({
      doc_tipo: "6",
      destino: "DNG",
      activa: true,
      version: 1,
      periodo_aprendido: "202610",
      origen: "importacion",
      creada_por: contador.id,
      eliminada: false,
    });
    const c = await v.candidataBd(e.p1.id);
    expect(c).toMatchObject({ estado: "activada", destino_elegido: "DNG", regla_id: reglas[0].id, resuelta_por: contador.id });
  });

  it("la regla activada se ve en GET /clientes/:id/reglas con origen «importacion» y es una regla normal de 021 (editable)", async () => {
    const e = await escenario();
    expect((await activar(contador, e.c, { items: [{ id: e.p2.id }] })).status).toBe(200);
    const lista = await reglasDe(contador, e.c);
    expect(lista.status, lista.text).toBe(200);
    const regla = (lista.body as any[]).find((x) => x.proveedor.numero === doc(2));
    expect(regla, lista.text).toBeDefined();
    expect(cumple("reglaVistaSchema", regla), JSON.stringify(regla)).toBe(true);
    expect(regla).toMatchObject({ destino: "DGNG", activa: true, version: 1, origen: "importacion", periodoAprendido: "202610", aplicada: 0, aceptada: 0 });
    expect(regla.creadaPor).toMatchObject({ id: contador.id });
    // Las reglas de contador sembradas siguen con su origen por defecto.
    expect((lista.body as any[]).find((x) => x.id === e.reglaYa)).toMatchObject({ origen: "contador" });
    // Desde ahí es una regla normal: se edita con su versión.
    const editada = await v.http(contador, "PATCH", `${rutaReglas(e.c.id)}/${regla.id}`, { versionBase: 1, destino: "DNG" });
    expect(editada.status, editada.text).toBe(200);
    expect(editada.body).toMatchObject({ destino: "DNG", version: 2, origen: "importacion" });
  });

  it("la candidata activada pasa al grupo «resueltas» con su regla; deja de ser propuesta", async () => {
    const e = await escenario();
    await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(ids(await listar(contador, e.c, "?grupo=propuestas"))).toEqual([e.p2.id]);
    const res = await listar(contador, e.c, "?grupo=resueltas");
    const m = res.body.candidatas.find((x: any) => x.id === e.p1.id);
    expect(m).toMatchObject({ estado: "activada", destinoElegido: "DNG", destinoPropuesto: "DNG", regla: { destino: "DNG", version: 1 } });
  });

  it("auditoría: regla.creada con origen importacion, por quien activa, sin RUC ni razón social", async () => {
    const e = await escenario();
    await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    const reglaId = (await v.candidataBd(e.p1.id))?.regla_id;
    const aud = (await v.auditoriaDe(E.tenantId, "regla.creada")).filter((f) => f.entidad_id === reglaId);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario_id: contador.id, cliente_id: e.c.id });
    expect(aud[0].datos).toMatchObject({ origen: "importacion", destino: "DNG" });
    const texto = JSON.stringify(aud[0].datos);
    expect(texto).not.toContain(doc(1));
    expect(texto).not.toContain("PROVEEDOR UNO");
  });

  it("D-7: activar no registra confirmación para 033 aunque el aporte esté encendido y el RUC empiece en 20", async () => {
    const e = await escenario();
    await v.fijarAporteBd(E.tenantId, true);
    const antes = (await v.confirmacionesBd(E.tenantId)).length;
    expect((await activar(contador, e.c, { items: [{ id: e.p1.id }, { id: e.p2.id }] })).status).toBe(200);
    expect((await v.confirmacionesBd(E.tenantId)).length).toBe(antes);
  });

  it("cambiar el destino antes de activar crea la regla con el destino elegido (CA-3) y lo recuerda en la candidata", async () => {
    const e = await escenario();
    const r = await activar(contador, e.c, { items: [{ id: e.p1.id, destino: "DG" }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.activadas).toEqual([e.p1.id]);
    const regla = (await v.reglasConOrigen(e.c.id)).find((x) => x.doc_numero === doc(1));
    expect(regla).toMatchObject({ destino: "DG", origen: "importacion" });
    expect(await v.candidataBd(e.p1.id)).toMatchObject({ destino_propuesto: "DNG", destino_elegido: "DG" });
    const vista = (await listar(contador, e.c, "?grupo=resueltas")).body.candidatas.find((x: any) => x.id === e.p1.id);
    expect(vista).toMatchObject({ destinoPropuesto: "DNG", destinoElegido: "DG" });
  });

  it("varias a la vez: todas se activan, cada una con su destino (el elegido o el propuesto)", async () => {
    const e = await escenario();
    const r = await activar(contador, e.c, { items: [{ id: e.p1.id }, { id: e.p2.id, destino: "DNG" }] });
    expect(r.status, r.text).toBe(200);
    expect(ordenados(r.body.activadas)).toEqual(ordenados([e.p1.id, e.p2.id]));
    expect(r.body.omitidas).toEqual([]);
    const reglas = await v.reglasConOrigen(e.c.id);
    expect(reglas.find((x) => x.doc_numero === doc(1))).toMatchObject({ destino: "DNG", origen: "importacion" });
    expect(reglas.find((x) => x.doc_numero === doc(2))).toMatchObject({ destino: "DNG", origen: "importacion" });
  });

  it("«Activar todas»: activa las propuestas, omite e informa los conflictos, nunca incluye las sin criterio y no toca las reglas vivas (CA-4, U-8)", async () => {
    const c = await nuevoCliente();
    const reglas = [
      { docNumero: doc(20), destino: "DNG" as Destino }, // ya_aprendida
      { docNumero: doc(21), destino: "DG" as Destino, version: 3 }, // conflicto
      { docNumero: doc(22), destino: "DGNG" as Destino, version: 2 }, // conflicto
    ];
    const { importacionId, cs, reglaIds } = await conImportacion(
      c,
      [
        ...[1, 2, 3, 4, 5].map((n) => ({ docNumero: doc(n), destinoPropuesto: "DNG" as Destino })), // 5 propuestas
        { docNumero: doc(10), destinoPropuesto: null },
        { docNumero: doc(11), destinoPropuesto: null }, // 2 sin criterio
        { docNumero: doc(20), destinoPropuesto: "DNG" },
        { docNumero: doc(21), destinoPropuesto: "DNG" },
        { docNumero: doc(22), destinoPropuesto: "DNG" },
        { docNumero: doc(30), destinoPropuesto: "DNG", estado: "descartada" }, // resuelta: no entra
      ],
      { reglas },
    );
    const antes = await v.reglasConOrigen(c.id);
    const r = await activar(contador, c, { todas: true, importacionId });
    expect(r.status, r.text).toBe(200);
    expect(cumple("respuestaActivarSchema", r.body), r.text).toBe(true);
    expect(ordenados(r.body.activadas)).toEqual(ordenados(idsDe(cs.slice(0, 5))));
    expect([...r.body.omitidas].sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: cs[7]!.id, motivo: "ya_aprendida" },
        { id: cs[8]!.id, motivo: "conflicto" },
        { id: cs[9]!.id, motivo: "conflicto" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // Ni las sin criterio ni la descartada figuran en ninguna lista.
    const mencionadas = [...r.body.activadas, ...r.body.omitidas.map((x: any) => x.id)];
    for (const id of [cs[5]!.id, cs[6]!.id, cs[10]!.id]) expect(mencionadas).not.toContain(id);
    expect(await v.candidataBd(cs[5]!.id)).toMatchObject({ estado: "pendiente" });
    expect(await v.candidataBd(cs[6]!.id)).toMatchObject({ estado: "pendiente" });
    expect(await v.candidataBd(cs[10]!.id)).toMatchObject({ estado: "descartada" });

    const despues = await v.reglasConOrigen(c.id);
    expect(despues).toHaveLength(antes.length + 5);
    expect(despues.filter((x) => x.origen === "importacion")).toHaveLength(5);
    // Las reglas vivas de los conflictos siguen como estaban: destino y versión (nunca se sobrescribe una regla sola, D-6).
    for (const [id, destino, version] of [
      [reglaIds[0], "DNG", 1],
      [reglaIds[1], "DG", 3],
      [reglaIds[2], "DGNG", 2],
    ] as const)
      expect(despues.find((x) => x.id === id)).toMatchObject({ destino, version, origen: "contador" });
    expect(ids(await listar(contador, c, "?grupo=propuestas"))).toEqual([]);
    expect(ids(await listar(contador, c, "?grupo=sin_criterio"))).toEqual([cs[5]!.id, cs[6]!.id]);
  });

  it("«Activar todas» con la importación equivocada (una anterior, otra inexistente o la de otro cliente) no activa nada: 400 o 404 igual para las tres", async () => {
    const c = await nuevoCliente();
    const vieja = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "5 days" });
    await v.sembrarCandidatas(E.tenantId, c.id, vieja, [{ docNumero: doc(90), estado: "reemplazada" }], u());
    const { importacionId: vigente } = await conImportacion(c, [{ docNumero: doc(1) }]);
    const otro = await nuevoCliente();
    const deOtro = await v.sembrarImportacion(E.tenantId, otro.id, { usuarioId: u() });
    const antes = await foto(c);
    const respuestas = [];
    for (const importacionId of [vieja, inexistente(), deOtro]) respuestas.push(await activar(contador, c, { todas: true, importacionId }));
    for (const r of respuestas) {
      expect([400, 404], r.text).toContain(r.status);
      expect(r.body.codigo === "solicitud_invalida" || r.body.codigo === "no_encontrado", r.text).toBe(true);
    }
    expect(respuestas[1]!.text).toBe(respuestas[2]!.text); // la ajena no se distingue de la inexistente
    expect(await foto(c)).toEqual(antes);
    // Control: con la importación vigente sí se activa (el rechazo de arriba no era la ruta que falta).
    const ok = await activar(contador, c, { todas: true, importacionId: vigente });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.activadas).toHaveLength(1);
  });

  it("sin criterio SOLO con destino elegido a mano (U-8): con destino se activa; sin destino se omite como sin_criterio", async () => {
    const e = await escenario();
    const sin = await activar(contador, e.c, { items: [{ id: e.s1.id }] });
    expect(sin.status, sin.text).toBe(200);
    expect(sin.body).toEqual({ activadas: [], omitidas: [{ id: e.s1.id, motivo: "sin_criterio" }] });
    expect((await v.reglasConOrigen(e.c.id)).find((x) => x.doc_numero === doc(3))).toBeUndefined();
    expect(await v.candidataBd(e.s1.id)).toMatchObject({ estado: "pendiente" });

    const con = await activar(contador, e.c, { items: [{ id: e.s1.id, destino: "DGNG" }] });
    expect(con.status, con.text).toBe(200);
    expect(con.body).toEqual({ activadas: [e.s1.id], omitidas: [] });
    expect((await v.reglasConOrigen(e.c.id)).find((x) => x.doc_numero === doc(3))).toMatchObject({ destino: "DGNG", origen: "importacion" });
    expect(await v.candidataBd(e.s1.id)).toMatchObject({ estado: "activada", destino_elegido: "DGNG" });
  });

  it("con una regla viva: ya_aprendida (mismo destino) y conflicto (otro destino) se omiten y la regla no cambia (D-6)", async () => {
    const e = await escenario();
    const antes = await v.reglasConOrigen(e.c.id);
    const r = await activar(contador, e.c, { items: [{ id: e.ya.id }, { id: e.dis.id }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.activadas).toEqual([]);
    expect([...r.body.omitidas].sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: e.ya.id, motivo: "ya_aprendida" },
        { id: e.dis.id, motivo: "conflicto" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await v.reglasConOrigen(e.c.id)).toEqual(antes);
    // Aun con un destino elegido que coincide con la regla viva, no se crea una segunda regla.
    const igual = await activar(contador, e.c, { items: [{ id: e.dis.id, destino: "DG" }] });
    expect(igual.status, igual.text).toBe(200);
    expect(igual.body.activadas).toEqual([]);
    expect(await v.reglasConOrigen(e.c.id)).toEqual(antes);
  });

  it("un lote mixto es parcial: activa lo válido y explica el resto (propuesta, conflicto, sin criterio sin destino, ya activada y descartada)", async () => {
    const e = await escenario();
    const r = await activar(contador, e.c, {
      items: [{ id: e.p1.id }, { id: e.dis.id }, { id: e.s1.id }, { id: e.act.id }, { id: e.des.id }],
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.activadas).toEqual([e.p1.id]);
    const motivos = Object.fromEntries((r.body.omitidas as any[]).map((x) => [x.id, x.motivo]));
    expect(motivos).toEqual({ [e.dis.id]: "conflicto", [e.s1.id]: "sin_criterio", [e.act.id]: "no_pendiente", [e.des.id]: "no_pendiente" });
    expect(r.body.omitidas).toHaveLength(4);
  });

  it("activar dos veces la misma candidata: la segunda es no_pendiente y queda UNA sola regla", async () => {
    const e = await escenario();
    expect((await activar(contador, e.c, { items: [{ id: e.p1.id }] })).body.activadas).toEqual([e.p1.id]);
    const otra = await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(otra.status, otra.text).toBe(200);
    expect(otra.body).toEqual({ activadas: [], omitidas: [{ id: e.p1.id, motivo: "no_pendiente" }] });
    expect((await v.reglasConOrigen(e.c.id)).filter((x) => x.doc_numero === doc(1) && !x.eliminada)).toHaveLength(1);
  });

  it("dos activaciones simultáneas de la misma candidata dejan UNA sola regla viva (8 rondas, CA-4)", async () => {
    for (let ronda = 0; ronda < 8; ronda++) {
      const e = await escenario();
      const rs = await Promise.all([activar(contador, e.c, { items: [{ id: e.p1.id }] }), activar(contador, e.c, { items: [{ id: e.p1.id }] })]);
      for (const r of rs) expect(r.status, `ronda ${ronda}: ${r.text}`).toBe(200);
      const gano = rs.filter((r) => (r.body.activadas as string[]).includes(e.p1.id));
      expect(gano, `ronda ${ronda}: exactamente una activa`).toHaveLength(1);
      const otra = rs.find((r) => r !== gano[0])!;
      expect(otra.body.omitidas).toEqual([{ id: e.p1.id, motivo: "no_pendiente" }]);
      const vivas = (await v.reglasConOrigen(e.c.id)).filter((x) => x.doc_numero === doc(1) && !x.eliminada);
      expect(vivas, `ronda ${ronda}`).toHaveLength(1);
    }
  });

  it("activar ∥ «Recordar» del mismo proveedor: una sola regla viva y el «Recordar» nunca queda sobrescrito (6 rondas, CA-4)", async () => {
    for (let ronda = 0; ronda < 6; ronda++) {
      const c = await nuevoCliente();
      const { cs } = await conImportacion(c, [{ docNumero: doc(1), destinoPropuesto: "DNG" }]);
      const compra = await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: String(ronda + 1), doc: doc(1), usuarioId: u() });
      const [a, rec] = await Promise.all([
        activar(contador, c, { items: [{ id: cs[0]!.id }] }),
        v.http(contador, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds: [compra], destino: "DG", versionBase: null }),
      ]);
      expect(a.status, `ronda ${ronda}: ${a.text}`).toBe(200);
      const vivas = (await v.reglasConOrigen(c.id)).filter((x) => x.doc_numero === doc(1) && !x.eliminada);
      expect(vivas, `ronda ${ronda}: una sola regla viva`).toHaveLength(1);
      if (rec.status === 200) {
        // Ganó «Recordar»: su destino se conserva y la candidata quedó en conflicto (omitida), nunca activada sobre ella.
        expect(vivas[0]).toMatchObject({ destino: "DG", origen: "contador" });
        expect(a.body.activadas, `ronda ${ronda}`).toEqual([]);
        expect(a.body.omitidas).toEqual([{ id: cs[0]!.id, motivo: "conflicto" }]);
        expect(await v.candidataBd(cs[0]!.id)).toMatchObject({ estado: "pendiente" });
      } else {
        // Ganó la activación: «Recordar» recibe el 409 de siempre (ya hay una viva) y la regla es la importada.
        expect(rec.status, `ronda ${ronda}: ${rec.text}`).toBe(409);
        expect(rec.body).toEqual({ codigo: "regla_cambiada" });
        expect(vivas[0]).toMatchObject({ destino: "DNG", origen: "importacion" });
        expect(a.body.activadas).toEqual([cs[0]!.id]);
      }
    }
  });
});

describe("POST …/candidatas/activar · cuerpo inválido (400 solicitud_invalida, sin efectos)", () => {
  const casos: [string, (e: Awaited<ReturnType<typeof escenario>>) => unknown][] = [
    ["items vacío", () => ({ items: [] })],
    ["sin items ni todas", () => ({})],
    // 1.001 ítems pesan ~50 kB de JSON y el analizador global corta en 16 kB (`LIMITE_JSON`, 413): como `RUTAS_LOTES` de 005 y las masivas de
    // 014, T12 debe darle a estas rutas un límite propio que deje pasar el tope de 1.000 hasta zod, que es quien responde el 400.
    ["items de 1.001", () => ({ items: Array.from({ length: 1001 }, () => ({ id: inexistente() })) })],
    ["ids repetidos", (e) => ({ items: [{ id: e.p1.id }, { id: e.p1.id }] })],
    ["ids repetidos con distinto destino", (e) => ({ items: [{ id: e.p1.id, destino: "DG" }, { id: e.p1.id, destino: "DNG" }] })],
    ["destino inválido", (e) => ({ items: [{ id: e.p1.id, destino: "XX" }] })],
    ["destino en minúsculas", (e) => ({ items: [{ id: e.p1.id, destino: "dng" }] })],
    ["id que no es uuid", () => ({ items: [{ id: "no-es-uuid" }] })],
    ["clave extra en un ítem", (e) => ({ items: [{ id: e.p1.id, regla: "x" }] })],
    ["todas sin importacionId", () => ({ todas: true })],
    ["todas: false", (e) => ({ todas: false, importacionId: e.importacionId })],
    ["todas con importacionId que no es uuid", () => ({ todas: true, importacionId: "x" })],
    ["mezcla de las dos formas", (e) => ({ items: [{ id: e.p1.id }], todas: true, importacionId: e.importacionId })],
    ["clave extra", (e) => ({ items: [{ id: e.p1.id }], clienteId: e.c.id })],
  ];
  it.each(casos.map(([n, f]) => [n, f] as const))("%s", async (_n, cuerpo) => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await activar(contador, e.c, cuerpo(e));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await foto(e.c)).toEqual(antes);
  });
});

describe("POST …/candidatas/activar · el tope de 1.000 ítems cabe en el cuerpo (el límite global de 16 kB no se aplica)", () => {
  it("1.000 ids inexistentes: pasa el analizador y da 404 (no 413 solicitud_demasiado_grande) sin cambiar nada", async () => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await activar(contador, e.c, { items: Array.from({ length: 1000 }, () => ({ id: inexistente() })) });
    expect(r.status, r.text.slice(0, 200)).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
    expect(await foto(e.c)).toEqual(antes);
    const d = await descartar(contador, e.c, { ids: Array.from({ length: 1000 }, () => inexistente()) });
    expect(d.status, d.text.slice(0, 200)).toBe(404);
    expect(await foto(e.c)).toEqual(antes);
  });
});

describe("POST …/candidatas/activar · alcance y cliente archivado (CA-7, D-10)", () => {
  it("una candidata de otro cliente del mismo estudio, de otro estudio o inexistente: el mismo 404, y el lote entero no activa nada", async () => {
    const e = await escenario();
    const otro = await escenario();
    const ajeno = await v.cliente(F, {});
    const impAjena = await v.sembrarImportacion(F.tenantId, ajeno.id, { usuarioId: F.titular.id });
    const [candAjena] = await v.sembrarCandidatas(F.tenantId, ajeno.id, impAjena, [{ docNumero: doc(1) }], F.titular.id);
    const antes = await foto(e.c);
    const antesAjeno = await foto(ajeno);
    const noExiste = await activar(contador, e.c, { items: [{ id: inexistente() }] });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    for (const items of [
      [{ id: otro.p1.id }], // candidata del cliente B en la ruta del cliente A
      [{ id: candAjena!.id }], // de otro estudio
      [{ id: e.p1.id }, { id: otro.p1.id }], // una propia y una cruzada: P0002 a todo
      [{ id: e.p1.id }, { id: candAjena!.id }],
      [{ id: e.p1.id }, { id: inexistente() }],
    ]) {
      const r = await activar(contador, e.c, { items });
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(noExiste.text);
    }
    expect(await foto(e.c)).toEqual(antes); // ni siquiera la propia del lote mixto se activó
    expect(await foto(ajeno)).toEqual(antesAjeno);
    expect(await v.candidataBd(otro.p1.id)).toMatchObject({ estado: "pendiente" });
    // Control: la propia, sola, sí se activa (el 404 de arriba no era la ruta que falta).
    const ok = await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.activadas).toEqual([e.p1.id]);
  });

  it("cliente de otro estudio, no visible o inexistente: el mismo 404 (la ruta no revela cuál es)", async () => {
    const e = await escenario();
    const ajeno = await v.cliente(F, {});
    const noExiste = await activar(contador, { id: inexistente() }, { items: [{ id: e.p1.id }] });
    expect(noExiste.status, noExiste.text).toBe(404);
    for (const [quien, c] of [[contador, ajeno], [contadorAjeno, e.c]] as const) {
      const r = await activar(quien, c, { items: [{ id: e.p1.id }] });
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(noExiste.text);
    }
    expect(await v.candidataBd(e.p1.id)).toMatchObject({ estado: "pendiente" });
    expect((await activar(contador, e.c, { items: [{ id: e.p1.id }] })).status).toBe(200); // control: el responsable sí
  });

  it("cliente archivado: 409 cliente_archivado y no se crea ninguna regla", async () => {
    const e = await escenario();
    await v.archivar(e.c.id);
    const antes = await foto(e.c);
    const r = await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await foto(e.c)).toEqual(antes);
    const t = await activar(contador, e.c, { todas: true, importacionId: e.importacionId });
    expect(t.status, t.text).toBe(409);
    expect(t.body).toEqual({ codigo: "cliente_archivado" });
    expect(await foto(e.c)).toEqual(antes);
  });
});

// --- POST reemplazar -------------------------------------------------------------------------------------------------------------

describe("POST …/candidatas/:candidataId/reemplazar · compare-and-set por la versión de la regla (CA-4; D-6)", () => {
  const cuerpo = (versionRegla: unknown, destino?: unknown) => ({ versionRegla, ...(destino === undefined ? {} : { destino }) });

  it("con la versión vigente de la regla: 200 { regla } con el destino propuesto, versión +1 y periodo aprendido del último periodo; la candidata pasa a activada", async () => {
    const e = await escenario();
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpo(3));
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body)).toEqual(["regla"]);
    expect(cumple("reglaVistaSchema", r.body.regla), r.text).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body.regla).toMatchObject({ id: e.reglaDis, destino: "DNG", version: 4, activa: true, periodoAprendido: "202610", proveedor: { numero: doc(5) } });
    const regla = (await v.reglasConOrigen(e.c.id)).find((x) => x.id === e.reglaDis);
    expect(regla).toMatchObject({ destino: "DNG", version: 4, eliminada: false });
    expect(await v.candidataBd(e.dis.id)).toMatchObject({ estado: "activada", regla_id: e.reglaDis, destino_elegido: "DNG", resuelta_por: contador.id });
    // La lista de reglas lo ve como cualquier edición y el grupo «conflicto» ya no la trae.
    expect(ids(await listar(contador, e.c, "?grupo=conflicto"))).toEqual([e.ya.id]);
  });

  it("con `destino` elegido: la regla queda con ese destino", async () => {
    const e = await escenario();
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpo(3, "DGNG"));
    expect(r.status, r.text).toBe(200);
    expect(r.body.regla).toMatchObject({ destino: "DGNG", version: 4 });
    expect(await v.candidataBd(e.dis.id)).toMatchObject({ destino_elegido: "DGNG" });
  });

  it("auditoría: regla.editada con el destino anterior y el nuevo, sin RUC ni razón social", async () => {
    const e = await escenario();
    await reemplazar(contador, e.c, e.dis.id, cuerpo(3));
    const aud = (await v.auditoriaDe(E.tenantId, "regla.editada")).filter((f) => f.entidad_id === e.reglaDis);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario_id: contador.id, cliente_id: e.c.id });
    expect(aud[0].datos.destino).toEqual({ anterior: "DG", nuevo: "DNG" });
    expect(JSON.stringify(aud[0].datos)).not.toContain(doc(5));
  });

  it.each([[2], [1], [4]])("versión de la regla %i (la vigente es la 3): 409 regla_cambiada y no cambia nada", async (version) => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpo(version));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    expect(await foto(e.c)).toEqual(antes);
    expect((await v.reglasConOrigen(e.c.id)).find((x) => x.id === e.reglaDis)).toMatchObject({ destino: "DG", version: 3 });
  });

  it("una regla editada después de cargar la lista cambia su versión: el reemplazo con la versión que se vio da 409 regla_cambiada", async () => {
    const e = await escenario();
    expect((await v.http(contador, "PATCH", `${rutaReglas(e.c.id)}/${e.reglaDis}`, { versionBase: 3, destino: "DGNG" })).status).toBe(200);
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpo(3));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    expect((await v.reglasConOrigen(e.c.id)).find((x) => x.id === e.reglaDis)).toMatchObject({ destino: "DGNG", version: 4 });
  });

  it("dos reemplazos simultáneos con la misma versión: uno 200 y otro 409 regla_cambiada (4 rondas)", async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const e = await escenario();
      const rs = await Promise.all([reemplazar(contador, e.c, e.dis.id, cuerpo(3)), reemplazar(contador, e.c, e.dis.id, cuerpo(3))]);
      expect(rs.map((r) => r.status).sort(), `ronda ${ronda}: ${rs.map((r) => r.text).join(" | ")}`).toEqual([200, 409]);
      const perdedora = rs.find((r) => r.status === 409)!;
      expect(perdedora.body).toEqual({ codigo: "regla_cambiada" });
      expect((await v.reglasConOrigen(e.c.id)).find((x) => x.id === e.reglaDis)).toMatchObject({ version: 4 });
    }
  });

  it.each([
    ["ya_aprendida (el destino coincide: nada que reemplazar)", (e: any) => e.ya.id],
    ["propuesta sin regla viva (no hay qué reemplazar)", (e: any) => e.p1.id],
    ["sin criterio", (e: any) => e.s1.id],
    ["ya activada", (e: any) => e.act.id],
    ["descartada", (e: any) => e.des.id],
  ])("candidata %s: se rechaza (400, 409 o 422) y no cambia nada", async (_n, cual) => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await reemplazar(contador, e.c, cual(e), cuerpo(1));
    expect([400, 409, 422], r.text).toContain(r.status);
    expect(r.body.codigo, r.text).toBeTruthy();
    expect(await foto(e.c)).toEqual(antes);
  });

  it.each([
    ["sin versionRegla", {}],
    ["versionRegla 0", { versionRegla: 0 }],
    ["versionRegla negativa", { versionRegla: -1 }],
    ["versionRegla como texto", { versionRegla: "3" }],
    ["versionRegla decimal", { versionRegla: 2.5 }],
    ["destino inválido", { versionRegla: 3, destino: "XX" }],
  ])("cuerpo inválido (%s): 400 solicitud_invalida y no cambia nada", async (_n, cuerpoMalo) => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpoMalo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await foto(e.c)).toEqual(antes);
  });

  it("candidata de otro cliente, de otro estudio o inexistente: el mismo 404; la candidata id no uuid, 404 o 400 sin cambios", async () => {
    const e = await escenario();
    const otro = await escenario();
    const antes = await foto(e.c);
    const noExiste = await reemplazar(contador, e.c, inexistente(), cuerpo(3));
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    const cruzada = await reemplazar(contador, e.c, otro.dis.id, cuerpo(3));
    expect(cruzada.status, cruzada.text).toBe(404);
    expect(cruzada.text).toBe(noExiste.text);
    const mal = await reemplazar(contador, e.c, "no-es-uuid", cuerpo(3));
    expect([400, 404], mal.text).toContain(mal.status);
    expect(await foto(e.c)).toEqual(antes);
    expect(await v.candidataBd(otro.dis.id)).toMatchObject({ estado: "pendiente" });
    expect((await reemplazar(contador, e.c, e.dis.id, cuerpo(3))).status).toBe(200); // control: la propia sí
  });

  it("cliente archivado: 409 cliente_archivado y la regla no cambia", async () => {
    const e = await escenario();
    await v.archivar(e.c.id);
    const antes = await foto(e.c);
    const r = await reemplazar(contador, e.c, e.dis.id, cuerpo(3));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await foto(e.c)).toEqual(antes);
  });
});

// --- POST descartar --------------------------------------------------------------------------------------------------------------

describe("POST …/candidatas/descartar · descartar no crea nada (CA-3; D-4)", () => {
  it("descarta las pendientes: 200 { descartadas, omitidas: [] }, sin reglas nuevas, y pasan a «resueltas»", async () => {
    const e = await escenario();
    const reglasAntes = await v.reglasConOrigen(e.c.id);
    const r = await descartar(contador, e.c, { ids: [e.p1.id, e.s1.id, e.dis.id] });
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["descartadas", "omitidas"]);
    expect(ordenados(r.body.descartadas)).toEqual(ordenados([e.p1.id, e.s1.id, e.dis.id]));
    expect(r.body.omitidas).toEqual([]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.reglasConOrigen(e.c.id)).toEqual(reglasAntes); // CA-3: descartar no crea nada
    for (const id of [e.p1.id, e.s1.id, e.dis.id]) expect(await v.candidataBd(id)).toMatchObject({ estado: "descartada", regla_id: null, resuelta_por: contador.id });
    expect(ids(await listar(contador, e.c, "?grupo=propuestas"))).toEqual([e.p2.id]);
    expect(ids(await listar(contador, e.c, "?grupo=sin_criterio"))).toEqual([]);
    expect(ids(await listar(contador, e.c, "?grupo=conflicto"))).toEqual([e.ya.id]);
    // Por documento: p1 (1), s1 (3), dis (5), act (6), des (7).
    expect(ids(await listar(contador, e.c, "?grupo=resueltas"))).toEqual([e.p1.id, e.s1.id, e.dis.id, e.act.id, e.des.id]);
  });

  it("las que ya no están pendientes (activada, descartada) se omiten y no cambian; descartar dos veces es seguro", async () => {
    const e = await escenario();
    const r = await descartar(contador, e.c, { ids: [e.p1.id, e.act.id, e.des.id] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.descartadas).toEqual([e.p1.id]);
    expect(ordenados(r.body.omitidas)).toEqual(ordenados([e.act.id, e.des.id]));
    expect(await v.candidataBd(e.act.id)).toMatchObject({ estado: "activada", regla_id: e.reglaAct });
    const otra = await descartar(contador, e.c, { ids: [e.p1.id] });
    expect(otra.status, otra.text).toBe(200);
    expect(otra.body).toEqual({ descartadas: [], omitidas: [e.p1.id] });
  });

  it("una candidata descartada ya no se activa: no_pendiente", async () => {
    const e = await escenario();
    await descartar(contador, e.c, { ids: [e.p1.id] });
    const r = await activar(contador, e.c, { items: [{ id: e.p1.id }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ activadas: [], omitidas: [{ id: e.p1.id, motivo: "no_pendiente" }] });
  });

  it("auditoría: regla.candidata_descartada por candidata con {candidataId, importacionId}, sin RUC ni razón social", async () => {
    const e = await escenario();
    await descartar(contador, e.c, { ids: [e.p1.id, e.p2.id] });
    const aud = (await v.auditoriaDe(E.tenantId, "regla.candidata_descartada")).filter((f) => f.cliente_id === e.c.id);
    expect(aud).toHaveLength(2);
    expect(aud.map((f) => f.datos).sort((a, b) => a.candidataId.localeCompare(b.candidataId))).toEqual(
      [
        { candidataId: e.p1.id, importacionId: e.importacionId },
        { candidataId: e.p2.id, importacionId: e.importacionId },
      ].sort((a, b) => a.candidataId.localeCompare(b.candidataId)),
    );
    for (const f of aud) expect(f.usuario_id).toBe(contador.id);
    const texto = JSON.stringify(aud.map((f) => f.datos));
    expect(texto).not.toContain(doc(1));
    expect(texto).not.toContain("PROVEEDOR");
  });

  it.each([
    ["ids vacío", () => ({ ids: [] })],
    ["sin ids", () => ({})],
    ["ids de 1.001", () => ({ ids: Array.from({ length: 1001 }, () => inexistente()) })],
    ["id que no es uuid", () => ({ ids: ["no-es-uuid"] })],
    ["ids no es lista", (e: any) => ({ ids: e.p1.id })],
  ])("cuerpo inválido (%s): 400 solicitud_invalida y no cambia nada", async (_n, cuerpo) => {
    const e = await escenario();
    const antes = await foto(e.c);
    const r = await descartar(contador, e.c, cuerpo(e));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await foto(e.c)).toEqual(antes);
  });

  it("un id de otro cliente, de otro estudio o inexistente da 404 a todo el lote (la propia no se descarta)", async () => {
    const e = await escenario();
    const otro = await escenario();
    const antes = await foto(e.c);
    const noExiste = await descartar(contador, e.c, { ids: [inexistente()] });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    for (const ids_ of [[otro.p1.id], [e.p1.id, otro.p1.id], [e.p1.id, inexistente()]]) {
      const r = await descartar(contador, e.c, { ids: ids_ });
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(noExiste.text);
    }
    expect(await foto(e.c)).toEqual(antes);
    expect(await v.candidataBd(otro.p1.id)).toMatchObject({ estado: "pendiente" });
    expect((await descartar(contador, e.c, { ids: [e.p1.id] })).status).toBe(200); // control: la propia sí
  });

  it("cliente archivado: 409 cliente_archivado y nada se descarta", async () => {
    const e = await escenario();
    await v.archivar(e.c.id);
    const antes = await foto(e.c);
    const r = await descartar(contador, e.c, { ids: [e.p1.id] });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await foto(e.c)).toEqual(antes);
  });
});

// --- D-11 · canarios --------------------------------------------------------------------------------------------------------------

describe("CA-12 · ni RUC ni razón social en errores, logs ni auditoría de candidatas", () => {
  it("activar, reemplazar y descartar (con aciertos y errores) no filtran el RUC ni la razón social del proveedor", async () => {
    const c = await nuevoCliente();
    const { cs } = await conImportacion(
      c,
      [
        { docNumero: CANARIO_RUC, razonSocial: CANARIO_RAZON, destinoPropuesto: "DNG" },
        { docNumero: doc(2), razonSocial: CANARIO_RAZON, destinoPropuesto: "DNG" },
        { docNumero: doc(3), razonSocial: CANARIO_RAZON, destinoPropuesto: "DNG" },
      ],
      { reglas: [{ docNumero: doc(2), destino: "DG", version: 3 }] },
    );
    const { resultado, logs } = await capturarLogs(async () => ({
      activar: await activar(contador, c, { items: [{ id: cs[0]!.id }] }),
      invalida: await activar(contador, c, { items: [] }),
      cruzada: await activar(contador, c, { items: [{ id: inexistente() }] }),
      reemplazoViejo: await reemplazar(contador, c, cs[1]!.id, { versionRegla: 1 }),
      descartar: await descartar(contador, c, { ids: [cs[2]!.id] }),
      lista: await listar(contador, c, "?grupo=resueltas"),
    }));
    expect(resultado.activar.status, resultado.activar.text).toBe(200);
    expect(resultado.reemplazoViejo.status, resultado.reemplazoViejo.text).toBe(409);
    expect(resultado.descartar.status, resultado.descartar.text).toBe(200);
    // Los errores no llevan datos; las respuestas de lectura y de éxito solo los que corresponden al propio proveedor.
    for (const r of [resultado.invalida, resultado.cruzada, resultado.reemplazoViejo, resultado.activar, resultado.descartar]) {
      expect(r.text).not.toContain(CANARIO_RAZON);
      expect(r.text).not.toContain(CANARIO_RUC);
      expect(r.text).not.toContain(c.ruc);
    }
    for (const prohibido of [CANARIO_RUC, CANARIO_RAZON, c.ruc]) expect(logs, `logs con ${prohibido}`).not.toContain(prohibido);
    const texto = await v.textoAuditoria(E.tenantId);
    expect(texto).not.toContain(CANARIO_RUC);
    expect(texto).not.toContain(CANARIO_RAZON);
  });
});

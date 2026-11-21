// Spec 025 (T3, rojo): las siete funciones acotadas de la migracion 0062 en BD real (D-1, D-2, D-4 a D-7, D-10, D-11; CA-3 a CA-7).
// Catalogo (SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo al rol del plan), quien llama (42501), iniciar (periodos,
// cliente archivado/ajeno, una en curso, autocierre), completar (reemplaza pendientes, conserva activadas y descartadas, valida todo o
// nada, no toca reglas ni compras), activar (una, varias, todas; conflictos; sin criterio; ids ajenos), reemplazar (CA409), descartar,
// auditoria sin datos personales y el SAVEPOINT del worker (nota de 0038). Contrato en `reglas-importacion-soporte.ts`.
// Hasta T10 fallan por funcion o columna inexistente (42883, 42703, 42P01).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { compraDelWorker, DESCARGA } from "./reglas-soporte";
import {
  carga,
  codigoDe,
  comoRolSql,
  conExecute,
  EJECUTA,
  EscenarioImportacion,
  FIRMAS,
  infoFuncion,
  llamar,
  periodosHasta,
  resumen,
  ROLES_FUNCION,
  SQL,
  type ClientePrueba,
  type Llamada,
  type OpcionesCandidata,
} from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let ux: string; // contador activo de X
let uD: string; // miembro desactivado de X
let uy: string; // contador activo de Y
let cArch: ClientePrueba; // cliente archivado de X
let cy: ClientePrueba; // cliente de Y

const comoX = () => ({ tenantId: X, userId: ux });
const comoWorker = () => ({ tenantId: X });
const periodos6 = periodosHasta("202607", 6);

beforeAll(async () => {
  admin = abrirAdmin(8);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  Y = (await ei.estudio()).id;
  ux = await ei.usuarioDe(X);
  uD = (await ei.miembro(X, "contador", { desactivada: true })).id;
  uy = await ei.usuarioDe(Y);
  cy = await ei.cliente(Y);
  cArch = await ei.cliente(X);
  await ei.archivar(cArch.id);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ei?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

// ---- Ayudas --------------------------------------------------------------------------------------------------------------------
function filas(r: Llamada): any[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}
const cod = (r: Llamada) => codigoDe(r);

const iniciar = (c: ClientePrueba | string, periodos: unknown, ctx = comoX(), db = backend, revertir = false) =>
  llamar(db, ctx, SQL.iniciar, [typeof c === "string" ? c : c.id, periodos], { revertir });
const completar = (imp: string, cands: unknown, res = resumen(), ctx = comoWorker(), revertir = false) =>
  llamar(worker, ctx, SQL.completar, [imp, res, cands === null ? null : JSON.stringify(cands)], { revertir });
const activar = (c: ClientePrueba | string, items: unknown, todas: string | null = null, ctx = comoX(), revertir = false) =>
  llamar(backend, ctx, SQL.activar, [typeof c === "string" ? c : c.id, items === null ? null : JSON.stringify(items), todas], { revertir });
const reemplazar = (c: ClientePrueba | string, cand: string, destino: string | null, version: number, ctx = comoX()) =>
  llamar(backend, ctx, SQL.reemplazar, [typeof c === "string" ? c : c.id, cand, destino, version]);
const descartar = (c: ClientePrueba | string, ids: string[] | null, ctx = comoX(), revertir = false) =>
  llamar(backend, ctx, SQL.descartar, [typeof c === "string" ? c : c.id, ids], { revertir });

const porId = (r: Llamada) => new Map<string, any>(filas(r).map((x) => [x.candidata_id as string, x]));

interface Esc {
  c: ClientePrueba;
  imp: string;
  cs: { id: string; docNumero: string }[];
}
/** Cliente nuevo de X con una importacion completada (ultimo periodo 202607) y `n` candidatas pendientes DNG 5 de 5. */
async function escenario(n = 1, o: OpcionesCandidata = {}): Promise<Esc> {
  const c = await ei.cliente(X);
  const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
  const cs = await ei.candidatas(X, c, imp, n, o);
  return { c, imp, cs };
}

// =================================================================================================
describe("0062 · las siete funciones en el catalogo (CA-7)", () => {
  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    it(`${FIRMAS[k]}: SECURITY DEFINER de contapp_migrator, search_path fijo, sin PUBLIC; solo ${EJECUTA[k]} la ejecuta`, async () => {
      const i = await infoFuncion(admin, FIRMAS[k]).catch(() => {
        throw new Error(`falta la funcion ${FIRMAS[k]} (migracion 0062)`);
      });
      expect(i).toEqual({
        secdef: true,
        config: ["search_path=pg_catalog, pg_temp"],
        dueno: "contapp_migrator",
        duenoSuper: false,
        duenoBypass: false,
      });
      expect(await conExecute(admin, FIRMAS[k], ROLES_FUNCION)).toEqual([EJECUTA[k]]);
    });
  }
});

// =================================================================================================
describe("0062 · quien llama: estudio, usuario y membresia activa (42501)", () => {
  let candS: string;
  let impCurso: string; // en curso del cliente cS2 (para trabajo, completar y fallar)
  let jobS: string;
  let cS: ClientePrueba;
  beforeAll(async () => {
    cS = await ei.cliente(X);
    const imp = await ei.importacion(X, cS);
    candS = await ei.candidata(X, cS, imp);
    const cS2 = await ei.cliente(X);
    impCurso = await ei.importacion(X, cS2, { estado: "en_curso" });
    jobS = await ei.job(X, cS2, { tipo: "reglas.historial.importar", estado: "en_cola" });
  });

  /** Llamada valida de cada funcion, con la que se prueban los rechazos de quien llama. */
  const llamadaDe = (k: keyof typeof FIRMAS): [string, unknown[]] => {
    switch (k) {
      case "iniciar":
        return [SQL.iniciar, [cS.id, periodos6]];
      case "trabajo":
        return [SQL.trabajo, [impCurso, jobS]];
      case "completar":
        return [SQL.completar, [impCurso, resumen(), "[]"]];
      case "fallar":
        return [SQL.fallar, [impCurso, "error_interno"]];
      case "activar":
        return [SQL.activar, [cS.id, JSON.stringify([{ id: candS }]), null]];
      case "reemplazar":
        return [SQL.reemplazar, [cS.id, candS, null, 1]];
      case "descartar":
        return [SQL.descartar, [cS.id, [candS]]];
    }
  };

  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    const rol = EJECUTA[k];
    const otroRol = rol === "contapp_backend" ? "contapp_worker" : "contapp_backend";
    it(`${k}: sin estudio en la sesion, el rol equivocado y contapp_app dan 42501`, async () => {
      const [sql, valores] = llamadaDe(k);
      const sinEstudio = await comoRolSql(admin, rol, { tenantId: null, userId: ux }, sql, valores);
      expect(sinEstudio.ok ? "ok" : sinEstudio.code, "sin estudio").toBe("42501");
      for (const r of [otroRol, "contapp_app"]) {
        const x = await comoRolSql(admin, r, { tenantId: X, userId: ux }, sql, valores);
        expect(x.ok ? "ok" : x.code, `rol ${r}`).toBe("42501");
      }
    });

    if (rol === "contapp_backend") {
      it(`${k}: sin usuario, miembro desactivado y usuario de otro estudio dan 42501`, async () => {
        const [sql, valores] = llamadaDe(k);
        const sinUsuario = await llamar(backend, { tenantId: X }, sql, valores);
        expect(cod(sinUsuario), "sin usuario").toBe("42501");
        const desactivado = await llamar(backend, { tenantId: X, userId: uD }, sql, valores);
        expect(cod(desactivado), "miembro desactivado").toBe("42501");
        const ajeno = await llamar(backend, { tenantId: X, userId: uy }, sql, valores);
        expect(cod(ajeno), "usuario de otro estudio").toBe("42501");
      });
    }
  }
});

// =================================================================================================
describe("reglas_importacion_iniciar (D-4, CA-5)", () => {
  it("crea la importacion en curso con los periodos, el ultimo periodo, el solicitante y deja el trabajo para despues", async () => {
    const c = await ei.cliente(X);
    const r = await iniciar(c, periodos6);
    const id = filas(r)[0].id as string;
    const f = await ei.filaImportacion(id);
    expect(f).toMatchObject({
      estado: "en_curso",
      periodo_hasta: "202607",
      trabajo_id: null,
      solicitada_por: ux,
      terminada_en: null,
    });
    expect([...f.periodos].sort()).toEqual([...periodos6].sort());
    expect((await admin.query("select tenant_id, cliente_id from regla_importacion where id = $1", [id])).rows[0]).toEqual({
      tenant_id: X,
      cliente_id: c.id,
    });
  });

  it("el ultimo periodo es el mayor aunque lleguen desordenados; admite 1 y 12 periodos", async () => {
    const c1 = await ei.cliente(X);
    const id1 = filas(await iniciar(c1, ["202605", "202607", "202606"]))[0].id as string;
    expect((await ei.filaImportacion(id1)).periodo_hasta).toBe("202607");
    const c2 = await ei.cliente(X);
    expect(cod(await iniciar(c2, ["202607"]))).toBe("ok");
    const c3 = await ei.cliente(X);
    expect(cod(await iniciar(c3, periodosHasta("202607", 12)))).toBe("ok");
    const c4 = await ei.cliente(X);
    const f = await ei.filaImportacion(filas(await iniciar(c4, periodosHasta("202602", 12)))[0].id);
    expect(f.periodo_hasta, "cruza el cambio de ano").toBe("202602");
  });

  it("audita regla.historial_importado con {importacionId, periodos: n}, actor usuario y el cliente; sin RUC ni razon social", async () => {
    const c = await ei.cliente(X);
    let id = "";
    const { filas: aud } = await ei.capturar(X, "regla.historial_importado", async () => {
      id = filas(await iniciar(c, periodos6))[0].id;
    });
    expect(aud).toHaveLength(1);
    expect(aud[0]!.actor_tipo).toBe("usuario");
    expect(aud[0]!.usuario_id).toBe(ux);
    expect(aud[0]!.cliente_id).toBe(c.id);
    expect(aud[0]!.datos).toEqual({ importacionId: id, periodos: 6 });
    expect(JSON.stringify(aud[0]!.datos)).not.toContain(c.ruc);
  });

  it("rechaza periodos fuera de 1..12, repetidos, nulos o con formato invalido (22023) y no crea nada", async () => {
    const c = await ei.cliente(X);
    const casos: [string, unknown][] = [
      ["0 periodos", []],
      ["13 periodos", periodosHasta("202607", 13)],
      ["repetidos", ["202607", "202606", "202607"]],
      ["arreglo nulo", null],
      ["elemento nulo", ["202607", null]],
      ["mes 13", ["202613"]],
      ["mes 00", ["202600"]],
      ["5 digitos", ["20267"]],
      ["con guion", ["2026-07"]],
      ["letras", ["ABCDEF"]],
    ];
    for (const [nombre, p] of casos) expect(cod(await iniciar(c, p)), nombre).toBe("22023");
    expect((await admin.query("select count(*)::int as n from regla_importacion where cliente_id = $1", [c.id])).rows[0].n).toBe(0);
  });

  it("cliente archivado: 55000; cliente de otro estudio o inexistente: P0002", async () => {
    expect(cod(await iniciar(cArch, periodos6)), "archivado").toBe("55000");
    expect(cod(await iniciar(cy, periodos6)), "de otro estudio").toBe("P0002");
    expect(cod(await iniciar("00000000-0000-7000-8000-000000000000", periodos6)), "inexistente").toBe("P0002");
  });

  it("con otra en curso (trabajo vivo o reciente sin trabajo): 23505 y la existente no cambia", async () => {
    for (const trabajo of ["en_cola", "ejecutando", null] as const) {
      const c = await ei.cliente(X);
      const job = trabajo ? await ei.job(X, c, { tipo: "reglas.historial.importar", estado: trabajo }) : null;
      const previa = await ei.importacion(X, c, { estado: "en_curso", trabajoId: job, haceMin: 5 });
      expect(cod(await iniciar(c, periodos6)), String(trabajo)).toBe("23505");
      expect((await ei.filaImportacion(previa)).estado, "la previa sigue en curso").toBe("en_curso");
    }
  });

  it("autocierre: la en curso con trabajo en error o cancelado, o sin trabajo tras 10 min, se cierra como fallida «interrumpido» y se inicia la nueva", async () => {
    const casos: [string, (c: ClientePrueba) => Promise<string>][] = [
      ["trabajo en error", async (c) => ei.job(X, c, { tipo: "reglas.historial.importar", estado: "error", motivo: "sunat_no_responde", hace: 120 })],
      ["trabajo cancelado", async (c) => ei.job(X, c, { tipo: "reglas.historial.importar", estado: "cancelado", motivo: "cancelado_usuario", hace: 120 })],
    ];
    for (const [nombre, crearJob] of casos) {
      const c = await ei.cliente(X);
      const previa = await ei.importacion(X, c, { estado: "en_curso", trabajoId: await crearJob(c), haceMin: 30 });
      const nueva = filas(await iniciar(c, periodos6))[0].id as string;
      const p = await ei.filaImportacion(previa);
      expect(p.estado, nombre).toBe("fallida");
      expect(p.motivo, nombre).toBe("interrumpido");
      expect(p.terminada_en, nombre).not.toBeNull();
      expect((await ei.filaImportacion(nueva)).estado).toBe("en_curso");
    }
    const c = await ei.cliente(X);
    const previa = await ei.importacion(X, c, { estado: "en_curso", trabajoId: null, haceMin: 11 });
    const nueva = filas(await iniciar(c, periodos6))[0].id as string;
    expect(await ei.filaImportacion(previa), "sin trabajo tras 10 minutos").toMatchObject({ estado: "fallida", motivo: "interrumpido" });
    expect((await ei.filaImportacion(nueva)).estado).toBe("en_curso");
  });

  it("no toca reglas, compras ni versiones", async () => {
    const c = await ei.cliente(X);
    const antes = await ei.contadoresAjenos(X);
    expect(cod(await iniciar(c, periodos6))).toBe("ok");
    expect(await ei.contadoresAjenos(X)).toEqual(antes);
  });
});

// =================================================================================================
describe("reglas_importacion_trabajo", () => {
  it("fija trabajo_id una vez; un segundo trabajo no lo cambia", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { estado: "en_curso" });
    const j1 = await ei.job(X, c, { tipo: "reglas.historial.importar", estado: "en_cola" });
    const j2 = await ei.job(X, c, { tipo: "reglas.historial.importar", estado: "en_cola" });
    expect(cod(await llamar(backend, comoX(), SQL.trabajo, [imp, j1]))).toBe("ok");
    expect((await ei.filaImportacion(imp)).trabajo_id).toBe(j1);
    const otra = await llamar(backend, comoX(), SQL.trabajo, [imp, j2]);
    if (!otra.ok) expect(["55000", "22023"]).toContain(otra.code);
    expect((await ei.filaImportacion(imp)).trabajo_id, "no se reasigna").toBe(j1);
  });

  it("una importacion de otro estudio o inexistente: P0002", async () => {
    const cI = await ei.cliente(Y);
    const impY = await ei.importacion(Y, cI, { estado: "en_curso" });
    const c = await ei.cliente(X);
    const j = await ei.job(X, c, { tipo: "reglas.historial.importar", estado: "en_cola" });
    expect(cod(await llamar(backend, comoX(), SQL.trabajo, [impY, j])), "ajena").toBe("P0002");
    expect(cod(await llamar(backend, comoX(), SQL.trabajo, ["00000000-0000-7000-8000-000000000000", j])), "inexistente").toBe("P0002");
    expect((await ei.filaImportacion(impY)).trabajo_id).toBeNull();
  });
});

// =================================================================================================
describe("reglas_importacion_completar (D-2, D-4, CA-5, CA-6)", () => {
  async function enCurso(): Promise<{ c: ClientePrueba; imp: string }> {
    const c = await ei.cliente(X);
    return { c, imp: await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" }) };
  }

  it("inserta las candidatas, devuelve cuantas y deja la importacion completada con el resumen", async () => {
    const { c, imp } = await enCurso();
    const docs = [ei.docNuevo(), ei.docNuevo(), ei.docNuevo()];
    const r = await completar(
      imp,
      [
        carga({ docNumero: docs[0], destino: "DNG", dng: 11, dg: 1, total: 12, periodos: 5 }),
        carga({ docNumero: docs[1], destino: null, dg: 2, dng: 2, dgng: 1, mixto: 1, razonSocial: null }),
        carga({ docNumero: docs[2], docTipo: "1", destino: "DG", dg: 3, dng: 0, periodos: 2 }),
      ],
      resumen({ leidos: 5, sinDatos: ["202605"], candidatas: 3, sinCriterio: 1 }),
    );
    expect(filas(r)[0].n).toBe(3);
    const f = await ei.filaImportacion(imp);
    expect(f).toMatchObject({ estado: "completada", periodos_leidos: 5, periodos_sin_datos: ["202605"], candidatas: 3, sin_criterio: 1 });
    expect(f.terminada_en).not.toBeNull();
    const cs = (await admin.query("select * from regla_candidata where importacion_id = $1 order by doc_numero", [imp])).rows;
    expect(cs).toHaveLength(3);
    const a = cs.find((x) => x.doc_numero === docs[0])!;
    expect(a).toMatchObject({
      tenant_id: X,
      cliente_id: c.id,
      doc_tipo: "6",
      razon_social: "PROVEEDOR SINTETICO SAC",
      destino_propuesto: "DNG",
      n_dg: 1,
      n_dgng: 0,
      n_dng: 11,
      n_mixto: 0,
      n_total: 12,
      periodos_con_proveedor: 5,
      estado: "pendiente",
      destino_elegido: null,
      regla_id: null,
      resuelta_por: null,
      resuelta_en: null,
    });
    expect(cs.find((x) => x.doc_numero === docs[1])).toMatchObject({ destino_propuesto: null, razon_social: null, n_mixto: 1 });
    expect(cs.find((x) => x.doc_numero === docs[2])).toMatchObject({ doc_tipo: "1", destino_propuesto: "DG" });
  });

  it("sin candidatas (arreglo vacio) tambien completa y devuelve 0", async () => {
    const { imp } = await enCurso();
    expect(filas(await completar(imp, [], resumen({ candidatas: 0 })))[0].n).toBe(0);
    expect((await ei.filaImportacion(imp)).estado).toBe("completada");
  });

  it("acepta los limites del umbral (4 de 5, 2 de 2) y un proveedor sin criterio con cualquier conteo coherente", async () => {
    const { imp } = await enCurso();
    const r = await completar(imp, [
      carga({ docNumero: ei.docNuevo(), destino: "DNG", dng: 4, dg: 1 }),
      carga({ docNumero: ei.docNuevo(), destino: "DGNG", dgng: 2, dng: 0 }),
      carga({ docNumero: ei.docNuevo(), destino: null, dg: 1, dgng: 1, dng: 1, mixto: 1 }),
    ]);
    expect(filas(r)[0].n).toBe(3);
  });

  it("reemplaza las pendientes del cliente de otras importaciones y conserva las activadas, descartadas y las ya reemplazadas (CA-5)", async () => {
    const c = await ei.cliente(X);
    const otro = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606" });
    const regla = await ei.regla(X, c, { docNumero: ei.docNuevo() });
    const pend = await ei.candidata(X, c, vieja);
    const act = await ei.candidata(X, c, vieja, { estado: "activada", destinoElegido: "DNG", reglaId: regla });
    const desc = await ei.candidata(X, c, vieja, { estado: "descartada" });
    const reem = await ei.candidata(X, c, vieja, { estado: "reemplazada" });
    const impOtro = await ei.importacion(X, otro, { periodoHasta: "202606" });
    const pendOtroCliente = await ei.candidata(X, otro, impOtro);
    const impY = await ei.importacion(Y, cy, { periodoHasta: "202606" });
    const pendOtroEstudio = await ei.candidata(Y, cy, impY);
    const nueva = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    filas(await completar(nueva, [carga({ docNumero: ei.docNuevo() })]));
    expect((await ei.filaCandidata(pend)).estado, "la pendiente se reemplaza").toBe("reemplazada");
    expect(await ei.filaCandidata(act), "la activada se conserva").toMatchObject({ estado: "activada", regla_id: regla });
    expect((await ei.filaCandidata(desc)).estado).toBe("descartada");
    expect((await ei.filaCandidata(reem)).estado).toBe("reemplazada");
    expect((await ei.filaCandidata(pendOtroCliente)).estado, "otro cliente").toBe("pendiente");
    expect((await ei.filaCandidata(pendOtroEstudio)).estado, "otro estudio").toBe("pendiente");
    expect((await ei.filaImportacion(vieja)).estado, "la importacion anterior no cambia").toBe("completada");
    expect(await ei.cuantasCandidatas(nueva, "pendiente")).toBe(1);
  });

  it("no toca regla_aprendida, compras, versiones, aplicaciones ni confirmaciones, ni la regla viva del proveedor", async () => {
    const { c, imp } = await enCurso();
    const doc = ei.docNuevo();
    const regla = await ei.regla(X, c, { docNumero: doc, destino: "DG", version: 4 });
    const antes = await ei.contadoresAjenos(X);
    filas(await completar(imp, [carga({ docNumero: doc, destino: "DNG" })]));
    expect(await ei.contadoresAjenos(X)).toEqual(antes);
    expect(await ei.reglasVivas(c.id, doc)).toMatchObject([{ id: regla, destino: "DG", version: 4 }]);
  });

  it("una importacion que ya no esta en curso (completada, fallida, de otro estudio o inexistente): 55000 y no inserta nada", async () => {
    const c = await ei.cliente(X);
    const completada = await ei.importacion(X, c, { estado: "completada" });
    const fallida = await ei.importacion(X, c, { estado: "fallida" });
    const cI = await ei.cliente(Y);
    const ajena = await ei.importacion(Y, cI, { estado: "en_curso" });
    for (const [nombre, id] of [
      ["completada", completada],
      ["fallida", fallida],
      ["de otro estudio", ajena],
      ["inexistente", "00000000-0000-7000-8000-000000000000"],
    ] as const) {
      expect(cod(await completar(id, [carga({ docNumero: ei.docNuevo() })])), nombre).toBe("55000");
    }
    for (const id of [completada, fallida, ajena]) expect(await ei.cuantasCandidatas(id)).toBe(0);
    expect((await ei.filaImportacion(fallida)).estado).toBe("fallida");
    expect((await ei.filaImportacion(ajena)).estado, "la de otro estudio sigue en curso").toBe("en_curso");
  });

  it("valida todas las candidatas o ninguna: gramatica del documento, destino, conteos, umbral y razon social dan 22023 sin cambios", async () => {
    const { c, imp } = await enCurso();
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606" });
    const pend = await ei.candidata(X, c, vieja);
    const buena = () => carga({ docNumero: ei.docNuevo() });
    const casos: [string, Record<string, unknown>][] = [
      ["numero vacio", carga({ docNumero: "" })],
      ["numero «-»", carga({ docNumero: "-" })],
      ["numero con espacio inicial", carga({ docNumero: " 20100070970" })],
      ["numero con espacio final", carga({ docNumero: "20100070970 " })],
      ["numero en minusculas", carga({ docNumero: "abc123def" })],
      ["numero de 21 caracteres", carga({ docNumero: "2".repeat(21) })],
      ["tipo vacio", carga({ docTipo: "" })],
      ["tipo de 3 caracteres", carga({ docTipo: "123" })],
      ["destino invalido", carga({ destino: "XX" as never })],
      ["destino en minusculas", carga({ destino: "dng" as never })],
      ["1 de 1 (bajo el minimo de 2)", carga({ dng: 1 })],
      ["3 de 5 (60 %)", carga({ dng: 3, dg: 2 })],
      ["3 de 4 (75 %)", carga({ dng: 3, dg: 1 })],
      ["los mixtos bajan el porcentaje", carga({ dng: 4, mixto: 2 })],
      ["total que no es la suma", carga({ total: 9 })],
      ["conteo negativo", carga({ dg: -1, dng: 6, total: 5 })],
      ["razon social de 201 caracteres", carga({ razonSocial: "A".repeat(201) })],
      ["razon social con salto de linea", carga({ razonSocial: "A\nB" })],
      ["razon social con control bidi", carga({ razonSocial: "A‮B" })],
    ];
    for (const [nombre, mala] of casos) {
      expect(cod(await completar(imp, [buena(), mala], resumen(), comoWorker(), true)), nombre).toBe("22023");
    }
    for (const [nombre, payload] of [
      ["objeto en vez de arreglo", { a: 1 }],
      ["nulo", null],
      ["escalar", 5],
    ] as const)
      expect(cod(await completar(imp, payload as never, resumen(), comoWorker(), true)), nombre).toBe("22023");
    // Ninguno de los intentos dejo rastro: la importacion sigue en curso, sin candidatas, y la pendiente anterior intacta.
    expect((await ei.filaImportacion(imp)).estado).toBe("en_curso");
    expect(await ei.cuantasCandidatas(imp)).toBe(0);
    expect((await ei.filaCandidata(pend)).estado).toBe("pendiente");
  });

  it("1.000 candidatas en una sola llamada (jsonb_to_recordset)", async () => {
    const { imp } = await enCurso();
    const lote = Array.from({ length: 1000 }, () => carga({ docNumero: ei.docNuevo() }));
    expect(filas(await completar(imp, lote, resumen({ candidatas: 1000 })))[0].n).toBe(1000);
    expect(await ei.cuantasCandidatas(imp)).toBe(1000);
  }, 30_000);
});

// =================================================================================================
describe("reglas_importacion_fallar", () => {
  it("pasa la en curso a fallida con el motivo y la hora, sin candidatas", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { estado: "en_curso" });
    expect(cod(await llamar(worker, comoWorker(), SQL.fallar, [imp, "credencial_invalida"]))).toBe("ok");
    const f = await ei.filaImportacion(imp);
    expect(f).toMatchObject({ estado: "fallida", motivo: "credencial_invalida" });
    expect(f.terminada_en).not.toBeNull();
    expect(await ei.cuantasCandidatas(imp)).toBe(0);
  });

  it("un motivo que no es de trabajo no se acepta (22023 o 23514) y la importacion no cambia", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { estado: "en_curso" });
    const r = await llamar(worker, comoWorker(), SQL.fallar, [imp, "inventado"]);
    expect(["22023", "23514"]).toContain(cod(r));
    expect((await ei.filaImportacion(imp)).estado).toBe("en_curso");
  });

  it("una importacion ya cerrada o de otro estudio no cambia", async () => {
    const c = await ei.cliente(X);
    const hecha = await ei.importacion(X, c, { estado: "completada" });
    const cI = await ei.cliente(Y);
    const ajena = await ei.importacion(Y, cI, { estado: "en_curso" });
    // Control positivo: la propia en curso si se cierra (no es vacuo).
    const propia = await ei.importacion(X, await ei.cliente(X), { estado: "en_curso" });
    expect(cod(await llamar(worker, comoWorker(), SQL.fallar, [propia, "error_interno"]))).toBe("ok");
    for (const id of [hecha, ajena]) {
      const r = await llamar(worker, comoWorker(), SQL.fallar, [id, "error_interno"]);
      if (!r.ok) expect(["55000", "P0002"]).toContain(r.code);
    }
    expect((await ei.filaImportacion(hecha)).estado).toBe("completada");
    expect((await ei.filaImportacion(ajena)).estado).toBe("en_curso");
  });
});

// =================================================================================================
describe("reglas_candidatas_activar · una, varias y cambiar el destino (D-5, CA-3)", () => {
  it("activa una: crea la regla de 021 con origen 'importacion', ultimo periodo, destino propuesto y autor; la candidata queda activada", async () => {
    const { c, cs } = await escenario(1);
    const m = porId(await activar(c, [{ id: cs[0]!.id }]));
    expect(m.get(cs[0]!.id)).toMatchObject({ resultado: "activada" });
    const regla = m.get(cs[0]!.id).regla_id as string;
    expect(regla).toBeTruthy();
    expect(await ei.reglasVivas(c.id, cs[0]!.docNumero)).toMatchObject([
      {
        id: regla,
        tenant_id: X,
        destino: "DNG",
        activa: true,
        version: 1,
        periodo_aprendido: "202607",
        origen: "importacion",
        creada_por: ux,
        actualizada_por: ux,
      },
    ]);
    const k = await ei.filaCandidata(cs[0]!.id);
    expect(k).toMatchObject({ estado: "activada", regla_id: regla, resuelta_por: ux });
    expect(k.resuelta_en).not.toBeNull();
  });

  it("cambiar el destino antes de activar crea la regla con el elegido y lo guarda en la candidata (CA-3)", async () => {
    const { c, cs } = await escenario(1);
    const m = porId(await activar(c, [{ id: cs[0]!.id, destino: "DG" }]));
    expect(m.get(cs[0]!.id).resultado).toBe("activada");
    expect((await ei.reglasVivas(c.id, cs[0]!.docNumero))[0]).toMatchObject({ destino: "DG", origen: "importacion" });
    expect(await ei.filaCandidata(cs[0]!.id)).toMatchObject({ destino_elegido: "DG", destino_propuesto: "DNG" });
  });

  it("activa varias a la vez, cada una con su destino, y solo toca las pedidas", async () => {
    const { c, cs } = await escenario(4);
    const m = porId(await activar(c, [{ id: cs[0]!.id }, { id: cs[1]!.id, destino: "DGNG" }, { id: cs[2]!.id }]));
    expect([...m.values()].map((x) => x.resultado)).toEqual(["activada", "activada", "activada"]);
    expect((await ei.reglasVivas(c.id, cs[1]!.docNumero))[0]!.destino).toBe("DGNG");
    expect((await ei.filaCandidata(cs[3]!.id)).estado, "la no pedida sigue pendiente").toBe("pendiente");
    expect(await ei.reglasVivas(c.id, cs[3]!.docNumero)).toEqual([]);
  });

  it("no inserta en regla_confirmacion ni toca compras, versiones o aplicaciones (D-7); solo suma reglas", async () => {
    const { c, cs } = await escenario(2);
    const antes = await ei.contadoresAjenos(X);
    expect(cod(await activar(c, [{ id: cs[0]!.id }, { id: cs[1]!.id }]))).toBe("ok");
    const despues = await ei.contadoresAjenos(X);
    expect(despues.regla_confirmacion).toBe(antes.regla_confirmacion);
    expect(despues.regla_aprendida).toBe(antes.regla_aprendida! + 2);
    expect({ ...despues, regla_aprendida: 0 }).toEqual({ ...antes, regla_aprendida: 0 });
  });

  it("audita regla.creada por cada regla con origen 'importacion', el destino y el usuario, sin RUC ni razon social", async () => {
    const { c, cs } = await escenario(2, { razonSocial: "CANARIO RAZON ZZ SAC" });
    const { filas: aud } = await ei.capturar(X, "regla.creada", () => activar(c, [{ id: cs[0]!.id }, { id: cs[1]!.id }]));
    expect(aud).toHaveLength(2);
    for (const f of aud) {
      expect(f.actor_tipo).toBe("usuario");
      expect(f.usuario_id).toBe(ux);
      expect(f.cliente_id).toBe(c.id);
      expect(f.entidad).toBe("regla_aprendida");
      expect(f.datos).toMatchObject({ destino: "DNG", activa: true, origen: "importacion" });
      const t = JSON.stringify(f.datos);
      for (const p of [cs[0]!.docNumero, cs[1]!.docNumero, "CANARIO", c.ruc]) expect(t, p).not.toContain(p);
    }
  });
});

// =================================================================================================
describe("reglas_candidatas_activar · conflictos y estados (D-6, U-8, CA-4)", () => {
  it("regla viva con el mismo destino: ya_aprendida; con otro destino (activa o no): conflicto; nada cambia", async () => {
    const { c, cs } = await escenario(3);
    const mismo = await ei.regla(X, c, { docNumero: cs[0]!.docNumero, destino: "DNG", version: 2 });
    const otro = await ei.regla(X, c, { docNumero: cs[1]!.docNumero, destino: "DG", version: 3 });
    const inactiva = await ei.regla(X, c, { docNumero: cs[2]!.docNumero, destino: "DGNG", activa: false, version: 5 });
    const m = porId(await activar(c, cs.map((x) => ({ id: x.id }))));
    expect(m.get(cs[0]!.id)).toMatchObject({ resultado: "ya_aprendida", regla_id: null });
    expect(m.get(cs[1]!.id)).toMatchObject({ resultado: "conflicto", regla_id: null });
    expect(m.get(cs[2]!.id)).toMatchObject({ resultado: "conflicto", regla_id: null });
    for (const k of cs) expect((await ei.filaCandidata(k.id)).estado, "sigue pendiente").toBe("pendiente");
    expect((await ei.reglasVivas(c.id, cs[0]!.docNumero))[0]).toMatchObject({ id: mismo, version: 2, destino: "DNG" });
    expect((await ei.reglasVivas(c.id, cs[1]!.docNumero))[0]).toMatchObject({ id: otro, version: 3, destino: "DG", origen: "contador" });
    expect((await ei.reglasVivas(c.id, cs[2]!.docNumero))[0]).toMatchObject({ id: inactiva, version: 5, activa: false });
  });

  it("el destino elegido decide el conflicto: igual al de la regla viva es ya_aprendida; distinto es conflicto", async () => {
    const { c, cs } = await escenario(2);
    await ei.regla(X, c, { docNumero: cs[0]!.docNumero, destino: "DG" });
    await ei.regla(X, c, { docNumero: cs[1]!.docNumero, destino: "DNG" });
    const m = porId(await activar(c, [{ id: cs[0]!.id, destino: "DG" }, { id: cs[1]!.id, destino: "DGNG" }]));
    expect(m.get(cs[0]!.id).resultado).toBe("ya_aprendida");
    expect(m.get(cs[1]!.id).resultado).toBe("conflicto");
  });

  it("una regla eliminada no es conflicto: se activa y la eliminada queda como estaba", async () => {
    const { c, cs } = await escenario(1);
    const vieja = await ei.regla(X, c, { docNumero: cs[0]!.docNumero, destino: "DG", eliminada: true });
    expect(porId(await activar(c, [{ id: cs[0]!.id }])).get(cs[0]!.id).resultado).toBe("activada");
    const vivas = await ei.reglasVivas(c.id, cs[0]!.docNumero);
    expect(vivas).toHaveLength(1);
    expect(vivas[0]!.id).not.toBe(vieja);
    expect((await admin.query("select eliminada_en from regla_aprendida where id = $1", [vieja])).rows[0].eliminada_en).not.toBeNull();
  });

  it("sin criterio claro (U-8): sin destino es sin_criterio; con destino elegido a mano se activa", async () => {
    const { c, cs } = await escenario(2, { destino: null, dng: 2, dg: 2, dgng: 1 });
    const m = porId(await activar(c, [{ id: cs[0]!.id }, { id: cs[1]!.id, destino: "DNG" }]));
    expect(m.get(cs[0]!.id)).toMatchObject({ resultado: "sin_criterio", regla_id: null });
    expect(m.get(cs[1]!.id).resultado).toBe("activada");
    expect((await ei.reglasVivas(c.id, cs[1]!.docNumero))[0]).toMatchObject({ destino: "DNG", origen: "importacion" });
    expect(await ei.reglasVivas(c.id, cs[0]!.docNumero)).toEqual([]);
    expect((await ei.filaCandidata(cs[0]!.id)).estado).toBe("pendiente");
  });

  it("no_pendiente: la ya activada, descartada o reemplazada no se vuelve a activar; activar dos veces deja una sola regla", async () => {
    const { c, imp, cs } = await escenario(1);
    const descartada = await ei.candidata(X, c, imp, { estado: "descartada" });
    const reemplazada = await ei.candidata(X, c, imp, { estado: "reemplazada" });
    const primera = porId(await activar(c, [{ id: cs[0]!.id }]));
    expect(primera.get(cs[0]!.id).resultado).toBe("activada");
    const reglaId = primera.get(cs[0]!.id).regla_id;
    const m = porId(await activar(c, [{ id: cs[0]!.id }, { id: descartada }, { id: reemplazada }]));
    for (const id of [cs[0]!.id, descartada, reemplazada]) expect(m.get(id).resultado, id).toBe("no_pendiente");
    const vivas = await ei.reglasVivas(c.id, cs[0]!.docNumero);
    expect(vivas.map((v) => v.id)).toEqual([reglaId]);
    expect((await ei.filaCandidata(descartada)).estado).toBe("descartada");
  });
});

// =================================================================================================
describe("reglas_candidatas_activar · ids ajenos, cliente y validacion (CA-7)", () => {
  it("un id de otro cliente, de otro estudio o inexistente da P0002 a todo: ni siquiera las validas del lote se activan", async () => {
    const { c, cs } = await escenario(2);
    const otro = await escenario(1);
    const cI = await ei.cliente(Y);
    const impY = await ei.importacion(Y, cI);
    const candY = await ei.candidata(Y, cI, impY);
    for (const [nombre, ajeno] of [
      ["de otro cliente", otro.cs[0]!.id],
      ["de otro estudio", candY],
      ["inexistente", "00000000-0000-7000-8000-000000000000"],
    ] as const) {
      expect(cod(await activar(c, [{ id: cs[0]!.id }, { id: ajeno }])), nombre).toBe("P0002");
    }
    for (const k of cs) expect((await ei.filaCandidata(k.id)).estado).toBe("pendiente");
    expect((await ei.filaCandidata(otro.cs[0]!.id)).estado).toBe("pendiente");
    expect(await ei.reglasVivas(otro.c.id, otro.cs[0]!.docNumero)).toEqual([]);
    // Control positivo: lo mismo sin el ajeno si se activa.
    expect(cod(await activar(c, [{ id: cs[0]!.id }]))).toBe("ok");
  });

  it("no crea una regla en otro cliente aunque el proveedor sea el mismo", async () => {
    const a = await escenario(1);
    const b = await ei.cliente(X);
    expect(cod(await activar(a.c, [{ id: a.cs[0]!.id }]))).toBe("ok");
    expect(await ei.reglasVivas(b.id, a.cs[0]!.docNumero)).toEqual([]);
    expect(await ei.reglasVivas(a.c.id, a.cs[0]!.docNumero)).toHaveLength(1);
  });

  it("cliente archivado: 55000 y no se activa nada; cliente de otro estudio o inexistente: P0002", async () => {
    const impA = await ei.importacion(X, cArch, { periodoHasta: "202607" });
    const candA = await ei.candidata(X, cArch, impA);
    expect(cod(await activar(cArch, [{ id: candA }])), "archivado").toBe("55000");
    expect((await ei.filaCandidata(candA)).estado).toBe("pendiente");
    const { cs } = await escenario(1);
    expect(cod(await activar(cy, [{ id: cs[0]!.id }])), "cliente de otro estudio").toBe("P0002");
    expect(cod(await activar("00000000-0000-7000-8000-000000000000", [{ id: cs[0]!.id }])), "cliente inexistente").toBe("P0002");
  });

  it("validacion: 0 ids, mas de 1.000, repetidos, destino invalido, id faltante, items junto con todas, ni items ni todas (22023)", async () => {
    const { c, imp, cs } = await escenario(1);
    const id = cs[0]!.id;
    const casos: [string, unknown, string | null][] = [
      ["0 items", [], null],
      ["1.001 items", Array.from({ length: 1001 }, () => ({ id: "00000000-0000-7000-8000-000000000001" })), null],
      ["repetidos", [{ id }, { id }], null],
      ["destino invalido", [{ id, destino: "XX" }], null],
      ["destino en minusculas", [{ id, destino: "dng" }], null],
      ["sin id", [{ destino: "DNG" }], null],
      ["id que no es uuid", [{ id: "abc" }], null],
      ["no es un arreglo", { id }, null],
      ["items y todas a la vez", [{ id }], imp],
      ["ni items ni todas", null, null],
    ];
    for (const [nombre, items, todas] of casos) expect(cod(await activar(c, items, todas)), nombre).toBe("22023");
    expect((await ei.filaCandidata(id)).estado).toBe("pendiente");
  });
});

// =================================================================================================
describe("reglas_candidatas_activar · «todas» (D-6, U-8, CA-4)", () => {
  it("activa las pendientes con destino propuesto, omite y informa las de conflicto, y no incluye las sin criterio ni las ya resueltas", async () => {
    const { c, imp, cs } = await escenario(3);
    const sinCriterio = await ei.candidata(X, c, imp, { docNumero: ei.docNuevo(), destino: null, dng: 2, dg: 2, dgng: 1 });
    const resuelta = await ei.candidata(X, c, imp, { docNumero: ei.docNuevo(), estado: "descartada" });
    await ei.regla(X, c, { docNumero: cs[1]!.docNumero, destino: "DG" });
    await ei.regla(X, c, { docNumero: cs[2]!.docNumero, destino: "DNG" });
    const antes = await ei.contadoresAjenos(X);
    const m = porId(await activar(c, null, imp));
    expect(m.get(cs[0]!.id)).toMatchObject({ resultado: "activada" });
    expect(m.get(cs[1]!.id)).toMatchObject({ resultado: "conflicto", regla_id: null });
    expect(m.get(cs[2]!.id)).toMatchObject({ resultado: "ya_aprendida", regla_id: null });
    expect(m.has(sinCriterio), "las sin criterio nunca entran en «todas»").toBe(false);
    expect(m.has(resuelta), "las resueltas no entran").toBe(false);
    expect((await ei.filaCandidata(sinCriterio)).estado).toBe("pendiente");
    expect(await ei.reglasVivas(c.id, (await admin.query("select doc_numero from regla_candidata where id = $1", [sinCriterio])).rows[0].doc_numero)).toEqual([]);
    expect((await ei.reglasVivas(c.id, cs[0]!.docNumero))[0]).toMatchObject({ origen: "importacion", periodo_aprendido: "202607", destino: "DNG" });
    const despues = await ei.contadoresAjenos(X);
    expect(despues.regla_aprendida).toBe(antes.regla_aprendida! + 1);
    expect(despues.regla_confirmacion).toBe(antes.regla_confirmacion);
  });

  it("solo vale para la ultima importacion completada del cliente: una anterior, una en curso o fallida, o de otro cliente se rechazan", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202605" });
    const candVieja = await ei.candidata(X, c, vieja);
    const nueva = await ei.importacion(X, c, { periodoHasta: "202607" });
    const candNueva = await ei.candidata(X, c, nueva);
    expect(cod(await activar(c, null, vieja)), "anterior").toBe("22023");
    const otro = await escenario(1);
    expect(["22023", "P0002"], "de otro cliente").toContain(cod(await activar(c, null, otro.imp)));
    const enCurso = await ei.importacion(X, await ei.cliente(X), { estado: "en_curso" });
    const c2 = await ei.cliente(X);
    const fallida = await ei.importacion(X, c2, { estado: "fallida" });
    expect(["22023", "P0002"], "en curso de otro cliente").toContain(cod(await activar(c, null, enCurso)));
    expect(cod(await activar(c2, null, fallida)), "fallida").toBe("22023");
    for (const k of [candVieja, candNueva]) expect((await ei.filaCandidata(k)).estado).toBe("pendiente");
    // Control positivo: la ultima si se acepta.
    expect(porId(await activar(c, null, nueva)).get(candNueva).resultado).toBe("activada");
    expect((await ei.filaCandidata(candVieja)).estado, "la de la anterior sigue pendiente").toBe("pendiente");
  });

  it("sin pendientes con destino devuelve cero filas y no falla", async () => {
    const { c, imp } = await escenario(0);
    await ei.candidata(X, c, imp, { docNumero: ei.docNuevo(), destino: null, dng: 2, dg: 2, dgng: 1 });
    expect(filas(await activar(c, null, imp))).toEqual([]);
  });

  it("de otro estudio: no activa nada", async () => {
    const cI = await ei.cliente(Y);
    const impY = await ei.importacion(Y, cI);
    const candY = await ei.candidata(Y, cI, impY);
    const { c } = await escenario(1);
    expect(["22023", "P0002"]).toContain(cod(await activar(c, null, impY)));
    expect((await ei.filaCandidata(candY)).estado).toBe("pendiente");
    expect(await ei.reglasVivas(cI.id, (await admin.query("select doc_numero from regla_candidata where id = $1", [candY])).rows[0].doc_numero)).toEqual([]);
  });
});

// =================================================================================================
describe("reglas_candidata_reemplazar (D-6, CA-4)", () => {
  async function conConflicto(version = 3) {
    const { c, cs } = await escenario(1);
    const regla = await ei.regla(X, c, { docNumero: cs[0]!.docNumero, destino: "DG", version, periodoAprendido: "202601" });
    return { c, cand: cs[0]!.id, doc: cs[0]!.docNumero, regla };
  }

  it("con la version vigente cambia el destino de la regla, la version, el periodo y el autor, y marca la candidata activada", async () => {
    const { c, cand, doc, regla } = await conConflicto(3);
    const { filas: aud } = await ei.capturar(X, "regla.editada", async () => {
      expect(cod(await reemplazar(c, cand, null, 3))).toBe("ok");
    });
    expect((await ei.reglasVivas(c.id, doc))[0]).toMatchObject({
      id: regla,
      destino: "DNG",
      version: 4,
      periodo_aprendido: "202607",
      actualizada_por: ux,
    });
    const k = await ei.filaCandidata(cand);
    expect(k).toMatchObject({ estado: "activada", regla_id: regla, resuelta_por: ux });
    expect(aud).toHaveLength(1);
    expect(aud[0]!.datos).toEqual({ destino: { anterior: "DG", nuevo: "DNG" } });
    expect(aud[0]!.usuario_id).toBe(ux);
    expect(aud[0]!.entidad_id).toBe(regla);
  });

  it("con un destino elegido usa ese en vez del propuesto", async () => {
    const { c, cand, doc } = await conConflicto(1);
    expect(cod(await reemplazar(c, cand, "DGNG", 1))).toBe("ok");
    expect((await ei.reglasVivas(c.id, doc))[0]!.destino).toBe("DGNG");
    expect((await ei.filaCandidata(cand)).destino_elegido).toBe("DGNG");
  });

  it("con una version vieja da CA409 y no cambia nada", async () => {
    const { c, cand, doc, regla } = await conConflicto(3);
    expect(cod(await reemplazar(c, cand, null, 2)), "version vieja").toBe("CA409");
    expect(cod(await reemplazar(c, cand, null, 4)), "version futura").toBe("CA409");
    expect((await ei.reglasVivas(c.id, doc))[0]).toMatchObject({ id: regla, destino: "DG", version: 3, periodo_aprendido: "202601" });
    expect((await ei.filaCandidata(cand)).estado).toBe("pendiente");
  });

  it("solo con conflicto «distinto»: sin regla viva, con la misma o ya activada se rechaza y no cambia nada", async () => {
    const { c, cs } = await escenario(3);
    const igual = await ei.regla(X, c, { docNumero: cs[1]!.docNumero, destino: "DNG" });
    expect(["55000", "22023", "P0002"], "sin regla viva").toContain(cod(await reemplazar(c, cs[0]!.id, null, 1)));
    expect(["55000", "22023", "P0002"], "mismo destino").toContain(cod(await reemplazar(c, cs[1]!.id, null, 1)));
    expect((await ei.reglasVivas(c.id, cs[1]!.docNumero))[0]).toMatchObject({ id: igual, version: 1 });
    expect(await ei.reglasVivas(c.id, cs[0]!.docNumero)).toEqual([]);
    // Candidata ya activada: control positivo con una pendiente en conflicto.
    const { c: c2, cand } = await conConflicto(1);
    expect(cod(await reemplazar(c2, cand, null, 1))).toBe("ok");
    expect(["55000", "22023", "P0002"], "ya activada").toContain(cod(await reemplazar(c2, cand, null, 2)));
  });

  it("candidata de otro cliente, de otro estudio o inexistente: P0002; cliente archivado: 55000", async () => {
    const a = await conConflicto(1);
    const b = await conConflicto(1);
    const cI = await ei.cliente(Y);
    const impY = await ei.importacion(Y, cI);
    const candY = await ei.candidata(Y, cI, impY);
    expect(cod(await reemplazar(a.c, b.cand, null, 1)), "de otro cliente").toBe("P0002");
    expect(cod(await reemplazar(a.c, candY, null, 1)), "de otro estudio").toBe("P0002");
    expect(cod(await reemplazar(a.c, "00000000-0000-7000-8000-000000000000", null, 1)), "inexistente").toBe("P0002");
    const impA = await ei.importacion(X, cArch, { periodoHasta: "202607" });
    const candA = await ei.candidata(X, cArch, impA);
    expect(cod(await reemplazar(cArch, candA, null, 1)), "archivado").toBe("55000");
    expect((await ei.reglasVivas(b.c.id, b.doc))[0]).toMatchObject({ destino: "DG", version: 1 });
  });

  it("no registra confirmacion para 033 (D-7)", async () => {
    const { c, cand } = await conConflicto(1);
    const antes = await ei.contadoresAjenos(X);
    expect(cod(await reemplazar(c, cand, null, 1))).toBe("ok");
    const despues = await ei.contadoresAjenos(X);
    expect(despues.regla_confirmacion).toBe(antes.regla_confirmacion);
    expect(despues.regla_aprendida).toBe(antes.regla_aprendida);
  });
});

// =================================================================================================
describe("reglas_candidatas_descartar (D-5, CA-3)", () => {
  it("descarta las pendientes, guarda quien y cuando, no crea reglas y devuelve el resultado por candidata", async () => {
    const { c, imp, cs } = await escenario(3);
    const activada = await ei.candidata(X, c, imp, { estado: "activada" });
    const antes = await ei.contadoresAjenos(X);
    const m = porId(await descartar(c, [cs[0]!.id, cs[1]!.id, activada]));
    expect(m.get(cs[0]!.id).descartada).toBe(true);
    expect(m.get(cs[1]!.id).descartada).toBe(true);
    expect(m.get(activada).descartada, "la ya resuelta no se descarta").toBe(false);
    expect(await ei.filaCandidata(cs[0]!.id)).toMatchObject({ estado: "descartada", resuelta_por: ux, regla_id: null });
    expect((await ei.filaCandidata(cs[0]!.id)).resuelta_en).not.toBeNull();
    expect((await ei.filaCandidata(cs[2]!.id)).estado, "la no pedida sigue pendiente").toBe("pendiente");
    expect((await ei.filaCandidata(activada)).estado).toBe("activada");
    expect(await ei.contadoresAjenos(X)).toEqual(antes);
  });

  it("audita regla.candidata_descartada por candidata descartada con {candidataId, importacionId} y nada personal", async () => {
    const { c, imp, cs } = await escenario(3, { razonSocial: "CANARIO RAZON ZZ SAC" });
    const { filas: aud } = await ei.capturar(X, "regla.candidata_descartada", () => descartar(c, [cs[0]!.id, cs[1]!.id]));
    expect(aud).toHaveLength(2);
    expect(aud.map((f) => (f.datos as { candidataId: string }).candidataId).sort()).toEqual([cs[0]!.id, cs[1]!.id].sort());
    for (const f of aud) {
      expect(f.actor_tipo).toBe("usuario");
      expect(f.usuario_id).toBe(ux);
      expect(f.cliente_id).toBe(c.id);
      expect(Object.keys(f.datos as object).sort()).toEqual(["candidataId", "importacionId"]);
      expect((f.datos as { importacionId: string }).importacionId).toBe(imp);
      const t = JSON.stringify(f.datos);
      for (const p of [cs[0]!.docNumero, "CANARIO", c.ruc]) expect(t, p).not.toContain(p);
    }
  });

  it("una ya descartada o resuelta no genera auditoria ni cambia", async () => {
    const { c, cs } = await escenario(1);
    expect(cod(await descartar(c, [cs[0]!.id]))).toBe("ok");
    const { filas: aud } = await ei.capturar(X, "regla.candidata_descartada", () => descartar(c, [cs[0]!.id]));
    expect(aud).toHaveLength(0);
    expect((await ei.filaCandidata(cs[0]!.id)).estado).toBe("descartada");
  });

  it("id de otro cliente, de otro estudio o inexistente: P0002 a todo; lista vacia, nula o de mas de 1.000: 22023", async () => {
    const a = await escenario(2);
    const b = await escenario(1);
    const cI = await ei.cliente(Y);
    const candY = await ei.candidata(Y, cI, await ei.importacion(Y, cI));
    for (const [nombre, ajeno] of [
      ["de otro cliente", b.cs[0]!.id],
      ["de otro estudio", candY],
      ["inexistente", "00000000-0000-7000-8000-000000000000"],
    ] as const)
      expect(cod(await descartar(a.c, [a.cs[0]!.id, ajeno])), nombre).toBe("P0002");
    expect((await ei.filaCandidata(a.cs[0]!.id)).estado).toBe("pendiente");
    expect(cod(await descartar(a.c, [])), "vacia").toBe("22023");
    expect(cod(await descartar(a.c, null)), "nula").toBe("22023");
    expect(
      cod(await descartar(a.c, Array.from({ length: 1001 }, () => "00000000-0000-7000-8000-000000000001"))),
      "1.001 ids",
    ).toBe("22023");
    expect(cod(await descartar(a.c, [a.cs[0]!.id]))).toBe("ok");
  });
});

// =================================================================================================
describe("auditoria del flujo completo sin RUC, razon social ni montos (D-11, CA-12)", () => {
  it("importar, completar, activar, reemplazar y descartar no dejan canarios en los datos de la auditoria", async () => {
    const c = await ei.cliente(X);
    const docs = [ei.docNuevo(), ei.docNuevo(), ei.docNuevo()];
    const acciones = ["regla.historial_importado", "regla.creada", "regla.editada", "regla.candidata_descartada"];
    const previas = new Set<string>();
    for (const a of acciones) for (const f of await ei.filas(X, a)) previas.add(f.id);
    const imp = filas(await iniciar(c, periodos6))[0].id as string;
    const razon = "CANARIO RAZON ZZ SAC";
    filas(
      await completar(imp, docs.map((d) => carga({ docNumero: d, razonSocial: razon, dng: 10, total: 10 })), resumen({ candidatas: 3 })),
    );
    const cands = (await admin.query("select id, doc_numero from regla_candidata where importacion_id = $1", [imp])).rows as { id: string; doc_numero: string }[];
    const idDe = (d: string) => cands.find((x) => x.doc_numero === d)!.id;
    await ei.regla(X, c, { docNumero: docs[1], destino: "DG", version: 1 });
    expect(cod(await activar(c, [{ id: idDe(docs[0]) }]))).toBe("ok");
    expect(cod(await reemplazar(c, idDe(docs[1]), null, 1))).toBe("ok");
    expect(cod(await descartar(c, [idDe(docs[2])]))).toBe("ok");
    const nuevas = [];
    for (const a of acciones) for (const f of await ei.filas(X, a)) if (!previas.has(f.id)) nuevas.push(f);
    expect(new Set(nuevas.map((f) => f.accion))).toEqual(new Set(acciones));
    for (const f of nuevas) {
      const t = JSON.stringify(f.datos);
      for (const p of [...docs, c.ruc, "CANARIO", "PROVEEDOR"]) expect(t, `${f.accion}: ${p}`).not.toContain(p);
      expect(t, `${f.accion}: montos`).not.toMatch(/\d+\.\d{2}/);
    }
  });
});

// =================================================================================================
describe("sin SAVEPOINT en el worker (D-1, CA-6; nota de 0038)", () => {
  it("insertar una compra del worker dentro de un SAVEPOINT sigue fallando cerrado (42501) y fuera del SAVEPOINT funciona", async () => {
    const c = await ei.cliente(X);
    const prop = await ei.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 5 });
    const control = await worker.withTenant({ tenantId: X }, async (tx) => {
      await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: "1", docNumero: "20100070971" });
      return "ok";
    });
    expect(control, "control sin SAVEPOINT").toBe("ok");
    const dentro = await worker.withTenant({ tenantId: X }, async (tx) => {
      await tx.query("SAVEPOINT sp_025");
      try {
        await compraDelWorker(tx, c.id, prop, DESCARGA, { numero: "2", docNumero: "20100070972" });
        return "ok";
      } catch (e) {
        await tx.query("ROLLBACK TO SAVEPOINT sp_025");
        return String((e as { code?: string }).code);
      }
    });
    expect(dentro).toBe("42501");
  });
});

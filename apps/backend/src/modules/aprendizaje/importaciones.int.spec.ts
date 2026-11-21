// Spec 025 (T6, rojo): importar el historial presentado y ver la última importación por HTTP (D-1, D-2, D-4, D-10, D-11; CA-1, CA-5, CA-6, CA-12).
// Contrato (plan 025, «Contratos: HTTP» y «shared»; formas de `solicitarImportacionSchema` e `importacionVistaSchema` de `@contapp/shared`):
//  - `POST /clientes/:clienteId/reglas/importaciones` (`reglas.gestionar`) con `{periodos?: 1..12}` (6 por defecto, `.strict()`) -> 202
//    `{importacion: ImportacionVista, trabajoId}`. Los periodos los calcula el backend: del MES ANTERIOR (hora de Lima) hacia atrás.
//    La importación queda `en_curso` con `trabajoId` = el trabajo `reglas.historial.importar` encolado (cola y canal `sire`, prioridad
//    `interactivo`, parámetros `{importacionId}` y nada más, creado por quien pidió) y se audita `regla.historial_importado`
//    `{importacionId, periodos: n}`. El backend no llama al SIRE ni lee compras: solo encola (D-1).
//  - 409 `importacion_en_curso` (una por cliente; una en curso cuyo trabajo terminó en error o se perdió se cierra como `fallida`
//    con motivo `interrumpido` al pedir la siguiente), `cliente_archivado`, `credencial_no_configurada` (falta `sol` o `sire_api`, las
//    de la descarga de 014) o `credencial_invalida` (la de SIRE marcada inválida): sin importación, sin trabajo y sin auditoría.
//    400 `solicitud_invalida` si el cuerpo no cumple el esquema. Cliente de otro estudio, no visible o inexistente: 404 igual.
//  - `GET /clientes/:clienteId/reglas/importaciones/ultima` (`reglas.ver`) -> 200 `{importacion: ImportacionVista | null}`: la más
//    reciente por fecha de solicitud, sea cual sea su estado. `resumen` solo con conteos (leídos, sin datos, candidatas, sin criterio).
//  - Todas: `Cache-Control: no-store`, errores `{codigo}`; ni montos, RUC ni razón social en errores, logs ni auditoría (D-11).
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente. Las tablas son de T10; la siembra sin ellas no rompe la carga.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { capturarLogs } from "../../../test/soporte.js";
import {
  abrirBancoAprendizaje,
  cumple,
  inexistente,
  NO_ENCONTRADO,
  periodosEsperados,
  PERIODOS_6,
  rutaImportaciones,
  rutasDeAprendizaje,
  rutaUltima,
  RUTAS_025,
  type Actor,
  type BancoAprendizaje,
  type Estudio,
} from "../../../test/soporte-aprendizaje.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoAprendizaje;
let E: Estudio;
let F: Estudio;
let contador: Actor; // responsable del cliente: reglas.gestionar, alcance asignado
let asistente: Actor; // colaborador: solo reglas.ver
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado: no lo ve

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
afterEach(() => {
  vi.useRealTimers();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id], ...o });
const importar = (a: Actor, c: { id: string }, cuerpo: unknown = {}) => v.http(a, "POST", rutaImportaciones(c.id), cuerpo);
const ultima = (a: Actor, c: { id: string }) => v.http(a, "GET", rutaUltima(c.id));
const u = (): string => E.titular.id;

/** Una respuesta de error no lleva datos del cliente ni del proveedor (D-11): ni RUC ni razón social ni montos. */
function sinDatosDelCliente(r: { text: string }, c: Cliente): void {
  expect(r.text).not.toContain(c.ruc);
  expect(r.text).not.toContain(CANARIO_RUC);
  expect(r.text).not.toContain(CANARIO_RAZON);
  expect(r.text).not.toMatch(/\d+\.\d{2}/);
}

// --- Contrato de rutas -----------------------------------------------------------------------------------------------------

describe("contrato de rutas de 025 (D-10, CA-8)", () => {
  it("las seis rutas existen y declaran su permiso (ver: reglas.ver; importar, activar, reemplazar y descartar: reglas.gestionar)", () => {
    const rutas = rutasDeAprendizaje(v.b.c.p.b.h.app)
      .map((r) => `${r.metodo} ${r.ruta} ${r.permiso}`)
      .sort();
    expect(rutas).toEqual(RUTAS_025);
  });

  it("el backend no llama al SIRE: ni el módulo ni el paquete dependen de @contapp/sunat (D-1, CA-6)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)));
    const fuentes = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"));
    expect(fuentes.length, "el módulo `aprendizaje` debe tener fuentes (T12)").toBeGreaterThan(0);
    for (const n of fuentes) expect(readFileSync(join(dir, n), "utf8"), n).not.toMatch(/@contapp\/sunat/);
    const paquete = readFileSync(join(dir, "../../../package.json"), "utf8");
    expect(paquete).not.toMatch(/@contapp\/sunat/);
    expect(existsSync(join(dir, "aprendizaje.module.ts")), "el módulo se llama aprendizaje (plan 025)").toBe(true);
  });
});

// --- POST importaciones: camino feliz ----------------------------------------------------------------------------------------

describe("POST …/reglas/importaciones · encola la importación sin llamar al SIRE (CA-1, CA-5, CA-6)", () => {
  it("202 { importacion, trabajoId }: en curso, 6 periodos por defecto, trabajo reglas.historial.importar encolado y auditado", async () => {
    const c = await nuevoCliente();
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body).sort()).toEqual(["importacion", "trabajoId"]);
    expect(cumple("importacionVistaSchema", r.body.importacion), r.text).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.ms).toBeLessThan(3000); // nada espera al SIRE

    const imp = r.body.importacion;
    expect(imp).toMatchObject({ estado: "en_curso", terminadaEn: null, resumen: null, motivo: null, trabajoId: r.body.trabajoId });
    expect(imp.periodos).toEqual(periodosEsperados(6));
    expect(imp.solicitadaPor).toMatchObject({ id: contador.id });

    const trabajos = await v.trabajosImportar(E.tenantId, c.id);
    expect(trabajos).toHaveLength(1);
    expect(trabajos[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: "reglas.historial.importar",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
      estado: "en_cola",
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(trabajos[0].parametros).toEqual({ importacionId: imp.id }); // los periodos y el cliente salen de la fila, no del payload

    const filas = await v.importacionesBd(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: imp.id,
      estado: "en_curso",
      periodos: imp.periodos,
      periodo_hasta: imp.periodos[0],
      trabajo_id: r.body.trabajoId,
      solicitada_por: contador.id,
      terminada_en: null,
    });
    expect(await v.candidatasBd(c.id)).toEqual([]); // el backend no crea candidatas: las escribe el worker

    const aud = await v.auditoriaDe(E.tenantId, "regla.historial_importado");
    const suya = aud.filter((f) => f.cliente_id === c.id);
    expect(suya).toHaveLength(1);
    expect(suya[0]).toMatchObject({ usuario_id: contador.id });
    expect(suya[0].datos).toEqual({ importacionId: imp.id, periodos: 6 });
  });

  it.each([1, 3, 12])("periodos = %i: los del mes anterior hacia atrás, en orden del más reciente al más antiguo", async (n) => {
    const c = await nuevoCliente();
    const r = await importar(contador, c, { periodos: n });
    expect(r.status, r.text).toBe(202);
    expect(r.body.importacion.periodos).toEqual(periodosEsperados(n));
    expect(r.body.importacion.periodos).toHaveLength(n);
    expect((await v.importacionesBd(c.id))[0]?.periodos).toEqual(periodosEsperados(n));
  });

  it.each([
    ["2026-03-15T17:00:00Z", ["202602", "202601", "202512"]], // mitad de mes: el anterior es febrero
    ["2026-04-01T04:30:00Z", ["202602", "202601", "202512"]], // 23:30 del 31 de marzo en Lima: aún es marzo, el anterior es febrero
    ["2026-04-01T05:00:00Z", ["202603", "202602", "202601"]], // 00:00 del 1 de abril en Lima: el anterior es marzo
    ["2026-01-01T04:59:00Z", ["202511", "202510", "202509"]], // 23:59 del 31 de diciembre en Lima: el anterior es noviembre
    ["2026-01-01T05:00:00Z", ["202512", "202511", "202510"]], // enero (Lima): cruza el año hacia atrás
  ])("reloj fijo en %s (UTC): periodos %j (el mes anterior se cuenta en Lima, no en UTC)", async (ahora, esperados) => {
    const c = await nuevoCliente();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(ahora) });
    const r = await importar(contador, c, { periodos: 3 });
    vi.useRealTimers();
    expect(r.status, r.text).toBe(202);
    expect(r.body.importacion.periodos).toEqual(esperados);
    expect((await v.importacionesBd(c.id))[0]).toMatchObject({ periodo_hasta: esperados[0] });
  });

  it("12 periodos desde enero cruzan el año: 202511 … 202412", async () => {
    const c = await nuevoCliente();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-20T15:00:00Z") });
    const r = await importar(contador, c, { periodos: 12 });
    vi.useRealTimers();
    expect(r.status, r.text).toBe(202);
    expect(r.body.importacion.periodos).toEqual([
      "202512", "202511", "202510", "202509", "202508", "202507", "202506", "202505", "202504", "202503", "202502", "202501",
    ]);
  });

  it("una importación completada anterior no impide pedir otra; sus candidatas siguen pendientes hasta que el worker complete la nueva (D-4)", async () => {
    const c = await nuevoCliente();
    const anterior = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "3 days", candidatas: 2 });
    const cs = await v.sembrarCandidatas(E.tenantId, c.id, anterior, [{}, { estado: "descartada" }], u());
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(202);
    const filas = await v.importacionesBd(c.id);
    expect(filas.map((f) => f.estado)).toEqual(["completada", "en_curso"]);
    expect((await v.candidataBd(cs[0]!.id))?.estado).toBe("pendiente"); // el reemplazo lo hace `reglas_importacion_completar` del worker
    expect((await v.candidataBd(cs[1]!.id))?.estado).toBe("descartada");
  });

  it("no toca compras ni reglas: solo la importación, el trabajo y la auditoría", async () => {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "1", doc: CANARIO_RUC, usuarioId: u() });
    const antes = { compras: await v.compras(c.id), reglas: await v.reglasBd(c.id) };
    const versionesAntes = (await v.versiones(antes.compras[0]!.id)).length;
    expect((await importar(contador, c)).status).toBe(202);
    expect(await v.compras(c.id)).toEqual(antes.compras);
    expect(await v.reglasBd(c.id)).toEqual(antes.reglas);
    expect((await v.versiones(antes.compras[0]!.id)).length).toBe(versionesAntes);
  });
});

// --- POST importaciones: cuerpo inválido -----------------------------------------------------------------------------------

describe("POST …/reglas/importaciones · cuerpo inválido (400 solicitud_invalida, sin efectos)", () => {
  it.each([
    ["periodos 0", { periodos: 0 }],
    ["periodos 13", { periodos: 13 }],
    ["periodos negativo", { periodos: -1 }],
    ["periodos decimal", { periodos: 2.5 }],
    ["periodos como texto", { periodos: "6" }],
    ["periodos nulo", { periodos: null }],
    ["clave extra (cliente)", { periodos: 6, clienteId: "x" }],
    ["clave extra (la lista de periodos la calcula el backend)", { periodos: 3, lista: ["202610"] }],
  ])("%s", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const antes = await v.fotoAprendizaje(E.tenantId, c.id);
    const r = await importar(contador, c, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.fotoAprendizaje(E.tenantId, c.id)).toEqual(antes);
    expect(await v.auditoriaDe(E.tenantId, "regla.historial_importado")).not.toContainEqual(expect.objectContaining({ cliente_id: c.id }));
  });
});

// --- POST importaciones: 409 ------------------------------------------------------------------------------------------------

describe("POST …/reglas/importaciones · 409 sin encolar (CA-5)", () => {
  /** Nada cambió: ni importaciones, ni candidatas, ni reglas, ni trabajos encolados. */
  const sinEfectos = async (c: Cliente, antes: unknown): Promise<void> => {
    expect(await v.fotoAprendizaje(E.tenantId, c.id)).toEqual(antes);
  };

  it("con otra importación en curso (con su trabajo vivo): 409 importacion_en_curso y no encola un segundo trabajo", async () => {
    const c = await nuevoCliente();
    const trabajo = await v.sembrarTrabajoImportar(E.tenantId, c.id, "en_cola", u());
    await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), trabajoId: trabajo });
    const antes = await v.fotoAprendizaje(E.tenantId, c.id);
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "importacion_en_curso" });
    sinDatosDelCliente(r, c);
    await sinEfectos(c, antes);
  });

  it("con el trabajo ejecutándose también es importacion_en_curso", async () => {
    const c = await nuevoCliente();
    const trabajo = await v.sembrarTrabajoImportar(E.tenantId, c.id, "ejecutando", u());
    await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), trabajoId: trabajo });
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "importacion_en_curso" });
  });

  it("una en curso cuyo trabajo terminó en error se cierra como fallida (interrumpido) y la nueva se acepta (autocierre del plan)", async () => {
    const c = await nuevoCliente();
    const trabajo = await v.sembrarTrabajoImportar(E.tenantId, c.id, "error", u());
    const vieja = await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), trabajoId: trabajo, solicitadaHace: "1 hour" });
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(202);
    const filas = await v.importacionesBd(c.id);
    expect(filas.find((f) => f.id === vieja)).toMatchObject({ estado: "fallida", motivo: "interrumpido" });
    expect(filas.filter((f) => f.estado === "en_curso")).toHaveLength(1);
  });

  it("una en curso sin trabajo desde hace más de 10 minutos también se cierra y la nueva se acepta; con 1 minuto de vida no", async () => {
    const c = await nuevoCliente();
    const vieja = await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), solicitadaHace: "11 minutes" });
    expect((await importar(contador, c)).status).toBe(202);
    expect((await v.importacionesBd(c.id)).find((f) => f.id === vieja)).toMatchObject({ estado: "fallida", motivo: "interrumpido" });

    const d = await nuevoCliente();
    await v.sembrarImportacion(E.tenantId, d.id, { estado: "en_curso", usuarioId: u(), solicitadaHace: "1 minute" });
    const r = await importar(contador, d);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "importacion_en_curso" });
  });

  it("10 pedidos simultáneos dejan UNA importación en curso y UN trabajo: un 202 y nueve 409 importacion_en_curso", async () => {
    const c = await nuevoCliente();
    const rs = await Promise.all(Array.from({ length: 10 }, () => importar(contador, c)));
    expect(rs.filter((r) => r.status === 202), rs.map((r) => r.status).join()).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 202)) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "importacion_en_curso" });
    }
    expect((await v.importacionesBd(c.id)).filter((f) => f.estado === "en_curso")).toHaveLength(1);
    expect(await v.trabajosImportar(E.tenantId, c.id)).toHaveLength(1);
    expect((await v.auditoriaDe(E.tenantId, "regla.historial_importado")).filter((f) => f.cliente_id === c.id)).toHaveLength(1);
  });

  it("cliente archivado: 409 cliente_archivado, sin importación ni trabajo", async () => {
    const c = await nuevoCliente({ archivado: true });
    const antes = await v.fotoAprendizaje(E.tenantId, c.id);
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    await sinEfectos(c, antes);
  });

  it.each([
    ["sin clave SOL", { sol: "no_configurada", sireApi: "verificada" }],
    ["sin credencial de la API del SIRE", { sol: "verificada", sireApi: "no_configurada" }],
    ["sin ninguna de las dos", { sol: "no_configurada", sireApi: "no_configurada" }],
  ] as const)("%s: 409 credencial_no_configurada y no se encola", async (_n, cred) => {
    const c = await nuevoCliente(cred);
    const antes = await v.fotoAprendizaje(E.tenantId, c.id);
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
    await sinEfectos(c, antes);
  });

  it("credencial de SIRE marcada inválida: 409 credencial_invalida y no se encola", async () => {
    const c = await nuevoCliente({ sol: "verificada", sireApi: "invalida" });
    const antes = await v.fotoAprendizaje(E.tenantId, c.id);
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_invalida" });
    await sinEfectos(c, antes);
  });

  it("configuradas sin verificar bastan (como la descarga de 014)", async () => {
    const c = await nuevoCliente({ sol: "configurada", sireApi: "configurada" });
    expect((await importar(contador, c)).status).toBe(202);
  });

  it("archivado y sin credenciales: gana cliente_archivado", async () => {
    const c = await nuevoCliente({ archivado: true, sol: "no_configurada", sireApi: "no_configurada" });
    const r = await importar(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
  });

  it("importacion_en_curso es un código de CODIGOS_ERROR_REGLA y el cuerpo cumple errorReglaSchema", async () => {
    const d = await nuevoCliente();
    await v.sembrarImportacion(E.tenantId, d.id, { estado: "en_curso", usuarioId: u(), solicitadaHace: "1 minute" });
    const e = await importar(contador, d);
    expect(e.status, e.text).toBe(409);
    expect(cumple("errorReglaSchema", e.body), e.text).toBe(true);
  });
});

// --- Alcance ----------------------------------------------------------------------------------------------------------------

describe("alcance de las rutas de importación (D-10, CA-7)", () => {
  it("cliente de otro estudio, no visible para el contador o inexistente: el mismo 404 sin revelar cuál es", async () => {
    const ajeno = await v.cliente(F, {});
    const propio = await nuevoCliente();
    // Control: el mismo contador sí puede importar para un cliente suyo (si no, el 404 de abajo sería el de la ruta que falta).
    expect((await importar(contador, await nuevoCliente())).status).toBe(202);
    const noExiste = await importar(contador, { id: inexistente() });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    for (const c of [ajeno, propio]) {
      const quien = c === ajeno ? contador : contadorAjeno;
      const r = await importar(quien, c);
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(noExiste.text);
    }
    expect(await v.importacionesBd(ajeno.id)).toEqual([]);
    expect(await v.importacionesBd(propio.id)).toEqual([]);
    expect(await v.trabajosImportar(F.tenantId, ajeno.id)).toEqual([]);
  });

  it("sin sesión: 401", async () => {
    const c = await nuevoCliente();
    const r = await v.sinSesion("POST", rutaImportaciones(c.id), {});
    expect(r.status, r.text).toBe(401);
    const g = await v.sinSesion("GET", rutaUltima(c.id));
    expect(g.status, g.text).toBe(401);
  });
});

// --- GET ultima -------------------------------------------------------------------------------------------------------------

describe("GET …/reglas/importaciones/ultima (reglas.ver)", () => {
  it("un cliente sin importaciones: 200 { importacion: null } y Cache-Control: no-store", async () => {
    const c = await nuevoCliente();
    const r = await ultima(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ importacion: null });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("completada: con resumen de solo conteos, periodos sin datos, quién la pidió y cuándo terminó", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarImportacion(E.tenantId, c.id, {
      usuarioId: contador.id,
      periodos: PERIODOS_6,
      periodosLeidos: 5,
      periodosSinDatos: ["202605"],
      candidatas: 12,
      sinCriterio: 3,
      trabajoId: await v.sembrarTrabajoImportar(E.tenantId, c.id, "en_cola", u()),
    });
    const r = await ultima(asistente, c);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body)).toEqual(["importacion"]);
    expect(cumple("importacionVistaSchema", r.body.importacion), r.text).toBe(true);
    expect(r.body.importacion).toMatchObject({
      id,
      estado: "completada",
      periodos: [...PERIODOS_6],
      solicitadaPor: { id: contador.id },
      resumen: { periodosLeidos: 5, periodosSinDatos: ["202605"], candidatas: 12, sinCriterio: 3 },
      motivo: null,
    });
    expect(r.body.importacion.terminadaEn).not.toBeNull();
    expect(r.body.importacion.trabajoId).not.toBeNull();
    expect(Object.keys(r.body.importacion).sort()).toEqual(
      ["estado", "id", "motivo", "periodos", "resumen", "solicitadaEn", "solicitadaPor", "terminadaEn", "trabajoId"].sort(),
    );
    expect(Object.keys(r.body.importacion.resumen).sort()).toEqual(["candidatas", "periodosLeidos", "periodosSinDatos", "sinCriterio"]);
  });

  it("es la más reciente por fecha de solicitud, sea cual sea su estado (fallida con motivo; en curso sin resumen)", async () => {
    const c = await nuevoCliente();
    await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "3 days", candidatas: 4 });
    const fallida = await v.sembrarImportacion(E.tenantId, c.id, { estado: "fallida", usuarioId: u(), solicitadaHace: "2 days", motivo: "credencial_invalida" });
    const r1 = await ultima(contador, c);
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.importacion).toMatchObject({ id: fallida, estado: "fallida", motivo: "credencial_invalida" });
    expect(cumple("importacionVistaSchema", r1.body.importacion), r1.text).toBe(true);

    const enCurso = await v.sembrarImportacion(E.tenantId, c.id, { estado: "en_curso", usuarioId: u(), solicitadaHace: "1 minute" });
    const r2 = await ultima(contador, c);
    expect(r2.body.importacion).toMatchObject({ id: enCurso, estado: "en_curso", resumen: null, terminadaEn: null, motivo: null });
  });

  it("la importación de un cliente no aparece en otro del mismo estudio ni en otro estudio", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    const ajeno = await v.cliente(F, {});
    await v.sembrarImportacion(E.tenantId, a.id, { usuarioId: u() });
    await v.sembrarImportacion(F.tenantId, ajeno.id, { usuarioId: F.titular.id });
    expect((await ultima(contador, b)).body).toEqual({ importacion: null });
    const r = await ultima(contador, ajeno);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
  });

  it("cliente no visible o inexistente: el mismo 404", async () => {
    const c = await nuevoCliente();
    expect((await ultima(contador, c)).status).toBe(200); // control: el responsable sí lo ve
    const noVisible = await ultima(contadorAjeno, c);
    const noExiste = await ultima(contador, { id: inexistente() });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noVisible.status, noVisible.text).toBe(404);
    expect(noVisible.text).toBe(noExiste.text);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
  });
});

// --- D-11 · canarios --------------------------------------------------------------------------------------------------------

describe("CA-12 · ni RUC ni razón social ni montos en errores, logs ni auditoría de importar", () => {
  it("importar (feliz y con 409) con canarios sembrados no filtra nada", async () => {
    const c = await nuevoCliente();
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u(), solicitadaHace: "2 days", candidatas: 1 });
    await v.sembrarCandidatas(E.tenantId, c.id, imp, [{ docNumero: CANARIO_RUC, razonSocial: CANARIO_RAZON }], u());
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F001", numero: "1", doc: CANARIO_RUC, razonSocial: CANARIO_RAZON, usuarioId: u() });
    const { resultado, logs } = await capturarLogs(async () => ({
      feliz: await importar(contador, c),
      repetida: await importar(contador, c),
      invalida: await importar(contador, c, { periodos: 99 }),
      ultima: await ultima(contador, c),
    }));
    expect(resultado.feliz.status, resultado.feliz.text).toBe(202);
    expect(resultado.repetida.status, resultado.repetida.text).toBe(409);
    expect(resultado.invalida.status, resultado.invalida.text).toBe(400);
    for (const r of [resultado.feliz, resultado.repetida, resultado.invalida, resultado.ultima]) sinDatosDelCliente(r, c);
    for (const prohibido of [CANARIO_RUC, CANARIO_RAZON, c.ruc]) expect(logs, `logs con ${prohibido}`).not.toContain(prohibido);
    const texto = await v.textoAuditoria(E.tenantId);
    expect(texto).not.toContain(CANARIO_RUC);
    expect(texto).not.toContain(CANARIO_RAZON);
    const trabajos = await v.trabajosImportar(E.tenantId, c.id);
    expect(JSON.stringify(trabajos.map((t) => [t.parametros, t.resultado]))).not.toContain(CANARIO_RAZON);
  });
});

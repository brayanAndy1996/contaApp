// Spec 012b (T6, rojo): POST /clientes/:clienteId/periodos/:periodo/{compras|ventas}/archivos (D1, D2, D5, D6, D9, D10;
// CA-3, CA-4, CA-6, CA-7, CA-8, CA-9 parte HTTP, CA-10 parte HTTP). Contrato (plan 012b, «Contratos: HTTP»; `generarArchivoSchema`):
//  - Cuerpo estricto { estadoVisto: "abierto"|"revisado", huella } (64 hex). `libro` sale de la ruta. Cualquier clave extra
//    (permitirProvisional, registro, libro, tenantId, clienteId, usuarioId…) = 400 `solicitud_invalida` sin encolar.
//  - Permiso `sire.aprobar_generar` (asistente y lectura: 403 `permiso_denegado`); `ClienteScopeGuard` antes del permiso (un no
//    asignado, inexistente u otro estudio: 404 `no_encontrado`); sin sesión 401.
//  - 202 `{ trabajoId }` y NADA más. Encola `archivo.generar` (cola `archivos`, canal `ninguno`) con parámetros exactos
//    { periodo, libro, estadoVisto, huella }, `creado_por` = quien pulsó; publica en Redis; NO cambia el estado del periodo,
//    no guarda versiones ni storage (eso lo hace el worker). Idempotente con el trabajo vivo (008 D8).
//  - Orden de las comprobaciones (plan): 400 -> guards -> 409 `cliente_archivado` -> 409 `estado_invalido` (el `estadoVisto` ya no
//    es el vigente; también con el periodo `generado`) -> 422 `formato_no_oficial` (NODE_ENV=production, leído en cada petición)
//    -> 409 `resumen_cambiado` (la huella ya no coincide) -> 422 `prevalidacion_fallida` { codigo, errores[], erroresOmitidos }.
//  - Un rechazo nunca encola ni cambia el estado del periodo. Logs, parámetros y respuestas no llevan razones sociales, montos
//    ni rutas de storage (D10) salvo la lista de errores del 422, que existe para mostrarse.
// Rojo: el módulo `archivos` aún no existe (T12): toda ruta responde 404 de ruta inexistente.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base as baseCompras,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type IdsPorNumero,
  type OpcionesCompra,
} from "../../../test/soporte-compras.js";
import {
  abrirArchivos,
  archivosBajo,
  descuadrada,
  HEX64,
  prepararStorage,
  rutaArchivos,
  type Libro,
  type SoporteArchivos,
  type StoragePrueba,
} from "../../../test/soporte-archivos.js";
import { boletas290y292, type FilaV } from "../../../test/soporte-ventas.js";
import { capturarLogs, forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;

const CORRECCIONES: Record<string, NonNullable<OpcionesCompra["versiones"]>> = {
  "F001-1040": [{ montos: { biDg: "0.00", isc: "770.00" }, accion: "sugerencia" }],
  "F001-2056": [{ montos: { biDg: "8.97", noGravado: "12.51" }, accion: "sugerencia" }],
};

const nuevoCliente = (o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
async function compras(o: Parameters<BancoCompras["cliente"]>[1] = {}, corregido = true): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await nuevoCliente(o);
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u(), ...(corregido ? { versiones: CORRECCIONES } : {}) });
  return { c, ids };
}
async function ventas(filas: FilaV[] = boletas290y292(), o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<{ c: Cliente; ids: string[] }> {
  const c = await nuevoCliente(o);
  const ids = await v.sembrarVentas(E.tenantId, c.id, filas, { usuarioId: u() });
  return { c, ids };
}

const previo = (a: Actor, c: Cliente, libro: Libro) => v.llamar(a, "GET", `${rutaArchivos(c.id, PERIODO, libro)}/previo`);
const previoOk = async (...args: Parameters<typeof previo>) => {
  const r = await previo(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};
const generar = (a: Actor, c: { id: string }, libro: Libro, cuerpo?: unknown, periodo = PERIODO) =>
  v.llamar(a, "POST", rutaArchivos(c.id, periodo, libro), cuerpo);
const huellaDe = async (c: Cliente, libro: Libro): Promise<string> => (await previoOk(contador, c, libro)).body.huella;
const cuerpoDe = async (c: Cliente, libro: Libro, estadoVisto: "abierto" | "revisado" = "abierto") => ({
  estadoVisto,
  huella: await huellaDe(c, libro),
});
const enRedis = (tenantId: string, id: string) =>
  v.b.redis.zscore(v.b.claves.pend("archivos", tenantId), id) as Promise<string | null>;
const enProduccion = async <T>(fn: () => Promise<T>): Promise<T> => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
};
const MALA = "f".repeat(64);

/** Nada se encoló, ni cambió el estado del periodo, ni quedó versión o archivo en storage. */
async function sinEfectos(c: Cliente, estado: "abierto" | "revisado" | "generado" | null = null): Promise<void> {
  expect(await A.trabajosArchivo(c.id)).toEqual([]);
  expect(await A.versionesBd(c.id)).toEqual([]);
  expect(archivosBajo(st.dir, `archivos/${E.tenantId}/${c.id}/`)).toEqual([]);
  expect((await v.periodoFila(c.id))?.estado ?? null).toBe(estado);
  expect((await A.periodoVentas(c.id))?.estado ?? null).toBeNull();
}

// --- 202 ----------------------------------------------------------------------------------------------------------------------

describe("CA-2 parte HTTP · POST responde 202 con el trabajoId y encola sin tocar el estado", () => {
  it("compras: 202 { trabajoId }, fila en_cola de la cola archivos con los parámetros exactos y publicada en Redis", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    const r = await generar(contador, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajoId"]);
    expect(r.body.trabajoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ms).toBeLessThan(3000);
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const filas = await A.trabajosArchivo(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: "archivo.generar",
      cola: "archivos",
      canal: "ninguno",
      estado: "en_cola",
      intentos: 0,
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(filas[0].parametros).toEqual({ periodo: PERIODO, libro: "compras", estadoVisto: "abierto", huella: cuerpo.huella });
    expect(await enRedis(E.tenantId, r.body.trabajoId)).not.toBeNull();
  });

  it("ventas: el libro sale de la ruta y queda en los parámetros del trabajo", async () => {
    const { c } = await ventas();
    const cuerpo = await cuerpoDe(c, "ventas");
    const r = await generar(contador, c, "ventas", cuerpo);
    expect(r.status, r.text).toBe(202);
    const filas = await A.trabajosArchivo(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0].parametros).toEqual({ periodo: PERIODO, libro: "ventas", estadoVisto: "abierto", huella: cuerpo.huella });
  });

  it("202 no cambia el estado del periodo, no guarda versiones ni archivos: eso es del worker", async () => {
    const { c } = await compras();
    const antes = await v.foto(c.id);
    expect((await generar(contador, c, "compras", await cuerpoDe(c, "compras"))).status).toBe(202);
    const despues = await v.foto(c.id);
    expect(despues.compras).toEqual(antes.compras);
    expect(despues.versiones).toEqual(antes.versiones);
    expect(despues.periodo).toBeNull();
    expect(await A.versionesBd(c.id)).toEqual([]);
    expect(archivosBajo(st.dir, `archivos/${E.tenantId}/${c.id}/`)).toEqual([]);
  });

  it("con el periodo revisado y estadoVisto = revisado: 202 y el trabajo lo lleva en sus parámetros", async () => {
    const { c } = await compras();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const cuerpo = await cuerpoDe(c, "compras", "revisado");
    const r = await generar(contador, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(202);
    expect((await A.trabajosArchivo(c.id))[0].parametros.estadoVisto).toBe("revisado");
    expect((await v.periodoFila(c.id)).estado).toBe("revisado"); // sigue como estaba hasta que el worker lo pase a generado
  });

  it("Dueño y contador pueden generar; el trabajo queda a nombre de quien pulsó", async () => {
    for (const a of [E.titular, contador]) {
      const { c } = await compras();
      const r = await generar(a, c, "compras", await cuerpoDe(c, "compras"));
      expect(r.status, `${a.rol}: ${r.text}`).toBe(202);
      expect((await A.trabajosArchivo(c.id))[0].creado_por).toBe(a.id);
    }
  });
});

// --- CA-7 · duplicados ------------------------------------------------------------------------------------------------------

describe("CA-7 · dos clics, un solo trabajo (008 D8)", () => {
  it("pulsar dos veces con el mismo previo devuelve el mismo trabajoId y deja una sola fila", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    const a = await generar(contador, c, "compras", cuerpo);
    const b = await generar(contador, c, "compras", cuerpo);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.trabajoId).toBe(a.body.trabajoId);
    expect(await A.trabajosArchivo(c.id)).toHaveLength(1);
  });

  it("dos POST simultáneos tampoco duplican el trabajo", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    const rs = await Promise.all([generar(contador, c, "compras", cuerpo), generar(contador, c, "compras", cuerpo)]);
    expect(rs.map((r) => r.status)).toEqual([202, 202]);
    expect(rs[1]!.body.trabajoId).toBe(rs[0]!.body.trabajoId);
    expect(await A.trabajosArchivo(c.id)).toHaveLength(1);
  });

  it("el libro distingue el trabajo: compras y ventas del mismo periodo son dos trabajos", async () => {
    const { c } = await compras();
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    const a = await generar(contador, c, "compras", await cuerpoDe(c, "compras"));
    const b = await generar(contador, c, "ventas", await cuerpoDe(c, "ventas"));
    expect([a.status, b.status], `${a.text} ${b.text}`).toEqual([202, 202]);
    expect(b.body.trabajoId).not.toBe(a.body.trabajoId);
    expect((await A.trabajosArchivo(c.id)).map((f) => f.parametros.libro).sort()).toEqual(["compras", "ventas"]);
  });
});

// --- 400 ----------------------------------------------------------------------------------------------------------------------

describe("CA-4 / D1 · 400 solicitud_invalida: cuerpo estricto", () => {
  const CLAVES_EXTRA: [string, unknown][] = [
    ["permitirProvisional", true],
    ["registro", "oficial"],
    ["libro", "ventas"],
    ["tenantId", randomUUID()],
    ["clienteId", randomUUID()],
    ["usuarioId", randomUUID()],
    ["nodeEnv", "development"],
  ];

  it.each(CLAVES_EXTRA)("la clave extra «%s» se rechaza (no se descarta) y no se encola nada", async (clave, valor) => {
    const { c } = await compras();
    const cuerpo = { ...(await cuerpoDe(c, "compras")), [clave]: valor };
    const r = await generar(contador, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    await sinEfectos(c);
  });

  it("estadoVisto y huella son obligatorios", async () => {
    const { c } = await compras();
    const huella = await huellaDe(c, "compras");
    for (const cuerpo of [{}, { estadoVisto: "abierto" }, { huella }]) {
      const r = await generar(contador, c, "compras", cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    await sinEfectos(c);
  });

  it("estadoVisto solo admite abierto o revisado", async () => {
    const { c } = await compras();
    const huella = await huellaDe(c, "compras");
    for (const estadoVisto of ["generado", "ABIERTO", "", null, 1]) {
      const r = await generar(contador, c, "compras", { estadoVisto, huella });
      expect(r.status, String(estadoVisto)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    await sinEfectos(c);
  });

  it("la huella son exactamente 64 hexadecimales en minúscula", async () => {
    const { c } = await compras();
    for (const huella of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", null, 7]) {
      const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella });
      expect(r.status, String(huella)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    await sinEfectos(c);
  });

  it("un cuerpo que no es un objeto se rechaza", async () => {
    const { c } = await compras();
    for (const cuerpo of [[], "abierto", 5]) {
      const r = await generar(contador, c, "compras", cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
    }
    await sinEfectos(c);
  });

  it.each(["2026-10", "20261", "202613", "202600", "abcdef", "209912"])("periodo «%s»: 400 y no se encola", async (periodo) => {
    const { c } = await compras();
    await huellaDe(c, "compras"); // control: el módulo existe
    const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA }, periodo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    await sinEfectos(c);
  });
});

// --- 403 / 404 / 401 ----------------------------------------------------------------------------------------------------------

describe("CA-9 · permisos y alcance de POST", () => {
  it.each(["compras", "ventas"] as const)("%s: el asistente y la lectura asignados reciben 403 permiso_denegado y no se encola", async (libro) => {
    const { c } = libro === "compras" ? await compras() : await ventas();
    const cuerpo = await cuerpoDe(c, libro);
    for (const a of [asistente, lectura]) {
      const r = await generar(a, c, libro, cuerpo);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    await sinEfectos(c);
  });

  it("el asistente no asignado recibe el 404 del guard antes que el 403, igual que un cliente inexistente", async () => {
    const { c } = await compras({ colaboradores: [] });
    const cuerpo = await cuerpoDe(c, "compras");
    const r = await generar(asistenteAjeno, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await generar(asistenteAjeno, { id: randomUUID() }, "compras", cuerpo)));
    await sinEfectos(c);
  });

  it("el contador no asignado también es 404 (el Dueño, con alcance global, sí genera)", async () => {
    const c = await v.cliente(E); // sin responsable ni colaboradores
    await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u(), versiones: CORRECCIONES });
    const huella = (await previoOk(E.titular, c, "compras")).body.huella;
    const cuerpo = { estadoVisto: "abierto", huella };
    const r = await generar(contador, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
    expect((await generar(E.titular, c, "compras", cuerpo)).status).toBe(202); // control: la ruta existe
  });

  it("otro estudio: el cliente de E es un 404 para el Dueño de F y no deja trabajo", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    const r = await generar(F.titular, c, "compras", cuerpo);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    await sinEfectos(c);
  });

  it("sin sesión: 401 y no se encola nada", async () => {
    const { c } = await compras();
    const r = await v.sinSesion("POST", rutaArchivos(c.id, PERIODO, "compras"), await cuerpoDe(c, "compras"));
    expect(r.status, r.text).toBe(401);
    await sinEfectos(c);
  });
});

// --- 409 cliente / estado ------------------------------------------------------------------------------------------------------

describe("D5 / CA-6 · 409 cliente_archivado y estado_invalido", () => {
  it("cliente archivado: 409 cliente_archivado y no se encola nada", async () => {
    const { c } = await compras({ archivado: true });
    const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: await huellaDe(c, "compras") });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    await sinEfectos(c);
  });

  const CASOS: ["abierto" | "revisado" | "generado", "abierto" | "revisado"][] = [
    ["abierto", "revisado"],
    ["revisado", "abierto"],
    ["generado", "abierto"],
    ["generado", "revisado"],
  ];
  it.each(CASOS)("el periodo está %s y se pide con estadoVisto = %s: 409 estado_invalido, sin encolar ni cambiar el estado", async (estado, visto) => {
    const { c } = await compras();
    const huella = await huellaDe(c, "compras");
    if (estado !== "abierto") await v.estadoPeriodo(E.tenantId, c.id, PERIODO, estado, contador.id);
    const r = await generar(contador, c, "compras", { estadoVisto: visto, huella });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
    expect((await v.periodoFila(c.id))?.estado ?? "abierto").toBe(estado);
  });

  it("ventas: el mismo control con venta_periodo (revisado visto como abierto, y generado)", async () => {
    const { c } = await ventas();
    const huella = await huellaDe(c, "ventas");
    for (const estado of ["revisado", "generado"] as const) {
      await A.estadoVentas(E.tenantId, c.id, PERIODO, estado, contador.id);
      const r = await generar(contador, c, "ventas", { estadoVisto: "abierto", huella });
      expect(r.status, `${estado}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "estado_invalido" });
    }
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
  });

  it("el estado de compras no vale para ventas: compras revisado y ventas abierto -> estadoVisto = revisado en ventas es 409", async () => {
    const { c } = await compras();
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const r = await generar(contador, c, "ventas", { estadoVisto: "revisado", huella: await huellaDe(c, "ventas") });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
  });

  it("CA-6: generado -> editar da 409 periodo_generado; reabrir y corregir permite generar de nuevo con otro previo", async () => {
    const { c, ids } = await compras();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    await A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro: "compras", version: 1 }, st);
    const editar = { versionBase: 1, cambios: { biDg: "200.00", igvDg: "36.00" } };
    const bloq = await v.llamar(contador, "POST", `${baseCompras(c.id)}/${ids["F001-3064"]}/editar`, editar);
    expect(bloq.status, bloq.text).toBe(409);
    expect(bloq.body).toEqual({ codigo: "periodo_generado" });

    const viejo = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: await huellaDe(c, "compras") });
    expect(viejo.status, viejo.text).toBe(409);
    expect(viejo.body).toEqual({ codigo: "estado_invalido" });

    expect((await v.llamar(contador, "POST", `${baseCompras(c.id)}/estado/reabrir`, { estadoVisto: "generado" })).status).toBe(200);
    const huella1 = await huellaDe(c, "compras");
    const ok = await v.llamar(contador, "POST", `${baseCompras(c.id)}/${ids["F001-3064"]}/editar`, editar);
    expect(ok.status, ok.text).toBe(200);
    const p = await previoOk(contador, c, "compras");
    expect(p.body.reabiertoTrasUltima).toBe(true);
    expect(p.body.ultimaVersion.version).toBe(1);
    expect(p.body.huella).not.toBe(huella1);
    const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: p.body.huella });
    expect(r.status, r.text).toBe(202);
  });
});

// --- 422 formato_no_oficial -------------------------------------------------------------------------------------------------------

describe("CA-4 · producción con formatos provisionales: 422 formato_no_oficial", () => {
  it.each(["compras", "ventas"] as const)("%s: 422 { codigo: formato_no_oficial } sin encolar y sin cambiar el estado", async (libro) => {
    const { c } = libro === "compras" ? await compras() : await ventas();
    const cuerpo = await cuerpoDe(c, libro);
    const r = await enProduccion(() => generar(contador, c, libro, cuerpo));
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "formato_no_oficial" });
    await sinEfectos(c);
    // Control: fuera de producción, el mismo cuerpo se encola.
    expect((await generar(contador, c, libro, cuerpo)).status).toBe(202);
  });

  it("un cuerpo con permitirProvisional o registro sigue siendo 400, también en producción", async () => {
    const { c } = await compras();
    const base = await cuerpoDe(c, "compras");
    for (const extra of [{ permitirProvisional: true }, { registro: "oficial" }]) {
      const r = await enProduccion(() => generar(contador, c, "compras", { ...base, ...extra }));
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    await sinEfectos(c);
  });

  it("NODE_ENV no se toma de la petición: ?NODE_ENV=development&permitirProvisional=true no cambian el 422", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    const r = await enProduccion(() =>
      v.llamar(contador, "POST", `${rutaArchivos(c.id, PERIODO, "compras")}?NODE_ENV=development&permitirProvisional=true`, cuerpo),
    );
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "formato_no_oficial" });
    await sinEfectos(c);
  });
});

// --- 409 resumen_cambiado ------------------------------------------------------------------------------------------------------------

describe("CA-8 / P-2 · 409 resumen_cambiado", () => {
  it("una fila cambia entre el previo y el POST: 409, no se encola, el estado no cambia; con el previo nuevo, 202", async () => {
    const { c, ids } = await compras();
    const viejo = await cuerpoDe(c, "compras");
    const e = await v.llamar(contador, "POST", `${baseCompras(c.id)}/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { biDg: "200.00", igvDg: "36.00" },
    });
    expect(e.status, e.text).toBe(200);
    const r = await generar(contador, c, "compras", viejo);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
    await sinEfectos(c, "abierto");
    expect((await generar(contador, c, "compras", await cuerpoDe(c, "compras"))).status).toBe(202);
  });

  it("una huella cualquiera (64 hex que no es la del previo) es 409 resumen_cambiado", async () => {
    const { c } = await compras();
    const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
    await sinEfectos(c);
  });

  it("la huella del otro libro no vale: la de compras en ventas es 409", async () => {
    const { c } = await compras();
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    const r = await generar(contador, c, "ventas", { estadoVisto: "abierto", huella: await huellaDe(c, "compras") });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
  });

  it("la huella de otro cliente no vale aunque tenga los mismos datos", async () => {
    const a = await compras();
    const b = await compras();
    const r = await generar(contador, b.c, "compras", { estadoVisto: "abierto", huella: await huellaDe(a.c, "compras") });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
  });

  it("marcar revisado entre el previo y el POST no cambia la huella pero sí el estado: 409 estado_invalido, no resumen_cambiado", async () => {
    const { c } = await compras();
    const cuerpo = await cuerpoDe(c, "compras");
    expect((await v.llamar(contador, "POST", `${baseCompras(c.id)}/estado/revisar`, {})).status).toBe(200);
    const r = await generar(contador, c, "compras", cuerpo);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
  });
});

// --- 422 prevalidación -----------------------------------------------------------------------------------------------------------------

describe("CA-3 / CA-10 · 422 prevalidacion_fallida con la lista de filas", () => {
  it("compras con F001-2056: 422 con el error de IGV y su filaId, sin encolar ni cambiar el estado", async () => {
    const { c, ids } = await compras({}, false);
    const r = await generar(contador, c, "compras", await cuerpoDe(c, "compras"));
    expect(r.status, r.text).toBe(422);
    expect(r.body.codigo).toBe("prevalidacion_fallida");
    expect(r.body.erroresOmitidos).toBe(0);
    expect(r.body.errores).toHaveLength(1);
    expect(r.body.errores[0]).toMatchObject({ filaId: ids["F001-2056"], codigo: "IGV", campo: "igvDg", excluible: false });
    expect(r.body.errores[0].explicacion).toContain("1.61 no es 18 % ni 10 % de 21.48");
    await sinEfectos(c);
  });

  it("ventas con una venta descuadrada: 422 con CUADRE, excluible = true y la diferencia", async () => {
    const { c, ids } = await ventas([...boletas290y292(), descuadrada("B001", 293)]);
    const r = await generar(contador, c, "ventas", await cuerpoDe(c, "ventas"));
    expect(r.status, r.text).toBe(422);
    expect(r.body.codigo).toBe("prevalidacion_fallida");
    expect(r.body.errores).toEqual([expect.objectContaining({ filaId: ids[2], codigo: "CUADRE", campo: "total", diferencia: "1.00", excluible: true })]);
    await sinEfectos(c);
  });

  it("más de 1.000 errores: la respuesta lleva 1.000 y el resto en erroresOmitidos", async () => {
    const c = await nuevoCliente();
    await A.sembrarDescuadradas(E.tenantId, c.id, 1100, { usuarioId: u() });
    const r = await generar(contador, c, "ventas", await cuerpoDe(c, "ventas"));
    expect(r.status, r.text.slice(0, 200)).toBe(422);
    expect(r.body.errores).toHaveLength(1000);
    expect(r.body.erroresOmitidos).toBe(100);
    await sinEfectos(c);
  });

  it("un periodo sin filas: 422 prevalidacion_fallida con SIN_FILAS", async () => {
    const c = await nuevoCliente();
    const r = await generar(contador, c, "compras", await cuerpoDe(c, "compras"));
    expect(r.status, r.text).toBe(422);
    expect(r.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS", filaId: null })]);
    await sinEfectos(c);
  });
});

// --- Orden de las comprobaciones ---------------------------------------------------------------------------------------------------------

describe("orden: cliente -> estado -> formato -> huella -> prevalidación", () => {
  it("archivado gana a un estadoVisto viejo y a una huella mala", async () => {
    const { c } = await compras({ archivado: true });
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const r = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
  });

  it("estado gana al formato y a la huella: periodo generado, producción y huella mala -> estado_invalido", async () => {
    const { c } = await compras();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await enProduccion(() => generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA }));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
  });

  it("formato gana a la huella: producción, estado vigente y huella mala -> formato_no_oficial", async () => {
    const { c } = await compras();
    const r = await enProduccion(() => generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA }));
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "formato_no_oficial" });
  });

  it("la huella gana a la prevalidación: con errores y huella mala -> resumen_cambiado; con la huella buena -> prevalidacion_fallida", async () => {
    const { c } = await compras({}, false);
    const mala = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA });
    expect(mala.status, mala.text).toBe(409);
    expect(mala.body).toEqual({ codigo: "resumen_cambiado" });
    const buena = await generar(contador, c, "compras", await cuerpoDe(c, "compras"));
    expect(buena.status, buena.text).toBe(422);
    expect(buena.body.codigo).toBe("prevalidacion_fallida");
  });
});

// --- D10 · lo que no debe filtrarse ---------------------------------------------------------------------------------------------------------

describe("D10 · logs, parámetros y respuestas sin razones sociales, montos ni rutas", () => {
  it("una razón social y un monto únicos no aparecen en logs ni en los parámetros del trabajo; la 202 solo trae el trabajoId", async () => {
    const { c } = await compras();
    const razon = `CANARIO-RAZON-${randomBytes(6).toString("hex")}`;
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F077",
      numero: "1",
      doc: "20700000070",
      razonSocial: razon,
      origen: "agregada",
      usuarioId: u(),
      montos: { biDg: "3456789.00", igvDg: "622222.02", total: "4079011.02" },
    });
    const { resultado, logs } = await capturarLogs(async () => {
      const p = await previoOk(contador, c, "compras");
      const g = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: p.body.huella });
      const rechazo = await generar(contador, c, "compras", { estadoVisto: "abierto", huella: MALA });
      return { p, g, rechazo };
    });
    expect(resultado.p.status, resultado.p.text).toBe(200);
    expect(resultado.g.status, resultado.g.text).toBe(202);
    expect(resultado.rechazo.status).toBe(409);
    for (const prohibido of [razon, "3456789", "4079011", `archivos/${E.tenantId}`]) {
      expect(logs, `logs con ${prohibido}`).not.toContain(prohibido);
      expect(resultado.g.text).not.toContain(prohibido);
      expect(resultado.rechazo.text).not.toContain(prohibido);
    }
    expect(JSON.stringify((await A.trabajosArchivo(c.id)).map((t) => t.parametros))).not.toContain(razon);
    expect(Object.keys(resultado.g.body)).toEqual(["trabajoId"]);
    expect(resultado.p.body.huella).toMatch(HEX64);
  });
});

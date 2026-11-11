/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b (T6, rojo): GET /clientes/:clienteId/periodos/:periodo/{compras|ventas}/archivos/previo (D1, D2, D12, P-4; CA-1,
// CA-4 parte previo, CA-5, CA-10, CA-15 parte previo). Contrato (plan 012b, «Contratos: HTTP»; `previoArchivoSchema` de shared):
//  - 200 `PrevioArchivoDto` { apto, generable, motivo, errores[], erroresOmitidos, avisos[], resumen, excluidas[],
//    excluidasOmitidas, formato{id,version,oficial}, estado{estado,por,en}, huella, ultimaVersion|null, reabiertoTrasUltima }.
//    Permiso `clientes.ver` con el cliente asignado (P-4: el asistente y la lectura asignados lo ven). `Cache-Control: no-store`.
//  - Solo lectura: no escribe filas, estado del periodo, versiones ni trabajos. Nunca toma `registro` ni `permitirProvisional` de
//    la petición; `NODE_ENV` se lee en CADA petición (como el layout de 013), nunca de la petición.
//  - `motivo` (cuando `generable = false`) sigue el orden del POST: cliente_archivado, periodo_generado, formato_no_oficial,
//    prevalidacion_fallida. `apto` es solo el resultado de la prevalidación (independiente de `generable`).
//  - `errores[].excluible` solo es verdadero en ventas de origen SIRE no excluidas; en compras siempre falso.
//  - `reabiertoTrasUltima` = existe una versión del libro y el periodo ya no está `generado`.
//  - La huella (64 hex) depende del contenido, no del estado del periodo: marcar revisado no la cambia; editar una fila, sí.
//  - Hasta 1.000 errores (el resto cuenta en `erroresOmitidos`). Compras: `excluidas[]` vacía (la zapatilla cuenta en
//    `resumen.excluidas`). Ventas: `impactoIgv.DG/DGNG/DNG` en null y `filasSinConvertir` con los ids de las filas USD sin convertir.
//  - Id de otro estudio o cliente inexistente, no asignado: el mismo 404 `{ codigo: "no_encontrado" }`.
// Rojo: el módulo `archivos` aún no existe (T12): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
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
  cumple,
  descuadrada,
  HEX64,
  prepararStorage,
  rutaArchivos,
  usdSinTc,
  type Libro,
  type SoporteArchivos,
  type StoragePrueba,
} from "../../../test/soporte-archivos.js";
import { boletas290y292, fila, filasFixtureVentas, type FilaV } from "../../../test/soporte-ventas.js";
import { forma } from "../../../test/soporte.js";

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
  asistenteAjeno = await p.miembro(E.tenantId, "asistente"); // sin ningún cliente asignado
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;

/** San Juan (R-ISC aceptada: ISC 770.00) y la mixta (gravado 8.97 + 12.51): el fixture de 009 ya corregido. */
const CORRECCIONES: Record<string, NonNullable<OpcionesCompra["versiones"]>> = {
  "F001-1040": [{ montos: { biDg: "0.00", isc: "770.00" }, accion: "sugerencia" }],
  "F001-2056": [{ montos: { biDg: "8.97", noGravado: "12.51" }, accion: "sugerencia" }],
};

const nuevoCliente = (o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
async function compras(
  o: Parameters<BancoCompras["cliente"]>[1] = {},
  corregido = false,
): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await nuevoCliente(o);
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u(), ...(corregido ? { versiones: CORRECCIONES } : {}) });
  return { c, ids };
}
async function ventas(filas: FilaV[], o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<{ c: Cliente; ids: string[] }> {
  const c = await nuevoCliente(o);
  const ids = await v.sembrarVentas(E.tenantId, c.id, filas, { usuarioId: u() });
  return { c, ids };
}

const previo = (a: Actor, c: Cliente | { id: string }, libro: Libro = "compras", periodo = PERIODO, consulta = "") =>
  v.llamar(a, "GET", `${rutaArchivos(c.id, periodo, libro)}/previo${consulta}`);
const previoOk = async (...args: Parameters<typeof previo>) => {
  const r = await previo(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};
const post = (a: Actor, ruta: string, cuerpo?: unknown) => v.llamar(a, "POST", ruta, cuerpo ?? {});
const enProduccion = async <T>(fn: () => Promise<T>): Promise<T> => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
};
const huellaDe = async (c: Cliente, libro: Libro = "compras"): Promise<string> => (await previoOk(contador, c, libro)).body.huella;

// --- CA-1 · compras sin corregir ------------------------------------------------------------------------------------------

describe("CA-1 · previo de compras sin corregir (mixta 21.48/1.61 y San Juan ISC)", () => {
  it("200 con la forma de previoArchivoSchema, no apto, y «Generar» deshabilitado por la prevalidación", async () => {
    const { c } = await compras();
    const r = await previoOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("previoArchivoSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ apto: false, generable: false, motivo: "prevalidacion_fallida", erroresOmitidos: 0, excluidas: [] });
    expect(r.body.huella).toMatch(HEX64);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("F001-2056 trae el error de IGV «1.61 no es 18 % ni 10 % de 21.48» con su filaId, y es el único error", async () => {
    const { c, ids } = await compras();
    const r = await previoOk(contador, c);
    expect(r.body.errores).toHaveLength(1);
    expect(r.body.errores[0]).toMatchObject({
      filaId: ids["F001-2056"],
      codigo: "IGV",
      campo: "igvDg",
      destino: "DG",
      diferencia: null,
      excluible: false, // en compras nada se excluye por error: la excluible es solo de ventas del SIRE (D12)
    });
    expect(r.body.errores[0].explicacion).toContain("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("F001-1040 (San Juan) trae el aviso R-ISC con su filaId y no bloquea", async () => {
    const { c, ids } = await compras();
    const r = await previoOk(contador, c);
    const isc = (r.body.avisos as any[]).filter((a) => a.codigo === "R-ISC");
    expect(isc.map((a) => a.filaId)).toEqual([ids["F001-1040"]]);
    expect(typeof isc[0].explicacion).toBe("string");
    expect((r.body.errores as any[]).some((e) => e.filaId === ids["F001-1040"])).toBe(false);
  });

  it("T23a · cada error y aviso con fila dice su comprobante SERIE-NUMERO; sin fila, null", async () => {
    const { c } = await compras();
    const r = await previoOk(contador, c);
    expect((r.body.errores as any[]).map((e) => e.comprobante)).toEqual(["F001-2056"]);
    const isc = (r.body.avisos as any[]).find((a) => a.codigo === "R-ISC");
    expect(isc.comprobante).toBe("F001-1040");
    for (const a of r.body.avisos as any[]) expect(a.comprobante).toMatch(/^F001-\d+$/);
    const vacio = await previoOk(contador, await nuevoCliente());
    expect(vacio.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS", filaId: null, comprobante: null })]);
  });

  it("el formato es provisional (oficial = false) y viene con id y versión", async () => {
    const { c } = await compras();
    const f = (await previoOk(contador, c)).body.formato;
    expect(f.oficial).toBe(false);
    expect(typeof f.id).toBe("string");
    expect(f.id.length).toBeGreaterThan(0);
    expect(typeof f.version).toBe("string");
  });

  it("estado inicial: abierto, sin marca, sin versiones y sin reapertura", async () => {
    const { c } = await compras();
    const r = await previoOk(contador, c);
    expect(r.body.estado).toEqual({ estado: "abierto", por: null, autor: null, en: null }); // 017 D-12: `autor` junto a `por`
    expect(r.body.ultimaVersion).toBeNull();
    expect(r.body.reabiertoTrasUltima).toBe(false);
  });

  it("un periodo sin filas es SIN_FILAS (sin filaId) y no es apto", async () => {
    const c = await nuevoCliente();
    const r = await previoOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.apto).toBe(false);
    expect(r.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS", filaId: null })]);
  });
});

// --- CA-2 / CA-5 · compras corregidas y resumen de cambios ---------------------------------------------------------------

describe("CA-2 / CA-5 · previo de compras tras aplicar las sugerencias", () => {
  it("8.97 + 12.51 y ISC 770.00: apto y generable, sin errores, con 2 modificadas, 0 excluidas, 0 agregadas e impacto 0.00", async () => {
    const { c } = await compras({}, true);
    const r = await previoOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("previoArchivoSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ apto: true, generable: true, motivo: null, errores: [], erroresOmitidos: 0 });
    expect(r.body.resumen).toEqual({
      modificadas: 2,
      excluidas: 0,
      agregadas: 0,
      impactoIgv: { DG: "0.00", DGNG: "0.00", DNG: "0.00", total: "0.00" },
      filasSinConvertir: [],
    });
  });

  it("la zapatilla excluida cuenta en resumen.excluidas y resta su IGV (-18.00); la lista excluidas[] de compras queda vacía", async () => {
    const c = await nuevoCliente();
    await v.sembrarFixture(E.tenantId, c.id, {
      usuarioId: u(),
      versiones: { ...CORRECCIONES, "F001-3064": [{ excluida: true, motivo: "zapatillas", accion: "excluir" }] },
    });
    const r = await previoOk(contador, c);
    expect(r.body.apto).toBe(true);
    expect(r.body.resumen).toMatchObject({ modificadas: 2, excluidas: 1, agregadas: 0 });
    expect(r.body.resumen.impactoIgv).toEqual({ DG: "-18.00", DGNG: "0.00", DNG: "0.00", total: "-18.00" });
    expect(r.body.excluidas).toEqual([]);
    expect(r.body.excluidasOmitidas).toBe(0);
  });

  it("una compra agregada cuenta como agregada y suma su IGV (+18.00) al impacto", async () => {
    const { c } = await compras({}, true);
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F050", numero: "1", doc: "20700000050", origen: "agregada", usuarioId: u() });
    const r = await previoOk(contador, c);
    expect(r.body.resumen).toMatchObject({ modificadas: 2, excluidas: 0, agregadas: 1 });
    expect(r.body.resumen.impactoIgv).toEqual({ DG: "18.00", DGNG: "0.00", DNG: "0.00", total: "18.00" });
  });

  it("una agregada descartada no cuenta", async () => {
    const { c } = await compras({}, true);
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F050",
      numero: "2",
      doc: "20700000051",
      origen: "agregada",
      descartada: true,
      usuarioId: u(),
    });
    const r = await previoOk(contador, c);
    expect(r.body.resumen.agregadas).toBe(0);
    expect(r.body.resumen.impactoIgv.total).toBe("0.00");
  });

  it("solo el periodo pedido: las filas de otro periodo del mismo cliente no entran", async () => {
    const { c } = await compras({}, true);
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F051", numero: "1", usuarioId: u(), periodo: "202609", montos: { biDg: "100.00", igvDg: "17.00", total: "117.00" } });
    const r = await previoOk(contador, c);
    expect(r.body.apto).toBe(true);
    expect((await previoOk(contador, c, "compras", "202609")).body.apto).toBe(false); // control: el otro periodo sí trae su error
  });
});

// --- Estado del periodo, formato, cliente archivado y última versión -----------------------------------------------------------

describe("D2 / D5 · generable, motivo, estado y última versión", () => {
  it("marcado revisado: estado { revisado, por, en } con el usuario y la fecha de la marca", async () => {
    const { c } = await compras({}, true);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const r = await previoOk(asistente, c);
    expect(r.body.estado.estado).toBe("revisado");
    expect(r.body.estado.por).toBe(contador.id);
    expect(Number.isNaN(Date.parse(r.body.estado.en))).toBe(false);
    expect(r.body).toMatchObject({ apto: true, generable: true, motivo: null });
  });

  it("generado: no es generable (motivo periodo_generado) aunque la prevalidación sea apta", async () => {
    const { c } = await compras({}, true);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await previoOk(contador, c);
    expect(r.body).toMatchObject({ apto: true, generable: false, motivo: "periodo_generado" });
    expect(r.body.estado.estado).toBe("generado");
  });

  it("cliente archivado: el previo se ve, pero no es generable (motivo cliente_archivado)", async () => {
    const { c } = await compras({ archivado: true }, true);
    const r = await previoOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ apto: true, generable: false, motivo: "cliente_archivado" });
  });

  it("con NODE_ENV=production y solo formatos provisionales: apto pero generable = false con motivo formato_no_oficial (CA-4)", async () => {
    const { c } = await compras({}, true);
    const r = await enProduccion(() => previo(contador, c));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ apto: true, generable: false, motivo: "formato_no_oficial" });
    expect(r.body.formato.oficial).toBe(false);
    expect(r.body.errores).toEqual([]);
    // Control: fuera de producción el mismo periodo sí se puede generar.
    expect((await previoOk(contador, c)).body).toMatchObject({ generable: true, motivo: null });
  });

  it("en producción el previo igual muestra errores y resumen (con prevalidación fallida, la causa más antigua del POST gana)", async () => {
    const { c } = await compras();
    const r = await enProduccion(() => previo(contador, c));
    expect(r.status, r.text).toBe(200);
    expect(r.body.apto).toBe(false);
    expect(r.body.generable).toBe(false);
    expect(r.body.errores).toHaveLength(1);
    expect(r.body.motivo).toBe("formato_no_oficial"); // orden del POST: formato antes que prevalidación
  });

  it("«permitirProvisional» y «registro» en la consulta no se leen: en producción siguen sin poder generarse", async () => {
    const { c } = await compras({}, true);
    const r = await enProduccion(() => previo(contador, c, "compras", PERIODO, "?permitirProvisional=true&registro=oficial&NODE_ENV=development"));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ generable: false, motivo: "formato_no_oficial" });
  });

  it("última versión del libro y reapertura: con la versión y el periodo generado no hay aviso; al reabrir, sí", async () => {
    const { c } = await compras({}, true);
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    await A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro: "compras", version: 1 }, st);
    const v2 = await A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro: "compras", version: 2 }, st);
    const a = await previoOk(contador, c);
    expect(a.body.ultimaVersion.version).toBe(2);
    expect(Number.isNaN(Date.parse(a.body.ultimaVersion.generadoEn))).toBe(false);
    expect(a.body.reabiertoTrasUltima).toBe(false);
    expect(a.body.huella).toMatch(HEX64);
    expect(v2.version).toBe(2);

    expect((await post(contador, `${baseCompras(c.id)}/estado/reabrir`, { estadoVisto: "generado" })).status).toBe(200);
    const b = await previoOk(contador, c);
    expect(b.body.estado.estado).toBe("abierto");
    expect(b.body.ultimaVersion.version).toBe(2);
    expect(b.body.reabiertoTrasUltima).toBe(true);
  });

  it("la última versión es del libro pedido: una versión de ventas no aparece en el previo de compras", async () => {
    const { c } = await compras({}, true);
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    await A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro: "ventas" }, st);
    expect((await previoOk(contador, c, "compras")).body.ultimaVersion).toBeNull();
    expect((await previoOk(contador, c, "ventas")).body.ultimaVersion.version).toBe(1);
  });
});

// --- Huella (P-2) --------------------------------------------------------------------------------------------------------------

describe("P-2 · la huella es de contenido, no de estado", () => {
  it("dos previos seguidos dan la misma huella (64 hexadecimales en minúscula)", async () => {
    const { c } = await compras({}, true);
    const a = await huellaDe(c);
    expect(a).toMatch(HEX64);
    expect(await huellaDe(c)).toBe(a);
  });

  it("marcar revisado no la cambia", async () => {
    const { c } = await compras({}, true);
    const antes = await huellaDe(c);
    expect((await post(contador, `${baseCompras(c.id)}/estado/revisar`)).status).toBe(200);
    expect(await huellaDe(c)).toBe(antes);
  });

  it("editar una fila (v2: BI 200.00 e IGV 36.00) la cambia, y el nuevo previo ya la trae", async () => {
    const { c, ids } = await compras({}, true);
    const antes = await huellaDe(c);
    const e = await post(contador, `${baseCompras(c.id)}/${ids["F001-3064"]}/editar`, {
      versionBase: 1,
      cambios: { biDg: "200.00", igvDg: "36.00" },
    });
    expect(e.status, e.text).toBe(200);
    const despues = await huellaDe(c);
    expect(despues).toMatch(HEX64);
    expect(despues).not.toBe(antes);
  });

  it("excluir una fila de compras la cambia", async () => {
    const { c, ids } = await compras({}, true);
    const antes = await huellaDe(c);
    const e = await post(contador, `${baseCompras(c.id)}/${ids["F001-3064"]}/excluir`, { versionBase: 1, motivo: "zapatillas" });
    expect(e.status, e.text).toBe(200);
    expect(await huellaDe(c)).not.toBe(antes);
  });

  it("la huella de compras y la de ventas del mismo cliente y periodo son distintas", async () => {
    const { c } = await compras({}, true);
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    expect(await huellaDe(c, "ventas")).not.toBe(await huellaDe(c, "compras"));
  });
});

// --- Solo lectura ---------------------------------------------------------------------------------------------------------------

describe("el previo no escribe nada", () => {
  it("ni filas, ni estado del periodo, ni versiones, ni trabajos (compras)", async () => {
    const { c } = await compras();
    const antes = await v.foto(c.id);
    for (let i = 0; i < 3; i++) expect((await previoOk(contador, c)).status).toBe(200);
    expect(await v.foto(c.id)).toEqual(antes);
    expect(antes.periodo).toBeNull();
    expect(await A.versionesBd(c.id)).toEqual([]);
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
  });

  it("ni el estado del periodo de ventas ni exclusiones (ventas)", async () => {
    const { c } = await ventas([...boletas290y292(), descuadrada()]);
    const antes = await A.fotoVentas(v, c.id);
    for (let i = 0; i < 3; i++) expect((await previoOk(contador, c, "ventas")).status).toBe(200);
    expect(await A.fotoVentas(v, c.id)).toEqual(antes);
    expect(await A.periodoVentas(c.id)).toBeNull();
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("la respuesta no deja ver el estudio, el RUC del cliente ni rutas de storage", async () => {
    const { c } = await compras();
    await A.sembrarVersion({ tenantId: E.tenantId, clienteId: c.id, usuarioId: contador.id, libro: "compras" }, st);
    const texto = (await previoOk(contador, c)).text;
    for (const prohibido of [E.tenantId, c.ruc, "archivos/"]) expect(texto).not.toContain(prohibido);
  });
});

// --- Ventas (CA-10, CA-15 parte previo) -------------------------------------------------------------------------------------------

describe("CA-10 · previo de ventas: boleta 291", () => {
  it("B001-290 y B001-292: apto y generable, con el aviso «Falta B001-291» sin filaId, que no bloquea", async () => {
    const { c } = await ventas(boletas290y292());
    const r = await previoOk(contador, c, "ventas");
    expect(r.status, r.text).toBe(200);
    expect(cumple("previoArchivoSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ apto: true, generable: true, motivo: null, errores: [], excluidas: [] });
    const salto = (r.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD");
    expect(salto).toHaveLength(1);
    expect(salto[0].filaId).toBeNull();
    expect(salto[0].explicacion).toContain("B001-291");
    expect(r.body.formato.oficial).toBe(false);
    expect(r.body.resumen).toEqual({
      modificadas: 0,
      excluidas: 0,
      agregadas: 0,
      impactoIgv: { DG: null, DGNG: null, DNG: null, total: "0.00" },
      filasSinConvertir: [],
    });
  });

  it("justificar el salto quita el aviso (013 D8); una justificación revertida no cuenta", async () => {
    const { c } = await ventas(boletas290y292());
    await v.sembrarSalto(E.tenantId, c.id, { usuarioId: u(), serie: "B001", desde: 291, hasta: 291 });
    const sin = await previoOk(contador, c, "ventas");
    expect((sin.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD")).toEqual([]);
    expect(sin.body.apto).toBe(true);
    const otro = await ventas(boletas290y292());
    await v.sembrarSalto(E.tenantId, otro.c.id, { usuarioId: u(), serie: "B001", desde: 291, hasta: 291, revertido: true });
    const con = await previoOk(contador, otro.c, "ventas");
    expect((con.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD")).toHaveLength(1);
  });

  it("una venta agregada a mano que llena el hueco hace desaparecer el aviso", async () => {
    const { c } = await ventas(boletas290y292());
    await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 291)], { usuarioId: u(), origen: "manual" });
    const r = await previoOk(contador, c, "ventas");
    expect((r.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD")).toEqual([]);
    expect(r.body.resumen.agregadas).toBe(1);
  });

  it("el estado del periodo de ventas se ve y bloquea: generado -> generable = false", async () => {
    const { c } = await ventas(boletas290y292());
    await A.estadoVentas(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    expect((await previoOk(contador, c, "ventas")).body.estado).toMatchObject({ estado: "revisado", por: contador.id });
    await A.estadoVentas(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await previoOk(contador, c, "ventas");
    expect(r.body).toMatchObject({ apto: true, generable: false, motivo: "periodo_generado" });
  });

  it("el estado de ventas y el de compras son independientes", async () => {
    const { c } = await compras({}, true);
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    await A.estadoVentas(E.tenantId, c.id, PERIODO, "generado", contador.id);
    expect((await previoOk(contador, c, "compras")).body.estado.estado).toBe("abierto");
    expect((await previoOk(contador, c, "ventas")).body.estado.estado).toBe("generado");
  });

  it("los libros no se mezclan: las filas de compras no entran al previo de ventas ni al revés", async () => {
    const { c, ids } = await compras();
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    const compra = await previoOk(contador, c, "compras");
    expect(compra.body.errores.map((e: any) => e.filaId)).toEqual([ids["F001-2056"]]);
    expect((await previoOk(contador, c, "ventas")).body.apto).toBe(true);
  });
});

describe("CA-10 / D12 · errores de ventas: descuadrada, USD sin tipo de cambio y excluible", () => {
  it("una venta descuadrada del SIRE bloquea con CUADRE en total, la diferencia 1.00 y excluible = true", async () => {
    const { c, ids } = await ventas([...boletas290y292(), descuadrada("B001", 293)]);
    const r = await previoOk(contador, c, "ventas");
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ apto: false, generable: false, motivo: "prevalidacion_fallida" });
    expect(r.body.errores).toHaveLength(1);
    expect(r.body.errores[0]).toMatchObject({ filaId: ids[2], codigo: "CUADRE", campo: "total", diferencia: "1.00", excluible: true });
    expect(r.body.errores[0].explicacion.length).toBeGreaterThan(0);
  });

  it("T23a · los errores y avisos de ventas llevan el comprobante de la fila (los saltos, que no son de una fila, null)", async () => {
    const { c } = await ventas([...boletas290y292(), descuadrada("B001", 293)]);
    const r = await previoOk(contador, c, "ventas");
    expect(r.body.errores[0].comprobante).toBe("B001-293");
    const salto = (r.body.avisos as any[]).find((a) => a.codigo === "SALTO_CORRELATIVIDAD");
    expect(salto.filaId).toBeNull();
    expect(salto.comprobante).toBeNull();
  });

  it("USD sin tipo de cambio: USD_SIN_TC en tipoCambio y excluible", async () => {
    const { c, ids } = await ventas([...boletas290y292(), usdSinTc("U001", 7)]);
    const r = await previoOk(contador, c, "ventas");
    expect(r.body.errores).toEqual([expect.objectContaining({ filaId: ids[2], codigo: "USD_SIN_TC", campo: "tipoCambio", excluible: true })]);
  });

  it("un error en una venta agregada a mano no es excluible (solo lo es lo que llegó del SIRE)", async () => {
    const { c } = await ventas(boletas290y292());
    const [manual] = await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 293, { igv: "17.00", total: "117.00" })], {
      usuarioId: u(),
      origen: "manual",
    });
    const r = await previoOk(contador, c, "ventas");
    expect(r.body.errores).toEqual([expect.objectContaining({ filaId: manual, codigo: "IGV", campo: "igv", excluible: false })]);
  });

  it("el fixture de 013 (11 filas): el único error es la USD sin tipo de cambio F002-2, excluible; B003 y B001 traen su aviso de salto", async () => {
    const filas = filasFixtureVentas();
    const { c, ids } = await ventas(filas);
    const r = await previoOk(contador, c, "ventas");
    const usd = ids[filas.findIndex((f) => f.serie === "F002" && f.numero === "2")]!;
    expect(r.body.errores).toEqual([expect.objectContaining({ filaId: usd, codigo: "USD_SIN_TC", excluible: true })]);
    const saltos = (r.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD").map((a) => a.explicacion as string);
    expect(saltos.some((t) => t.includes("B001-291"))).toBe(true);
    expect(saltos.some((t) => /B003-40[2-4]/.test(t))).toBe(true);
  });

  it("más de 1.000 errores: viajan 1.000 y el resto cuenta en erroresOmitidos", async () => {
    const c = await nuevoCliente();
    await A.sembrarDescuadradas(E.tenantId, c.id, 1200, { usuarioId: u() });
    const r = await previoOk(contador, c, "ventas");
    expect(r.status, r.text).toBe(200);
    expect(r.body.apto).toBe(false);
    expect(r.body.errores).toHaveLength(1000);
    expect(r.body.erroresOmitidos).toBe(200);
    expect(r.body.errores.every((e: any) => e.codigo === "CUADRE" && e.excluible === true)).toBe(true);
    expect(cumple("previoArchivoSchema", r.body)).toBe(true);
  });

  it("un periodo de ventas sin filas es SIN_FILAS", async () => {
    const c = await nuevoCliente();
    const r = await previoOk(contador, c, "ventas");
    expect(r.body.apto).toBe(false);
    expect(r.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS", filaId: null })]);
  });
});

// --- Permisos, alcance y entrada (D9, P-4, CA-9) ---------------------------------------------------------------------------------

describe("D9 / P-4 / CA-9 · quién ve el previo", () => {
  it.each(["compras", "ventas"] as const)("%s: Dueño, contador, asistente asignado y lectura asignada lo ven (P-4)", async (libro) => {
    const c = await nuevoCliente();
    if (libro === "ventas") await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    else await v.sembrarFixture(E.tenantId, c.id, { usuarioId: u(), versiones: CORRECCIONES });
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await previo(a, c, libro);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(200);
      expect(r.body.apto).toBe(true);
    }
  });

  it.each(["compras", "ventas"] as const)("%s: el asistente no asignado recibe el mismo 404 que un cliente inexistente", async (libro) => {
    const c = await v.cliente(E); // sin responsable ni colaboradores
    expect((await previo(E.titular, c, libro)).status).toBe(200); // control: la ruta existe
    const r = await previo(asistenteAjeno, c, libro);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await previo(asistenteAjeno, { id: randomUUID() }, libro)));
  });

  it("otro estudio: el cliente de E es un 404 para el Dueño de F", async () => {
    const { c } = await compras({}, true);
    expect((await previo(E.titular, c)).status).toBe(200); // control
    const r = await previo(F.titular, c);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });

  it("sin sesión: 401", async () => {
    const { c } = await compras({}, true);
    expect((await previo(contador, c)).status).toBe(200); // control: la ruta existe
    const r = await v.sinSesion("GET", `${rutaArchivos(c.id, PERIODO, "compras")}/previo`);
    expect(r.status, r.text).toBe(401);
  });

  it.each(["2026-10", "20261", "202613", "202600", "abcdef", "209912"])("periodo «%s»: 400 solicitud_invalida", async (periodo) => {
    const c = await nuevoCliente();
    expect((await previo(contador, c)).status).toBe(200); // control: la ruta existe con un periodo válido
    for (const libro of ["compras", "ventas"] as const) {
      const r = await previo(contador, c, libro, periodo);
      expect(r.status, `${libro}: ${r.text}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
  });

  it("el periodo de otro mes del mismo cliente tiene su propio previo (SIN_FILAS)", async () => {
    const { c } = await compras({}, true);
    const r = await previo(contador, c, "compras", "202609");
    expect(r.status).toBe(200);
    expect(r.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS" })]);
  });
});

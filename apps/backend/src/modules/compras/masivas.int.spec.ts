/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 (T9, rojo): acciones masivas por HTTP (D-15, DU-5, DU-6, DU-15; CA-3, CA-4, CA-11, CA-18).
// Contrato (plan 014, «Contratos: HTTP»; `masivas.ts` y `respuestas.ts` de `@contapp/shared`):
//  - `POST …/compras/masivas/{clasificar,aceptar,excluir,restaurar}` con `{ items: [{ compraId, versionBase }] (1 a 5.000, sin
//    repetir compraId), … }`: clasificar `+ destino`, aceptar `+ regla`, excluir `+ motivo?`. Responde 200
//    `{ operacionId | null, aplicadas, rechazadas: [{ compraId, codigo }] }`; 5.001, vacío o repetidos: 400 `solicitud_invalida`.
//  - Son parciales (DU-5): las filas válidas se aplican en UNA operación; las demás van en `rechazadas` con `version_obsoleta`,
//    `requiere_dato`, `revisar_de_nuevo`, `fila_excluida`, `no_masiva` o `no_encontrada`. Sin ninguna aplicada no se crea
//    operación (`operacionId: null`). Un id ajeno (otro cliente, periodo o estudio) o inexistente es `no_encontrada`, sin revelar.
//  - En masa solo se aceptan sugerencias con `requiereConfirmacion = false` y sin dato (DU-6, DU-15): las respaldadas por el XML;
//    el resto es `no_masiva` y se acepta de una en una. Deshacer revierte una masiva de una vez (un paso).
// SUPUESTO que fija este archivo y que T16 debe resolver con el arquitecto: en 014 no hay XML (llega con 016), así que una
// sugerencia con `requiereConfirmacion = false` solo existe como hallazgo GUARDADO. Las pruebas la siembran así (soporte:
// `hallazgoIscXml`, `hallazgoRedXml`) y esperan que la masiva se apoye en el hallazgo guardado de la versión base. Si T16
// re-evalúa sin XML, CA-18 («8 aplicadas») es inalcanzable: se decide con el usuario, no se cambia la prueba.
// LÍMITE DE CUERPO: 5.000 filas pesan unos 340 kB de JSON y hoy el analizador global corta en 16 kB (`LIMITE_JSON` de
// `src/app.ts`: 413 `solicitud_demasiado_grande`). T16 debe darle a `/clientes/:clienteId/periodos/:periodo/compras/masivas/*`
// un límite propio (como `RUTAS_LOTES` de 005) que deje pasar 5.001 filas hasta zod, que es quien responde el 400 del tope.
// Rojo: el módulo `compras` aún no existe (T15 y T16).
import { randomUUID } from "node:crypto";
import { informeMasivaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  hallazgoIscSinXml,
  hallazgoIscXml,
  hallazgoRedXml,
  montos,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type OpcionesCompra,
} from "../../../test/soporte-compras.js";

// Siembras de miles de filas y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const masiva = (
  a: Actor,
  c: Cliente,
  cual: "clasificar" | "aceptar" | "excluir" | "restaurar",
  cuerpo: unknown,
  periodo = PERIODO,
) => v.llamar(a, "POST", `${base(c.id, periodo)}/masivas/${cual}`, cuerpo);
const accion = (a: Actor, c: Cliente, ruta: string, cuerpo?: unknown) =>
  v.llamar(a, "POST", `${base(c.id)}${ruta}`, cuerpo ?? {});
const items = (ids: string[], versionBase = 1) =>
  ids.map((compraId) => ({ compraId, versionBase }));
const doc = (n: number) => `2070000${String(n).padStart(4, "0")}`;

/** Informe de una masiva: forma de `@contapp/shared` y códigos ordenados por id para comparar sin depender del orden. */
function informe(r: { status: number; body: any; text: string }) {
  expect(r.status, r.text).toBe(200);
  const x = informeMasivaSchema.safeParse(r.body);
  expect(x.success, r.text).toBe(true);
  return {
    operacionId: r.body.operacionId as string | null,
    aplicadas: r.body.aplicadas as number,
    rechazadas: [...(r.body.rechazadas as { compraId: string; codigo: string }[])].sort(
      (a, b) => a.compraId.localeCompare(b.compraId),
    ),
  };
}
const ordenar = <T extends { compraId: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.compraId.localeCompare(b.compraId));

/** 12 filas F005-1 a F005-12 de BI 100.00 + IGV 18.00 sin hallazgos (CA-4). */
async function doceGravadas(): Promise<{ c: Cliente; ids: string[] }> {
  const c = await nuevoCliente();
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, {
    libro: "compras",
    nuevas: 12,
    usuarioId: E.titular.id,
  });
  const ids: string[] = [];
  for (let n = 1; n <= 12; n++)
    ids.push(
      await v.sembrarCompra(E.tenantId, c.id, {
        serie: "F005",
        numero: String(n),
        doc: doc(n),
        propuestaId,
        usuarioId: E.titular.id,
      }),
    );
  return { c, ids };
}

/**
 * El caso de CA-18: 12 filas F005-1 a F005-12 de BI 500.00 con IGV 0.00.
 *  1 a 8   R-ISC respaldada por el XML (sin confirmación): se aplican.
 *  9 y 10  con versión vigente 2 (el cliente manda la 1): version_obsoleta.
 *  11      excluida (versión 2): fila_excluida.
 *  12      R-ISC sin XML (pide confirmación): no_masiva.
 */
async function casoCA18() {
  const c = await nuevoCliente();
  const u = E.titular.id;
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, {
    libro: "compras",
    nuevas: 12,
    usuarioId: u,
  });
  const M = montos({ biDg: "500.00" });
  const sembrar = (n: number, extra: Partial<OpcionesCompra>) =>
    v.sembrarCompra(E.tenantId, c.id, {
      serie: "F005",
      numero: String(n),
      doc: doc(n),
      propuestaId,
      usuarioId: u,
      montos: { biDg: "500.00" },
      hallazgos: [hallazgoIscXml(M, "500.00")],
      ...extra,
    });
  const aplicables: string[] = [];
  for (let n = 1; n <= 8; n++) aplicables.push(await sembrar(n, {}));
  const obsoletas = [
    await sembrar(9, { versiones: [{ accion: "editar" }] }),
    await sembrar(10, { versiones: [{ accion: "editar" }] }),
  ];
  const excluida = await sembrar(11, {
    versiones: [{ excluida: true, motivo: "no es del giro", accion: "excluir" }],
  });
  const iscSinXml = await sembrar(12, { hallazgos: [hallazgoIscSinXml(M)] });
  const cuerpo = {
    items: [
      ...items(aplicables.slice(0, 4)),
      { compraId: obsoletas[0], versionBase: 1 },
      ...items(aplicables.slice(4)),
      { compraId: obsoletas[1], versionBase: 1 },
      { compraId: excluida, versionBase: 2 },
      { compraId: iscSinXml, versionBase: 1 },
    ],
    regla: "R-ISC",
  };
  return { c, aplicables, obsoletas, excluida, iscSinXml, cuerpo };
}

// --- CA-18 · parciales ----------------------------------------------------------------------------------------------

describe("CA-18 · masiva de aceptar sugerencias: parcial, en una sola operación (D-15, DU-5, DU-6)", () => {
  it("12 filas con 2 obsoletas, 1 excluida y 1 R-ISC sin XML: se aplican 8 en una operación y las 4 rechazadas llevan su código", async () => {
    const k = await casoCA18();
    const r = await masiva(contador, k.c, "aceptar", k.cuerpo);
    const inf = informe(r);
    expect(inf.aplicadas).toBe(8);
    expect(inf.operacionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inf.rechazadas).toEqual(
      ordenar([
        { compraId: k.obsoletas[0]!, codigo: "version_obsoleta" },
        { compraId: k.obsoletas[1]!, codigo: "version_obsoleta" },
        { compraId: k.excluida, codigo: "fila_excluida" },
        { compraId: k.iscSinXml, codigo: "no_masiva" },
      ]),
    );

    // Una sola operación; las 8 versiones nuevas cuelgan de ella.
    const ops = await v.operaciones(k.c.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: inf.operacionId, usuario_id: contador.id, estado: "vigente" });
    for (const id of k.aplicables) {
      const vs = await v.versiones(id);
      expect(vs.map((x) => x.n)).toEqual([1, 2]);
      expect(vs[0]).toMatchObject({ biDg: "500.00", isc: "0.00", accion: "descarga" }); // versión 1 intacta
      expect(vs[1]).toMatchObject({ accion: "sugerencia", biDg: "0.00", isc: "500.00", total: "500.00", operacion_id: inf.operacionId });
    }
    // Las rechazadas no cambian.
    expect((await v.versiones(k.obsoletas[0]!)).map((x) => x.n)).toEqual([1, 2]);
    expect((await v.versiones(k.excluida)).map((x) => x.n)).toEqual([1, 2]);
    expect((await v.versiones(k.iscSinXml)).map((x) => x.n)).toEqual([1]);
  });

  it("deshacer revierte las 8 de una vez (una masiva es un paso) sin tocar las rechazadas; rehacer las repone", async () => {
    const k = await casoCA18();
    expect(informe(await masiva(contador, k.c, "aceptar", k.cuerpo)).aplicadas).toBe(8);
    const d = await accion(contador, k.c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect([...d.body.filas].sort()).toEqual([...k.aplicables].sort());
    for (const id of k.aplicables) {
      const vs = await v.versiones(id);
      expect(vs.map((x) => x.n)).toEqual([1, 2, 3]);
      expect(vs[2]).toMatchObject({ accion: "deshacer", biDg: "500.00", isc: "0.00", operacion_id: d.body.operacionId });
    }
    expect((await v.versiones(k.iscSinXml)).map((x) => x.n)).toEqual([1]);
    const otra = await accion(contador, k.c, "/deshacer");
    expect(otra.status, otra.text).toBe(409);
    expect(otra.body).toEqual({ codigo: "nada_que_deshacer" });

    const r = await accion(contador, k.c, "/rehacer");
    expect(r.status, r.text).toBe(200);
    expect([...r.body.filas].sort()).toEqual([...k.aplicables].sort());
    for (const id of k.aplicables) expect((await v.versiones(id)).at(-1)).toMatchObject({ accion: "rehacer", isc: "500.00", biDg: "0.00" });
  });

  it("aceptar R-RED en masa: las respaldadas por el XML se aceptan y la de umbral (pide confirmación) va una por una", async () => {
    const c = await nuevoCliente();
    const u = E.titular.id;
    const M = montos({ biDg: "100.00", igvDg: "18.00", total: "118.01" }); // descuadre de un céntimo
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++)
      ids.push(
        await v.sembrarCompra(E.tenantId, c.id, {
          serie: "F006",
          numero: String(n),
          doc: doc(n),
          usuarioId: u,
          montos: { biDg: "100.00", igvDg: "18.00", total: "118.01" },
          hallazgos: [hallazgoRedXml(M, "118.00")],
        }),
      );
    const umbral = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F006",
      numero: "6",
      doc: doc(6),
      usuarioId: u,
      montos: { biDg: "100.00", igvDg: "18.00", total: "118.01" },
      hallazgos: [{ ...hallazgoRedXml(M, "118.00"), requiereConfirmacion: true }],
    });
    const r = await masiva(contador, c, "aceptar", { items: items([...ids, umbral]), regla: "R-RED" });
    const inf = informe(r);
    expect(inf.aplicadas).toBe(5);
    expect(inf.rechazadas).toEqual([{ compraId: umbral, codigo: "no_masiva" }]);
    for (const id of ids) expect((await v.versiones(id)).at(-1)).toMatchObject({ n: 2, accion: "sugerencia", total: "118.00", operacion_id: inf.operacionId });
    expect((await v.versiones(umbral)).map((x) => x.n)).toEqual([1]);
  });

  it("sin ninguna aplicada no se crea operación: 200 con operacionId null y la lista de rechazadas", async () => {
    const k = await casoCA18();
    const cuerpo = {
      regla: "R-ISC",
      items: [
        { compraId: k.obsoletas[0], versionBase: 1 },
        { compraId: k.excluida, versionBase: 2 },
        { compraId: k.iscSinXml, versionBase: 1 },
      ],
    };
    const antes = await v.foto(k.c.id);
    const inf = informe(await masiva(contador, k.c, "aceptar", cuerpo));
    expect(inf.operacionId).toBeNull();
    expect(inf.aplicadas).toBe(0);
    expect(inf.rechazadas).toHaveLength(3);
    expect(await v.foto(k.c.id)).toEqual(antes);
    expect((await accion(contador, k.c, "/deshacer")).body).toEqual({ codigo: "nada_que_deshacer" });
  });

  it("una masiva de aceptar no admite `confirmar` ni `dato`: se ignoran y no cambian la regla de qué entra", async () => {
    const k = await casoCA18();
    const inf = informe(await masiva(contador, k.c, "aceptar", { ...k.cuerpo, confirmar: true, dato: { gravado: "1.00" } }));
    expect(inf.aplicadas).toBe(8); // la de «sin XML» sigue siendo no_masiva aunque se mande confirmar
    expect(inf.rechazadas.find((x) => x.compraId === k.iscSinXml)?.codigo).toBe("no_masiva");
  });
});

// --- CA-4 · clasificar en masa --------------------------------------------------------------------------------------------

describe("CA-4 · clasificar 12 filas es una sola operación y el resumen lo refleja", () => {
  it("12 filas de DG a DNG: 12 aplicadas, una operación, versión 1 intacta y resumen con BI DG −1200.00 y BI DNG +1200.00", async () => {
    const { c, ids } = await doceGravadas();
    const r = await masiva(contador, c, "clasificar", { items: items(ids), destino: "DNG" });
    const inf = informe(r);
    expect(inf.aplicadas).toBe(12);
    expect(inf.rechazadas).toEqual([]);
    expect(await v.operaciones(c.id)).toHaveLength(1);
    for (const id of ids) {
      const vs = await v.versiones(id);
      expect(vs.map((x) => x.n)).toEqual([1, 2]);
      expect(vs[0]).toMatchObject({ biDg: "100.00", igvDg: "18.00", biDng: "0.00", accion: "descarga" });
      expect(vs[1]).toMatchObject({ accion: "clasificar", clasificada: true, biDg: "0.00", igvDg: "0.00", biDng: "100.00", igvDng: "18.00", total: "118.00", operacion_id: inf.operacionId });
    }
    const res = await v.llamar(contador, "GET", `${base(c.id)}/resumen`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.casilleros.diferencia).toMatchObject({ biDg: "-1200.00", igvDg: "-216.00", biDng: "1200.00", igvDng: "216.00", total: "0.00" });
  });

  it("un destino que no existe, o sin destino, es 400 y no escribe", async () => {
    const { c, ids } = await doceGravadas();
    const antes = await v.foto(c.id);
    for (const cuerpo of [{ items: items(ids), destino: "XX" }, { items: items(ids) }]) {
      const r = await masiva(contador, c, "clasificar", cuerpo);
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("una fila excluida se rechaza con fila_excluida y una con versionBase vieja con version_obsoleta; el resto se aplica", async () => {
    const { c, ids } = await doceGravadas();
    expect((await accion(contador, c, `/${ids[0]}/excluir`, { versionBase: 1 })).status).toBe(200);
    expect((await accion(contador, c, `/${ids[1]}/editar`, { versionBase: 1, cambios: { biDg: "101.00" } })).status).toBe(200);
    const mezcla = [
      { compraId: ids[0], versionBase: 2 }, // excluida
      { compraId: ids[1], versionBase: 1 }, // obsoleta (la vigente es la 2)
      ...items(ids.slice(2)),
    ];
    const inf = informe(await masiva(contador, c, "clasificar", { items: mezcla, destino: "DGNG" }));
    expect(inf.aplicadas).toBe(10);
    expect(inf.rechazadas).toEqual(
      ordenar([
        { compraId: ids[0]!, codigo: "fila_excluida" },
        { compraId: ids[1]!, codigo: "version_obsoleta" },
      ]),
    );
  });
});

describe("excluir y restaurar en masa (D-6, D-15)", () => {
  it("excluir 12 con motivo: una operación, salen de la lista principal y aparecen en «excluidas»; restaurar las devuelve", async () => {
    const { c, ids } = await doceGravadas();
    const e = informe(await masiva(contador, c, "excluir", { items: items(ids), motivo: "no es del giro" }));
    expect(e.aplicadas).toBe(12);
    expect(await v.operaciones(c.id)).toHaveLength(1);
    expect((await v.versiones(ids[0]!)).at(-1)).toMatchObject({ accion: "excluir", excluida: true, motivo: "no es del giro" });
    const lista = await v.llamar(contador, "GET", `${base(c.id)}`);
    expect(lista.body.filas).toEqual([]);
    const ex = await v.llamar(contador, "GET", `${base(c.id)}?vista=excluidas`);
    expect(ex.body.filas).toHaveLength(12);

    const r = informe(await masiva(contador, c, "restaurar", { items: items(ids, 2) }));
    expect(r.aplicadas).toBe(12);
    expect(r.rechazadas).toEqual([]);
    expect((await v.llamar(contador, "GET", `${base(c.id)}`)).body.filas).toHaveLength(12);
    expect((await v.versiones(ids[0]!)).at(-1)).toMatchObject({ n: 3, accion: "restaurar", excluida: false });
  });

  it("excluir una ya excluida es fila_excluida en su fila; el motivo de más de 200 caracteres es 400", async () => {
    const { c, ids } = await doceGravadas();
    expect((await accion(contador, c, `/${ids[0]}/excluir`, { versionBase: 1 })).status).toBe(200);
    const inf = informe(await masiva(contador, c, "excluir", { items: [{ compraId: ids[0], versionBase: 2 }, { compraId: ids[1], versionBase: 1 }] }));
    expect(inf.aplicadas).toBe(1);
    expect(inf.rechazadas).toEqual([{ compraId: ids[0], codigo: "fila_excluida" }]);
    const largo = await masiva(contador, c, "excluir", { items: items([ids[2]!]), motivo: "x".repeat(201) });
    expect(largo.status, largo.text).toBe(400);
  });
});

// --- D-15 · límites y ids ajenos ----------------------------------------------------------------------------------------------

describe("D-15 · límites del cuerpo: hasta 5.000 filas, sin repetir, y nada se escribe si el cuerpo es inválido", () => {
  it("5.001 ids dan 400 solicitud_invalida y no escribe nada", async () => {
    const { c, ids } = await doceGravadas();
    const antes = await v.foto(c.id);
    const muchos = Array.from({ length: 5001 }, () => ({ compraId: randomUUID(), versionBase: 1 }));
    for (const cual of ["clasificar", "aceptar", "excluir", "restaurar"] as const) {
      const cuerpo = cual === "clasificar" ? { items: muchos, destino: "DNG" } : cual === "aceptar" ? { items: muchos, regla: "R-RED" } : { items: muchos };
      const r = await masiva(contador, c, cual, cuerpo);
      expect(r.status, `${cual}: ${r.text}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    // 5.001 con ids reales mezclados tampoco: el tope manda antes que cualquier lectura.
    const mezcla = [...items(ids), ...muchos.slice(0, 4989)];
    expect(mezcla).toHaveLength(5001);
    expect((await masiva(contador, c, "clasificar", { items: mezcla, destino: "DNG" })).status).toBe(400);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each([
    ["items vacío", { items: [], destino: "DNG" }],
    ["sin items", { destino: "DNG" }],
    ["items no es arreglo", { items: "x", destino: "DNG" }],
    ["compraId que no es uuid", { items: [{ compraId: "no-es-uuid", versionBase: 1 }], destino: "DNG" }],
    ["versionBase cero", { items: [{ compraId: randomUUID(), versionBase: 0 }], destino: "DNG" }],
    ["sin versionBase", { items: [{ compraId: randomUUID() }], destino: "DNG" }],
  ])("400 solicitud_invalida: %s", async (_n, cuerpo) => {
    const { c } = await doceGravadas();
    const antes = await v.foto(c.id);
    const r = await masiva(contador, c, "clasificar", cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("un compraId repetido, aunque cambie la versionBase, es 400", async () => {
    const { c, ids } = await doceGravadas();
    const antes = await v.foto(c.id);
    const r = await masiva(contador, c, "clasificar", {
      items: [{ compraId: ids[0], versionBase: 1 }, { compraId: ids[0]!.toUpperCase(), versionBase: 2 }],
      destino: "DNG",
    });
    expect(r.status, r.text).toBe(400);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("5.000 ids se aplican en una sola operación y deshacer los revierte todos", async () => {
    const c = await nuevoCliente();
    const ids = await v.sembrarVolumen(E.tenantId, c.id, 5000, { usuarioId: E.titular.id });
    const r = await masiva(contador, c, "clasificar", { items: items(ids), destino: "DNG" });
    const inf = informe(r);
    expect(inf.aplicadas).toBe(5000);
    expect(inf.rechazadas).toEqual([]);
    expect(await v.operaciones(c.id)).toHaveLength(1);
    const n = await v.b.sql("select count(*)::int as n from compra_version where operacion_id = $1", [inf.operacionId]);
    expect(n[0].n).toBe(5000);
    const d = await accion(contador, c, "/deshacer");
    expect(d.status, d.text).toBe(200);
    expect(d.body.filas).toHaveLength(5000);
  });
});

describe("D-15 · ids de otro cliente, periodo o estudio: `no_encontrada`, igual que uno inexistente, y no se tocan", () => {
  it("la fila propia se aplica y las ajenas salen no_encontrada sin revelar nada", async () => {
    const { c, ids } = await doceGravadas();
    const otro = await doceGravadas(); // otro cliente del mismo estudio
    const enOtroPeriodo = await v.sembrarCompra(E.tenantId, c.id, { serie: "F007", numero: "1", usuarioId: E.titular.id, periodo: "202609" });
    const cf = await v.cliente(F);
    const deF = await v.sembrarCompra(F.tenantId, cf.id, { serie: "F008", numero: "1", usuarioId: F.titular.id });
    const antesOtro = await v.foto(otro.c.id);
    const antesF = await v.foto(cf.id);
    const inexistente = randomUUID();
    const r = await masiva(contador, c, "clasificar", {
      items: [
        { compraId: ids[0], versionBase: 1 },
        { compraId: otro.ids[0], versionBase: 1 },
        { compraId: enOtroPeriodo, versionBase: 1 },
        { compraId: deF, versionBase: 1 },
        { compraId: inexistente, versionBase: 1 },
      ],
      destino: "DNG",
    });
    const inf = informe(r);
    expect(inf.aplicadas).toBe(1);
    expect(inf.rechazadas).toEqual(
      ordenar([otro.ids[0]!, enOtroPeriodo, deF, inexistente].map((compraId) => ({ compraId, codigo: "no_encontrada" }))),
    );
    // Lo ajeno no se tocó.
    expect(await v.foto(otro.c.id)).toEqual(antesOtro);
    expect(await v.foto(cf.id)).toEqual(antesF);
    expect((await v.versiones(enOtroPeriodo)).map((x) => x.n)).toEqual([1]);
    // Y la respuesta no deja ver de dónde salía cada id (nada del estudio ni del otro cliente).
    const texto = JSON.stringify(r.body);
    for (const prohibido of [F.tenantId, E.tenantId, otro.c.id, cf.id]) expect(texto).not.toContain(prohibido);
  });

  it("el cliente ajeno entero (otro estudio) es el mismo 404 de siempre, con ids reales o inexistentes", async () => {
    const { c, ids } = await doceGravadas();
    const antes = await v.foto(c.id);
    const real = await v.llamar(F.titular, "POST", `${base(c.id)}/masivas/clasificar`, { items: items(ids), destino: "DNG" });
    const falso = await v.llamar(F.titular, "POST", `${base(randomUUID())}/masivas/clasificar`, { items: items(ids), destino: "DNG" });
    expect(real.status, real.text).toBe(404);
    expect(real.body).toEqual({ codigo: "no_encontrado" });
    expect({ s: real.status, b: real.body }).toEqual({ s: falso.status, b: falso.body });
    expect(await v.foto(c.id)).toEqual(antes);
  });
});

// --- CA-3 · concurrencia -------------------------------------------------------------------------------------------------------

describe("CA-3 · masivas con filas contendidas: ninguna queda a medias ni hay interbloqueo", () => {
  it("dos masivas sobre las mismas 200 filas en orden opuesto, a la vez: cada fila la gana una sola; el resto es version_obsoleta", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const c = await nuevoCliente();
      const ids = await v.sembrarVolumen(E.tenantId, c.id, 200, { usuarioId: E.titular.id });
      const t0 = Date.now();
      const [a, b] = await Promise.all([
        masiva(contador, c, "clasificar", { items: items(ids), destino: "DNG" }),
        masiva(E.titular, c, "clasificar", { items: items([...ids].reverse()), destino: "DGNG" }),
      ]);
      expect(Date.now() - t0, `ronda ${ronda}: sin interbloqueo`).toBeLessThan(60_000);
      const ia = informe(a);
      const ib = informe(b);
      expect(ia.aplicadas + ib.aplicadas, `ronda ${ronda}`).toBe(200);
      for (const x of [...ia.rechazadas, ...ib.rechazadas]) expect(x.codigo).toBe("version_obsoleta");
      // Ninguna fila quedó a medias ni con dos versiones nuevas: cada una tiene exactamente la 1 y la ganadora.
      for (const id of ids) expect((await v.versiones(id)).map((x) => x.n)).toEqual([1, 2]);
      // Las operaciones creadas son las que aplicaron algo, y cada versión 2 apunta a una de ellas.
      const ops = (await v.operaciones(c.id)).map((o) => o.id).sort();
      expect(ops).toEqual([ia.operacionId, ib.operacionId].filter((x): x is string => x !== null).sort());
    }
  });

  it("una masiva y una acción individual sobre la misma fila a la vez: la fila la gana una sola", async () => {
    const { c, ids } = await doceGravadas();
    const [m, s] = await Promise.all([
      masiva(contador, c, "clasificar", { items: items(ids), destino: "DNG" }),
      accion(E.titular, c, `/${ids[5]}/clasificar`, { versionBase: 1, destino: "DGNG" }),
    ]);
    const inf = informe(m);
    expect([200, 409]).toContain(s.status);
    // O la ganó la individual (la masiva la rechaza como obsoleta) o la ganó la masiva (la individual recibe 409).
    expect(inf.aplicadas + (s.status === 200 ? 1 : 0)).toBe(12);
    expect((await v.versiones(ids[5]!)).map((x) => x.n)).toEqual([1, 2]);
  });

  it("una masiva y un deshacer simultáneos no se interbloquean", async () => {
    const { c, ids } = await doceGravadas();
    expect((await accion(contador, c, `/${ids[0]}/clasificar`, { versionBase: 1, destino: "DNG" })).status).toBe(200);
    const t0 = Date.now();
    const [m, d] = await Promise.all([
      masiva(asistente, c, "clasificar", { items: items(ids.slice(1)), destino: "DGNG" }),
      accion(contador, c, "/deshacer"),
    ]);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(informe(m).aplicadas).toBe(11);
    expect(d.status, d.text).toBe(200);
  });
});

// --- CA-12 / CA-13 · estado y alcance de las masivas ------------------------------------------------------------------------------------

describe("CA-12 · estado del periodo en las masivas", () => {
  it("revisado: sire.clasificar recibe 403 periodo_revisado y sire.aprobar_generar aplica; generado: 409 periodo_generado para todos", async () => {
    const { c, ids } = await doceGravadas();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const antes = await v.foto(c.id);
    const bloq = await masiva(asistente, c, "clasificar", { items: items(ids), destino: "DNG" });
    expect(bloq.status, bloq.text).toBe(403);
    expect(bloq.body).toEqual({ codigo: "periodo_revisado" });
    expect(await v.foto(c.id)).toEqual(antes);
    expect(informe(await masiva(contador, c, "clasificar", { items: items(ids.slice(0, 6)), destino: "DNG" })).aplicadas).toBe(6);

    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    for (const a of [asistente, contador, E.titular]) {
      const r = await masiva(a, c, "clasificar", { items: items(ids.slice(6)), destino: "DNG" });
      expect(r.status, `${a.rol}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "periodo_generado" });
    }
  });
});

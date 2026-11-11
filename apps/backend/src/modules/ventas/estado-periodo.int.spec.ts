/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b (T6, rojo): estado del periodo de ventas (P-1, P-9, D5; CA-10). Contrato (plan 012b, «Contratos: HTTP»; formas de
// 014: `estadoPeriodoRespuestaSchema`, `reabrirPeriodoSchema`):
//  - `POST …/ventas/estado/revisar` (`sire.clasificar`) -> 200 { estado: "revisado", por, en }; `POST …/ventas/estado/reabrir`
//    { estadoVisto: "revisado"|"generado" } (`sire.aprobar_generar`) -> 200 { estado: "abierto", … }. Compare-and-set: revisar
//    desde revisado o generado, y reabrir con un estadoVisto que no es el vigente (o desde abierto), son 409 `estado_invalido`.
//    `estadoVisto: "abierto"` o un cuerpo mal formado es 400. Cliente archivado: 409 `cliente_archivado`. No crean versiones ni
//    tocan las ventas. El estado vive en `venta_periodo` y es independiente del de compras (`compra_periodo`).
//  - `GET …/ventas/resumen` suma `estado` ("abierto" por omisión) y `excluidas` (cantidad; las excluidas no suman).
//  - Escrituras de ventas (de 013: descargar, importar/confirmar, agregar, quitar, justificar y revertir; de 012b: excluir y
//    restaurar): con `generado`, 409 `periodo_generado` para todos; con `revisado`, solo quien tiene `sire.aprobar_generar`
//    escribe y el resto recibe 403 `periodo_revisado` (P-9, también al volver a descargar o importar); con `abierto`, basta el
//    permiso de la ruta. El permiso de la ruta (403 `permiso_denegado`) va antes que el estado. Un rechazo no cambia nada.
//  - Las lecturas siguen disponibles con cualquier estado. El estado de un periodo no pasa a otro periodo ni a otro cliente.
// Rojo: las rutas de estado y las tablas de 012b aún no existen (T10 y T13).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, cumple, descuadrada, type EstadoPeriodoBd, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, boletas290y292, csvVentas, cuerpoVenta, fila } from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
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
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;

interface Esc {
  c: Cliente;
  /** Venta del SIRE descuadrada (excluible). */
  excluibleId: string;
  /** Venta del SIRE descuadrada que `preparar` de «restaurar» deja con exclusión vigente. */
  excluidaId: string;
  /** Venta agregada a mano (quitable). */
  manualId: string;
  /** Justificación vigente de B002-5 (revertible). */
  saltoId: string;
}

/** Cliente con B001-290 y B001-292 (falta la 291), dos descuadradas del SIRE, una manual y un salto justificado. */
async function escenario(estado: EstadoPeriodoBd = "abierto", o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<Esc> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
  await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
  const [excluibleId] = await v.sembrarVentas(E.tenantId, c.id, [descuadrada("D001", 1)], { usuarioId: u() });
  const [excluidaId] = await v.sembrarVentas(E.tenantId, c.id, [descuadrada("D001", 2)], { usuarioId: u() });
  const [manualId] = await v.sembrarVentas(E.tenantId, c.id, [fila("M001", 1)], { usuarioId: u(), origen: "manual" });
  const saltoId = await v.sembrarSalto(E.tenantId, c.id, { usuarioId: contador.id, serie: "B002", desde: 5, hasta: 5 });
  if (estado !== "abierto") await A.estadoVentas(E.tenantId, c.id, PERIODO, estado, contador.id);
  return { c, excluibleId: excluibleId!, excluidaId: excluidaId!, manualId: manualId!, saltoId };
}

const post = (a: Actor, c: { id: string }, ruta: string, cuerpo?: unknown, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}${ruta}`, cuerpo ?? {});
const get = (a: Actor, c: { id: string }, ruta = "", periodo = PERIODO) => v.llamar(a, "GET", `${base(c.id, periodo)}${ruta}`);
const getOk = async (...args: Parameters<typeof get>) => {
  const r = await get(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};
const codigoDe = (r: { body?: any; json?: any }): string | undefined => r.body?.codigo ?? r.json?.codigo;

// --- Revisar y reabrir ------------------------------------------------------------------------------------------------------

describe("P-1 · marcar revisado y reabrir el periodo de ventas", () => {
  it("el resumen trae estado «abierto» y excluidas = 0 por omisión, con la forma de resumenVentasSchema", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(E.tenantId, c.id, boletas290y292(), { usuarioId: u() });
    const r = await getOk(contador, c, "/resumen");
    expect(r.status, r.text).toBe(200);
    expect(cumple("resumenVentasSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ estado: "abierto", excluidas: 0 });
  });

  it("revisar desde abierto lo hace sire.clasificar: 200 { estado, por, en }, la fila de venta_periodo y el resumen lo refleja", async () => {
    const e = await escenario();
    const r = await post(asistente, e.c, "/estado/revisar");
    expect(r.status, r.text).toBe(200);
    expect(cumple("estadoPeriodoRespuestaSchema", r.body), r.text).toBe(true);
    expect(r.body.estado).toBe("revisado");
    expect(r.body.por).toBe(asistente.id);
    expect(Number.isNaN(Date.parse(r.body.en))).toBe(false);
    expect(await A.periodoVentas(e.c.id)).toMatchObject({ estado: "revisado", marcado_por: asistente.id });
    expect((await getOk(contador, e.c, "/resumen")).body.estado).toBe("revisado");
  });

  it("revisar de nuevo, o desde generado, es 409 estado_invalido y no cambia nada", async () => {
    const e = await escenario();
    expect((await post(contador, e.c, "/estado/revisar")).status).toBe(200);
    const otra = await post(contador, e.c, "/estado/revisar");
    expect(otra.status, otra.text).toBe(409);
    expect(otra.body).toEqual({ codigo: "estado_invalido" });
    await A.estadoVentas(E.tenantId, e.c.id, PERIODO, "generado", contador.id);
    const gen = await post(contador, e.c, "/estado/revisar");
    expect(gen.status, gen.text).toBe(409);
    expect(gen.body).toEqual({ codigo: "estado_invalido" });
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("generado");
  });

  it("dos revisar simultáneos: uno gana (200) y el otro es 409 estado_invalido", async () => {
    const e = await escenario();
    const rs = await Promise.all([post(contador, e.c, "/estado/revisar"), post(asistente, e.c, "/estado/revisar")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body).toEqual({ codigo: "estado_invalido" });
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("revisado");
  });

  it("reabrir exige sire.aprobar_generar: el asistente recibe 403 permiso_denegado", async () => {
    const e = await escenario("revisado");
    const r = await post(asistente, e.c, "/estado/reabrir", { estadoVisto: "revisado" });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("revisado");
  });

  it("reabrir desde revisado y desde generado vuelve a abierto (CA-10), y entonces el asistente vuelve a escribir", async () => {
    for (const desde of ["revisado", "generado"] as const) {
      const e = await escenario(desde);
      const bloq = await post(asistente, e.c, "", cuerpoVenta("B001", 291));
      expect(bloq.status, `${desde}: ${bloq.text}`).toBe(desde === "revisado" ? 403 : 409);
      const r = await post(contador, e.c, "/estado/reabrir", { estadoVisto: desde });
      expect(r.status, `${desde}: ${r.text}`).toBe(200);
      expect(cumple("estadoPeriodoRespuestaSchema", r.body), r.text).toBe(true);
      expect(r.body.estado).toBe("abierto");
      expect((await A.periodoVentas(e.c.id))?.estado).toBe("abierto");
      expect((await getOk(contador, e.c, "/resumen")).body.estado).toBe("abierto");
      const ok = await post(asistente, e.c, "", cuerpoVenta("B001", 291));
      expect(ok.status, `${desde}: ${ok.text}`).toBe(201);
    }
  });

  it("reabrir con un estadoVisto que ya no es el vigente (generado visto como revisado, o abierto) es 409 estado_invalido", async () => {
    const e = await escenario("generado");
    const viejo = await post(contador, e.c, "/estado/reabrir", { estadoVisto: "revisado" });
    expect(viejo.status, viejo.text).toBe(409);
    expect(viejo.body).toEqual({ codigo: "estado_invalido" });
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("generado");
    const abierto = await escenario();
    const r = await post(contador, abierto.c, "/estado/reabrir", { estadoVisto: "revisado" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
  });

  it("reabrir con un cuerpo mal formado es 400 solicitud_invalida", async () => {
    const e = await escenario("revisado");
    for (const cuerpo of [{}, { estadoVisto: "abierto" }, { estadoVisto: "cerrado" }, { estadoVisto: null }]) {
      const r = await post(contador, e.c, "/estado/reabrir", cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("revisado");
  });

  it("revisar y reabrir no tocan las ventas, las exclusiones ni los saltos", async () => {
    const e = await escenario();
    const antes = (await A.fotoVentas(v, e.c.id)) as any;
    await post(contador, e.c, "/estado/revisar");
    await post(contador, e.c, "/estado/reabrir", { estadoVisto: "revisado" });
    const despues = (await A.fotoVentas(v, e.c.id)) as any;
    expect({ ...despues, periodo: null }).toEqual({ ...antes, periodo: null });
  });

  it("el estado de ventas y el de compras son independientes", async () => {
    const e = await escenario();
    expect((await post(contador, e.c, "/estado/revisar")).status).toBe(200);
    expect(await v.periodoFila(e.c.id)).toBeNull(); // compra_periodo intacto
    const c2 = await escenario();
    expect((await v.llamar(contador, "POST", `/clientes/${c2.c.id}/periodos/${PERIODO}/compras/estado/revisar`, {})).status).toBe(200);
    expect(await A.periodoVentas(c2.c.id)).toBeNull();
    expect((await getOk(contador, c2.c, "/resumen")).body.estado).toBe("abierto");
  });

  it("el estado de un periodo no pasa a otro periodo ni a otro cliente", async () => {
    const e = await escenario("generado");
    const otro = await escenario();
    expect((await post(asistente, e.c, "", cuerpoVenta("B009", 1, { fechaEmision: "2026-09-05" }), "202609")).status).toBe(201); // otro periodo del mismo cliente
    expect((await post(asistente, otro.c, "", cuerpoVenta("B009", 1))).status).toBe(201); // otro cliente
    expect((await post(asistente, e.c, "", cuerpoVenta("B009", 1))).status).toBe(409); // control: el suyo sigue generado
  });

  it("las lecturas siguen disponibles con el periodo generado", async () => {
    const e = await escenario("generado");
    for (const ruta of ["", "/resumen", "/correlatividad", "/propuestas"]) {
      const r = await getOk(lectura, e.c, ruta);
      expect(r.status, `${ruta}: ${r.text}`).toBe(200);
    }
  });
});

// Spec 017 · T18a-servidor (P-1): el resumen de ventas trae el bloque de estado de revisar y reabrir (`por`, `autor`, `en`).
describe("P-1 (017) · el resumen de ventas dice quién marcó el periodo y cuándo", () => {
  it("abierto y sin marcar: por, autor y en son null", async () => {
    const c = await v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id] });
    const r = await getOk(lectura, c, "/resumen");
    expect(r.body).toMatchObject({ estado: "abierto", por: null, autor: null, en: null });
    expect(cumple("resumenVentasSchema", r.body), r.text).toBe(true);
  });

  it("revisado: otro usuario, o tras recargar, ve por, autor con nombre y en iguales a los de revisar", async () => {
    const e = await escenario();
    await v.b.c.p.b.sql("update usuario set nombre = 'Carlos Contador' where id = $1", [contador.id]);
    const marca = await post(contador, e.c, "/estado/revisar");
    expect(marca.status, marca.text).toBe(200);
    for (const quien of [lectura, contador]) {
      const r = await getOk(quien, e.c, "/resumen");
      expect(r.body.estado).toBe("revisado");
      expect(r.body.por).toBe(contador.id);
      expect(r.body.autor).toEqual({ id: contador.id, nombre: "Carlos Contador", activo: true });
      expect(r.body.en).toBe(marca.body.en);
      expect(Object.keys(r.body.autor).sort()).toEqual(["activo", "id", "nombre"]);
      expect(cumple("resumenVentasSchema", r.body), r.text).toBe(true);
    }
  });

  it("quien marcó y se desactivó conserva su nombre con activo false", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const baja = await v.b.c.p.b.miembro(E.tenantId, "contador", { sesion: false });
    await v.b.c.p.b.sql("update usuario set nombre = 'Beto Baja' where id = $1", [baja.id]);
    await A.estadoVentas(E.tenantId, c.id, PERIODO, "revisado", baja.id);
    await v.b.c.p.b.sql("update membresia set desactivada_en = now() where usuario_id = $1 and tenant_id = $2", [baja.id, E.tenantId]);
    const r = await getOk(contador, c, "/resumen");
    expect(r.body.autor).toEqual({ id: baja.id, nombre: "Beto Baja", activo: false });
  });
});

describe("P-1 · permisos, alcance y cliente archivado de revisar y reabrir", () => {
  it("la lectura no revisa ni reabre (403 permiso_denegado); el asistente no asignado recibe 404", async () => {
    const e = await escenario("revisado");
    for (const [ruta, cuerpo] of [
      ["/estado/revisar", {}],
      ["/estado/reabrir", { estadoVisto: "revisado" }],
    ] as const) {
      const l = await post(lectura, e.c, ruta, cuerpo);
      expect(l.status, `lectura ${ruta}: ${l.text}`).toBe(403);
      expect(l.body).toEqual({ codigo: "permiso_denegado" });
      const n = await post(asistenteAjeno, e.c, ruta, cuerpo);
      expect(n.status, `asistente ajeno ${ruta}: ${n.text}`).toBe(404);
      expect(n.body).toEqual({ codigo: "no_encontrado" });
    }
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("revisado");
  });

  it("otro estudio y cliente inexistente: 404; sin sesión: 401", async () => {
    const e = await escenario();
    expect((await post(contador, (await escenario()).c, "/estado/revisar")).status).toBe(200); // control: la ruta existe
    for (const ruta of ["/estado/revisar", "/estado/reabrir"]) {
      const cuerpo = ruta.endsWith("reabrir") ? { estadoVisto: "revisado" } : {};
      expect((await post(F.titular, e.c, ruta, cuerpo)).status).toBe(404);
      expect((await post(contador, { id: randomUUID() }, ruta, cuerpo)).status).toBe(404);
      const sin = await v.sinSesion("POST", `${base(e.c.id)}${ruta}`, cuerpo);
      expect(sin.status, sin.text).toBe(401);
    }
    expect(await A.periodoVentas(e.c.id)).toBeNull();
  });

  it("cliente archivado: revisar y reabrir son 409 cliente_archivado y no cambian el estado", async () => {
    const e = await escenario("revisado", { archivado: true });
    for (const [ruta, cuerpo] of [
      ["/estado/revisar", {}],
      ["/estado/reabrir", { estadoVisto: "revisado" }],
    ] as const) {
      const r = await post(contador, e.c, ruta, cuerpo);
      expect(r.status, `${ruta}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "cliente_archivado" });
    }
    expect((await A.periodoVentas(e.c.id))?.estado).toBe("revisado");
  });

  it.each(["2026-10", "202613", "abcdef", "209912"])("periodo «%s»: 400 solicitud_invalida", async (periodo) => {
    const e = await escenario();
    expect((await getOk(contador, e.c, "/resumen")).body.estado).toBe("abierto"); // control: el estado existe en el resumen
    for (const [ruta, cuerpo] of [
      ["/estado/revisar", {}],
      ["/estado/reabrir", { estadoVisto: "revisado" }],
    ] as const) {
      const r = await post(contador, e.c, ruta, cuerpo, periodo);
      expect(r.status, `${ruta}: ${r.text}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
  });
});

// --- Matriz de escrituras × estado (CA-10, P-9) ------------------------------------------------------------------------------

interface Accion {
  nombre: string;
  /** Estado HTTP cuando la escritura se permite. */
  ok: number;
  /** Siembra lo que la acción necesita (p. ej. la exclusión vigente que restaurar cierra). */
  preparar?(e: Esc): Promise<void>;
  llamar(a: Actor, e: Esc): Promise<{ status: number; body?: any; json?: any }>;
}
const ACCIONES: Accion[] = [
  { nombre: "descargar", ok: 202, llamar: (a, e) => v.llamar(a, "POST", `${base(e.c.id)}/descargar`) },
  {
    nombre: "importar",
    ok: 201,
    llamar: (a, e) => v.bin(a, "POST", `${base(e.c.id)}/importar/confirmar`, csvVentas([fila("B009", 1)])),
  },
  { nombre: "agregar", ok: 201, llamar: (a, e) => v.llamar(a, "POST", base(e.c.id), cuerpoVenta("B001", 291)) },
  { nombre: "quitar", ok: 204, llamar: (a, e) => v.llamar(a, "DELETE", `${base(e.c.id)}/${e.manualId}`) },
  {
    nombre: "justificar",
    ok: 201,
    llamar: (a, e) =>
      v.llamar(a, "POST", `${base(e.c.id)}/saltos-justificados`, {
        tipo: "03",
        serie: "B001",
        desde: 291,
        hasta: 291,
        comentario: "Boleta anulada en caja",
      }),
  },
  { nombre: "revertir", ok: 204, llamar: (a, e) => v.llamar(a, "DELETE", `${base(e.c.id)}/saltos-justificados/${e.saltoId}`) },
  {
    nombre: "excluir",
    ok: 200,
    llamar: (a, e) => v.llamar(a, "POST", `${base(e.c.id)}/${e.excluibleId}/excluir`, { motivo: "Llegó descuadrada del SIRE" }),
  },
  {
    nombre: "restaurar",
    ok: 200,
    preparar: async (e) => {
      await A.sembrarExclusion(E.tenantId, e.c.id, e.excluidaId, { usuarioId: contador.id });
    },
    llamar: (a, e) => v.llamar(a, "POST", `${base(e.c.id)}/${e.excluidaId}/restaurar`, {}),
  },
];

describe("CA-10 / P-9 · matriz de escrituras de ventas × estado × permiso", () => {
  describe.each(ACCIONES)("$nombre", (accion) => {
    it("generado: nadie escribe, ni con sire.aprobar_generar (409 periodo_generado), y nada cambia", async () => {
      const e = await escenario("generado");
      await accion.preparar?.(e);
      const antes = await A.fotoVentas(v, e.c.id);
      for (const a of [asistente, contador, E.titular]) {
        const r = await accion.llamar(a, e);
        expect(r.status, `${accion.nombre} como ${a.rol}: ${JSON.stringify(r.body ?? r.json)}`).toBe(409);
        expect(codigoDe(r)).toBe("periodo_generado");
      }
      expect(await A.fotoVentas(v, e.c.id)).toEqual(antes);
    });

    it("revisado: quien solo tiene sire.clasificar o sire.descargar (asistente) recibe 403 periodo_revisado y nada cambia", async () => {
      const e = await escenario("revisado");
      await accion.preparar?.(e);
      const antes = await A.fotoVentas(v, e.c.id);
      const r = await accion.llamar(asistente, e);
      expect(r.status, `${accion.nombre}: ${JSON.stringify(r.body ?? r.json)}`).toBe(403);
      expect(codigoDe(r)).toBe("periodo_revisado");
      expect(await A.fotoVentas(v, e.c.id)).toEqual(antes);
    });

    it("revisado: quien tiene sire.aprobar_generar (contador) no es bloqueado y la escritura se hace", async () => {
      const e = await escenario("revisado");
      await accion.preparar?.(e);
      const r = await accion.llamar(contador, e);
      expect(r.status, `${accion.nombre}: ${JSON.stringify(r.body ?? r.json)}`).toBe(accion.ok);
    });

    it("abierto: basta el permiso de la ruta (el asistente escribe)", async () => {
      const e = await escenario("abierto");
      await accion.preparar?.(e);
      const r = await accion.llamar(asistente, e);
      expect(r.status, `${accion.nombre}: ${JSON.stringify(r.body ?? r.json)}`).toBe(accion.ok);
    });

    it("la lectura recibe 403 permiso_denegado antes que el estado (generado o revisado)", async () => {
      for (const estado of ["generado", "revisado"] as const) {
        const e = await escenario(estado);
        await accion.preparar?.(e);
        const r = await accion.llamar(lectura, e);
        expect(r.status, `${accion.nombre} ${estado}: ${JSON.stringify(r.body ?? r.json)}`).toBe(403);
        expect(codigoDe(r)).toBe("permiso_denegado");
      }
    });
  });

  it("un rechazo por estado no encola descargas: ningún trabajo nuevo", async () => {
    const e = await escenario("generado");
    const antes = (await v.trabajos(e.c.id)).length;
    const r = await v.llamar(contador, "POST", `${base(e.c.id)}/descargar`);
    expect(r.status).toBe(409);
    expect((await v.trabajos(e.c.id)).length).toBe(antes);
  });

  it("la vista previa de la importación no escribe y sigue disponible con el periodo generado", async () => {
    const e = await escenario("generado");
    const antes = await A.fotoVentas(v, e.c.id);
    const r = await v.bin(contador, "POST", `${base(e.c.id)}/importar/vista-previa`, csvVentas([fila("B009", 1)]));
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(await A.fotoVentas(v, e.c.id)).toEqual(antes);
  });
});

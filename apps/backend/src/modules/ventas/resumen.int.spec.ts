/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): resumen por tipo y historial de descargas (RF-056, D11, D16; CA-9, CA-11).
//  - GET …/ventas/resumen  `clientes.ver` -> 200 `ResumenVentasDto`: `{ porTipo: [{ tipo, cantidad, baseGravada, igv, exonerada,
//    inafecta, isc, icbper, otros, total }], total: { cantidad, …las mismas ocho sumas }, sinConvertir: [{ clave, moneda }],
//    avisos: ["usd_sin_tipo_cambio"] }`. TODO en soles, montos como cadenas de 2 decimales, calculado con `Money` (sin
//    `number`). Incluye las filas agregadas a mano. La fila USD se convierte columna por columna con
//    `redondearSunat(columna × tipoCambio)` y su total es Σ de las columnas convertidas; una USD sin tipo de cambio NO se suma
//    (ni en `cantidad`): sale en `sinConvertir` (clave y moneda) y la respuesta trae el aviso. Las notas de crédito restan.
//  - GET …/ventas/propuestas  `clientes.ver` -> 200 `PropuestaVentasDto[]` (la más reciente primero) del cliente, el periodo y el
//    libro `ventas`: `{ id, fuente, filasRecibidas, filasNuevas, filasIguales, filasDistintas, creadaEn }` y nada más (ni hash,
//    ni usuario, ni trabajo, ni tenant).
//  - GET …/ventas/propuestas/:propuestaId/diferencias  `clientes.ver` -> 200 `DiferenciaVentasDto[]` de ESA propuesta:
//    `{ clave, tipo, serie, numero, origenExistente, campos, valoresSire }`; 404 si la propuesta no es de este cliente, periodo y
//    libro (ni de otro estudio).
// Rojo: el módulo `ventas` aún no existe (T13).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  centavos,
  fila,
  filasFixtureVentas,
  type Actor,
  type BancoVentas,
  type Estudio,
  type FilaV,
} from "../../../test/soporte-ventas.js";
import { forma } from "../../../test/soporte.js";

// Siembras de miles de filas, archivos de decenas de MB y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;
let lectura: Actor;
let lecturaAjena: Actor;

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  lecturaAjena = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

const nuevo = (o: Parameters<BancoVentas["cliente"]>[1] = {}) =>
  v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id], ...o });
const resumen = (a: Actor, clienteId: string, periodo = "202610") =>
  v.llamar(a, "GET", `${base(clienteId, periodo)}/resumen`);
const CERO = {
  baseGravada: "0.00",
  igv: "0.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "0.00",
};
const COLUMNAS = Object.keys(CERO) as Array<keyof typeof CERO>;

describe("CA-9 · resumen por tipo con las filas del contribuyente de prueba", () => {
  it("cantidad y sumas exactas en soles por tipo: la NC resta, la USD se convierte y la USD sin tipo de cambio queda aparte", async () => {
    const c = await nuevo();
    await v.sembrarVentas(E.tenantId, c.id, filasFixtureVentas(), {
      usuarioId: E.titular.id,
    });
    const r = await resumen(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({
      porTipo: [
        {
          tipo: "01",
          cantidad: 4,
          ...CERO,
          baseGravada: "1160.00", // 200 + 300 + 0 + (200 × 3.300 = 660.00)
          igv: "208.80", // 36 + 54 + 0 + (36 × 3.300 = 118.80)
          exonerada: "150.00",
          total: "1518.80", // 236 + 354 + 150 + 778.80 (Σ de las columnas convertidas)
        },
        {
          tipo: "03",
          cantidad: 5,
          ...CERO,
          baseGravada: "275.00",
          igv: "49.50",
          total: "324.50",
        },
        {
          tipo: "07",
          cantidad: 1,
          ...CERO,
          baseGravada: "-50.00",
          igv: "-9.00",
          total: "-59.00",
        },
      ],
      total: {
        cantidad: 10,
        ...CERO,
        baseGravada: "1385.00",
        igv: "249.30",
        exonerada: "150.00",
        total: "1784.30",
      },
      sinConvertir: [{ clave: "01|F002|2", moneda: "USD" }],
      avisos: ["usd_sin_tipo_cambio"],
      estado: "abierto", // 012b: estado del periodo de ventas
      excluidas: 0, // 012b: cantidad de ventas excluidas (no suman)
    });
    // Montos como cadenas con sus ceros, nunca number.
    expect(r.text).toContain('"total":"1784.30"');
    expect(r.text).toContain('"exonerada":"150.00"');
  });

  it("la suma de los tipos iguala el total general columna por columna, con las agregadas a mano incluidas", async () => {
    const c = await nuevo();
    await v.sembrarVentas(E.tenantId, c.id, filasFixtureVentas(), {
      usuarioId: E.titular.id,
    });
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("B001", 291, {
          baseGravada: "10.50",
          igv: "1.89",
          total: "12.39",
        }),
      ],
      { usuarioId: E.titular.id, origen: "manual" },
    );
    const r = await resumen(contador, c.id);
    expect(r.status, r.text).toBe(200);
    const b03 = (r.body.porTipo as any[]).find((t) => t.tipo === "03");
    expect(b03).toMatchObject({
      cantidad: 6,
      baseGravada: "285.50",
      igv: "51.39",
      total: "336.89",
    });
    expect(r.body.total).toMatchObject({
      cantidad: 11,
      baseGravada: "1395.50",
      igv: "251.19",
      total: "1796.69",
    });
    for (const col of COLUMNAS) {
      const suma = (r.body.porTipo as any[]).reduce(
        (a, t) => a + centavos(t[col]),
        0n,
      );
      expect(suma, col).toBe(centavos(r.body.total[col]));
    }
    expect((r.body.porTipo as any[]).reduce((a, t) => a + t.cantidad, 0)).toBe(
      r.body.total.cantidad,
    );
  });

  it("el redondeo de la USD es por columna (half-up): 0.15 y 0.03 a 3.300 dan 0.50 y 0.10 y el total es 0.60, no 0.59", async () => {
    const c = await nuevo();
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("F002", 1, {
          tipo: "01",
          moneda: "USD",
          tipoCambio: "3.300",
          baseGravada: "0.15",
          igv: "0.03",
          total: "0.18",
        }),
      ],
      { usuarioId: E.titular.id },
    );
    const r = await resumen(contador, c.id);
    expect(r.body.porTipo).toEqual([
      {
        tipo: "01",
        cantidad: 1,
        ...CERO,
        baseGravada: "0.50",
        igv: "0.10",
        total: "0.60",
      },
    ]);
    expect(r.body.sinConvertir).toEqual([]);
    expect(r.body.avisos).toEqual([]);
  });

  it("solo ventas USD sin tipo de cambio: no se suman, salen todas en sinConvertir y la respuesta trae el aviso", async () => {
    const c = await nuevo();
    const usd = (n: number): FilaV =>
      fila("F002", n, { tipo: "01", moneda: "USD" });
    await v.sembrarVentas(E.tenantId, c.id, [usd(2), usd(3)], {
      usuarioId: E.titular.id,
    });
    const r = await resumen(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.porTipo).toEqual([]);
    expect(r.body.total).toEqual({ cantidad: 0, ...CERO });
    expect(r.body.sinConvertir).toEqual([
      { clave: "01|F002|2", moneda: "USD" },
      { clave: "01|F002|3", moneda: "USD" },
    ]);
    expect(r.body.avisos).toEqual(["usd_sin_tipo_cambio"]);
  });

  it("un periodo sin ventas: nada que sumar y sin avisos", async () => {
    const c = await nuevo();
    const r = await resumen(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({
      porTipo: [],
      total: { cantidad: 0, ...CERO },
      sinConvertir: [],
      avisos: [],
      estado: "abierto",
      excluidas: 0,
    });
  });

  it("0.10 + 0.20 suma exactamente 0.30 (con number daría 0.30000000000000004)", async () => {
    const c = await nuevo();
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("M001", 1, { baseGravada: "0.10", igv: "0.00", total: "0.10" }),
        fila("M001", 2, { baseGravada: "0.20", igv: "0.00", total: "0.20" }),
      ],
      { usuarioId: E.titular.id },
    );
    const r = await resumen(contador, c.id);
    expect(r.body.total).toMatchObject({ baseGravada: "0.30", total: "0.30" });
    expect(r.text).not.toContain("0.30000000000000004");
  });

  it("una fila descuadrada se suma tal como llegó (el resumen no la corrige)", async () => {
    const c = await nuevo();
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [fila("B001", 290, { total: "119.00" })],
      { usuarioId: E.titular.id },
    );
    const r = await resumen(contador, c.id);
    expect(r.body.total).toMatchObject({
      cantidad: 1,
      baseGravada: "100.00",
      igv: "18.00",
      total: "119.00",
    });
  });

  it("solo cuenta el periodo y el cliente pedidos", async () => {
    const c = await nuevo();
    const otro = await nuevo();
    await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 290)], {
      usuarioId: E.titular.id,
    });
    await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 1)], {
      usuarioId: E.titular.id,
      periodo: "202609",
    });
    await v.sembrarVentas(
      E.tenantId,
      otro.id,
      [fila("B001", 5), fila("B001", 6)],
      { usuarioId: E.titular.id },
    );
    expect((await resumen(contador, c.id)).body.total).toMatchObject({
      cantidad: 1,
      total: "118.00",
    });
    expect((await resumen(contador, c.id, "202609")).body.total).toMatchObject({
      cantidad: 1,
    });
  });

  it("D5: lectura colaborador lo ve; sin asignar recibe el mismo 404 que un cliente inexistente; periodo inválido es 400", async () => {
    const c = await nuevo();
    expect((await resumen(lectura, c.id)).status).toBe(200);
    const ajeno = await v.cliente(E);
    expect((await resumen(E.titular, ajeno.id)).status).toBe(200); // control
    const r = await resumen(lecturaAjena, ajeno.id);
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(await resumen(lecturaAjena, randomUUID())));
    const malo = await resumen(contador, c.id, "2026-10");
    expect(malo.status).toBe(400);
    expect(malo.body).toEqual({ codigo: "solicitud_invalida" });
  });
});

describe("D16 · historial de descargas e importaciones", () => {
  async function conHistorial() {
    const c = await nuevo();
    const u = E.titular.id;
    const p1 = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u,
      fuente: "api",
      nuevas: 2,
      creadaEn: "2026-11-01T10:00:00.000Z",
    });
    const p2 = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u,
      fuente: "importacion",
      nuevas: 1,
      iguales: 2,
      creadaEn: "2026-11-02T10:00:00.000Z",
    });
    const p3 = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u,
      fuente: "api",
      nuevas: 1,
      iguales: 1,
      distintas: 2,
      creadaEn: "2026-11-03T10:00:00.000Z",
    });
    await v.sembrarDiferencia(E.tenantId, p3, {
      serie: "B001",
      numero: "290",
      campos: ["total"],
      valoresSire: { total: "236.00" },
    });
    await v.sembrarDiferencia(E.tenantId, p3, {
      serie: "B001",
      numero: "291",
      origenExistente: "manual",
      campos: ["igv", "total"],
      valoresSire: { igv: "20.00", total: "130.00" },
    });
    // Lo que no debe verse: otro periodo, el libro de compras y otro cliente.
    const otroPeriodo = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u,
      periodo: "202609",
      nuevas: 7,
    });
    const compras = await v.sembrarPropuesta(E.tenantId, c.id, {
      usuarioId: u,
      libro: "compras",
      nuevas: 9,
    });
    const otro = await v.cliente(E, { responsable: contador.id }); // sin el colaborador de solo lectura
    const deOtro = await v.sembrarPropuesta(E.tenantId, otro.id, {
      usuarioId: u,
      nuevas: 5,
    });
    await v.sembrarDiferencia(E.tenantId, deOtro, {
      serie: "B009",
      numero: "1",
      campos: ["total"],
      valoresSire: { total: "1.00" },
    });
    return { c, otro, p1, p2, p3, otroPeriodo, compras, deOtro };
  }
  const propuestas = (a: Actor, clienteId: string, periodo = "202610") =>
    v.llamar(a, "GET", `${base(clienteId, periodo)}/propuestas`);
  const diferencias = (
    a: Actor,
    clienteId: string,
    id: string,
    periodo = "202610",
  ) =>
    v.llamar(
      a,
      "GET",
      `${base(clienteId, periodo)}/propuestas/${id}/diferencias`,
    );

  it("GET /propuestas: las del cliente, periodo y libro ventas, la más reciente primero, con sus contadores y nada más", async () => {
    const h = await conHistorial();
    const r = await propuestas(contador, h.c.id);
    expect(r.status, r.text).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as any[]).map((p) => p.id)).toEqual([h.p3, h.p2, h.p1]);
    expect(r.body[0]).toEqual({
      id: h.p3,
      fuente: "api",
      filasRecibidas: 4,
      filasNuevas: 1,
      filasIguales: 1,
      filasDistintas: 2,
      creadaEn: "2026-11-03T10:00:00.000Z",
    });
    expect(r.body[1]).toMatchObject({
      fuente: "importacion",
      filasRecibidas: 3,
      filasNuevas: 1,
      filasIguales: 2,
      filasDistintas: 0,
    });
    for (const p of r.body as any[]) {
      expect(Object.keys(p).sort()).toEqual([
        "creadaEn",
        "filasDistintas",
        "filasIguales",
        "filasNuevas",
        "filasRecibidas",
        "fuente",
        "id",
      ]);
      expect(p.filasRecibidas).toBe(
        p.filasNuevas + p.filasIguales + p.filasDistintas,
      );
    }
    expect(r.text).not.toMatch(/hash|usuario|trabajo|tenant/i);
  });

  it("un cliente sin descargas: lista vacía", async () => {
    const c = await nuevo();
    const r = await propuestas(contador, c.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("GET /propuestas/:id/diferencias: las de esa propuesta, con campos y valores del SIRE (D16)", async () => {
    const h = await conHistorial();
    const r = await diferencias(contador, h.c.id, h.p3);
    expect(r.status, r.text).toBe(200);
    const filas = [...(r.body as any[])].sort((a, b) =>
      a.clave.localeCompare(b.clave),
    );
    expect(filas).toEqual([
      {
        clave: "03|B001|290",
        tipo: "03",
        serie: "B001",
        numero: "290",
        origenExistente: "sire",
        campos: ["total"],
        valoresSire: { total: "236.00" },
      },
      {
        clave: "03|B001|291",
        tipo: "03",
        serie: "B001",
        numero: "291",
        origenExistente: "manual",
        campos: ["igv", "total"],
        valoresSire: { igv: "20.00", total: "130.00" },
      },
    ]);
    expect(Object.keys(filas[0]).sort()).toEqual([
      "campos",
      "clave",
      "numero",
      "origenExistente",
      "serie",
      "tipo",
      "valoresSire",
    ]);
  });

  it("una propuesta sin diferencias: lista vacía", async () => {
    const h = await conHistorial();
    const r = await diferencias(contador, h.c.id, h.p1);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("la propuesta de otro cliente, de otro periodo, del libro de compras, inexistente o mal formada: 404 sin datos", async () => {
    const h = await conHistorial();
    expect((await diferencias(contador, h.c.id, h.p3)).status).toBe(200); // control: la ruta existe
    for (const [nombre, id] of [
      ["de otro cliente", h.deOtro],
      ["de otro periodo", h.otroPeriodo],
      ["del libro de compras", h.compras],
      ["inexistente", randomUUID()],
      ["mal formada", "no-es-uuid"],
    ] as const) {
      const r = await diferencias(contador, h.c.id, id);
      expect(r.status, nombre).toBe(404);
      expect(r.text, nombre).not.toContain("B009");
    }
  });

  it("otro estudio: la propuesta de E es un 404 para el Dueño de F, y su lista de propuestas del cliente de E también", async () => {
    const h = await conHistorial();
    const F = await v.estudio();
    expect((await diferencias(E.titular, h.c.id, h.p3)).status).toBe(200); // control
    expect((await diferencias(F.titular, h.c.id, h.p3)).status).toBe(404);
    expect((await propuestas(F.titular, h.c.id)).status).toBe(404);
  });

  it("D5: lectura colaborador las ve; sin asignar, el mismo 404 que un cliente inexistente", async () => {
    const h = await conHistorial();
    expect((await propuestas(lectura, h.c.id)).status).toBe(200);
    expect((await diferencias(lectura, h.c.id, h.p3)).status).toBe(200);
    expect((await propuestas(E.titular, h.otro.id)).status).toBe(200); // control
    const r = await propuestas(lectura, h.otro.id);
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(await propuestas(lectura, randomUUID())));
    const d = await diferencias(lectura, h.otro.id, h.deOtro);
    expect(d.status).toBe(404);
    expect(d.text).not.toContain("B009");
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T22b, rojo; D26; decisión del usuario 2026-11-07 a Q-1, opción (a)): una venta descuadrada de la descarga del
// SIRE se guarda tal cual (D3) y se MARCA: `GET /clientes/:clienteId/periodos/:periodo/ventas` devuelve en cada `VentaDto`
// `cuadra: boolean`, calculado AL LEER con el dominio (Σ de las siete columnas contra `total`, tolerancia 0.00, en la
// moneda del comprobante: el mismo criterio de `validarFilaVenta`). Sin migración ni columna: `venta` no gana `cuadra`.
//  - `cuadra` es booleano en todas las filas (páginas, `tamano=todas`, filtros), nunca texto ni nulo.
//  - Una fila `sire` descuadrada llega con `cuadra: false` y sus montos TAL CUAL (no se corrige ni se oculta, D3).
//  - La respuesta de agregar (`POST …/ventas`, 201) también es un `VentaDto`: una venta manual siempre cuadra (D9).
//  - El cuadre no cambia lo demás: total, orden, resumen y faltantes iguales que sin la marca.
// Rojo: hoy `VentaDto` no trae `cuadra`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  fila,
  type Actor,
  type BancoVentas,
  type Estudio,
  type FilaV,
} from "../../../test/soporte-ventas.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;
let cli: { id: string; ruc: string };

/** Serie, número y si debe cuadrar. Los montos descuadrados difieren de la suma por un céntimo o más. */
const CASOS: { fila: FilaV; cuadra: boolean; porque: string }[] = [
  { fila: fila("C001", 1), cuadra: true, porque: "boleta 100.00 + 18.00 = 118.00" },
  {
    fila: fila("C001", 2, { total: "118.01" }),
    cuadra: false,
    porque: "un céntimo de más: la tolerancia es 0.00",
  },
  {
    fila: fila("C001", 3, { total: "117.99" }),
    cuadra: false,
    porque: "un céntimo de menos",
  },
  {
    fila: fila("C001", 4, { total: "0.00", baseGravada: "0.00", igv: "0.00" }),
    cuadra: true,
    porque: "venta en cero",
  },
  {
    fila: fila("C001", 5, { tipo: "07", baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }),
    cuadra: true,
    porque: "nota de crédito: todo negativo",
  },
  {
    fila: fila("C001", 6, { tipo: "07", baseGravada: "-50.00", igv: "-9.00", total: "59.00" }),
    cuadra: false,
    porque: "el signo del total no coincide con los componentes",
  },
  {
    fila: fila("C001", 7, {
      tipo: "01",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "10.00",
      inafecta: "5.00",
      isc: "3.00",
      icbper: "0.50",
      otros: "2.00",
      total: "138.50",
    }),
    cuadra: true,
    porque: "las siete columnas suman al total (con ISC e ICBPER)",
  },
  {
    fila: fila("C001", 8, {
      tipo: "01",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "10.00",
      inafecta: "5.00",
      isc: "3.00",
      icbper: "0.50",
      otros: "2.00",
      total: "138.00",
    }),
    cuadra: false,
    porque: "falta el ICBPER en el total: se nota en la columna chica",
  },
  {
    fila: fila("C001", 9, { moneda: "USD", tipoCambio: "3.750", total: "118.00" }),
    cuadra: true,
    porque: "USD: se cuadra en la moneda del comprobante, sin convertir",
  },
  {
    fila: fila("C001", 10, { moneda: "USD", tipoCambio: "3.750", total: "118.01" }),
    cuadra: false,
    porque: "USD descuadrada por un céntimo",
  },
  {
    fila: fila("C001", 11, { moneda: "USD", total: "118.00" }),
    cuadra: true,
    porque: "USD sin tipo de cambio: el cuadre no depende del tipo de cambio",
  },
  {
    fila: fila("C001", 12, { tipo: "01", baseGravada: "999999999999.99", igv: "0.00", total: "999999999999.99" }),
    cuadra: true,
    porque: "borde de NUMERIC(14,2) que cuadra",
  },
  {
    fila: fila("C001", 13, { tipo: "01", baseGravada: "999999999999.99", igv: "18.00", total: "999999999999.99" }),
    cuadra: false,
    porque: "la suma excede NUMERIC(14,2): no cuadra, y no revienta la lectura",
  },
];

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  cli = await v.cliente(E, { responsable: contador.id });
  await v.sembrarVentas(E.tenantId, cli.id, CASOS.map((c) => c.fila), { usuarioId: E.titular.id });
});
afterAll(async () => {
  await v?.cerrar();
});

const leer = (query = "", clienteId = cli.id) =>
  v.llamar(contador, "GET", `${base(clienteId, "202610")}${query}`);
const porNumero = (r: { body: any }, numero: number) =>
  (r.body.filas as any[]).find((f) => f.serie === "C001" && f.numero === String(numero));

describe("T22b · la lectura de ventas devuelve `cuadra`", () => {
  it.each(CASOS.map((c) => [c.fila.numero, c.cuadra, c.porque] as const))(
    "C001-%s: cuadra=%s (%s)",
    async (numero, cuadra) => {
      const r = await leer("?tamano=todas");
      expect(r.status, r.text).toBe(200);
      const f = porNumero(r, Number(numero));
      expect(f, `no vino C001-${numero}`).toBeDefined();
      expect(f.cuadra).toBe(cuadra);
    },
  );

  it("`cuadra` es booleano en todas las filas de todas las páginas, nunca texto ni nulo", async () => {
    const vistas: any[] = [];
    for (let p = 1; p <= 2; p++) {
      const r = await leer(`?pagina=${p}&tamano=10`);
      expect(r.status, r.text).toBe(200);
      vistas.push(...r.body.filas);
    }
    expect(vistas).toHaveLength(CASOS.length);
    for (const f of vistas) expect(typeof f.cuadra, `${f.serie}-${f.numero}`).toBe("boolean");
  });

  it("la marca no corrige ni oculta la fila: la descuadrada llega con sus montos tal cual y cuenta en el total", async () => {
    const r = await leer("?tamano=todas");
    expect(r.body.total).toBe(CASOS.length);
    expect(porNumero(r, 2)).toMatchObject({ cuadra: false, baseGravada: "100.00", igv: "18.00", total: "118.01" });
    expect(porNumero(r, 3)).toMatchObject({ cuadra: false, total: "117.99" });
  });

  it("el cuadre se calcula al leer: no hay columna `cuadra` en `venta` (sin migración)", async () => {
    const cols = await v.b.sql(
      `select column_name from information_schema.columns where table_name = 'venta' and column_name ilike '%cuadr%'`,
    );
    expect(cols).toEqual([]);
  });

  it("los filtros no cambian la marca de la fila que devuelven", async () => {
    const r = await leer("?serie=C001&tipo=07&tamano=todas");
    expect(r.status, r.text).toBe(200);
    expect(porNumero(r, 5)?.cuadra).toBe(true);
    expect(porNumero(r, 6)?.cuadra).toBe(false);
    expect(r.body.filas).toHaveLength(2);
  });
});

describe("T22b · agregar devuelve `cuadra` (una venta manual siempre cuadra, D9)", () => {
  it("201 con `cuadra: true`", async () => {
    const r = await v.llamar(contador, "POST", base(cli.id, "202610"), {
      ...fila("M777", 1, { fechaEmision: "2026-10-04" }),
    });
    expect(r.status, r.text).toBe(201);
    expect(r.body.cuadra).toBe(true);
  });

  it("una venta manual descuadrada sigue siendo 400 venta_descuadrada: la marca es solo para las del SIRE", async () => {
    const r = await v.llamar(contador, "POST", base(cli.id, "202610"), {
      ...fila("M777", 2, { total: "118.01" }),
    });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toMatchObject({ codigo: "venta_descuadrada" });
  });
});

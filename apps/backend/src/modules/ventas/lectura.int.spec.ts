/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): GET /clientes/:clienteId/periodos/:periodo/ventas (RF-052; D5, D10; CA-5).
// Contrato (plan: Rutas; DTO de `@contapp/shared/ventas`: `PaginaVentasDto`, `VentaDto`):
//  - 200 `{ filas, total, pagina, tamano, avisos }`; query `pagina` (1, 2…), `tamano` (10 | 25 | 50 | "todas"; por omisión 25),
//    `q`, `tipo`, `serie`, `min`, `max`. `total` cuenta las filas que cumplen el filtro (no las de la página). Filtra y ordena el
//    servidor: tipo, serie y número NUMÉRICO (B001-2 antes que B001-10). Permiso `clientes.ver` y `ClienteScopeGuard`.
//  - `VentaDto` = { id, origen, tipo, serie, numero, fechaEmision, tipoDocContraparte, docContraparte, moneda, tipoCambio,
//    baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total }: montos y tipo de cambio SIEMPRE cadenas con sus ceros
//    ("118.00"), jamás `number`; nada del estudio, la clave interna, la propuesta ni el usuario.
//  - `q` busca (sin distinguir mayúsculas) en serie, número y documento de la contraparte, con `%`, `_` y `\` como texto literal
//    y sin concatenar SQL. `min` y `max` comparan el `total` con NUMERIC (cadenas decimales de hasta 3 decimales: 0.005 es válido
//    y NO se redondea) y son inclusivos. «todas» entrega como máximo 5.000 filas y agrega el aviso `todas_limitada` con `total` real.
//  - Parámetros inválidos: 400 `solicitud_invalida`. Una página fuera de rango es 200 con `filas: []`.
// Rojo: el módulo `ventas` aún no existe (T13).
import { randomUUID } from "node:crypto";
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
import { forma } from "../../../test/soporte.js";

// Siembras de miles de filas, archivos de decenas de MB y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;
let lectura: Actor;
let lecturaAjena: Actor;
let cli: { id: string; ruc: string };
let ajeno: { id: string; ruc: string };

const COLUMNAS_DTO = [
  "baseGravada",
  "cuadra",
  "docContraparte",
  "exclusion", // 012b: la exclusión vigente (D12) o null
  "exonerada",
  "fechaEmision",
  "icbper",
  "id",
  "igv",
  "inafecta",
  "isc",
  "moneda",
  "numero",
  "origen",
  "otros",
  "serie",
  "tipo",
  "tipoCambio",
  "tipoDocContraparte",
  "total",
];

/** 69 ventas del periodo: B001 1..30, F001 1..20 (S/ 236.00), FC01 1..10 (NC de -59.00), 3 con comodines y 6 de montos extremos. */
function dataset(): FilaV[] {
  const filas: FilaV[] = [];
  for (let n = 1; n <= 30; n++) filas.push(fila("B001", n));
  for (let n = 1; n <= 20; n++)
    filas.push(
      fila("F001", n, {
        tipo: "01",
        tipoDocContraparte: "6",
        docContraparte: "20700000011",
        baseGravada: "200.00",
        igv: "36.00",
        total: "236.00",
      }),
    );
  for (let n = 1; n <= 10; n++)
    filas.push(
      fila("FC01", n, {
        tipo: "07",
        baseGravada: "-50.00",
        igv: "-9.00",
        total: "-59.00",
      }),
    );
  // Documentos con comodines de LIKE: la búsqueda debe tratarlos como texto.
  filas.push(fila("F009", 1, { tipo: "01", docContraparte: "AB%CD" }));
  filas.push(fila("F009", 2, { tipo: "01", docContraparte: "AB_CD" }));
  filas.push(fila("F009", 3, { tipo: "01", docContraparte: "ABXCD" }));
  // Montos que `number` malograría o que están en el borde de NUMERIC(14,2).
  const monto = (n: number, total: string, base = total): FilaV =>
    fila("M001", n, {
      tipo: "01",
      baseGravada: base,
      igv: "0.00",
      total,
    });
  filas.push(monto(1, "0.00"));
  filas.push(monto(2, "0.01"));
  filas.push(monto(3, "0.10"));
  filas.push(monto(4, "0.20"));
  filas.push(monto(5, "0.30"));
  filas.push(monto(6, "999999999999.99"));
  return filas;
}

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
  lecturaAjena = await p.miembro(E.tenantId, "lectura");
  cli = await v.cliente(E, {
    responsable: contador.id,
    colaboradores: [lectura.id],
  });
  ajeno = await v.cliente(E);
  await v.sembrarVentas(E.tenantId, cli.id, dataset(), {
    usuarioId: E.titular.id,
  });
  // Lo que NO debe aparecer: otro periodo del mismo cliente y otro cliente del mismo estudio y periodo.
  await v.sembrarVentas(E.tenantId, cli.id, [fila("P009", 1)], {
    usuarioId: E.titular.id,
    periodo: "202609",
  });
  await v.sembrarVentas(E.tenantId, ajeno.id, [fila("Z999", 1)], {
    usuarioId: E.titular.id,
  });
});
afterAll(async () => {
  await v?.cerrar();
});

const leer = (a: Actor, query = "", clienteId = cli.id, periodo = "202610") =>
  v.llamar(a, "GET", `${base(clienteId, periodo)}${query}`);
const claves = (r: { body: any }) =>
  (r.body.filas as any[]).map((f) => `${f.tipo}|${f.serie}|${f.numero}`);

/** El orden esperado de todo el dataset: tipo, serie y número numérico. */
function ordenEsperado(): string[] {
  return dataset()
    .map((f) => ({ ...f, n: Number(f.numero) }))
    .sort(
      (a, b) =>
        a.tipo.localeCompare(b.tipo) ||
        (a.serie < b.serie ? -1 : a.serie > b.serie ? 1 : 0) ||
        a.n - b.n,
    )
    .map((f) => `${f.tipo}|${f.serie}|${f.numero}`);
}

describe("forma de la respuesta y paginación (RF-052)", () => {
  it("por omisión: página 1 de 25, total 69, sin avisos, filas con las columnas del DTO y nada más", async () => {
    const r = await leer(contador);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      "avisos",
      "filas",
      "pagina",
      "tamano",
      "total",
    ]);
    expect(r.body).toMatchObject({
      total: 69,
      pagina: 1,
      tamano: 25,
      avisos: [],
    });
    expect(r.body.filas).toHaveLength(25);
    for (const f of r.body.filas)
      expect(Object.keys(f).sort(), f.serie).toEqual(COLUMNAS_DTO);
  });

  it.each([10, 25, 50])(
    "tamano=%i: páginas del tamaño pedido que, juntas, recorren las 69 ventas en orden tipo, serie y número numérico",
    async (tamano) => {
      const vistas: string[] = [];
      const paginas = Math.ceil(69 / tamano);
      for (let p = 1; p <= paginas; p++) {
        const r = await leer(contador, `?pagina=${p}&tamano=${tamano}`);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toMatchObject({ total: 69, pagina: p, tamano });
        expect(r.body.filas.length).toBe(
          p < paginas ? tamano : 69 - tamano * (paginas - 1),
        );
        vistas.push(...claves(r));
      }
      expect(vistas).toEqual(ordenEsperado());
      expect(new Set(vistas).size, "sin filas repetidas entre páginas").toBe(
        69,
      );
    },
  );

  it("el número se ordena como número: B001-2 va antes que B001-10", async () => {
    const r = await leer(contador, "?serie=B001&tamano=50");
    const numeros = (r.body.filas as any[]).map((f) => f.numero);
    expect(numeros.slice(0, 11)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
  });

  it("tamano=todas entrega las 69 sin aviso", async () => {
    const r = await leer(contador, "?tamano=todas");
    expect(r.status, r.text).toBe(200);
    expect(r.body.tamano).toBe("todas");
    expect(r.body.filas).toHaveLength(69);
    expect(r.body.avisos).toEqual([]);
    expect(claves(r)).toEqual(ordenEsperado());
  });

  it("una página fuera de rango es 200 con filas vacías y el total real", async () => {
    const r = await leer(contador, "?pagina=99&tamano=10");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ filas: [], total: 69, pagina: 99 });
  });

  it("un parámetro desconocido se ignora", async () => {
    const r = await leer(contador, "?tamano=10&foo=bar");
    expect(r.status, r.text).toBe(200);
    expect(r.body.filas).toHaveLength(10);
  });

  it("solo ve el periodo y el cliente pedidos: nada de otro periodo ni de otro cliente", async () => {
    const todo = claves(await leer(contador, "?tamano=todas"));
    expect(todo.some((c) => c.includes("P009") || c.includes("Z999"))).toBe(
      false,
    );
    const otroPeriodo = await leer(contador, "?tamano=todas", cli.id, "202609");
    expect(claves(otroPeriodo)).toEqual(["03|P009|1"]);
    const vacio = await leer(contador, "?tamano=todas", cli.id, "202501");
    expect(vacio.body).toMatchObject({ filas: [], total: 0 });
  });
});

describe("el dinero viaja como cadena, sin number", () => {
  it("montos y tipo de cambio son cadenas con sus ceros: 118.00, 999999999999.99, -59.00", async () => {
    const r = await leer(contador, "?tamano=todas");
    expect(r.text).toContain('"total":"118.00"');
    expect(r.text).toContain('"baseGravada":"100.00"');
    expect(r.text).toContain('"total":"999999999999.99"');
    expect(r.text).toContain('"total":"-59.00"');
    for (const f of r.body.filas as any[]) {
      for (const c of [
        "baseGravada",
        "igv",
        "exonerada",
        "inafecta",
        "isc",
        "icbper",
        "otros",
        "total",
      ])
        expect(typeof f[c], `${f.serie}-${f.numero} ${c}`).toBe("string");
      expect(f.total).toMatch(/^-?\d+\.\d{2}$/);
      expect(f.tipoCambio === null || typeof f.tipoCambio === "string").toBe(
        true,
      );
    }
  });

  it("la venta en USD trae su tipo de cambio como cadena y la de soles lo trae nulo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("F002", 1, { tipo: "01", moneda: "USD", tipoCambio: "3.300" }),
        fila("F002", 2, { tipo: "01", moneda: "USD" }),
        fila("B001", 1),
      ],
      { usuarioId: E.titular.id },
    );
    const r = await leer(contador, "?tamano=todas", c.id);
    const por = Object.fromEntries(
      (r.body.filas as any[]).map((f) => [`${f.serie}-${f.numero}`, f]),
    );
    expect(por["F002-1"]).toMatchObject({ moneda: "USD", tipoCambio: "3.300" });
    expect(por["F002-2"]).toMatchObject({ moneda: "USD", tipoCambio: null });
    expect(por["B001-1"]).toMatchObject({ moneda: "PEN", tipoCambio: null });
  });
});

describe("búsqueda q (RF-052, D10): comodines y comillas son texto, no sintaxis", () => {
  it("por serie, sin distinguir mayúsculas", async () => {
    expect(claves(await leer(contador, "?q=F001&tamano=todas"))).toHaveLength(
      20,
    );
    expect(claves(await leer(contador, "?q=f001&tamano=todas"))).toHaveLength(
      20,
    );
    expect((await leer(contador, "?q=B001&tamano=todas")).body.total).toBe(30);
  });

  it("por número y por documento de la contraparte", async () => {
    expect(claves(await leer(contador, "?q=29&tamano=todas"))).toEqual([
      "03|B001|29",
    ]);
    const doc = await leer(contador, "?q=2070000&tamano=todas");
    expect(doc.body.total).toBe(20);
    expect((doc.body.filas as any[]).every((f) => f.serie === "F001")).toBe(
      true,
    );
  });

  it("«%» busca un % literal: solo el documento AB%CD", async () => {
    const r = await leer(contador, "?q=%25&tamano=todas");
    expect(r.status, r.text).toBe(200);
    expect(claves(r)).toEqual(["01|F009|1"]);
  });

  it("«_» busca un _ literal: solo el documento AB_CD", async () => {
    const r = await leer(contador, "?q=_&tamano=todas");
    expect(claves(r)).toEqual(["01|F009|2"]);
  });

  it("«B%C» y «B_C» no son comodines: cada uno trae solo su documento y nunca ABXCD", async () => {
    expect(claves(await leer(contador, "?q=B%25C&tamano=todas"))).toEqual([
      "01|F009|1",
    ]);
    expect(claves(await leer(contador, "?q=B_C&tamano=todas"))).toEqual([
      "01|F009|2",
    ]);
  });

  it("la barra invertida tampoco altera la consulta: 200 y sin filas", async () => {
    const r = await leer(contador, "?q=%5C&tamano=todas");
    expect(r.status, r.text).toBe(200);
    expect(r.body.filas).toEqual([]);
  });

  it.each([
    "' OR '1'='1",
    "'; DROP TABLE venta; --",
    '" OR ""="',
    "B001' --",
    "ñandú",
  ])("%j: 200, sin filas y la tabla sigue intacta", async (q) => {
    const r = await leer(contador, `?q=${encodeURIComponent(q)}&tamano=todas`);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ filas: [], total: 0 });
    expect(r.body.avisos).toEqual([]);
    expect((await v.conteo(cli.id)).ventas).toBe(70); // 69 + la P009 de otro periodo
  });

  it("q vacío no filtra", async () => {
    expect((await leer(contador, "?q=&tamano=todas")).body.total).toBe(69);
  });
});

describe("filtros por tipo y serie", () => {
  it("tipo=07 trae solo las 10 notas de crédito; tipo=99, ninguna", async () => {
    const r = await leer(contador, "?tipo=07&tamano=todas");
    expect(r.body.total).toBe(10);
    expect((r.body.filas as any[]).every((f) => f.tipo === "07")).toBe(true);
    expect((await leer(contador, "?tipo=99&tamano=todas")).body.total).toBe(0);
  });

  it("serie=F001 trae las 20 facturas; combinado con tipo, solo lo que cumple ambos", async () => {
    expect((await leer(contador, "?serie=F001&tamano=todas")).body.total).toBe(
      20,
    );
    expect(
      (await leer(contador, "?tipo=01&serie=F001&tamano=todas")).body.total,
    ).toBe(20);
    expect(
      (await leer(contador, "?tipo=03&serie=F001&tamano=todas")).body.total,
    ).toBe(0);
  });

  it("el filtro se aplica antes de paginar: total es el de las que cumplen", async () => {
    const r = await leer(contador, "?serie=B001&tamano=10&pagina=3");
    expect(r.body).toMatchObject({ total: 30, pagina: 3 });
    expect(r.body.filas).toHaveLength(10);
    expect(claves(r)[0]).toBe("03|B001|21");
  });
});

describe("rango de montos sobre el total, comparado como NUMERIC (CA-5)", () => {
  const total = async (q: string) =>
    (await leer(contador, `${q}&tamano=todas`)).body.total;

  it("min y max iguales traen solo el 0.30 exacto (con number, 0.1 + 0.2 no es 0.3)", async () => {
    const r = await leer(contador, "?min=0.30&max=0.30&tamano=todas");
    expect(claves(r)).toEqual(["01|M001|5"]);
  });

  it("0.005 no se redondea: entre 0.005 y 0.009 no hay ninguna; max=0.005 trae el 0.00 y las 10 notas negativas, no el 0.01", async () => {
    expect(await total("?min=0.005&max=0.009")).toBe(0);
    const r = await leer(contador, "?max=0.005&tamano=todas");
    expect(r.body.total).toBe(11);
    expect(claves(r)).not.toContain("01|M001|2");
    expect(claves(r)).toContain("01|M001|1");
    expect(await total("?min=0.005")).toBe(58); // sin el 0.00 ni las negativas
  });

  it("999999999999.99 llega hasta el borde: max lo incluye, min lo deja solo, y .98 lo separa", async () => {
    expect(await total("?max=999999999999.99")).toBe(69);
    expect(
      claves(await leer(contador, "?min=999999999999.99&tamano=todas")),
    ).toEqual(["01|M001|6"]);
    expect(
      claves(await leer(contador, "?min=999999999999.98&tamano=todas")),
    ).toEqual(["01|M001|6"]);
    expect(await total("?max=999999999999.98")).toBe(68);
  });

  it("los límites son inclusivos y admiten negativos (las notas de crédito)", async () => {
    expect(await total("?min=-59.00&max=-59.00")).toBe(10);
    expect(await total("?min=-100&max=-1")).toBe(10);
    expect(await total("?min=118.00&max=118.00")).toBe(30 + 3); // B001 y las F009
    expect(await total("?min=236&max=236")).toBe(20);
  });

  it("se combina con q, tipo y serie", async () => {
    expect(await total("?serie=B001&min=118&max=118")).toBe(30);
    expect(await total("?tipo=01&min=100&max=300")).toBe(23); // F001 (236.00) y las 3 F009 (118.00)
  });
});

describe("parámetros inválidos: 400 solicitud_invalida y sin tocar la consulta", () => {
  const MALOS = [
    "tamano=7",
    "tamano=0",
    "tamano=-1",
    "tamano=TODAS",
    "tamano=100",
    "pagina=0",
    "pagina=-1",
    "pagina=abc",
    "pagina=1.5",
    "tipo=1",
    "tipo=ab",
    "tipo=001",
    "serie=B0011",
    "serie=B-01",
    "min=abc",
    "min=1e3",
    "min=1,5",
    "min=%27",
    "max=1.2345",
    "max=--1",
    `q=${"x".repeat(101)}`,
  ];
  it.each(MALOS)("?%s", async (query) => {
    const r = await leer(contador, `?${query}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("periodo mal formado en la ruta también es 400", async () => {
    const r = await leer(contador, "", cli.id, "2026-10");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });
});

describe("D5 · permisos y alcance de la lectura", () => {
  it("el contador asignado y el colaborador de solo lectura leen; el Dueño lee cualquier cliente", async () => {
    expect((await leer(contador)).status).toBe(200);
    expect((await leer(lectura)).status).toBe(200);
    expect((await leer(E.titular, "", ajeno.id)).status).toBe(200);
  });

  it("quien no está asignado recibe el mismo 404 que un cliente inexistente", async () => {
    expect((await leer(E.titular, "", ajeno.id)).status).toBe(200); // control: la ruta existe
    const r = await leer(lecturaAjena);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await leer(lecturaAjena, "", randomUUID())));
    expect(r.text).not.toContain("B001");
    const c = await leer(contador, "", ajeno.id);
    expect(c.status).toBe(404);
  });

  it("un cliente archivado se puede leer (solo se bloquean las escrituras)", async () => {
    const c = await v.cliente(E, { responsable: contador.id, archivado: true });
    await v.sembrarVentas(E.tenantId, c.id, [fila("B001", 1)], {
      usuarioId: E.titular.id,
    });
    const r = await leer(contador, "?tamano=todas", c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toBe(1);
  });
});

describe("D10 · «todas» entrega como máximo 5.000 filas", () => {
  it("5.001 ventas: tamano=todas devuelve 5.000, total 5.001 y el aviso todas_limitada; el resto se alcanza paginando", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarMuchas(E.tenantId, c.id, 5001, { usuarioId: E.titular.id });
    const r = await leer(contador, "?tamano=todas", c.id);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.body.filas).toHaveLength(5000);
    expect(r.body).toMatchObject({
      total: 5001,
      tamano: "todas",
      avisos: ["todas_limitada"],
    });
    expect(claves(r)[0]).toBe("03|S001|1");
    expect(claves(r)[4999]).toBe("03|S001|5000");
    // La fila 5.001 se pide paginando.
    const ultima = await leer(contador, "?tamano=50&pagina=101", c.id);
    expect(ultima.body.filas).toHaveLength(1);
    expect(claves(ultima)).toEqual(["03|S001|5001"]);
    expect(ultima.body.avisos).toEqual([]);
  });

  it("5.000 ventas exactas: todas entrega las 5.000 y no hay aviso", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarMuchas(E.tenantId, c.id, 5000, { usuarioId: E.titular.id });
    const r = await leer(contador, "?tamano=todas", c.id);
    expect(r.body.filas).toHaveLength(5000);
    expect(r.body).toMatchObject({ total: 5000, avisos: [] });
  });

  it("con filtro, el aviso depende de las filas que cumplen, no de las del periodo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.sembrarMuchas(E.tenantId, c.id, 5001, { usuarioId: E.titular.id });
    const pocas = await leer(contador, "?tamano=todas&q=5000", c.id);
    expect(claves(pocas)).toEqual(["03|S001|5000"]);
    expect(pocas.body.avisos).toEqual([]);
    const todas = await leer(contador, "?tamano=todas&tipo=03", c.id);
    expect(todas.body.avisos).toEqual(["todas_limitada"]);
    expect(todas.body.total).toBe(5001);
  });
});

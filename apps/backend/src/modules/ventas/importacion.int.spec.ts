/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): importación de la propuesta de ventas desde `.xlsx`/`.csv` (RF-051; D6, D16, D18; CA-10, CA-11).
// Contrato (plan: Rutas; el cuerpo es el archivo crudo `application/octet-stream`, el formato se detecta por el contenido, el
// estudio sale de la sesión; permiso `sire.descargar`; no pasa por la cola ni toca SUNAT):
//  - POST …/ventas/importar/vista-previa  -> 200 `{ filas: [{ n, estado: "valida" | "error", motivos: MotivoFilaVenta[] }],
//    validas, conError }` (`vistaPreviaVentasSchema`; `n` es la fila del archivo, la primera de datos es la 2). NO escribe
//    nada. Ningún campo lleva el contenido de una celda.
//  - POST …/ventas/importar/confirmar     -> 201 `{ propuesta: PropuestaVentasDto }` (fuente `importacion`, `trabajo_id` nulo,
//    `usuario_id` = quien importó). Revalida todo y aplica el mismo complemento de D16 que la descarga: agrega solo las claves
//    que no existen, no toca lo existente, informa las que difieren y repite en cero. Todo o nada: un archivo con una fila con
//    error no guarda NADA (400 o 422). Las filas importadas son origen `sire`, colgadas de la propuesta nueva.
//  - D18: una clave repetida dentro del archivo se guarda una vez (primera aparición); las demás cuentan como `iguales` si son
//    idénticas a ella o `distintas` si no. No es un error de fila.
//  - Columnas: los nombres de `FilaVentaSire` (tipo, serie, numero, tipoDocContraparte, docContraparte, fechaEmision, moneda,
//    tipoCambio, baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total); la cabecera es obligatoria (faltan
//    columnas obligatorias: 400 `columnas_faltantes`).
//  - Hasta 20.000 filas por archivo (T18, D19: el tope no cuenta las vivas del periodo): más es 422 `propuesta_demasiado_grande` y no se guarda nada.
//    Un archivo de 20.000 filas pesa unos 2,5 MB (más que el tope de 2 MB de la importación de clientes): el tope de tamaño de
//    ventas debe permitirlo; uno de 64 MB es 413.
//  - Con `NODE_ENV=production` ambas rutas responden 422 `layout_no_oficial` (el layout es provisional, `oficial: false`) antes
//    de leer el archivo; el valor se lee del entorno en cada petición y jamás de la petición.
//  - Archivos hostiles (fórmulas, XXE, bombas, rutas con `..`, miles de entradas, truncados): se rechazan o se marcan por fila
//    (`celda_peligrosa`), sin 500; el archivo no queda en disco ni en logs.
// Rojo: el módulo `ventas` aún no existe (T13/T14).
import { randomBytes, randomUUID } from "node:crypto";
import { vistaPreviaVentasSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  archivosNuevosConCanario,
  instantaneaTmp,
} from "../../../test/soporte-credenciales.js";
import {
  comprimir,
  DOCTYPE_LOLS,
  DOCTYPE_XXE,
  partesXlsx,
  xlsxBomba,
  xlsxConRuta,
  xlsxMilesDeEntradas,
  type Celda,
} from "../../../test/soporte-importacion.js";
import {
  abrirBancoVentas,
  base,
  CABECERA_VENTAS,
  celdasDe,
  csvVentas,
  fila,
  xlsxVentas,
  type Actor,
  type BancoVentas,
  type Estudio,
  type FilaV,
} from "../../../test/soporte-ventas.js";
import { capturarLogs } from "../../../test/soporte.js";

// Siembras de miles de filas, archivos de decenas de MB y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoVentas();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await v?.cerrar();
});

const nuevo = (o: Parameters<BancoVentas["cliente"]>[1] = {}) =>
  v.cliente(E, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
const ruta = (
  clienteId: string,
  paso: "vista-previa" | "confirmar",
  periodo = "202610",
) => `${base(clienteId, periodo)}/importar/${paso}`;
const previa = (
  a: Actor,
  clienteId: string,
  bytes: Uint8Array,
  periodo?: string,
) => v.bin(a, "POST", ruta(clienteId, "vista-previa", periodo), bytes);
const confirmar = (
  a: Actor,
  clienteId: string,
  bytes: Uint8Array,
  periodo?: string,
) => v.bin(a, "POST", ruta(clienteId, "confirmar", periodo), bytes);
const FORMATOS: Array<[string, (f: FilaV[]) => Uint8Array]> = [
  ["csv", (f) => csvVentas(f)],
  ["xlsx", (f) => xlsxVentas(f)],
];
const porN = (filas: any[]) => Object.fromEntries(filas.map((f) => [f.n, f]));
const vacio = async (clienteId: string) =>
  expect(await v.conteo(clienteId), "no se escribió nada").toEqual({
    propuestas: 0,
    ventas: 0,
    diferencias: 0,
    saltos: 0,
  });

describe("CA-10 · vista previa: errores por fila y no persiste nada", () => {
  it.each(FORMATOS)(
    "%s: dos filas válidas y dos con error; cada fila dice su estado y sus motivos, sin el contenido de la celda",
    async (_f, armar) => {
      const c = await nuevo();
      const sucio = `CAN${randomBytes(4).toString("hex")}`; // 11 caracteres: cabe en un documento
      const bytes = armar([
        fila("B001", 290),
        fila("B001", 292, {
          baseGravada: "50.00",
          igv: "9.00",
          total: "59.00",
        }),
        fila("B001", 293, { fechaEmision: "2026-02-30" }),
        fila("B001", 294, { total: sucio }),
      ]);
      const r = await previa(contador, c.id, bytes);
      expect(r.status, r.texto).toBe(200);
      expect(vistaPreviaVentasSchema.safeParse(r.json).success).toBe(true);
      expect(r.json.filas.map((x: any) => [x.n, x.estado])).toEqual([
        [2, "valida"],
        [3, "valida"],
        [4, "error"],
        [5, "error"],
      ]);
      expect(r.json).toMatchObject({ validas: 2, conError: 2 });
      const f = porN(r.json.filas);
      expect(f[2].motivos).toEqual([]);
      expect(f[4].motivos).toContain("fecha_invalida");
      expect(f[5].motivos).toContain("monto_invalido");
      for (const fila of r.json.filas)
        expect(Object.keys(fila).sort()).toEqual(["estado", "motivos", "n"]);
      expect(r.texto).not.toContain(sucio);
      await vacio(c.id);
    },
  );

  it("una venta en USD sin tipo de cambio y las filas repetidas del archivo no son errores (D18)", async () => {
    const c = await nuevo();
    const r = await previa(
      contador,
      c.id,
      csvVentas([
        fila("F002", 1, { tipo: "01", moneda: "USD" }),
        fila("B001", 290),
        fila("B001", 290),
        fila("B001", "0290"),
      ]),
    );
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ validas: 4, conError: 0 });
    await vacio(c.id);
  });

  it("fórmula real <f> en el .xlsx y texto que empieza con = en el .csv: celda_peligrosa por fila, las demás siguen válidas", async () => {
    const c = await nuevo();
    const total = CABECERA_VENTAS.indexOf("total");
    const conFormula = celdasDe(fila("B001", 291)) as Celda[];
    conFormula[total] = { f: "1+1", v: "2" };
    const x = await previa(
      contador,
      c.id,
      comprimir(
        partesXlsx([
          [...CABECERA_VENTAS],
          celdasDe(fila("B001", 290)),
          conFormula,
          celdasDe(fila("B001", 292)),
        ]),
      ),
    );
    expect(x.status, x.texto).toBe(200);
    expect(porN(x.json.filas)[3]).toMatchObject({
      estado: "error",
      motivos: ["celda_peligrosa"],
    });
    expect(porN(x.json.filas)[2].estado).toBe("valida");
    expect(porN(x.json.filas)[4].estado).toBe("valida");

    const peligrosas = ['=HYPERLINK("http://x.test","clic")', "@SUM(1+1)"];
    const csv = await previa(
      contador,
      c.id,
      csvVentas([
        fila("B001", 290),
        ...peligrosas.map((p, i) =>
          fila("B001", 291 + i, { docContraparte: p }),
        ),
      ]),
    );
    expect(csv.status, csv.texto).toBe(200);
    expect(porN(csv.json.filas)[2].estado).toBe("valida");
    for (const n of [3, 4])
      expect(porN(csv.json.filas)[n], `fila ${n}`).toMatchObject({
        estado: "error",
        motivos: ["celda_peligrosa"],
      });
    expect(csv.texto).not.toContain("HYPERLINK");
    await vacio(c.id);
  });

  it("el documento de consumidor final («-») y las notas de crédito en negativo no se confunden con una fórmula", async () => {
    const c = await nuevo();
    const r = await previa(
      contador,
      c.id,
      csvVentas([
        fila("B001", 290),
        fila("FC01", 1, {
          tipo: "07",
          baseGravada: "-50.00",
          igv: "-9.00",
          total: "-59.00",
        }),
      ]),
    );
    expect(r.json).toMatchObject({ validas: 2, conError: 0 });
  });

  it.each(FORMATOS)(
    "%s: falta una columna obligatoria → 400 columnas_faltantes",
    async (formato) => {
      const c = await nuevo();
      const sinTotal = CABECERA_VENTAS.filter((x) => x !== "total");
      const filaSinTotal = celdasDe(fila("B001", 290)).slice(
        0,
        sinTotal.length,
      );
      const bytes =
        formato === "csv"
          ? new TextEncoder().encode(
              [sinTotal.join(","), filaSinTotal.join(",")].join("\r\n") +
                "\r\n",
            )
          : comprimir(partesXlsx([[...sinTotal], filaSinTotal]));
      const r = await previa(contador, c.id, bytes);
      expect(r.status, r.texto).toBe(400);
      expect(r.json).toEqual({ codigo: "columnas_faltantes" });
      const rc = await confirmar(contador, c.id, bytes);
      expect(rc.status).toBe(400);
      await vacio(c.id);
    },
  );

  it("vacío, bytes sin sentido y .xlsx truncado: 400 con un código de archivo, nunca 500", async () => {
    const c = await nuevo();
    const valido = xlsxVentas([fila("B001", 290)]);
    const casos: Array<[string, Uint8Array]> = [
      ["vacío", new Uint8Array(0)],
      [
        "binario no válido",
        Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0x00, 0x00, 0x9f]),
      ],
      ["zip truncado", valido.subarray(0, Math.floor(valido.length / 2))],
      ["solo la firma PK", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])],
    ];
    for (const [nombre, bytes] of casos) {
      for (const paso of [previa, confirmar]) {
        const r = await paso(contador, c.id, bytes);
        expect(r.status, `${nombre} ${r.texto}`).toBe(400);
        expect(
          ["archivo_invalido", "columnas_faltantes", "demasiadas_filas"],
          nombre,
        ).toContain(r.json?.codigo);
      }
    }
    await vacio(c.id);
  });

  it("XXE, <!DOCTYPE> y entidades en la hoja o en las cadenas: 400 archivo_invalido y ni rastro del archivo local", async () => {
    const c = await nuevo();
    for (const [nombre, bytes] of [
      [
        "XXE en la hoja",
        xlsxVentas([fila("B001", 290)], { doctypeHoja: DOCTYPE_XXE }),
      ],
      [
        "XXE en las cadenas",
        xlsxVentas([fila("B001", 290)], { doctypeCadenas: DOCTYPE_XXE }),
      ],
      [
        "billion laughs",
        xlsxVentas([fila("B001", 290)], { doctypeHoja: DOCTYPE_LOLS }),
      ],
    ] as const) {
      const r = await previa(contador, c.id, bytes);
      expect(r.status, nombre).toBe(400);
      expect(r.json, nombre).toEqual({ codigo: "archivo_invalido" });
      expect(r.texto).not.toMatch(/root:|\/bin\//);
    }
    await vacio(c.id);
  });

  it("bomba de descompresión (declara poco y expande 120 MB; miles de entradas; rutas con '..'): rechazada rápido, sin 500", async () => {
    const c = await nuevo();
    const casos: Array<[string, Uint8Array]> = [
      ["bomba con tamaño falsificado", xlsxBomba(120 * 1024 * 1024, true)],
      ["bomba con tamaño honesto", xlsxBomba(120 * 1024 * 1024, false)],
      ["miles de entradas", xlsxMilesDeEntradas(5000)],
      ["ruta con ..", xlsxConRuta("../../etc/evil.xml")],
      ["ruta absoluta", xlsxConRuta("/etc/evil.xml")],
    ];
    for (const [nombre, bytes] of casos) {
      for (const paso of [previa, confirmar]) {
        const t0 = Date.now();
        const r = await paso(contador, c.id, bytes);
        expect(
          [400, 413],
          `${nombre}: ${r.status} ${r.texto.slice(0, 120)}`,
        ).toContain(r.status);
        expect(Date.now() - t0, nombre).toBeLessThan(15_000);
      }
    }
    await vacio(c.id);
  });

  it("64 MB: 413 en las dos rutas y no se guarda nada", async () => {
    const c = await nuevo();
    const grande = Buffer.alloc(64 * 1024 * 1024, 0x41);
    for (const paso of ["vista-previa", "confirmar"] as const) {
      const r = await v.bin(contador, "POST", ruta(c.id, paso), grande);
      // El servidor puede cortar la conexión mientras se sube el cuerpo (status 0): sigue siendo un rechazo.
      expect([413, 0], paso).toContain(r.status);
    }
    await vacio(c.id);
  });
});

describe("tope de 20.000 filas (D10, P-9)", () => {
  const tantas = (n: number, serie = "S001"): FilaV[] =>
    Array.from({ length: n }, (_, i) => fila(serie, i + 1));

  it("un archivo de 20.000 filas es el borde permitido: la vista previa las lista y la confirmación las guarda", async () => {
    const c = await nuevo();
    const bytes = csvVentas(tantas(20_000));
    const p = await previa(contador, c.id, bytes);
    expect(p.status, p.texto.slice(0, 200)).toBe(200);
    expect(p.json).toMatchObject({ validas: 20_000, conError: 0 });
    expect(p.json.filas).toHaveLength(20_000);
    const r = await confirmar(contador, c.id, bytes);
    expect(r.status, r.texto.slice(0, 200)).toBe(201);
    expect(r.json.propuesta).toMatchObject({
      filasRecibidas: 20_000,
      filasNuevas: 20_000,
      filasIguales: 0,
      filasDistintas: 0,
    });
    expect((await v.conteo(c.id)).ventas).toBe(20_000);
  });

  it("20.001 filas: 422 propuesta_demasiado_grande y no se guarda nada", async () => {
    const c = await nuevo();
    const r = await confirmar(contador, c.id, csvVentas(tantas(20_001)));
    expect(r.status, r.texto.slice(0, 200)).toBe(422);
    expect(r.json).toEqual({ codigo: "propuesta_demasiado_grande" });
    await vacio(c.id);
    const p = await previa(contador, c.id, csvVentas(tantas(20_001)));
    expect([200, 400, 413, 422], p.texto.slice(0, 120)).toContain(p.status);
    await vacio(c.id);
  });

  // T18 (D19, usuario 2026-11-07): antes «el periodo no pasa de 20.000 vivas tras complementar: 19.999 + 2 nuevas es 422».
  it("el tope no cuenta lo ya guardado (D19): 19.999 + 2 nuevas se guardan (el periodo queda en 20.001) y 19.999 + 1 llega justo a 20.000", async () => {
    const c = await nuevo();
    await v.sembrarMuchas(E.tenantId, c.id, 19_999, {
      usuarioId: E.titular.id,
    });
    const dos = await confirmar(
      contador,
      c.id,
      csvVentas([fila("N001", 1), fila("N001", 2)]),
    );
    expect(dos.status, dos.texto).toBe(201);
    expect(dos.json.propuesta).toMatchObject({ filasRecibidas: 2, filasNuevas: 2 });
    expect(await v.conteo(c.id)).toMatchObject({
      ventas: 20_001,
      propuestas: 2,
    });
    const otro = await nuevo();
    await v.sembrarMuchas(E.tenantId, otro.id, 19_999, {
      usuarioId: E.titular.id,
    });
    const una = await confirmar(
      contador,
      otro.id,
      csvVentas([fila("S001", 1), fila("N001", 1)]),
    );
    expect(una.status, una.texto).toBe(201);
    expect(una.json.propuesta).toMatchObject({
      filasRecibidas: 2,
      filasNuevas: 1,
      filasIguales: 1,
    });
    expect((await v.conteo(otro.id)).ventas).toBe(20_000);
  });
});

describe("CA-10 · confirmar crea la propuesta de importación", () => {
  it.each(FORMATOS)(
    "%s: 201 con la propuesta (fuente importacion), las filas en venta origen sire y la correlatividad que muestra la 291",
    async (_f, armar) => {
      const c = await nuevo();
      const r = await confirmar(
        contador,
        c.id,
        armar([
          fila("B001", 290),
          fila("B001", 292, {
            baseGravada: "50.00",
            igv: "9.00",
            total: "59.00",
          }),
          fila("F001", 10, {
            tipo: "01",
            tipoDocContraparte: "6",
            docContraparte: "20700000011",
          }),
        ]),
      );
      expect(r.status, r.texto).toBe(201);
      const p = r.json.propuesta;
      expect(Object.keys(r.json)).toEqual(["propuesta"]);
      expect(p).toMatchObject({
        fuente: "importacion",
        filasRecibidas: 3,
        filasNuevas: 3,
        filasIguales: 0,
        filasDistintas: 0,
      });
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);

      const [pb] = await v.propuestas(c.id);
      expect(pb).toMatchObject({
        id: p.id,
        libro: "ventas",
        fuente: "importacion",
        periodo: "202610",
        usuario_id: contador.id,
        trabajo_id: null,
      });
      const ventas = await v.ventas(c.id);
      expect(ventas).toHaveLength(3);
      expect(
        ventas.every(
          (x) =>
            x.origen === "sire" &&
            x.propuesta_id === p.id &&
            x.creada_por === null,
        ),
      ).toBe(true);
      expect(ventas.find((x) => x.clave === "03|B001|290")).toMatchObject({
        total: "118.00",
        base_gravada: "100.00",
        numero_n: 290,
      });
      expect(ventas.find((x) => x.clave === "01|F001|10")).toMatchObject({
        tipo_doc_contraparte: "6",
        doc_contraparte: "20700000011",
      });

      const lista = await v.llamar(contador, "GET", `${base(c.id)}/propuestas`);
      expect(lista.body.map((x: any) => x.id)).toEqual([p.id]);
      const corr = await v.llamar(
        contador,
        "GET",
        `${base(c.id)}/correlatividad`,
      );
      expect(
        corr.body.series.find((s: any) => s.serie === "B001").faltantes,
      ).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
    },
  );

  it("una fila con error (o una fórmula) hace que no se guarde nada: 400 o 422, ni siquiera el encabezado", async () => {
    const c = await nuevo();
    const total = CABECERA_VENTAS.indexOf("total");
    const conFormula = celdasDe(fila("B001", 291)) as Celda[];
    conFormula[total] = { f: "1+1", v: "2" };
    const casos: Array<[string, Uint8Array]> = [
      [
        "fecha inexistente",
        csvVentas([
          fila("B001", 290),
          fila("B001", 291, { fechaEmision: "2026-02-30" }),
        ]),
      ],
      [
        "monto no numérico",
        csvVentas([fila("B001", 290), fila("B001", 291, { total: "abc" })]),
      ],
      [
        "moneda desconocida",
        csvVentas([
          fila("B001", 290),
          fila("B001", 291, { moneda: "EUR" as never }),
        ]),
      ],
      [
        "fórmula real",
        comprimir(
          partesXlsx([
            [...CABECERA_VENTAS],
            celdasDe(fila("B001", 290)),
            conFormula,
          ]),
        ),
      ],
      [
        "texto con =",
        csvVentas([
          fila("B001", 290),
          fila("B001", 291, { docContraparte: "=1+1" }),
        ]),
      ],
    ];
    for (const [nombre, bytes] of casos) {
      const r = await confirmar(contador, c.id, bytes);
      expect([400, 422], `${nombre}: ${r.texto}`).toContain(r.status);
      expect(typeof r.json?.codigo, nombre).toBe("string");
    }
    await vacio(c.id);
  });

  it("D18: la clave repetida en el archivo se guarda una vez (primera aparición); idénticas = iguales, distinta = distinta", async () => {
    const c = await nuevo();
    const r = await confirmar(
      contador,
      c.id,
      csvVentas([
        fila("B001", 290),
        fila("B001", 290),
        fila("B001", "0290"),
        fila("B001", 292, {
          baseGravada: "50.00",
          igv: "9.00",
          total: "59.00",
        }),
        fila("B001", 292, {
          baseGravada: "50.00",
          igv: "9.00",
          total: "60.00",
        }),
        fila("B001", 293),
      ]),
    );
    expect(r.status, r.texto).toBe(201);
    expect(r.json.propuesta).toMatchObject({
      filasRecibidas: 6,
      filasNuevas: 3,
      filasIguales: 2,
      filasDistintas: 1,
    });
    const ventas = await v.ventas(c.id);
    expect(ventas.map((x) => x.clave)).toEqual([
      "03|B001|290",
      "03|B001|292",
      "03|B001|293",
    ]);
    expect(ventas.find((x) => x.clave === "03|B001|292")!.total).toBe("59.00");
  });
});

describe("CA-11 · importar sobre un periodo ya cargado complementa", () => {
  /** 290 y 292 del SIRE, la 291 agregada a mano y justificada. */
  async function periodoTrabajado() {
    const c = await nuevo();
    const [s290] = await v.sembrarVentas(
      E.tenantId,
      c.id,
      [
        fila("B001", 290, { tipoDocContraparte: "0" }),
        fila("B001", 292, { tipoDocContraparte: "0" }),
      ],
      { usuarioId: E.titular.id },
    );
    const [m291] = await v.sembrarVentas(
      E.tenantId,
      c.id,
      [fila("B001", 291, { tipoDocContraparte: "0" })],
      { usuarioId: E.titular.id, origen: "manual" },
    );
    const j = await v.sembrarSalto(E.tenantId, c.id, {
      usuarioId: E.titular.id,
      desde: 291,
      hasta: 291,
    });
    return { c, s290, m291, j, antes: await v.ventas(c.id) };
  }
  const archivo = (): FilaV[] => [
    fila("B001", 290, { tipoDocContraparte: "0", total: "120.00" }), // difiere del existente
    fila("B001", 291, { tipoDocContraparte: "0" }), // igual a la agregada a mano
    fila("B001", 293, { tipoDocContraparte: "0", fechaEmision: "2026-10-08" }), // nueva
  ];

  it("se agrega solo la 293; la 290 y la 291 quedan intactas, la 290 sale en las diferencias, la justificación sigue y repetir da 0 nuevas", async () => {
    const { c, j, antes } = await periodoTrabajado();
    const r = await confirmar(contador, c.id, csvVentas(archivo()));
    expect(r.status, r.texto).toBe(201);
    expect(r.json.propuesta).toMatchObject({
      filasRecibidas: 3,
      filasNuevas: 1,
      filasIguales: 1,
      filasDistintas: 1,
    });

    const despues = await v.ventas(c.id);
    expect(despues.map((x) => x.clave)).toEqual([
      "03|B001|290",
      "03|B001|291",
      "03|B001|292",
      "03|B001|293",
    ]);
    for (const x of antes)
      expect(
        despues.find((d) => d.id === x.id),
        x.clave,
      ).toEqual(x);
    expect(despues.find((x) => x.clave === "03|B001|293")).toMatchObject({
      origen: "sire",
      propuesta_id: r.json.propuesta.id,
    });
    const saltos = await v.saltos(c.id);
    expect(saltos).toHaveLength(1);
    expect(saltos[0]).toMatchObject({ id: j, revertido_en: null });

    const dif = await v.llamar(
      contador,
      "GET",
      `${base(c.id)}/propuestas/${r.json.propuesta.id}/diferencias`,
    );
    expect(dif.status, dif.text).toBe(200);
    expect(dif.body).toEqual([
      {
        clave: "03|B001|290",
        tipo: "03",
        serie: "B001",
        numero: "290",
        origenExistente: "sire",
        campos: ["total"],
        valoresSire: { total: "120.00" },
      },
    ]);

    const otra = await confirmar(contador, c.id, csvVentas(archivo()));
    expect(otra.status, otra.texto).toBe(201);
    expect(otra.json.propuesta).toMatchObject({
      filasRecibidas: 3,
      filasNuevas: 0,
      filasIguales: 2,
      filasDistintas: 1,
    });
    expect(await v.ventas(c.id)).toEqual(despues);
    // periodoTrabajado() ya siembra una propuesta (fuente "api") para la 290 y la 292;
    // se cuentan solo las de importación: la primera y la repetida.
    const importaciones = (await v.propuestas(c.id)).filter((p) => p.fuente === "importacion");
    expect(importaciones).toHaveLength(2);
  });

  it("la 291 del archivo con otro total que la agregada a mano se informa con origen manual y la agregada no cambia", async () => {
    const { c, antes } = await periodoTrabajado();
    const r = await confirmar(
      contador,
      c.id,
      csvVentas([
        fila("B001", 291, { tipoDocContraparte: "0", total: "130.00" }),
      ]),
    );
    expect(r.status, r.texto).toBe(201);
    expect(r.json.propuesta).toMatchObject({
      filasNuevas: 0,
      filasIguales: 0,
      filasDistintas: 1,
    });
    expect(await v.ventas(c.id)).toEqual(antes);
    const dif = await v.diferencias(r.json.propuesta.id);
    expect(dif).toHaveLength(1);
    expect(dif[0]).toMatchObject({
      clave: "03|B001|291",
      origen_existente: "manual",
      campos: ["total"],
    });
  });

  it("dos importaciones simultáneas del mismo archivo (10 rondas): sin filas duplicadas ni 500; una agrega y la otra lo encuentra todo igual", async () => {
    const c = await nuevo();
    const bytes = csvVentas([
      fila("B001", 290),
      fila("B001", 292),
      fila("B001", 293),
    ]);
    for (let i = 0; i < 10; i++) {
      const p = `2024${String(i + 1).padStart(2, "0")}`;
      const rs = await Promise.all([
        confirmar(contador, c.id, bytes, p),
        confirmar(asistente, c.id, bytes, p),
      ]);
      expect(
        rs.map((r) => r.status),
        `ronda ${i}: ${rs.map((r) => r.texto)}`,
      ).toEqual([201, 201]);
      const nuevas = rs.map((r) => r.json.propuesta.filasNuevas).sort();
      const iguales = rs.map((r) => r.json.propuesta.filasIguales).sort();
      expect(nuevas, `ronda ${i}`).toEqual([0, 3]);
      expect(iguales, `ronda ${i}`).toEqual([0, 3]);
      expect(await v.ventas(c.id, p), `ronda ${i}`).toHaveLength(3);
      expect(await v.propuestas(c.id, p), `ronda ${i}`).toHaveLength(2);
    }
  });
});

describe("el archivo no queda en disco ni en logs, y no se refleja en la respuesta", () => {
  it.each(FORMATOS)(
    "%s: un documento canario del archivo no está en el directorio temporal, ni en los logs, ni en las respuestas",
    async (formato, armar) => {
      const c = await nuevo();
      const canario = `CAN${randomBytes(4).toString("hex")}`;
      const bytes = armar([fila("B001", 290, { docContraparte: canario })]);
      const antes = instantaneaTmp();
      const { resultado, logs } = await capturarLogs(async () => {
        const a = await previa(contador, c.id, bytes);
        const b = await confirmar(contador, c.id, bytes);
        return { a, b };
      });
      expect(resultado.a.status, resultado.a.texto).toBe(200);
      expect(resultado.b.status, resultado.b.texto).toBe(201);
      expect(resultado.a.texto).not.toContain(canario);
      expect(resultado.b.texto).not.toContain(canario);
      expect(JSON.stringify(resultado.b.headers)).not.toContain(canario);
      expect(logs, formato).not.toContain(canario);
      if (formato === "csv")
        expect(archivosNuevosConCanario(antes, [canario])).toEqual([]);
    },
  );

  it("un archivo rechazado tampoco deja rastro en logs", async () => {
    const c = await nuevo();
    const canario = `CAN${randomBytes(4).toString("hex")}`;
    const malo = csvVentas([
      fila("B001", 290, {
        docContraparte: canario,
        fechaEmision: "2026-02-30",
      }),
    ]);
    const { resultado, logs } = await capturarLogs(() =>
      confirmar(contador, c.id, malo),
    );
    expect([400, 422]).toContain(resultado.status);
    expect(resultado.texto).not.toContain(canario);
    expect(logs).not.toContain(canario);
  });
});

describe("D6 · con NODE_ENV=production no se importa: 422 layout_no_oficial", () => {
  const enProduccion = async <T>(fn: () => Promise<T>): Promise<T> => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      return await fn();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("vista previa y confirmar responden 422 { codigo: layout_no_oficial } y no escriben; sin producción, el mismo archivo se importa", async () => {
    const c = await nuevo();
    const bytes = csvVentas([fila("B001", 290)]);
    for (const paso of [previa, confirmar]) {
      const r = await enProduccion(() => paso(contador, c.id, bytes));
      expect(r.status, r.texto).toBe(422);
      expect(r.json).toEqual({ codigo: "layout_no_oficial" });
    }
    await vacio(c.id);
    expect((await previa(contador, c.id, bytes)).status).toBe(200); // control: fuera de producción sí
    expect((await confirmar(contador, c.id, bytes)).status).toBe(201);
  });

  it("no se procesa el archivo: aun siendo basura o una bomba, en producción la respuesta es la misma 422", async () => {
    const c = await nuevo();
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.from([0xff, 0x00, 0x9f]),
      xlsxMilesDeEntradas(5000),
    ]) {
      for (const paso of [previa, confirmar]) {
        const r = await enProduccion(() => paso(contador, c.id, bytes));
        expect(r.status).toBe(422);
        expect(r.json).toEqual({ codigo: "layout_no_oficial" });
      }
    }
    await vacio(c.id);
  });

  it("el valor jamás se toma de la petición: ni la query ni las cabeceras lo cambian", async () => {
    const c = await nuevo();
    const bytes = csvVentas([fila("B001", 290)]);
    const h = v.b.c.p.b.h;
    for (const [paso, sufijo, cabeceras] of [
      ["vista-previa", "?oficial=true&NODE_ENV=development&layout=oficial", {}],
      ["confirmar", "?oficial=true&NODE_ENV=development&layout=oficial", {}],
      [
        "vista-previa",
        "",
        { "X-Node-Env": "development", "X-Layout-Oficial": "true" },
      ],
      [
        "confirmar",
        "",
        { "X-Node-Env": "development", "X-Layout-Oficial": "true" },
      ],
    ] as const) {
      const r = await enProduccion(() =>
        h.pedir({
          metodo: "POST",
          ruta: `${ruta(c.id, paso)}${sufijo}`,
          binario: bytes,
          cookie: contador.cookie,
          csrf: contador.csrf,
          estudio: contador.tenantId,
          cabeceras: { ...cabeceras },
        }),
      );
      expect(r.status, `${paso} ${sufijo}`).toBe(422);
      expect(r.body).toEqual({ codigo: "layout_no_oficial" });
    }
    await vacio(c.id);
  });

  it("en producción, quien no tiene permiso sigue recibiendo 403 y quien no tiene alcance, 404 (el 422 no se antepone a la autorización)", async () => {
    const c = await nuevo();
    const ajeno = await v.cliente(E);
    const bytes = csvVentas([fila("B001", 290)]);
    const l = await enProduccion(() => previa(lectura, c.id, bytes));
    expect(l.status).toBe(403);
    const n = await enProduccion(() => previa(contador, ajeno.id, bytes));
    expect(n.status).toBe(404);
  });
});

describe("D5 · permisos, alcance y cliente archivado (sire.descargar)", () => {
  it("el asistente asignado importa; lectura recibe 403 permiso_denegado en las dos rutas y no se escribe nada", async () => {
    const c = await nuevo();
    const bytes = csvVentas([fila("B001", 290)]);
    expect((await previa(asistente, c.id, bytes)).status).toBe(200);
    for (const paso of [previa, confirmar]) {
      const r = await paso(lectura, c.id, bytes);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ codigo: "permiso_denegado" });
    }
    await vacio(c.id);
  });

  it("el contador no asignado recibe el mismo 404 que un cliente inexistente", async () => {
    const ajeno = await v.cliente(E);
    const bytes = csvVentas([fila("B001", 290)]);
    expect((await previa(E.titular, ajeno.id, bytes)).status).toBe(200); // control
    for (const paso of [previa, confirmar]) {
      const r = await paso(contador, ajeno.id, bytes);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      const inexistente = await paso(contador, randomUUID(), bytes);
      expect(r.status).toBe(inexistente.status);
      expect(r.json).toEqual(inexistente.json);
    }
    await vacio(ajeno.id);
  });

  it("otro estudio: el Dueño de F no importa en un cliente de E", async () => {
    const F = await v.estudio();
    const c = await nuevo();
    const bytes = csvVentas([fila("B001", 290)]);
    expect((await confirmar(E.titular, c.id, bytes)).status).toBe(201); // control
    const r = await confirmar(F.titular, c.id, bytes);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect((await v.conteo(c.id)).propuestas).toBe(1);
  });

  it("cliente archivado: confirmar da 409 cliente_archivado y no escribe", async () => {
    const c = await nuevo({ archivado: true });
    const r = await confirmar(contador, c.id, csvVentas([fila("B001", 290)]));
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ codigo: "cliente_archivado" });
    await vacio(c.id);
  });
});

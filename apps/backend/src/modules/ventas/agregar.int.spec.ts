/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): agregar y quitar una venta a mano (RF-055; D4, D5, D9; CA-8).
//  - POST   …/ventas          `sire.clasificar` -> 201 `VentaDto` (origen `manual`) · 400 `solicitud_invalida` (cuerpo que no pasa
//    `ventaAgregarSchema`) · 400 con un `codigo` propio si el total no cuadra con Σ de las siete columnas (tolerancia 0.00) ·
//    409 `duplicado` si la clave (tipo, SERIE en mayúsculas, número sin ceros a la izquierda) ya está en el periodo, también
//    contra una fila `sire`. Guarda `origen = manual`, `propuesta_id = null`, `creada_por` = quien la agregó y la clave
//    normalizada; descarta las claves desconocidas (origen, cliente y estudio nunca salen del cuerpo).
//  - DELETE …/ventas/:ventaId `sire.clasificar` -> 204 solo si la fila es `manual`; una fila `sire` es inmutable: 409 (o 404) y
//    queda intacta; inexistente, de otro cliente o de otro periodo: 404.
//  - La propuesta original queda intacta: agregar y quitar no tocan filas `sire` ni `propuesta`. La agregada cuenta como
//    presente en la correlatividad (la 291 deja de faltar) y deja de contar al quitarla.
//  - Cliente archivado: 409 `cliente_archivado` en ambas. Lectura: 403 `permiso_denegado`; no asignado: el 404 de siempre.
// Rojo: el módulo `ventas` aún no existe (T13).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  cuerpoVenta,
  fila,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "../../../test/soporte-ventas.js";
import { forma } from "../../../test/soporte.js";

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
  await v?.cerrar();
});

/** Cliente con la propuesta de B001-290 y B001-292 (falta la 291). */
async function conPropuesta() {
  const c = await v.cliente(E, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
  });
  await v.sembrarVentas(
    E.tenantId,
    c.id,
    [fila("B001", 290), fila("B001", 292)],
    { usuarioId: E.titular.id },
  );
  return c;
}
const agregar = (
  a: Actor,
  clienteId: string,
  cuerpo: unknown,
  periodo = "202610",
) => v.llamar(a, "POST", base(clienteId, periodo), cuerpo);
const quitar = (a: Actor, clienteId: string, id: string, periodo = "202610") =>
  v.llamar(a, "DELETE", `${base(clienteId, periodo)}/${id}`);
const falta = async (clienteId: string) => {
  const r = await v.llamar(
    contador,
    "GET",
    `${base(clienteId)}/correlatividad`,
  );
  return (r.body.series as any[]).find((s) => s.serie === "B001")!;
};
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

describe("CA-8 · agregar la 291", () => {
  it("201 con la venta manual; el salto desaparece, la propuesta original queda intacta y la fila se puede quitar", async () => {
    const c = await conPropuesta();
    expect((await falta(c.id)).faltantes).toEqual([
      { desde: 291, hasta: 291, estado: "pendiente" },
    ]);
    const sireAntes = (await v.ventas(c.id)).filter((x) => x.origen === "sire");
    const propuestasAntes = await v.propuestas(c.id);

    const r = await agregar(
      contador,
      c.id,
      cuerpoVenta("B001", 291, {
        fechaEmision: "2026-10-04",
        baseGravada: "10.50",
        igv: "1.89",
        total: "12.39",
      }),
    );
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(COLUMNAS_DTO);
    expect(r.body).toMatchObject({
      origen: "manual",
      tipo: "03",
      serie: "B001",
      numero: "291",
      fechaEmision: "2026-10-04",
      moneda: "PEN",
      tipoCambio: null,
      baseGravada: "10.50",
      igv: "1.89",
      exonerada: "0.00",
      total: "12.39",
    });
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);

    // En la BD: manual, sin propuesta, a nombre de quien la agregó y con la clave normalizada.
    const todas = await v.ventas(c.id);
    expect(todas).toHaveLength(3);
    const nueva = todas.find((x) => x.id === r.body.id)!;
    expect(nueva).toMatchObject({
      origen: "manual",
      propuesta_id: null,
      creada_por: contador.id,
      clave: "03|B001|291",
      numero_n: 291,
      total: "12.39",
    });
    // La propuesta original no cambió: mismas filas `sire`, mismo encabezado, sin diferencias nuevas.
    expect(todas.filter((x) => x.origen === "sire")).toEqual(sireAntes);
    expect(await v.propuestas(c.id)).toEqual(propuestasAntes);
    expect((await v.conteo(c.id)).diferencias).toBe(0);

    // El salto desaparece: la agregada cuenta como presente.
    expect(await falta(c.id)).toMatchObject({
      estado: "completa",
      faltantes: [],
    });
    const lista = await v.llamar(contador, "GET", `${base(c.id)}?tamano=todas`);
    expect(
      (lista.body.filas as any[]).map(
        (f) => `${f.serie}-${f.numero}:${f.origen}`,
      ),
    ).toEqual(["B001-290:sire", "B001-291:manual", "B001-292:sire"]);

    // Se puede quitar, y el salto vuelve.
    const q = await quitar(contador, c.id, r.body.id);
    expect(q.status, q.text).toBe(204);
    expect(await v.ventas(c.id)).toEqual(sireAntes);
    expect((await falta(c.id)).faltantes).toEqual([
      { desde: 291, hasta: 291, estado: "pendiente" },
    ]);
  });

  it("USD con tipo de cambio y las siete columnas: cuadra Σ de base, IGV, exonerada, inafecta, ISC, ICBPER y otros", async () => {
    const c = await conPropuesta();
    const r = await agregar(
      contador,
      c.id,
      cuerpoVenta("F002", 1, {
        tipo: "01",
        moneda: "USD",
        tipoCambio: "3.300",
        baseGravada: "100.00",
        igv: "18.00",
        exonerada: "10.00",
        inafecta: "5.00",
        isc: "2.00",
        icbper: "0.50",
        otros: "1.25",
        total: "136.75",
        tipoDocContraparte: "6",
        docContraparte: "20700000011",
      }),
    );
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({
      moneda: "USD",
      tipoCambio: "3.300",
      total: "136.75",
      tipoDocContraparte: "6",
      docContraparte: "20700000011",
    });
  });

  it("las claves de más del cuerpo se descartan: ni el origen, ni la propuesta, ni el cliente, ni el estudio salen del cuerpo", async () => {
    const c = await conPropuesta();
    const otro = await v.cliente(E);
    const propuestaAjena = await v.sembrarPropuesta(E.tenantId, otro.id, {
      usuarioId: E.titular.id,
    });
    const r = await agregar(
      contador,
      c.id,
      cuerpoVenta("B001", 291, {
        origen: "sire",
        propuestaId: propuestaAjena,
        clienteId: otro.id,
        tenantId: randomUUID(),
        creadaPor: E.titular.id,
        id: randomUUID(),
      }),
    );
    expect(r.status, r.text).toBe(201);
    const [fila291] = (await v.ventas(c.id)).filter((x) => x.numero === "291");
    expect(fila291).toMatchObject({
      origen: "manual",
      propuesta_id: null,
      creada_por: contador.id,
    });
    expect((await v.ventas(otro.id)).length).toBe(0);
  });
});

describe("el total debe cuadrar con tolerancia 0.00 (D9): 400 y no se escribe nada", () => {
  it.each([
    ["un centavo de más", { total: "118.01" }],
    ["un centavo de menos", { total: "117.99" }],
    ["119.00 con 100.00 + 18.00", { total: "119.00" }],
    ["el ISC no está en el total", { isc: "2.00" }],
    ["total en cero con montos", { total: "0.00" }],
  ])("%s", async (_n, extra) => {
    const c = await conPropuesta();
    const r = await agregar(contador, c.id, cuerpoVenta("B001", 291, extra));
    expect(r.status, r.text).toBe(400);
    expect(typeof r.body.codigo).toBe("string");
    expect((await v.ventas(c.id)).filter((x) => x.numero === "291")).toEqual(
      [],
    );
    expect((await falta(c.id)).faltantes).toHaveLength(1); // el salto sigue
  });

  it("una nota de crédito con montos negativos que cuadran se acepta", async () => {
    const c = await conPropuesta();
    const r = await agregar(
      contador,
      c.id,
      cuerpoVenta("FC01", 1, {
        tipo: "07",
        baseGravada: "-50.00",
        igv: "-9.00",
        total: "-59.00",
      }),
    );
    expect(r.status, r.text).toBe(201);
    expect(r.body.total).toBe("-59.00");
  });
});

describe("la clave (tipo, serie, número) no se repite en el periodo: 409 duplicado", () => {
  it("contra una fila del SIRE (B001-290), con ceros a la izquierda (00290) y con la serie en minúsculas (b001)", async () => {
    const c = await conPropuesta();
    for (const extra of [{}, { numero: "00290" }, { serie: "b001" }]) {
      const r = await agregar(contador, c.id, cuerpoVenta("B001", 290, extra));
      expect(r.status, JSON.stringify(extra)).toBe(409);
      expect(r.body).toEqual({ codigo: "duplicado" });
    }
    expect(await v.ventas(c.id)).toHaveLength(2); // nada nuevo
  });

  it("contra otra agregada a mano; otro tipo, otro periodo u otro cliente con la misma serie y número sí se pueden", async () => {
    const c = await conPropuesta();
    const otro = await conPropuesta();
    expect(
      (await agregar(contador, c.id, cuerpoVenta("B001", 291))).status,
    ).toBe(201);
    const repetida = await agregar(contador, c.id, cuerpoVenta("B001", 291));
    expect(repetida.status).toBe(409);
    expect(repetida.body).toEqual({ codigo: "duplicado" });
    expect(
      (await agregar(contador, c.id, cuerpoVenta("B001", 291, { tipo: "01" })))
        .status,
    ).toBe(201);
    expect(
      (await agregar(contador, c.id, cuerpoVenta("B001", 291), "202609"))
        .status,
    ).toBe(201);
    expect(
      (await agregar(contador, otro.id, cuerpoVenta("B001", 291))).status,
    ).toBe(201);
  });

  it("dos altas simultáneas de la misma venta: una 201, la otra 409 y una sola fila (10 rondas)", async () => {
    const c = await conPropuesta();
    for (let i = 0; i < 10; i++) {
      const cuerpo = cuerpoVenta("B002", 100 + i);
      const rs = await Promise.all([
        agregar(contador, c.id, cuerpo),
        agregar(asistente, c.id, cuerpo),
      ]);
      expect(
        rs.map((r) => r.status).sort(),
        `ronda ${i}: ${rs.map((r) => r.text)}`,
      ).toEqual([201, 409]);
      expect(
        (await v.ventas(c.id)).filter(
          (x) => x.serie === "B002" && x.numero === String(100 + i),
        ),
      ).toHaveLength(1);
    }
  });
});

describe("cuerpo inválido: 400 solicitud_invalida y no se escribe nada", () => {
  const MALOS: Array<[string, Record<string, unknown>]> = [
    ["serie de 3 caracteres", { serie: "B01" }],
    ["serie de 5 caracteres", { serie: "B0011" }],
    ["número vacío", { numero: "" }],
    ["número de 21 dígitos", { numero: "1".repeat(21) }],
    ["número con letras", { numero: "12A" }],
    ["tipo de un dígito", { tipo: "3" }],
    ["fecha inexistente", { fechaEmision: "2026-02-30" }],
    ["fecha en otro formato", { fechaEmision: "05/10/2026" }],
    ["moneda desconocida", { moneda: "EUR" }],
    ["monto con 3 decimales", { igv: "18.001" }],
    ["monto como número JSON", { total: 118 }],
    ["monto con coma", { total: "118,00" }],
    [
      "monto fuera de NUMERIC(14,2)",
      { baseGravada: "1000000000000.00", total: "1000000000018.00" },
    ],
    ["tipo de cambio en una venta en soles", { tipoCambio: "3.300" }],
    ["tipo de cambio en cero en USD", { moneda: "USD", tipoCambio: "0" }],
    ["documento vacío", { docContraparte: "" }],
    ["sin total", { total: undefined }],
    ["sin fecha", { fechaEmision: undefined }],
  ];
  it.each(MALOS)("%s", async (_n, extra) => {
    const c = await conPropuesta();
    const r = await agregar(contador, c.id, cuerpoVenta("B001", 291, extra));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.ventas(c.id)).toHaveLength(2);
  });

  it("un cuerpo que no es un objeto tampoco escribe", async () => {
    const c = await conPropuesta();
    for (const cuerpo of [[], "texto", 42]) {
      const r = await agregar(contador, c.id, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
    }
    expect(await v.ventas(c.id)).toHaveLength(2);
  });
});

describe("quitar: solo lo agregado a mano", () => {
  it("una fila del SIRE no se quita (409 o 404) y queda intacta; el borrado de verdad es solo de las manuales", async () => {
    const c = await conPropuesta();
    // Control: la ruta existe y quita una agregada a mano.
    const [manual] = await v.sembrarVentas(
      E.tenantId,
      c.id,
      [fila("B001", 291)],
      {
        usuarioId: E.titular.id,
        origen: "manual",
      },
    );
    expect((await quitar(contador, c.id, manual!)).status).toBe(204);
    const [b290] = await v.ventas(c.id);
    const r = await quitar(contador, c.id, b290!.id);
    expect([409, 404], r.text).toContain(r.status);
    expect(await v.ventas(c.id)).toHaveLength(2);
    expect((await v.ventas(c.id))[0]).toEqual(b290);
  });

  it("inexistente, id mal formado, de otro cliente y de otro periodo: 404 y no se borra nada", async () => {
    const c = await conPropuesta();
    const otro = await conPropuesta();
    const mia = await agregar(contador, c.id, cuerpoVenta("B001", 291));
    const deOtro = await agregar(contador, otro.id, cuerpoVenta("B001", 291));
    expect(mia.status).toBe(201);
    expect((await quitar(contador, c.id, randomUUID())).status).toBe(404);
    expect((await quitar(contador, c.id, "no-es-uuid")).status).toBe(404);
    expect((await quitar(contador, c.id, deOtro.body.id)).status).toBe(404);
    expect((await quitar(contador, c.id, mia.body.id, "202609")).status).toBe(
      404,
    );
    expect((await v.ventas(c.id)).some((x) => x.id === mia.body.id)).toBe(true);
    expect((await v.ventas(otro.id)).some((x) => x.id === deOtro.body.id)).toBe(
      true,
    );
  });

  it("quitar dos veces: la segunda es 404", async () => {
    const c = await conPropuesta();
    const mia = await agregar(contador, c.id, cuerpoVenta("B001", 291));
    expect((await quitar(contador, c.id, mia.body.id)).status).toBe(204);
    expect((await quitar(contador, c.id, mia.body.id)).status).toBe(404);
  });

  it("quitar una agregada no toca una justificación hecha sobre ese hueco", async () => {
    const c = await conPropuesta();
    const j = await v.llamar(
      contador,
      "POST",
      `${base(c.id)}/saltos-justificados`,
      {
        tipo: "03",
        serie: "B001",
        desde: 291,
        hasta: 291,
        comentario: "Anulada",
      },
    );
    expect(j.status, j.text).toBe(201);
    const mia = await agregar(contador, c.id, cuerpoVenta("B001", 291));
    expect((await quitar(contador, c.id, mia.body.id)).status).toBe(204);
    const [s] = await v.saltos(c.id);
    expect(s!.revertido_en).toBeNull();
  });
});

describe("D5 · permisos, alcance y cliente archivado", () => {
  it("el asistente asignado agrega y quita; lectura recibe 403 permiso_denegado (antes de validar el cuerpo) y no escribe", async () => {
    const c = await conPropuesta();
    const ok = await agregar(asistente, c.id, cuerpoVenta("B001", 291));
    expect(ok.status, ok.text).toBe(201);
    for (const cuerpo of [cuerpoVenta("B001", 295), { total: "x" }]) {
      const r = await agregar(lectura, c.id, cuerpo);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    const q = await quitar(lectura, c.id, ok.body.id);
    expect(q.status).toBe(403);
    expect(q.body).toEqual({ codigo: "permiso_denegado" });
    expect((await v.ventas(c.id)).some((x) => x.id === ok.body.id)).toBe(true);
    expect(await v.ventas(c.id)).toHaveLength(3);
    expect((await quitar(asistente, c.id, ok.body.id)).status).toBe(204);
  });

  it("el contador no asignado recibe el mismo 404 que un cliente inexistente en agregar y en quitar", async () => {
    const ajeno = await v.cliente(E);
    const control = await agregar(
      E.titular,
      ajeno.id,
      cuerpoVenta("B001", 291),
    );
    expect(control.status, control.text).toBe(201); // la ruta existe para quien tiene alcance
    const r = await agregar(contador, ajeno.id, cuerpoVenta("B001", 292));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(
      forma(await agregar(contador, randomUUID(), cuerpoVenta("B001", 292))),
    );
    const q = await quitar(contador, ajeno.id, control.body.id);
    expect(q.status).toBe(404);
    expect(forma(q)).toEqual(
      forma(await quitar(contador, randomUUID(), control.body.id)),
    );
    expect(await v.ventas(ajeno.id)).toHaveLength(1);
  });

  it("cliente archivado: agregar y quitar dan 409 cliente_archivado y no cambian nada", async () => {
    const c = await conPropuesta();
    const mia = await agregar(contador, c.id, cuerpoVenta("B001", 291));
    expect(
      (await v.b.c.p.b.llamar(E.titular, "POST", `/clientes/${c.id}/archivar`))
        .status,
    ).toBe(200);
    const a = await agregar(contador, c.id, cuerpoVenta("B001", 295));
    expect(a.status).toBe(409);
    expect(a.body).toEqual({ codigo: "cliente_archivado" });
    const q = await quitar(contador, c.id, mia.body.id);
    expect(q.status).toBe(409);
    expect(q.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.ventas(c.id)).toHaveLength(3);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): correlatividad y saltos justificados (RF-053, HU-12; D7, D8; CA-6, CA-7).
//  - GET  …/ventas/correlatividad                    `clientes.ver`     -> 200 `{ series: [{ tipo, serie, estado, faltantes:
//    [{ desde, hasta, estado, comentario? }], noEvaluables }] }` (`CorrelatividadVentasDto`; desde y hasta son enteros JSON).
//    Es el resultado de `analizarCorrelatividad` sobre TODAS las ventas del periodo (las agregadas a mano cuentan) y las
//    justificaciones vigentes. Series ordenadas por tipo y serie. Sin bandera de bloqueo de ninguna clase.
//  - POST …/ventas/saltos-justificados               `sire.clasificar`  -> 201 `{ id, tipo, serie, desde, hasta, comentario }`
//    · 400 `solicitud_invalida` (cuerpo mal formado, comentario vacío o de más de 500, desde > hasta) · 400 con un `codigo`
//    propio si el rango no está DENTRO de un faltante actual (presentes, fuera del menor-mayor, serie inexistente).
//  - DELETE …/ventas/saltos-justificados/:id         `sire.clasificar`  -> 204 (revierte: la fila queda con `revertido_por` y
//    `revertido_en`; no se borra) · 404 si no existe, es de otro cliente o ya estaba revertida (o 409).
//  - Dos justificaciones iguales a la vez dejan UNA vigente; revertir permite justificar de nuevo.
// Un salto solo alerta: ninguna otra ruta se bloquea por él (D7, P-6).
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
  type FilaV,
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

const seed = (filas: FilaV[], o: { periodo?: string } = {}) =>
  v
    .cliente(E, {
      responsable: contador.id,
      colaboradores: [asistente.id, lectura.id],
    })
    .then(async (c) => {
      await v.sembrarVentas(E.tenantId, c.id, filas, {
        usuarioId: E.titular.id,
        ...o,
      });
      return c;
    });
const serieDe = (
  tipo: string,
  serie: string,
  numeros: (string | number)[],
): FilaV[] => numeros.map((n) => fila(serie, n, { tipo }));

const corr = (a: Actor, clienteId: string, periodo = "202610") =>
  v.llamar(a, "GET", `${base(clienteId, periodo)}/correlatividad`);
const justificar = (
  a: Actor,
  clienteId: string,
  cuerpo: unknown,
  periodo = "202610",
) =>
  v.llamar(
    a,
    "POST",
    `${base(clienteId, periodo)}/saltos-justificados`,
    cuerpo,
  );
const revertir = (
  a: Actor,
  clienteId: string,
  id: string,
  periodo = "202610",
) =>
  v.llamar(
    a,
    "DELETE",
    `${base(clienteId, periodo)}/saltos-justificados/${id}`,
  );
const J = (extra: Record<string, unknown> = {}) => ({
  tipo: "03",
  serie: "B001",
  desde: 291,
  hasta: 291,
  comentario: "Boleta anulada en caja",
  ...extra,
});
const serie = (r: { body: any }, tipo: string, s: string) =>
  (r.body.series as any[]).find((x) => x.tipo === tipo && x.serie === s);

describe("GET correlatividad (CA-6): la boleta 291 y el resto de casos", () => {
  it("B001-290 y B001-292: falta la 291 (un faltante pendiente, de un solo número)", async () => {
    const c = await seed([fila("B001", 290), fila("B001", 292)]);
    const r = await corr(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({
      series: [
        {
          tipo: "03",
          serie: "B001",
          estado: "con_faltantes",
          faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
          noEvaluables: 0,
        },
      ],
    });
  });

  it("varias series: completa, con rangos, tipos separados, no evaluable y un salto enorme sin expandir", async () => {
    const c = await seed([
      ...serieDe("03", "B001", [290, 292]),
      ...serieDe("01", "F001", [10, 11, 12]), // completa
      ...serieDe("03", "B003", [400, 401, 405]), // falta 402 a 404
      ...serieDe("03", "S002", [1, 3, 6]), // faltan 2 y 4 a 5
      ...serieDe("03", "F001", [5, 7]), // mismo nombre de serie, otro tipo: se evalúa aparte
      ...serieDe("03", "N001", ["ABC", "123456789"]), // no evaluables
      ...serieDe("03", "B009", [1, 99999999]), // 99.999.998 números entre medias
    ]);
    const t0 = Date.now();
    const r = await corr(contador, c.id);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.text.length, "el salto enorme no se expande").toBeLessThan(5000);
    expect(r.body).toEqual({
      series: [
        {
          tipo: "01",
          serie: "F001",
          estado: "completa",
          faltantes: [],
          noEvaluables: 0,
        },
        {
          tipo: "03",
          serie: "B001",
          estado: "con_faltantes",
          faltantes: [{ desde: 291, hasta: 291, estado: "pendiente" }],
          noEvaluables: 0,
        },
        {
          tipo: "03",
          serie: "B003",
          estado: "con_faltantes",
          faltantes: [{ desde: 402, hasta: 404, estado: "pendiente" }],
          noEvaluables: 0,
        },
        {
          tipo: "03",
          serie: "B009",
          estado: "con_faltantes",
          faltantes: [{ desde: 2, hasta: 99999998, estado: "pendiente" }],
          noEvaluables: 0,
        },
        {
          tipo: "03",
          serie: "F001",
          estado: "con_faltantes",
          faltantes: [{ desde: 6, hasta: 6, estado: "pendiente" }],
          noEvaluables: 0,
        },
        {
          tipo: "03",
          serie: "N001",
          estado: "no_evaluable",
          faltantes: [],
          noEvaluables: 2,
        },
        {
          tipo: "03",
          serie: "S002",
          estado: "con_faltantes",
          faltantes: [
            { desde: 2, hasta: 2, estado: "pendiente" },
            { desde: 4, hasta: 5, estado: "pendiente" },
          ],
          noEvaluables: 0,
        },
      ],
    });
  });

  it("solo se revisa entre el menor y el mayor del periodo: la serie que empieza en el 5 no falta de 1 a 4; un solo número no falta nada", async () => {
    const c = await seed([
      ...serieDe("03", "B005", [5, 6, 7]),
      ...serieDe("03", "B006", [50]),
    ]);
    const r = await corr(contador, c.id);
    expect(serie(r, "03", "B005")).toMatchObject({
      estado: "completa",
      faltantes: [],
    });
    expect(serie(r, "03", "B006")).toMatchObject({
      estado: "completa",
      faltantes: [],
    });
  });

  it("el número con ceros a la izquierda cuenta como su valor (00291 cubre la 291)", async () => {
    const c = await seed([
      fila("B001", "00290"),
      fila("B001", "00291"),
      fila("B001", "00292"),
    ]);
    expect(serie(await corr(contador, c.id), "03", "B001")).toMatchObject({
      estado: "completa",
      faltantes: [],
    });
  });

  it("un periodo sin ventas: { series: [] }; otro periodo del cliente no se mezcla", async () => {
    const c = await seed([fila("B001", 290), fila("B001", 292)]);
    expect((await corr(contador, c.id, "202601")).body).toEqual({ series: [] });
    await seed([fila("B001", 1), fila("B001", 9)]); // otro cliente del estudio: no se mezcla
    expect(serie(await corr(contador, c.id), "03", "B001")!.faltantes).toEqual([
      { desde: 291, hasta: 291, estado: "pendiente" },
    ]);
  });

  it("la respuesta no lleva ninguna bandera de bloqueo (un salto solo alerta, D7)", async () => {
    const c = await seed([fila("B001", 290), fila("B001", 292)]);
    const r = await corr(contador, c.id);
    expect(Object.keys(r.body)).toEqual(["series"]);
    for (const s of r.body.series)
      expect(Object.keys(s).sort()).toEqual([
        "estado",
        "faltantes",
        "noEvaluables",
        "serie",
        "tipo",
      ]);
    expect(r.text).not.toMatch(/bloque|block/i);
  });

  it("con un salto pendiente ninguna otra ruta se bloquea: leer, resumir, descargar y agregar siguen respondiendo", async () => {
    const c = await seed([fila("B001", 290), fila("B001", 292)]);
    const p = base(c.id);
    expect((await v.llamar(contador, "GET", p)).status).toBe(200);
    expect((await v.llamar(contador, "GET", `${p}/resumen`)).status).toBe(200);
    expect((await v.llamar(contador, "GET", `${p}/propuestas`)).status).toBe(
      200,
    );
    expect((await v.llamar(contador, "POST", `${p}/descargar`)).status).toBe(
      202,
    );
    const nueva = await v.llamar(contador, "POST", p, cuerpoVenta("B001", 300));
    expect(nueva.status, nueva.text).toBe(201);
    expect(
      (await v.llamar(contador, "DELETE", `${p}/${nueva.body.id}`)).status,
    ).toBe(204);
    expect(
      (await v.llamar(contador, "GET", `${p}/correlatividad`)).status,
    ).toBe(200);
  });
});

describe("CA-7 · justificar la 291", () => {
  it("201 con el rango y el comentario; la correlatividad la muestra «justificado» con su comentario y la fila queda a nombre de quien la hizo", async () => {
    const c = await seed([
      ...serieDe("03", "B001", [290, 292]),
      ...serieDe("03", "B003", [400, 401, 405]),
    ]);
    const r = await justificar(contador, c.id, J());
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({
      tipo: "03",
      serie: "B001",
      desde: 291,
      hasta: 291,
      comentario: "Boleta anulada en caja",
    });
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const g = await corr(contador, c.id);
    expect(serie(g, "03", "B001")!.faltantes).toEqual([
      {
        desde: 291,
        hasta: 291,
        estado: "justificado",
        comentario: "Boleta anulada en caja",
      },
    ]);
    // La otra serie sigue alertando.
    expect(serie(g, "03", "B003")!.faltantes).toEqual([
      { desde: 402, hasta: 404, estado: "pendiente" },
    ]);

    const filas = await v.saltos(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.id,
      tipo: "03",
      serie: "B001",
      desde: 291,
      hasta: 291,
      comentario: "Boleta anulada en caja",
      usuario_id: contador.id,
      revertido_por: null,
      revertido_en: null,
    });
  });

  it("justificar no agrega ni cambia ventas", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const antes = await v.ventas(c.id);
    expect((await justificar(contador, c.id, J())).status).toBe(201);
    expect(await v.ventas(c.id)).toEqual(antes);
    expect((await v.conteo(c.id)).propuestas).toBe(1);
  });

  it("una justificación del periodo 202610 no cubre el mismo faltante de 202609", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    await v.sembrarVentas(E.tenantId, c.id, serieDe("03", "B001", [290, 292]), {
      usuarioId: E.titular.id,
      periodo: "202609",
    });
    expect((await justificar(contador, c.id, J())).status).toBe(201);
    expect(
      serie(await corr(contador, c.id, "202609"), "03", "B001")!.faltantes,
    ).toEqual([{ desde: 291, hasta: 291, estado: "pendiente" }]);
  });

  it("parcial: cubrir solo el 402 deja el faltante 402 a 404 «parcial» (rango completo); cubrir el resto lo deja «justificado»", async () => {
    const c = await seed(serieDe("03", "B003", [400, 401, 405]));
    expect(
      (
        await justificar(
          contador,
          c.id,
          J({ serie: "B003", desde: 402, hasta: 402 }),
        )
      ).status,
    ).toBe(201);
    let f = serie(await corr(contador, c.id), "03", "B003")!.faltantes;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ desde: 402, hasta: 404, estado: "parcial" });
    expect(
      (
        await justificar(
          contador,
          c.id,
          J({ serie: "B003", desde: 403, hasta: 404 }),
        )
      ).status,
    ).toBe(201);
    f = serie(await corr(contador, c.id), "03", "B003")!.faltantes;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      desde: 402,
      hasta: 404,
      estado: "justificado",
    });
  });

  it("un rango dentro de un hueco más grande se acepta (justificar 403 a 404 de 402 a 404)", async () => {
    const c = await seed(serieDe("03", "B003", [400, 401, 405]));
    expect(
      (
        await justificar(
          contador,
          c.id,
          J({ serie: "B003", desde: 403, hasta: 404 }),
        )
      ).status,
    ).toBe(201);
  });

  describe("comentario y forma del cuerpo: 400 solicitud_invalida y no se escribe nada", () => {
    const MALOS: Array<[string, Record<string, unknown>]> = [
      ["sin comentario", { comentario: undefined }],
      ["comentario vacío", { comentario: "" }],
      ["comentario de solo espacios", { comentario: "   " }],
      ["comentario de 501 caracteres", { comentario: "x".repeat(501) }],
      ["comentario que no es texto", { comentario: 5 }],
      ["desde mayor que hasta", { desde: 295, hasta: 291 }],
      ["desde 0", { desde: 0, hasta: 291 }],
      ["número de más de 8 dígitos", { desde: 291, hasta: 100000000 }],
      ["desde decimal", { desde: 291.5, hasta: 292 }],
      ["desde como texto", { desde: "291", hasta: 291 }],
      ["tipo de un dígito", { tipo: "3" }],
      ["serie de 5 caracteres", { serie: "B0011" }],
      ["sin serie", { serie: undefined }],
    ];
    it.each(MALOS)("%s", async (_n, extra) => {
      const c = await seed(serieDe("03", "B001", [290, 292]));
      const r = await justificar(contador, c.id, J(extra));
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(await v.saltos(c.id)).toHaveLength(0);
    });

    it("el comentario de 500 caracteres es el borde permitido", async () => {
      const c = await seed(serieDe("03", "B001", [290, 292]));
      const r = await justificar(
        contador,
        c.id,
        J({ comentario: "x".repeat(500) }),
      );
      expect(r.status, r.text).toBe(201);
    });

    it("un cuerpo con claves de más no cambia quién justifica ni el estudio (se descartan)", async () => {
      const c = await seed(serieDe("03", "B001", [290, 292]));
      const r = await justificar(
        contador,
        c.id,
        J({
          usuarioId: E.titular.id,
          tenantId: randomUUID(),
          clienteId: randomUUID(),
          revertidoEn: "2026-01-01",
        }),
      );
      expect(r.status, r.text).toBe(201);
      const [f] = await v.saltos(c.id);
      expect(f).toMatchObject({ usuario_id: contador.id, revertido_en: null });
    });
  });

  describe("un rango que no está dentro de un faltante actual es 400 y no se escribe nada", () => {
    const FUERA: Array<[string, Record<string, unknown>]> = [
      ["un número presente (290)", { desde: 290, hasta: 290 }],
      [
        "un rango que cruza un presente (291 a 292)",
        { desde: 291, hasta: 292 },
      ],
      ["antes del menor (289)", { desde: 289, hasta: 289 }],
      ["después del mayor (293)", { desde: 293, hasta: 295 }],
      ["una serie que no existe", { serie: "X999" }],
      ["un tipo que no corresponde a la serie", { tipo: "01" }],
    ];
    it.each(FUERA)("%s", async (_n, extra) => {
      const c = await seed(serieDe("03", "B001", [290, 292]));
      const r = await justificar(contador, c.id, J(extra));
      expect(r.status, r.text).toBe(400);
      expect(typeof r.body.codigo).toBe("string");
      expect(await v.saltos(c.id)).toHaveLength(0);
    });

    it("tras justificar la 291, volver a pedirla sigue siendo válido (idempotente) o es un conflicto, nunca un 500", async () => {
      const c = await seed(serieDe("03", "B001", [290, 292]));
      expect((await justificar(contador, c.id, J())).status).toBe(201);
      const otra = await justificar(contador, c.id, J());
      expect([201, 400, 409], otra.text).toContain(otra.status);
      expect(
        (await v.saltos(c.id)).filter((s) => s.revertido_en === null),
      ).toHaveLength(1);
    });
  });

  it("dos justificaciones iguales a la vez dejan una sola vigente (10 rondas)", async () => {
    const c = await seed(
      Array.from({ length: 10 }, (_, i) =>
        serieDe("03", `S10${i}`, [1, 3]),
      ).flat(),
    );
    for (let i = 0; i < 10; i++) {
      const cuerpo = J({ serie: `S10${i}`, desde: 2, hasta: 2 });
      const rs = await Promise.all([
        justificar(contador, c.id, cuerpo),
        justificar(asistente, c.id, cuerpo),
      ]);
      const estados = rs.map((r) => r.status);
      for (const s of estados)
        expect([201, 409], `ronda ${i}: ${estados}`).toContain(s);
      expect(estados, `ronda ${i}`).toContain(201);
      const vigentes = (await v.saltos(c.id)).filter(
        (s) => s.serie === `S10${i}` && s.revertido_en === null,
      );
      expect(vigentes, `ronda ${i}`).toHaveLength(1);
    }
  });
});

describe("revertir una justificación (HU-12)", () => {
  it("204: la fila queda con quién y cuándo, el salto vuelve a alertar y se puede justificar de nuevo", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const j = await justificar(contador, c.id, J());
    const r = await revertir(asistente, c.id, j.body.id);
    expect(r.status, r.text).toBe(204);
    const [f] = await v.saltos(c.id);
    expect(f).toMatchObject({
      id: j.body.id,
      revertido_por: asistente.id,
      comentario: "Boleta anulada en caja",
    });
    expect(f.revertido_en).not.toBeNull();
    expect(serie(await corr(contador, c.id), "03", "B001")!.faltantes).toEqual([
      { desde: 291, hasta: 291, estado: "pendiente" },
    ]);

    const de_nuevo = await justificar(
      contador,
      c.id,
      J({ comentario: "Segunda vez" }),
    );
    expect(de_nuevo.status, de_nuevo.text).toBe(201);
    const filas = await v.saltos(c.id);
    expect(filas).toHaveLength(2);
    expect(filas.filter((s) => s.revertido_en === null)).toHaveLength(1);
    expect(
      serie(await corr(contador, c.id), "03", "B001")!.faltantes[0],
    ).toMatchObject({
      estado: "justificado",
      comentario: "Segunda vez",
    });
  });

  it("revertir dos veces la misma, un id inexistente o el de otro cliente: 404 (o 409 la repetida) y no cambia nada", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const otro = await seed(serieDe("03", "B001", [290, 292]));
    const jOtro = await justificar(contador, otro.id, J());
    const j = await justificar(contador, c.id, J());
    expect((await revertir(contador, c.id, j.body.id)).status).toBe(204);
    const repetida = await revertir(contador, c.id, j.body.id);
    expect([404, 409]).toContain(repetida.status);
    expect((await revertir(contador, c.id, randomUUID())).status).toBe(404);
    expect((await revertir(contador, c.id, "no-es-uuid")).status).toBe(404);
    // El id de la justificación de OTRO cliente no se puede revertir por la ruta de este.
    expect((await revertir(contador, c.id, jOtro.body.id)).status).toBe(404);
    const [fOtro] = await v.saltos(otro.id);
    expect(fOtro.revertido_en).toBeNull();
  });

  it("revertir una justificación de otro periodo por la ruta de este periodo es 404", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const j = await justificar(contador, c.id, J());
    expect((await revertir(contador, c.id, j.body.id, "202609")).status).toBe(
      404,
    );
    expect((await v.saltos(c.id))[0]!.revertido_en).toBeNull();
  });
});

describe("D5 · permisos y alcance (sire.clasificar)", () => {
  it("el asistente asignado puede justificar (tiene sire.clasificar); lectura recibe 403 permiso_denegado, también con cuerpo inválido, y no escribe", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const ok = await justificar(asistente, c.id, J());
    expect(ok.status, ok.text).toBe(201);
    for (const cuerpo of [J({ desde: 292, hasta: 292 }), { comentario: "" }]) {
      const r = await justificar(lectura, c.id, cuerpo);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    const rev = await revertir(lectura, c.id, ok.body.id);
    expect(rev.status).toBe(403);
    expect(rev.body).toEqual({ codigo: "permiso_denegado" });
    const filas = await v.saltos(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.revertido_en).toBeNull();
  });

  it("el contador no asignado recibe el mismo 404 que un cliente inexistente y no escribe", async () => {
    const ajeno = await v.cliente(E); // sin responsable ni colaboradores
    await v.sembrarVentas(
      E.tenantId,
      ajeno.id,
      serieDe("03", "B001", [290, 292]),
      {
        usuarioId: E.titular.id,
      },
    );
    expect((await justificar(E.titular, ajeno.id, J())).status).toBe(201); // control: la ruta existe
    const r = await justificar(contador, ajeno.id, J());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(
      forma(await justificar(contador, randomUUID(), J())),
    );
    expect(await v.saltos(ajeno.id)).toHaveLength(1); // solo la del control
  });

  it("la correlatividad la lee quien tiene clientes.ver y alcance (lectura colaborador sí; sin asignar, 404)", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    expect((await corr(lectura, c.id)).status).toBe(200);
    const ajeno = await v.cliente(E);
    expect((await corr(E.titular, ajeno.id)).status).toBe(200); // control
    const r = await corr(lectura, ajeno.id);
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(await corr(lectura, randomUUID())));
  });

  it("cliente archivado: justificar y revertir dan 409 cliente_archivado y no escriben; la correlatividad se puede leer", async () => {
    const c = await seed(serieDe("03", "B001", [290, 292]));
    const j = await justificar(contador, c.id, J());
    expect(j.status).toBe(201);
    expect(
      (await v.b.c.p.b.llamar(E.titular, "POST", `/clientes/${c.id}/archivar`))
        .status,
    ).toBe(200);
    const nuevo = await justificar(contador, c.id, J({ comentario: "otra" }));
    expect(nuevo.status).toBe(409);
    expect(nuevo.body).toEqual({ codigo: "cliente_archivado" });
    const rev = await revertir(contador, c.id, j.body.id);
    expect(rev.status).toBe(409);
    expect(rev.body).toEqual({ codigo: "cliente_archivado" });
    const filas = await v.saltos(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.revertido_en).toBeNull();
    expect((await corr(contador, c.id)).status).toBe(200);
  });
});

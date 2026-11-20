// Spec 024 (T3, rojo): consultas de la bandeja y del detalle de atención contra la BD real (CA-1, CA-2, D-2 a D-4, D-12).
// Estudio sembrado con 120 clientes (archivados, responsable y colaborador), mensajes con fechas repetidas al microsegundo, las
// cinco categorías, leídos y no, y los estados pendiente, atendido, histórico y atendido + histórico. Todo se compara con un
// oráculo en memoria (soporte-prueba.ts). Las pruebas solo leen; las que cambian datos (atender o desasignar a mitad del
// recorrido) usan su propio estudio. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T7 en `packages/db/src/buzon/bandeja.ts`; todo con la `tx` de withTenant):
//   listarBandeja(tx, alcance, filtros, posicion | null, limite) -> { filas: FilaBandeja[], hayMas: boolean }
//     alcance: { tipo: "global" } | { tipo: "asignado", usuarioId }  (el de 005; también se aplica con `clienteId`).
//     filtros: { clienteId?, responsableId?, categoria? (una de las cinco o "criticos"), leido?: boolean, atencion? ("pendientes" |
//       "atendidos" | "historicos" | "todos", por omisión "todos"), desde?, hasta? ("AAAA-MM-DD", días de Lima, inclusive),
//       archivados?: boolean }.
//       - sin `archivados` y sin `clienteId`, los clientes archivados no aportan filas; con `clienteId` (bandeja fijada) el cliente
//         se muestra aunque esté archivado, y uno fuera del alcance no devuelve nada;
//       - `responsableId`: «solo donde soy responsable»: clientes con asignación `responsable` de esa persona, sea cual sea el alcance;
//       - estado de atención como partición (la misma de `atencion.estado`): atendido si tiene `atendido_en`; si no, histórico si
//         `historico`; si no, pendiente. «pendientes» = pendiente; «atendidos» = atendido (histórico o no); «historicos» = histórico
//         sin atender; «todos» = todos.
//     posicion: null para la primera página, o { fecha: <fechaTexto de la última fila>, id } (valor, no desplazamiento).
//     limite: número de filas de la página (≥ 1); `hayMas` es true si queda al menos una más.
//     orden fijo: fecha descendente e id descendente.
//     FilaBandeja = MensajeBuzonFila (023) + `fechaTexto` (texto UTC con microsegundos `AAAA-MM-DDTHH:MI:SS.UUUUUUZ`, producido por la
//       BD sin pasar por Date) + `cliente: { id, razonSocial, archivado }` + `atencion: { estado, por: { id, nombre } | null,
//       en: Date | null }`.
//   detalleAtencion(tx, mensajeId) -> { estado, por, en, comentario, historial } | null
//     `comentario` es el del último evento `atendido` mientras el mensaje siga atendido (null si no); `historial`, todos los eventos
//     en orden cronológico (creado_en, id) con `accion` ("atendido" | "deshecho"), `comentario`, `usuario: { id, nombre }` y `en`.
//     Mensaje inexistente o de otro estudio (RLS): null.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "../client";
import {
  detalleAtencion,
  listarBandeja,
  type FiltrosBandejaBuzon,
  type PosicionBandeja,
} from "./bandeja";
import {
  abrirAdmin,
  abrirBackend,
  atenderDirecto,
  desasignarDirecto,
  estadoDe,
  exigirEntorno,
  oraculoBandeja,
  porBandeja,
  sembrarEstudio,
  type Alcance,
  type Estudio,
  type FiltrosBandeja,
  type MensajeSembrado,
} from "./soporte-prueba";

let admin: Pool;
let db: ContappDb;
let A: Estudio; // estudio principal (solo lectura)
let B: Estudio; // otro estudio: nunca debe verse desde A
const limpiezas: Array<() => Promise<void>> = [];

beforeAll(async () => {
  exigirEntorno();
  admin = abrirAdmin();
  db = abrirBackend();
  A = await sembrarEstudio(admin, { clientes: 120, semilla: 1 });
  limpiezas.push(A.limpiar);
  B = await sembrarEstudio(admin, { clientes: 20, semilla: 99 });
  limpiezas.push(B.limpiar);
}, 120_000);

afterAll(async () => {
  for (const l of limpiezas) await l().catch(() => undefined);
  await db?.close();
  await admin?.end();
});

const GLOBAL: Alcance = { tipo: "global" };
const asignado = (e: Estudio): Alcance => ({
  tipo: "asignado",
  usuarioId: e.contador.id,
});

/** Todas las páginas de la bandeja (límite `limite`) como el usuario `usuarioId` del estudio `e`. */
async function recorrer(
  e: Estudio,
  usuarioId: string,
  alcance: Alcance,
  filtros: FiltrosBandeja,
  limite = 50,
): Promise<{
  filas: Awaited<ReturnType<typeof listarBandeja>>["filas"];
  paginas: number;
}> {
  const filas: Awaited<ReturnType<typeof listarBandeja>>["filas"] = [];
  let posicion: PosicionBandeja | null = null;
  let paginas = 0;
  for (;;) {
    const p = await db.withTenant(
      { tenantId: e.tenantId, userId: usuarioId },
      (tx) =>
        listarBandeja(
          tx,
          alcance,
          filtros as FiltrosBandejaBuzon,
          posicion,
          limite,
        ),
    );
    paginas++;
    filas.push(...p.filas);
    if (!p.hayMas) return { filas, paginas };
    expect(
      p.filas.length,
      "una página con hayMas trae exactamente `limite` filas",
    ).toBe(limite);
    const ultima = p.filas[p.filas.length - 1]!;
    posicion = { fecha: ultima.fechaTexto, id: ultima.id };
    if (paginas > 2000) throw new Error("la paginación no termina");
  }
}

const usuarioDe = (e: Estudio, a: Alcance): string =>
  a.tipo === "global" ? e.dueno.id : a.usuarioId;

// ---- Tabla de casos (CA-2): cada filtro solo y combinaciones ------------------------------------------------------------------
interface Caso {
  nombre: string;
  filtros: (e: Estudio, a: Alcance) => FiltrosBandeja;
}
const caso = (
  nombre: string,
  filtros: FiltrosBandeja | ((e: Estudio, a: Alcance) => FiltrosBandeja),
): Caso => ({
  nombre,
  filtros: typeof filtros === "function" ? filtros : () => filtros,
});

const CASOS: Caso[] = [
  caso("sin filtros (clientes no archivados)", {}),
  caso("incluir archivados", { archivados: true }),
  caso("categoria coactiva", { categoria: "coactiva" }),
  caso("categoria resolucion_determinacion", {
    categoria: "resolucion_determinacion",
  }),
  caso("categoria resolucion_multa", { categoria: "resolucion_multa" }),
  caso("categoria requerimiento_fiscalizacion", {
    categoria: "requerimiento_fiscalizacion",
  }),
  caso("categoria otro", { categoria: "otro" }),
  caso("todos los críticos", { categoria: "criticos" }),
  caso("leído en SUNAT", { leido: true }),
  caso("no leído en SUNAT", { leido: false }),
  caso("atención pendientes", { atencion: "pendientes" }),
  caso("atención atendidos", { atencion: "atendidos" }),
  caso("atención históricos", { atencion: "historicos" }),
  caso("atención todos", { atencion: "todos" }),
  caso("solo desde", { desde: "2026-11-10" }),
  caso("solo hasta", { hasta: "2026-11-10" }),
  caso("desde y hasta", { desde: "2026-11-05", hasta: "2026-11-12" }),
  caso("un solo día de Lima", { desde: "2026-11-10", hasta: "2026-11-10" }),
  caso("solo donde soy responsable", (e, a) => ({
    responsableId: usuarioDe(e, a),
  })),
  caso("responsable e incluir archivados", (e, a) => ({
    responsableId: usuarioDe(e, a),
    archivados: true,
  })),
  caso("bandeja fijada en un cliente activo", (e) => ({
    clienteId: e.clientes[1]!.id,
  })),
  caso(
    "bandeja fijada en un cliente archivado (sin incluir archivados)",
    (e) => ({
      clienteId: e.clientes[9]!.id,
    }),
  ),
  caso("bandeja fijada en un cliente archivado con atención todos", (e) => ({
    clienteId: e.clientes[18]!.id,
    atencion: "todos",
  })),
  caso("críticos pendientes", {
    categoria: "criticos",
    atencion: "pendientes",
  }),
  caso("críticos pendientes no leídos", {
    categoria: "criticos",
    atencion: "pendientes",
    leido: false,
  }),
  caso("coactiva atendidos desde una fecha", {
    categoria: "coactiva",
    atencion: "atendidos",
    desde: "2026-11-01",
  }),
  caso("resolucion_multa históricos leídos con archivados", {
    categoria: "resolucion_multa",
    atencion: "historicos",
    leido: true,
    archivados: true,
  }),
  caso("pendientes de un rango con archivados", {
    atencion: "pendientes",
    desde: "2026-11-09",
    hasta: "2026-11-15",
    archivados: true,
  }),
  caso("responsable, críticos y pendientes", (e, a) => ({
    responsableId: usuarioDe(e, a),
    categoria: "criticos",
    atencion: "pendientes",
  })),
  caso("responsable, no leídos, otro, desde y hasta", (e, a) => ({
    responsableId: usuarioDe(e, a),
    categoria: "otro",
    leido: false,
    desde: "2026-10-25",
    hasta: "2026-11-18",
  })),
  caso("cliente fijado, críticos y atendidos", (e) => ({
    clienteId: e.clientes[2]!.id,
    categoria: "criticos",
    atencion: "atendidos",
  })),
  caso("cliente fijado con los cinco bordes de Lima", (e) => ({
    clienteId: e.clientes[1]!.id,
    desde: "2026-11-10",
    hasta: "2026-11-10",
    atencion: "pendientes",
  })),
  caso("todos los filtros a la vez", (e, a) => ({
    responsableId: usuarioDe(e, a),
    categoria: "criticos",
    leido: false,
    atencion: "todos",
    desde: "2026-10-20",
    hasta: "2026-11-19",
    archivados: true,
  })),
];

const ALCANCES: Array<[string, (e: Estudio) => Alcance]> = [
  ["alcance global", () => GLOBAL],
  ["asignado a 15 clientes", asignado],
];

describe("listarBandeja contra el oráculo en memoria (CA-1, CA-2)", () => {
  it("la tabla de casos tiene al menos 30 combinaciones por alcance", () => {
    expect(CASOS.length).toBeGreaterThanOrEqual(30);
  });

  it("el oráculo no es trivial: hay filas de cada estado, categoría y de clientes archivados", () => {
    const todos = oraculoBandeja(A, GLOBAL, { archivados: true });
    expect(todos.length).toBeGreaterThan(400);
    for (const est of ["pendiente", "atendido", "historico"] as const)
      expect(
        todos.some((m) => estadoDe(m) === est),
        est,
      ).toBe(true);
    expect(todos.some((m) => m.atendidoEn !== null && m.historico)).toBe(true);
    for (const c of [
      "coactiva",
      "resolucion_determinacion",
      "resolucion_multa",
      "requerimiento_fiscalizacion",
      "otro",
    ])
      expect(
        todos.some((m) => m.categoria === c),
        c,
      ).toBe(true);
    expect(todos.some((m) => m.categoria === "otro" && m.critico)).toBe(true);
    expect(oraculoBandeja(A, GLOBAL).length).toBeLessThan(todos.length);
    expect(oraculoBandeja(A, asignado(A)).length).toBeGreaterThan(0);
    expect(oraculoBandeja(A, asignado(A)).length).toBeLessThan(
      oraculoBandeja(A, GLOBAL).length,
    );
  });

  for (const [nombreAlcance, alcanceDe] of ALCANCES) {
    describe(nombreAlcance, () => {
      it.each(CASOS.map((c) => [c.nombre, c] as const))(
        "%s: mismas filas, mismo orden y sin repetir",
        async (_n, c) => {
          const alcance = alcanceDe(A);
          const filtros = c.filtros(A, alcance);
          const esperado = oraculoBandeja(A, alcance, filtros);
          const { filas } = await recorrer(
            A,
            usuarioDe(A, alcance),
            alcance,
            filtros,
            50,
          );
          expect(filas.map((f) => f.id)).toEqual(esperado.map((m) => m.id));
          expect(new Set(filas.map((f) => f.id)).size).toBe(filas.length);
        },
      );
    });
  }

  it("los clientes de otro estudio nunca aparecen, ni siquiera fijándolos", async () => {
    const idsB = new Set(B.clientes.map((c) => c.id));
    const mensajesB = new Set(B.mensajes.map((m) => m.id));
    const { filas } = await recorrer(A, A.dueno.id, GLOBAL, {
      archivados: true,
      atencion: "todos",
    });
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(idsB.has(f.cliente.id)).toBe(false);
      expect(mensajesB.has(f.id)).toBe(false);
    }
    const fijado = await recorrer(A, A.dueno.id, GLOBAL, {
      clienteId: B.clientes[1]!.id,
    });
    expect(fijado.filas).toEqual([]);
  });

  it("el Contador asignado a 15 de 120 solo ve mensajes de esos 15 clientes; fijar uno que no es suyo no devuelve nada", async () => {
    const suyos = new Set(
      A.clientes.filter((c) => c.asignados.has(A.contador.id)).map((c) => c.id),
    );
    expect(suyos.size).toBe(15);
    const { filas } = await recorrer(A, A.contador.id, asignado(A), {
      archivados: true,
    });
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas)
      expect(suyos.has(f.cliente.id), f.cliente.id).toBe(true);
    const ajeno = A.clientes.find(
      (c) =>
        !suyos.has(c.id) &&
        !c.archivado &&
        A.mensajes.some((m) => m.clienteId === c.id),
    )!;
    const r = await recorrer(A, A.contador.id, asignado(A), {
      clienteId: ajeno.id,
      atencion: "todos",
    });
    expect(r.filas).toEqual([]);
  });

  it("el Dueño ve a los 120 clientes: todos los que tienen mensajes aparecen con «incluir archivados»", async () => {
    const { filas } = await recorrer(A, A.dueno.id, GLOBAL, {
      archivados: true,
    });
    const conMensajes = new Set(A.mensajes.map((m) => m.clienteId));
    expect(new Set(filas.map((f) => f.cliente.id))).toEqual(conMensajes);
    expect(conMensajes.size).toBeGreaterThan(80);
  });

  it("«solo donde soy responsable» deja solo esos clientes, también para quien tiene alcance global", async () => {
    const { filas } = await recorrer(A, A.dueno.id, GLOBAL, {
      responsableId: A.dueno.id,
      archivados: true,
    });
    expect(filas.length).toBeGreaterThan(0);
    const suyos = new Set(
      A.clientes.filter((c) => c.responsableId === A.dueno.id).map((c) => c.id),
    );
    for (const f of filas) expect(suyos.has(f.cliente.id)).toBe(true);
    const sinFiltro = await recorrer(A, A.dueno.id, GLOBAL, {
      archivados: true,
    });
    expect(filas.length).toBeLessThan(sinFiltro.filas.length);
  });

  it("el colaborador no cuenta como responsable: el Contador con «solo responsable» pierde los clientes impares", async () => {
    const { filas } = await recorrer(A, A.contador.id, asignado(A), {
      responsableId: A.contador.id,
      archivados: true,
    });
    const impares = new Set(
      A.clientes.filter((c) => c.idx < 15 && c.idx % 2 === 1).map((c) => c.id),
    );
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) expect(impares.has(f.cliente.id)).toBe(false);
  });
});

describe("campos de la fila (D-3, D-5)", () => {
  it("cada fila trae el mensaje, el cliente y la atención como en el modelo sembrado", async () => {
    const esperado = oraculoBandeja(A, GLOBAL, { archivados: true });
    const p = await db.withTenant(
      { tenantId: A.tenantId, userId: A.dueno.id },
      (tx) => listarBandeja(tx, GLOBAL, { archivados: true }, null, 100),
    );
    expect(p.filas).toHaveLength(100);
    expect(p.hayMas).toBe(true);
    const nombres = new Map([
      [A.dueno.id, A.dueno.nombre],
      [A.contador.id, A.contador.nombre],
    ]);
    p.filas.forEach((f, i) => {
      const m = esperado[i]!;
      const c = A.clientes.find((x) => x.id === m.clienteId)!;
      expect(f.id).toBe(m.id);
      expect(f.fechaTexto).toBe(m.fecha);
      expect(f.fecha.getTime()).toBe(Date.parse(m.fecha));
      expect(f.asunto).toBe(m.asunto);
      expect(f.remitente).toBe(m.remitente);
      expect(f.categoria).toBe(m.categoria);
      expect(f.critico).toBe(m.critico);
      expect(f.motivoCritico).toBe(m.motivo);
      expect(f.leidoEnSunat).toBe(m.leido);
      expect(f.contenidoObtenido).toBe(false);
      expect(f.adjuntosDeclarados).toBe(0);
      expect(f.cliente).toEqual({
        id: c.id,
        razonSocial: c.razonSocial,
        archivado: c.archivado,
      });
      expect(f.atencion.estado).toBe(estadoDe(m));
      if (m.atendidoEn === null) {
        expect(f.atencion.por).toBeNull();
        expect(f.atencion.en).toBeNull();
      } else {
        expect(f.atencion.por).toEqual({
          id: m.atendidoPor,
          nombre: nombres.get(m.atendidoPor!),
        });
        expect(f.atencion.en!.getTime()).toBe(Date.parse(m.atendidoEn));
      }
    });
  });

  it("no trae el contenido ni su ruta (solo si ya se obtuvo) ni nada de los adjuntos", async () => {
    const p = await db.withTenant(
      { tenantId: A.tenantId, userId: A.dueno.id },
      (tx) => listarBandeja(tx, GLOBAL, {}, null, 5),
    );
    for (const f of p.filas) {
      expect(Object.keys(f)).not.toContain("contenidoRuta");
      expect(Object.keys(f)).not.toContain("adjuntos");
    }
  });
});

describe("orden y paginación por valor (D-4)", () => {
  it("orden fecha descendente e id descendente, incluso con 12 mensajes de la misma fecha al microsegundo", async () => {
    const { filas } = await recorrer(A, A.dueno.id, GLOBAL, {
      archivados: true,
    });
    for (let i = 1; i < filas.length; i++) {
      const a = filas[i - 1]!;
      const b = filas[i]!;
      expect(
        a.fechaTexto >= b.fechaTexto,
        `${a.fechaTexto} antes de ${b.fechaTexto}`,
      ).toBe(true);
      if (a.fechaTexto === b.fechaTexto) expect(a.id > b.id).toBe(true);
    }
    const empate = filas.filter(
      (f) => f.fechaTexto === "2026-11-12T15:30:00.123456Z",
    );
    expect(empate.length).toBeGreaterThanOrEqual(12);
  });

  it("fechaTexto conserva los microsegundos (pares que solo difieren en el último dígito)", async () => {
    const { filas } = await recorrer(A, A.dueno.id, GLOBAL, {
      archivados: true,
    });
    const textos = new Set(filas.map((f) => f.fechaTexto));
    expect(textos.has("2026-11-05T22:00:00.000001Z")).toBe(true);
    expect(textos.has("2026-11-05T22:00:00.000002Z")).toBe(true);
    expect(textos.has("2026-11-10T15:30:00.123456Z")).toBe(true);
    expect(textos.has("2026-11-10T15:30:00.123457Z")).toBe(true);
  });

  it.each([
    [
      "global, todos, con archivados",
      () => GLOBAL,
      { archivados: true } as FiltrosBandeja,
    ],
    [
      "global, pendientes",
      () => GLOBAL,
      { atencion: "pendientes" } as FiltrosBandeja,
    ],
    [
      "asignado a 15, críticos pendientes",
      () => asignado(A),
      { categoria: "criticos", atencion: "pendientes" } as FiltrosBandeja,
    ],
  ])(
    "recorrer con límite 7 da cada fila una vez y en orden: %s",
    async (_n, alcanceDe, filtros) => {
      const alcance = alcanceDe();
      const esperado = oraculoBandeja(A, alcance, filtros);
      const { filas, paginas } = await recorrer(
        A,
        usuarioDe(A, alcance),
        alcance,
        filtros,
        7,
      );
      expect(filas.map((f) => f.id)).toEqual(esperado.map((m) => m.id));
      expect(paginas).toBe(Math.ceil(esperado.length / 7));
    },
  );

  it("hayMas es exacto: con tantas filas como el límite no queda otra página, con una menos sí", async () => {
    const cliente = A.clientes[1]!.id;
    const n = oraculoBandeja(A, GLOBAL, { clienteId: cliente }).length;
    expect(n).toBeGreaterThan(5);
    const ctx = { tenantId: A.tenantId, userId: A.dueno.id };
    const justo = await db.withTenant(ctx, (tx) =>
      listarBandeja(tx, GLOBAL, { clienteId: cliente }, null, n),
    );
    expect(justo.filas).toHaveLength(n);
    expect(justo.hayMas).toBe(false);
    const faltaUna = await db.withTenant(ctx, (tx) =>
      listarBandeja(tx, GLOBAL, { clienteId: cliente }, null, n - 1),
    );
    expect(faltaUna.filas).toHaveLength(n - 1);
    expect(faltaUna.hayMas).toBe(true);
    const mas = await db.withTenant(ctx, (tx) =>
      listarBandeja(tx, GLOBAL, { clienteId: cliente }, null, n + 10),
    );
    expect(mas.filas).toHaveLength(n);
    expect(mas.hayMas).toBe(false);
  });

  it("una posición que ya no corresponde a ninguna fila (valor) sigue siendo válida: continúa desde ese valor", async () => {
    const todas = oraculoBandeja(A, GLOBAL, {});
    const medio = todas[Math.floor(todas.length / 2)]!;
    const posicion = { fecha: medio.fecha, id: randomUUID() };
    const esperado = todas.filter(
      (m) => porBandeja(m, { ...medio, id: posicion.id }) > 0,
    );
    const p = await db.withTenant(
      { tenantId: A.tenantId, userId: A.dueno.id },
      (tx) => listarBandeja(tx, GLOBAL, {}, posicion, 1000),
    );
    expect(p.filas.map((f) => f.id)).toEqual(esperado.map((m) => m.id));
  });

  it("una posición posterior a todo devuelve todo lo del alcance y nada de fuera de él", async () => {
    const todas = oraculoBandeja(A, asignado(A), {});
    const primera = todas[0]!;
    const p = await db.withTenant(
      { tenantId: A.tenantId, userId: A.contador.id },
      (tx) =>
        listarBandeja(
          tx,
          asignado(A),
          {},
          { fecha: "2999-01-01T00:00:00.000000Z", id: primera.id },
          1000,
        ),
    );
    const suyos = new Set(
      A.clientes.filter((c) => c.asignados.has(A.contador.id)).map((c) => c.id),
    );
    expect(p.filas.map((f) => f.id)).toEqual(todas.map((m) => m.id));
    for (const f of p.filas) expect(suyos.has(f.cliente.id)).toBe(true);
  });
});

describe("días de Lima en desde y hasta (D-3)", () => {
  const filtro = (desde: string, hasta: string): FiltrosBandeja => ({
    clienteId: A.clientes[1]!.id,
    desde,
    hasta,
    atencion: "todos",
  });
  const ids = async (f: FiltrosBandeja) =>
    (await recorrer(A, A.dueno.id, GLOBAL, f)).filas.map((x) => x.id);

  it("un mensaje a las 23:30 de Lima (04:30Z del día siguiente) cae en su día de Lima", async () => {
    const dia10 = await ids(filtro("2026-11-10", "2026-11-10"));
    expect(dia10).toContain(A.bordes.limaDia10Noche);
    expect(dia10).toContain(A.bordes.limaDia10Inicio);
    expect(dia10).toContain(A.bordes.limaDia10Fin);
    expect(dia10).not.toContain(A.bordes.limaDia09Fin);
    expect(dia10).not.toContain(A.bordes.limaDia11Inicio);
  });

  it("hasta es inclusive hasta 23:59:59.999999 de Lima y desde empieza a las 00:00 de Lima", async () => {
    const dia09 = await ids(filtro("2026-11-09", "2026-11-09"));
    expect(dia09).toContain(A.bordes.limaDia09Fin);
    expect(dia09).not.toContain(A.bordes.limaDia10Inicio);
    const dia11 = await ids(filtro("2026-11-11", "2026-11-11"));
    expect(dia11).toContain(A.bordes.limaDia11Inicio);
    expect(dia11).not.toContain(A.bordes.limaDia10Fin);
    const desde10 = await ids({ ...filtro("2026-11-10", "2026-11-30") });
    expect(desde10).toContain(A.bordes.limaDia10Inicio);
    expect(desde10).not.toContain(A.bordes.limaDia09Fin);
    const hasta10 = await ids({
      clienteId: A.clientes[1]!.id,
      hasta: "2026-11-10",
      atencion: "todos",
    });
    expect(hasta10).toContain(A.bordes.limaDia10Fin);
    expect(hasta10).not.toContain(A.bordes.limaDia11Inicio);
  });
});

describe("estados y filtros de atención (D-12, U-2)", () => {
  it("pendientes, atendidos e históricos son una partición de «todos» por cliente visible", async () => {
    const tod = await recorrer(A, A.dueno.id, GLOBAL, {
      atencion: "todos",
      archivados: true,
    });
    const partes = await Promise.all(
      (["pendientes", "atendidos", "historicos"] as const).map((atencion) =>
        recorrer(A, A.dueno.id, GLOBAL, { atencion, archivados: true }),
      ),
    );
    const union = partes.flatMap((p) => p.filas.map((f) => f.id)).sort();
    expect(union).toEqual(tod.filas.map((f) => f.id).sort());
    for (const [i, estado] of (
      ["pendiente", "atendido", "historico"] as const
    ).entries())
      for (const f of partes[i]!.filas) expect(f.atencion.estado).toBe(estado);
  });

  it("un histórico atendido sale como atendido (no como histórico) y se lista en «atendidos»", async () => {
    const m = A.mensajes.find((x) => x.historico && x.atendidoEn !== null)!;
    const r = await recorrer(A, A.dueno.id, GLOBAL, {
      atencion: "atendidos",
      archivados: true,
      clienteId: m.clienteId,
    });
    expect(r.filas.find((f) => f.id === m.id)?.atencion.estado).toBe(
      "atendido",
    );
    const h = await recorrer(A, A.dueno.id, GLOBAL, {
      atencion: "historicos",
      archivados: true,
      clienteId: m.clienteId,
    });
    expect(h.filas.find((f) => f.id === m.id)).toBeUndefined();
  });

  it("leer la bandeja no modifica nada: dos lecturas seguidas dan lo mismo", async () => {
    const f: FiltrosBandeja = { atencion: "pendientes", categoria: "criticos" };
    const a = await recorrer(A, A.dueno.id, GLOBAL, f, 7);
    const b = await recorrer(A, A.dueno.id, GLOBAL, f, 7);
    expect(b.filas.map((x) => x.id)).toEqual(a.filas.map((x) => x.id));
  });
});

describe("cambios a mitad del recorrido (CA-2, CA-1)", () => {
  it("atender filas a mitad del recorrido no salta ni repite: lo ya visto no vuelve y lo atendido sin ver desaparece", async () => {
    const e = await sembrarEstudio(admin, { clientes: 40, semilla: 7 });
    limpiezas.push(e.limpiar);
    const filtros: FiltrosBandeja = {
      atencion: "pendientes",
      archivados: true,
    };
    const inicial = oraculoBandeja(e, GLOBAL, filtros);
    expect(inicial.length).toBeGreaterThan(40);
    const ctx = { tenantId: e.tenantId, userId: e.dueno.id };
    const vistas: string[] = [];
    let posicion: PosicionBandeja | null = null;
    for (let pagina = 0; ; pagina++) {
      const p = await db.withTenant(ctx, (tx) =>
        listarBandeja(tx, GLOBAL, filtros as FiltrosBandejaBuzon, posicion, 7),
      );
      vistas.push(...p.filas.map((f) => f.id));
      if (!p.hayMas) break;
      const ultima = p.filas[p.filas.length - 1]!;
      posicion = { fecha: ultima.fechaTexto, id: ultima.id };
      if (pagina === 2) {
        // Tras tres páginas (21 filas vistas): se atienden las ya vistas y una de cada tres de las que faltan.
        expect(vistas).toHaveLength(21);
        const faltan = inicial.slice(vistas.length);
        await atenderDirecto(
          admin,
          e,
          [
            ...vistas,
            ...faltan.filter((_m, i) => i % 3 === 0).map((m) => m.id),
          ],
          e.dueno.id,
        );
      }
    }
    expect(new Set(vistas).size, "ninguna fila repetida").toBe(vistas.length);
    const corte = vistas.slice(0, 21);
    expect(corte).toEqual(inicial.slice(0, 21).map((m) => m.id));
    const resto = vistas.slice(21);
    const restoEsperado = inicial
      .slice(21)
      .filter((_m, i) => i % 3 !== 0)
      .map((m) => m.id);
    expect(resto).toEqual(restoEsperado);
  }, 60_000);

  it("desasignar un cliente a mitad del recorrido lo saca de la página siguiente", async () => {
    const e = await sembrarEstudio(admin, { clientes: 40, semilla: 11 });
    limpiezas.push(e.limpiar);
    const alcance = asignado(e);
    const filtros: FiltrosBandeja = { atencion: "todos", archivados: true };
    const inicial = oraculoBandeja(e, alcance, filtros);
    const ctx = { tenantId: e.tenantId, userId: e.contador.id };
    const primera = await db.withTenant(ctx, (tx) =>
      listarBandeja(tx, alcance, filtros as FiltrosBandejaBuzon, null, 7),
    );
    expect(primera.hayMas).toBe(true);
    const ultima = primera.filas[primera.filas.length - 1]!;
    const posicion = { fecha: ultima.fechaTexto, id: ultima.id };
    // El cliente con más mensajes por ver tras la primera página.
    const restantes = inicial.slice(7);
    const cuenta = new Map<string, number>();
    for (const m of restantes)
      cuenta.set(m.clienteId, (cuenta.get(m.clienteId) ?? 0) + 1);
    const [quitado] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]!;
    await desasignarDirecto(admin, e, quitado, e.contador.id);
    const siguiente = await db.withTenant(ctx, (tx) =>
      listarBandeja(
        tx,
        alcance,
        filtros as FiltrosBandejaBuzon,
        posicion,
        1000,
      ),
    );
    const ids = siguiente.filas.map((f) => f.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(siguiente.filas.some((f) => f.cliente.id === quitado)).toBe(false);
    expect(ids).toEqual(
      restantes.filter((m) => m.clienteId !== quitado).map((m) => m.id),
    );
    // Y la bandeja fijada en ese cliente ya no devuelve nada.
    const fijada = await db.withTenant(ctx, (tx) =>
      listarBandeja(
        tx,
        alcance,
        { clienteId: quitado } as FiltrosBandejaBuzon,
        null,
        50,
      ),
    );
    expect(fijada.filas).toEqual([]);
  }, 60_000);
});

// ---- Detalle de atención ---------------------------------------------------------------------------------------------------
describe("detalleAtencion (D-5, CA-4, CA-5)", () => {
  const SIN_ATENDER = (e: Estudio): MensajeSembrado =>
    e.mensajes.find(
      (m) =>
        m.atendidoEn === null &&
        !m.historico &&
        m.clienteId === e.clientes[2]!.id,
    )!;

  async function evento(
    e: Estudio,
    m: MensajeSembrado,
    accion: "atendido" | "deshecho",
    usuarioId: string,
    en: string,
    comentario: string | null,
  ): Promise<void> {
    await admin.query(
      `insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, comentario, usuario_id, creado_en)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [e.tenantId, m.clienteId, m.id, accion, comentario, usuarioId, en],
    );
  }

  it("un mensaje sin atender: estado pendiente, sin comentario y sin historial", async () => {
    const m = SIN_ATENDER(A);
    const d = await db.withTenant(
      { tenantId: A.tenantId, userId: A.dueno.id },
      (tx) => detalleAtencion(tx, m.id),
    );
    expect(d).toEqual({
      estado: "pendiente",
      por: null,
      en: null,
      comentario: null,
      historial: [],
    });
  });

  it("un histórico sin atender: estado histórico", async () => {
    const m = A.mensajes.find((x) => x.historico && x.atendidoEn === null)!;
    const d = await db.withTenant(
      { tenantId: A.tenantId, userId: A.dueno.id },
      (tx) => detalleAtencion(tx, m.id),
    );
    expect(d?.estado).toBe("historico");
    expect(d?.por).toBeNull();
  });

  it("marcar, deshacer y volver a marcar: estado vigente, comentario del último «atendido» e historial en orden con nombres", async () => {
    const e = await sembrarEstudio(admin, { clientes: 12, semilla: 3 });
    limpiezas.push(e.limpiar);
    const m = SIN_ATENDER(e);
    await evento(
      e,
      m,
      "atendido",
      e.contador.id,
      "2026-11-19T10:00:00.000Z",
      "Se presentó el escrito",
    );
    await evento(
      e,
      m,
      "deshecho",
      e.dueno.id,
      "2026-11-19T11:00:00.000Z",
      "Falta adjuntar el cargo",
    );
    await evento(
      e,
      m,
      "atendido",
      e.dueno.id,
      "2026-11-19T12:00:00.000Z",
      "Cargo adjuntado",
    );
    await atenderDirecto(
      admin,
      e,
      [m.id],
      e.dueno.id,
      "2026-11-19T12:00:00.000Z",
    );
    const d = await db.withTenant(
      { tenantId: e.tenantId, userId: e.dueno.id },
      (tx) => detalleAtencion(tx, m.id),
    );
    expect(d).not.toBeNull();
    expect(d!.estado).toBe("atendido");
    expect(d!.por).toEqual({ id: e.dueno.id, nombre: e.dueno.nombre });
    expect(d!.en!.getTime()).toBe(Date.parse("2026-11-19T12:00:00.000Z"));
    expect(d!.comentario).toBe("Cargo adjuntado");
    expect(
      d!.historial.map((x) => [
        x.accion,
        x.comentario,
        x.usuario.id,
        x.usuario.nombre,
        x.en.toISOString(),
      ]),
    ).toEqual([
      [
        "atendido",
        "Se presentó el escrito",
        e.contador.id,
        e.contador.nombre,
        "2026-11-19T10:00:00.000Z",
      ],
      [
        "deshecho",
        "Falta adjuntar el cargo",
        e.dueno.id,
        e.dueno.nombre,
        "2026-11-19T11:00:00.000Z",
      ],
      [
        "atendido",
        "Cargo adjuntado",
        e.dueno.id,
        e.dueno.nombre,
        "2026-11-19T12:00:00.000Z",
      ],
    ]);
  }, 60_000);

  it("tras deshacer, el comentario vigente es null pero el historial conserva los comentarios (eventos sin comentario incluidos)", async () => {
    const e = await sembrarEstudio(admin, { clientes: 12, semilla: 4 });
    limpiezas.push(e.limpiar);
    const m = SIN_ATENDER(e);
    await evento(
      e,
      m,
      "atendido",
      e.contador.id,
      "2026-11-19T10:00:00.000Z",
      "Comentario de la marca",
    );
    await evento(
      e,
      m,
      "deshecho",
      e.contador.id,
      "2026-11-19T10:30:00.000Z",
      null,
    );
    const d = await db.withTenant(
      { tenantId: e.tenantId, userId: e.dueno.id },
      (tx) => detalleAtencion(tx, m.id),
    );
    expect(d!.estado).toBe("pendiente");
    expect(d!.comentario).toBeNull();
    expect(d!.historial.map((x) => [x.accion, x.comentario])).toEqual([
      ["atendido", "Comentario de la marca"],
      ["deshecho", null],
    ]);
  }, 60_000);

  it("un comentario con HTML se devuelve tal cual (texto), sin interpretarlo", async () => {
    const e = await sembrarEstudio(admin, { clientes: 12, semilla: 5 });
    limpiezas.push(e.limpiar);
    const m = SIN_ATENDER(e);
    const html = "<img src=x onerror=alert(1)> & <b>fuerte</b>";
    await evento(
      e,
      m,
      "atendido",
      e.dueno.id,
      "2026-11-19T10:00:00.000Z",
      html,
    );
    await atenderDirecto(
      admin,
      e,
      [m.id],
      e.dueno.id,
      "2026-11-19T10:00:00.000Z",
    );
    const d = await db.withTenant(
      { tenantId: e.tenantId, userId: e.dueno.id },
      (tx) => detalleAtencion(tx, m.id),
    );
    expect(d!.comentario).toBe(html);
    expect(d!.historial[0]!.comentario).toBe(html);
  }, 60_000);

  it("un mensaje inexistente o de otro estudio devuelve null", async () => {
    const ctx = { tenantId: A.tenantId, userId: A.dueno.id };
    expect(
      await db.withTenant(ctx, (tx) => detalleAtencion(tx, randomUUID())),
    ).toBeNull();
    const ajeno = B.mensajes[0]!;
    expect(
      await db.withTenant(ctx, (tx) => detalleAtencion(tx, ajeno.id)),
    ).toBeNull();
  });
});

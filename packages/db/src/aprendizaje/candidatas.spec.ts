// Spec 025 (T4, rojo): repositorio de candidatas del aprendizaje del historial (CA-3 a CA-5, CA-13, D-4 a D-6, U-8). Contra la BD real
// con el rol del backend, contra un oráculo en memoria (soporte-prueba.ts) y con una `tx` falsa para la traducción de errores.
// Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/aprendizaje/candidatas.ts`; todo con la `tx` de withTenant y
// solo con las funciones acotadas de 0062 para escribir; el listado es una consulta de solo lectura):
//   listarCandidatas(tx, { clienteId, grupo, posicion, limite }) -> { candidatas: CandidataFila[], siguiente: PosicionCandidata | null }
//     de la ÚLTIMA importación `completada` del cliente (una anterior, una `fallida` posterior o un cliente sin importaciones no cambian
//     ni aportan nada); orden fijo por (doc_tipo, doc_numero); `posicion` = null o la `siguiente` de la página anterior (valor, no
//     desplazamiento: no repite ni omite aunque cambien las filas); `siguiente` = la posición de la última fila de la página si queda
//     al menos una más, si no `null`. Grupos (partición de las candidatas):
//       propuestas   pendientes con destino propuesto y sin regla viva del proveedor (conflicto "ninguno");
//       sin_criterio pendientes sin destino propuesto;
//       conflicto    pendientes con destino propuesto y regla viva del proveedor: "ya_aprendida" (mismo destino) o "distinto";
//       resueltas    activada o descartada.
//     CandidataFila = { id, proveedor { tipo, numero, razonSocial }, destinoPropuesto, conteos { DG, DGNG, DNG, mixto, total },
//       periodosConProveedor, periodosLeidos (de la importación), estado, destinoElegido, regla { id, destino, version } | null,
//       conflicto }. `regla` es la regla viva del proveedor en un conflicto o la creada al activar; en otro caso, null.
//   activarCandidatas(tx, { clienteId, items: [{ id, destino? }] } | { clienteId, todas: importacionId })
//       -> { activadas: id[], omitidas: [{ id, motivo }] }     `reglas_candidatas_activar`
//     Ids de otro cliente, de otro estudio o inexistentes: error P0002 y nada cambia. `todas` solo acepta la última importación completada
//     (otra: 22023) y abarca las pendientes con destino propuesto (las sin criterio no entran ni se informan como omitidas).
//   reemplazarCandidata(tx, { clienteId, candidataId, destino?, versionRegla }) -> { reglaId } | "regla_cambiada"   (`CA409` traducido)
//   descartarCandidatas(tx, { clienteId, ids }) -> { descartadas: id[], omitidas: id[] }
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "../client";
import { editarRegla, leerRegla, listarReglas } from "../reglas";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import type { Tx } from "../with-tenant";
import {
  activarCandidatas,
  AprendizajeRepoError,
  descartarCandidatas,
  listarCandidatas,
  reemplazarCandidata,
  type CandidataFila,
  type GrupoCandidatas,
  type PosicionCandidata,
} from "./index";
import {
  abrirAdmin,
  abrirDb,
  DESTINOS,
  ESCENARIO_1000,
  ESCENARIO_CHICO,
  esperada,
  exigirEntorno,
  oraculo,
  sembrarEscenario,
  sembrarEstudio,
  type CandidataSembrada,
  type ClienteSembrado,
  type Destino,
  type Escenario,
  type Estudio,
  type PlanEscenario,
  type Tipo,
} from "./soporte-prueba";

let admin: Pool;
let backend: ContappDb;
let A: Estudio;
let B: Estudio; // otro estudio: nunca debe verse desde A
let GRANDE: { c: ClienteSembrado; esc: Escenario }; // 1.000 candidatas, solo lectura
const limpiezas: Array<() => Promise<void>> = [];

beforeAll(async () => {
  exigirEntorno();
  admin = abrirAdmin();
  backend = abrirDb("contapp_backend");
  A = await sembrarEstudio(admin);
  limpiezas.push(A.limpiar);
  B = await sembrarEstudio(admin);
  limpiezas.push(B.limpiar);
  const c = await A.nuevoCliente();
  GRANDE = { c, esc: await sembrarEscenario(admin, A, c, ESCENARIO_1000) };
}, 120_000);

afterAll(async () => {
  for (const l of limpiezas) await l().catch(() => undefined);
  await backend?.close();
  await admin?.end();
});

const comoDueno = <T>(fn: (tx: Tx) => Promise<T>, e: Estudio = A): Promise<T> =>
  backend.withTenant({ tenantId: e.tenantId, userId: e.dueno.id }, fn);

async function falla(p: Promise<unknown>): Promise<AprendizajeRepoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AprendizajeRepoError);
    return e as AprendizajeRepoError;
  }
  throw new Error("se esperaba un AprendizajeRepoError y no falló");
}

const GRUPOS: GrupoCandidatas[] = [
  "propuestas",
  "sin_criterio",
  "conflicto",
  "resueltas",
];
const posicionDe = (c: {
  proveedor: { tipo: string; numero: string };
}): PosicionCandidata => ({
  docTipo: c.proveedor.tipo,
  docNumero: c.proveedor.numero,
});

/** Todas las páginas de un grupo (valor, no desplazamiento), con una `tx` nueva por página. */
async function recorrer(
  c: ClienteSembrado,
  grupo: GrupoCandidatas,
  limite: number,
  alTerminarPagina?: (pagina: CandidataFila[], n: number) => Promise<void>,
  e: Estudio = A,
): Promise<{ filas: CandidataFila[]; tamanos: number[] }> {
  const filas: CandidataFila[] = [];
  const tamanos: number[] = [];
  let posicion: PosicionCandidata | null = null;
  for (let n = 1; ; n++) {
    const p: Awaited<ReturnType<typeof listarCandidatas>> = await comoDueno(
      (tx) =>
        listarCandidatas(tx, { clienteId: c.id, grupo, posicion, limite }),
      e,
    );
    filas.push(...p.candidatas);
    tamanos.push(p.candidatas.length);
    if (alTerminarPagina) await alTerminarPagina(p.candidatas, n);
    if (p.siguiente === null) return { filas, tamanos };
    expect(
      p.candidatas.length,
      "una página con `siguiente` trae exactamente `limite` filas",
    ).toBe(limite);
    expect(p.siguiente).toEqual(
      posicionDe(p.candidatas[p.candidatas.length - 1]!),
    );
    posicion = p.siguiente;
    if (n > 2000) throw new Error("la paginación no termina");
  }
}

/** Cliente nuevo con su escenario (para las pruebas que escriben). */
async function escenarioNuevo(
  plan: PlanEscenario = ESCENARIO_CHICO,
): Promise<{ c: ClienteSembrado; esc: Escenario }> {
  const c = await A.nuevoCliente();
  return { c, esc: await sembrarEscenario(admin, A, c, plan) };
}

const deTipo = (
  esc: Escenario,
  tipo: Tipo,
  n?: number,
): CandidataSembrada[] => {
  const r = esc.candidatas.filter((x) => x.tipo === tipo);
  return n === undefined ? r : r.slice(0, n);
};
const ids = (cs: Array<{ id: string }>): string[] => cs.map((x) => x.id).sort();
const otroDestino = (d: Destino): Destino =>
  DESTINOS[(DESTINOS.indexOf(d) + 1) % 3]!;
const ordenId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const reglasDe = (c: ClienteSembrado) =>
  comoDueno((tx) => listarReglas(tx, c.id));
const grupoCompleto = async (
  c: ClienteSembrado,
  g: GrupoCandidatas,
): Promise<CandidataFila[]> => (await recorrer(c, g, 200)).filas;

describe("listado por grupo contra el oráculo (CA-3, CA-13)", () => {
  it("la siembra tiene los tamaños del plan (400, 150 y 300, 150 resueltas = 1.000)", () => {
    expect(GRUPOS.map((g) => oraculo(GRANDE.esc, g).length)).toEqual([
      400, 150, 300, 150,
    ]);
  });

  it.each(GRUPOS)(
    "grupo %s: igual al oráculo, completo y en orden (documento, no id)",
    async (grupo) => {
      const filas = await grupoCompleto(GRANDE.c, grupo);
      expect(filas).toEqual(oraculo(GRANDE.esc, grupo));
    },
  );

  it("los cuatro grupos son una partición de las 1.000 candidatas de la última importación completada", async () => {
    const todas = (
      await Promise.all(GRUPOS.map((g) => grupoCompleto(GRANDE.c, g)))
    ).flat();
    expect(todas).toHaveLength(1000);
    expect(new Set(ids(todas)).size).toBe(1000);
    expect(ids(todas)).toEqual(ids(GRANDE.esc.candidatas));
  });

  it("cada fila trae la frecuencia, el destino elegido y la regla vigente del conflicto", async () => {
    const [propuesta] = (await grupoCompleto(GRANDE.c, "propuestas")).slice(
      0,
      1,
    );
    expect(propuesta!.estado).toBe("pendiente");
    expect(propuesta!.conflicto).toBe("ninguno");
    expect(propuesta!.regla).toBeNull();
    expect(propuesta!.destinoElegido).toBeNull();
    expect(propuesta!.periodosLeidos).toBe(GRANDE.esc.periodosLeidos);
    const conflictos = await grupoCompleto(GRANDE.c, "conflicto");
    expect(new Set(conflictos.map((f) => f.conflicto))).toEqual(
      new Set(["ya_aprendida", "distinto"]),
    );
    expect(
      conflictos.filter((f) => f.conflicto === "ya_aprendida"),
    ).toHaveLength(150);
    for (const f of conflictos) {
      expect(f.regla).not.toBeNull();
      expect(f.estado).toBe("pendiente");
      expect(f.conflicto === "ya_aprendida").toBe(
        f.regla!.destino === f.destinoPropuesto,
      );
    }
    const sinCriterio = await grupoCompleto(GRANDE.c, "sin_criterio");
    for (const f of sinCriterio) expect(f.destinoPropuesto).toBeNull();
  });

  it("la razón social con tildes y ñ, y la ausente (null), llegan tal cual", async () => {
    const filas = await grupoCompleto(GRANDE.c, "propuestas");
    expect(
      filas.some((f) => f.proveedor.razonSocial === "Ferretería Ñandú EIRL"),
    ).toBe(true);
    expect(filas.some((f) => f.proveedor.razonSocial === null)).toBe(true);
  });

  it("sin importación completada, de otro cliente o de otro estudio: vacío", async () => {
    const sin = await A.nuevoCliente();
    const cb = await B.nuevoCliente();
    for (const grupo of GRUPOS) {
      for (const [clienteId, e] of [
        [sin.id, A],
        [randomUUID(), A],
        [GRANDE.c.id, B],
        [cb.id, A],
      ] as const) {
        const r = await comoDueno(
          (tx) =>
            listarCandidatas(tx, {
              clienteId,
              grupo,
              posicion: null,
              limite: 50,
            }),
          e,
        );
        expect(r).toEqual({ candidatas: [], siguiente: null });
      }
    }
  });
});

describe("cursor por (doc_tipo, doc_numero) (CA-13)", () => {
  it.each(GRUPOS)(
    "grupo %s con límite 7: sin repetir ni omitir, páginas completas salvo la última",
    async (grupo) => {
      const esperado = oraculo(GRANDE.esc, grupo).map((f) => f.id);
      const { filas, tamanos } = await recorrer(GRANDE.c, grupo, 7);
      expect(filas.map((f) => f.id)).toEqual(esperado);
      expect(new Set(filas.map((f) => f.id)).size).toBe(esperado.length);
      const ultima = esperado.length % 7 || 7;
      expect(tamanos).toHaveLength(Math.ceil(esperado.length / 7));
      expect(tamanos.slice(0, -1).every((t) => t === 7)).toBe(true);
      expect(tamanos[tamanos.length - 1]).toBe(ultima);
    },
  );

  it("recorre las 1.000 candidatas con límite 7 sin repetir ni omitir", async () => {
    const vistas: string[] = [];
    for (const g of GRUPOS)
      vistas.push(...(await recorrer(GRANDE.c, g, 7)).filas.map((f) => f.id));
    expect(vistas).toHaveLength(1000);
    expect([...vistas].sort()).toEqual(ids(GRANDE.esc.candidatas));
  });

  it("el último grupo exacto no deja `siguiente`, y uno menos sí", async () => {
    const todas = oraculo(GRANDE.esc, "resueltas");
    const exacto = await comoDueno((tx) =>
      listarCandidatas(tx, {
        clienteId: GRANDE.c.id,
        grupo: "resueltas",
        posicion: null,
        limite: todas.length,
      }),
    );
    expect(exacto.candidatas).toHaveLength(150);
    expect(exacto.siguiente).toBeNull();
    const menos = await comoDueno((tx) =>
      listarCandidatas(tx, {
        clienteId: GRANDE.c.id,
        grupo: "resueltas",
        posicion: null,
        limite: 149,
      }),
    );
    expect(menos.candidatas).toHaveLength(149);
    expect(menos.siguiente).toEqual({
      docTipo: todas[148]!.proveedor.tipo,
      docNumero: todas[148]!.proveedor.numero,
    });
  });

  it("con `posicion` devuelve solo filas estrictamente posteriores", async () => {
    const todas = oraculo(GRANDE.esc, "propuestas");
    const desde = todas[199]!;
    const r = await comoDueno((tx) =>
      listarCandidatas(tx, {
        clienteId: GRANDE.c.id,
        grupo: "propuestas",
        posicion: posicionDe(desde),
        limite: 5,
      }),
    );
    expect(r.candidatas.map((f) => f.id)).toEqual(
      todas.slice(200, 205).map((f) => f.id),
    );
    const alFinal = await comoDueno((tx) =>
      listarCandidatas(tx, {
        clienteId: GRANDE.c.id,
        grupo: "propuestas",
        posicion: posicionDe(todas[399]!),
        limite: 5,
      }),
    );
    expect(alFinal).toEqual({ candidatas: [], siguiente: null });
  });

  it("activando a mitad del recorrido, tampoco repite ni omite (las de atrás y las de adelante)", async () => {
    const { c, esc } = await escenarioNuevo(ESCENARIO_1000);
    const inicial = oraculo(esc, "propuestas");
    expect(inicial).toHaveLength(400);
    const adelante = new Set(inicial.slice(250, 262).map((f) => f.id)); // se activan tras la tercera página
    const vistas: string[] = [];
    const { filas } = await recorrer(c, "propuestas", 7, async (pagina, n) => {
      vistas.push(...pagina.map((f) => f.id));
      // Cada página se activa apenas se ve, y tras la 3.ª también un tramo que aún no se ha visto.
      const aActivar = [
        ...pagina.map((f) => f.id),
        ...(n === 3 ? [...adelante] : []),
      ];
      const r = await comoDueno((tx) =>
        activarCandidatas(tx, {
          clienteId: c.id,
          items: aActivar.map((id) => ({ id })),
        }),
      );
      expect(ids(r.activadas.map((id) => ({ id })))).toEqual(
        [...aActivar].sort(),
      );
      expect(r.omitidas).toEqual([]);
    });
    expect(filas.map((f) => f.id)).toEqual(vistas);
    expect(new Set(vistas).size).toBe(vistas.length); // sin repetir
    const esperado = inicial.map((f) => f.id).filter((id) => !adelante.has(id));
    expect(vistas).toEqual(esperado); // sin omitir, en orden
    // Al final no queda ninguna propuesta y las 400 están resueltas con su regla.
    expect(await grupoCompleto(c, "propuestas")).toEqual([]);
    const resueltas = await grupoCompleto(c, "resueltas");
    expect(resueltas.filter((f) => f.estado === "activada")).toHaveLength(
      60 + 400,
    );
  }, 120_000);
});

describe("activar (CA-4)", () => {
  it("activar propuestas crea las reglas con el destino propuesto, origen importación y último periodo", async () => {
    const { c, esc } = await escenarioNuevo();
    const antes = await reglasDe(c);
    const elegidas = deTipo(esc, "propuesta", 5);
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: elegidas.map((x) => ({ id: x.id })),
      }),
    );
    expect([...r.activadas].sort()).toEqual(ids(elegidas));
    expect(r.omitidas).toEqual([]);

    const despues = await reglasDe(c);
    expect(despues).toHaveLength(antes.length + 5);
    const nuevas = despues.filter((g) => !antes.some((a) => a.id === g.id));
    for (const x of elegidas) {
      const regla = nuevas.find(
        (g) => g.docTipo === x.docTipo && g.docNumero === x.docNumero,
      );
      expect(regla, `regla de ${x.docTipo}-${x.docNumero}`).toBeDefined();
      expect(regla).toMatchObject({
        destino: x.destinoPropuesto,
        version: 1,
        activa: true,
        periodoAprendido: esc.periodoHasta,
      });
      expect((regla as { origen?: string }).origen).toBe("importacion");
      const fila = (await grupoCompleto(c, "resueltas")).find(
        (f) => f.id === x.id,
      );
      expect(fila).toMatchObject({
        estado: "activada",
        destinoElegido: x.destinoPropuesto,
        regla: { id: regla!.id, destino: x.destinoPropuesto, version: 1 },
        conflicto: "ninguno",
      });
    }
    const propuestas = new Set(
      (await grupoCompleto(c, "propuestas")).map((f) => f.id),
    );
    for (const x of elegidas) expect(propuestas.has(x.id)).toBe(false);
  });

  it("las reglas que no venían de la importación siguen con origen `contador`", async () => {
    const { c } = await escenarioNuevo();
    for (const g of await reglasDe(c))
      expect((g as { origen?: string }).origen).toBe("contador");
  });

  it("con otro destino elegido, la regla y la candidata quedan con ese destino", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "propuesta", 1)[0]!;
    const elegido = otroDestino(x.destinoPropuesto!);
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: [{ id: x.id, destino: elegido }],
      }),
    );
    expect(r.activadas).toEqual([x.id]);
    const fila = (await grupoCompleto(c, "resueltas")).find(
      (f) => f.id === x.id,
    )!;
    expect(fila.destinoPropuesto).toBe(x.destinoPropuesto);
    expect(fila.destinoElegido).toBe(elegido);
    expect(fila.regla).toMatchObject({ destino: elegido, version: 1 });
  });

  it("sin criterio: sin destino se omite (`sin_criterio`); con destino elegido se activa (U-8)", async () => {
    const { c, esc } = await escenarioNuevo();
    const [a, b] = deTipo(esc, "sin_criterio", 2) as [
      CandidataSembrada,
      CandidataSembrada,
    ];
    const antes = await reglasDe(c);
    const r1 = await comoDueno((tx) =>
      activarCandidatas(tx, { clienteId: c.id, items: [{ id: a.id }] }),
    );
    expect(r1).toEqual({
      activadas: [],
      omitidas: [{ id: a.id, motivo: "sin_criterio" }],
    });
    expect(await reglasDe(c)).toHaveLength(antes.length);
    const r2 = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: [{ id: b.id, destino: "DNG" }],
      }),
    );
    expect(r2).toEqual({ activadas: [b.id], omitidas: [] });
    const fila = (await grupoCompleto(c, "resueltas")).find(
      (f) => f.id === b.id,
    )!;
    expect(fila).toMatchObject({
      estado: "activada",
      destinoPropuesto: null,
      destinoElegido: "DNG",
      regla: { destino: "DNG", version: 1 },
    });
  });

  it("proveedor con regla viva: `ya_aprendida` si es el mismo destino y `conflicto` si no; las reglas no cambian", async () => {
    const { c, esc } = await escenarioNuevo();
    const ya = deTipo(esc, "ya_aprendida", 2);
    const distinta = deTipo(esc, "distinta", 2);
    const antes = await reglasDe(c);
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: [...ya, ...distinta].map((x) => ({ id: x.id })),
      }),
    );
    expect(r.activadas).toEqual([]);
    expect([...r.omitidas].sort(ordenId)).toEqual(
      [
        ...ya.map((x) => ({ id: x.id, motivo: "ya_aprendida" as const })),
        ...distinta.map((x) => ({ id: x.id, motivo: "conflicto" as const })),
      ].sort(ordenId),
    );
    expect(await reglasDe(c)).toEqual(antes);
    const conflicto = await grupoCompleto(c, "conflicto");
    for (const x of [...ya, ...distinta])
      expect(conflicto.find((f) => f.id === x.id)!.estado).toBe("pendiente");
  });

  it("una candidata que ya no está pendiente (activada, descartada o repetida) se omite como `no_pendiente`", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "propuesta", 1)[0]!;
    const activada = deTipo(esc, "activada", 1)[0]!;
    const descartada = deTipo(esc, "descartada", 1)[0]!;
    expect(
      (
        await comoDueno((tx) =>
          activarCandidatas(tx, { clienteId: c.id, items: [{ id: x.id }] }),
        )
      ).activadas,
    ).toEqual([x.id]);
    const antes = await reglasDe(c);
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: [x, activada, descartada].map((y) => ({
          id: y.id,
          destino: "DG" as const,
        })),
      }),
    );
    expect(r.activadas).toEqual([]);
    expect([...r.omitidas].sort(ordenId)).toEqual(
      [x, activada, descartada]
        .map((y) => ({ id: y.id, motivo: "no_pendiente" as const }))
        .sort(ordenId),
    );
    expect(await reglasDe(c)).toEqual(antes);
  });

  it("mezcla: activa las posibles e informa cada omitida con su motivo", async () => {
    const { c, esc } = await escenarioNuevo();
    const ok = deTipo(esc, "propuesta", 3);
    const ya = deTipo(esc, "ya_aprendida", 1)[0]!;
    const dist = deTipo(esc, "distinta", 1)[0]!;
    const sin = deTipo(esc, "sin_criterio", 1)[0]!;
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, {
        clienteId: c.id,
        items: [...ok, ya, dist, sin].map((x) => ({ id: x.id })),
      }),
    );
    expect([...r.activadas].sort()).toEqual(ids(ok));
    expect([...r.omitidas].sort(ordenId)).toEqual(
      [
        { id: ya.id, motivo: "ya_aprendida" as const },
        { id: dist.id, motivo: "conflicto" as const },
        { id: sin.id, motivo: "sin_criterio" as const },
      ].sort(ordenId),
    );
  });

  it("`todas`: activa las propuestas, omite e informa los conflictos y deja las sin criterio", async () => {
    const { c, esc } = await escenarioNuevo();
    const propuestas = deTipo(esc, "propuesta");
    const antes = await reglasDe(c);
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, { clienteId: c.id, todas: esc.importacionId }),
    );
    expect([...r.activadas].sort()).toEqual(ids(propuestas));
    expect([...r.omitidas].sort(ordenId)).toEqual(
      [
        ...deTipo(esc, "ya_aprendida").map((x) => ({
          id: x.id,
          motivo: "ya_aprendida" as const,
        })),
        ...deTipo(esc, "distinta").map((x) => ({
          id: x.id,
          motivo: "conflicto" as const,
        })),
      ].sort(ordenId),
    );
    expect(await reglasDe(c)).toHaveLength(antes.length + propuestas.length);
    expect(await grupoCompleto(c, "propuestas")).toEqual([]);
    expect(await grupoCompleto(c, "sin_criterio")).toEqual(
      oraculo(esc, "sin_criterio"),
    );
    expect(await grupoCompleto(c, "conflicto")).toEqual(
      oraculo(esc, "conflicto"),
    );
    // Repetirla no activa nada más: quedan solo los conflictos.
    const otra = await comoDueno((tx) =>
      activarCandidatas(tx, { clienteId: c.id, todas: esc.importacionId }),
    );
    expect(otra.activadas).toEqual([]);
    expect(otra.omitidas).toHaveLength(
      deTipo(esc, "ya_aprendida").length + deTipo(esc, "distinta").length,
    );
  });

  it("`todas` con una importación que no es la última completada: 22023 y nada cambia", async () => {
    const { c, esc } = await escenarioNuevo();
    const antes = await reglasDe(c);
    for (const importacionId of [esc.anteriorId, esc.fallidaId, randomUUID()]) {
      expect(
        (
          await falla(
            comoDueno((tx) =>
              activarCandidatas(tx, { clienteId: c.id, todas: importacionId }),
            ),
          )
        ).codigo,
      ).toBe("22023");
    }
    expect(await reglasDe(c)).toEqual(antes);
    expect(await grupoCompleto(c, "propuestas")).toEqual(
      oraculo(esc, "propuestas"),
    );
  });

  it("un id ajeno o inexistente da P0002 a todo: no se activa ni una", async () => {
    const { c, esc } = await escenarioNuevo();
    const otro = await escenarioNuevo();
    const cb = await B.nuevoCliente();
    const escB = await sembrarEscenario(admin, B, cb, {
      ...ESCENARIO_CHICO,
      propuestas: 3,
    });
    const validas = deTipo(esc, "propuesta", 3);
    const antes = await reglasDe(c);
    const ajenos = [
      randomUUID(),
      deTipo(otro.esc, "propuesta", 1)[0]!.id,
      deTipo(escB, "propuesta", 1)[0]!.id,
    ];
    for (const ajeno of ajenos) {
      const e = await falla(
        comoDueno((tx) =>
          activarCandidatas(tx, {
            clienteId: c.id,
            items: [...validas.map((x) => ({ id: x.id })), { id: ajeno }],
          }),
        ),
      );
      expect(e.codigo).toBe("P0002");
    }
    expect(await reglasDe(c)).toEqual(antes);
    expect(await grupoCompleto(c, "propuestas")).toEqual(
      oraculo(esc, "propuestas"),
    );
    // Y la candidata del otro estudio sigue pendiente (su estudio la ve intacta).
    expect(
      (await recorrer(cb, "propuestas", 200, undefined, B)).filas,
    ).toHaveLength(3);
  });

  it("cliente archivado: 55000 y no activa", async () => {
    const { c, esc } = await escenarioNuevo();
    await admin.query("update cliente set archivado_at = now() where id = $1", [
      c.id,
    ]);
    const e = await falla(
      comoDueno((tx) =>
        activarCandidatas(tx, {
          clienteId: c.id,
          items: deTipo(esc, "propuesta", 2).map((x) => ({ id: x.id })),
        }),
      ),
    );
    expect(e.codigo).toBe("55000");
    expect(await grupoCompleto(c, "propuestas")).toEqual(
      oraculo(esc, "propuestas"),
    );
  });
});

describe("reemplazar (CA-4, U-5)", () => {
  it("cambia el destino de la regla vigente a la versión siguiente y marca la candidata activada", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "distinta", 1)[0]!;
    const r = await comoDueno((tx) =>
      reemplazarCandidata(tx, {
        clienteId: c.id,
        candidataId: x.id,
        versionRegla: 3,
      }),
    );
    expect(r).toEqual({ reglaId: x.regla!.id });
    const regla = await comoDueno((tx) => leerRegla(tx, c.id, x.regla!.id));
    expect(regla).toMatchObject({
      destino: x.destinoPropuesto,
      version: 4,
      activa: true,
      periodoAprendido: esc.periodoHasta,
    });
    const fila = (await grupoCompleto(c, "resueltas")).find(
      (f) => f.id === x.id,
    )!;
    expect(fila).toMatchObject({
      estado: "activada",
      destinoElegido: x.destinoPropuesto,
      regla: { id: x.regla!.id, destino: x.destinoPropuesto, version: 4 },
      conflicto: "ninguno",
    });
    expect(
      (await grupoCompleto(c, "conflicto")).some((f) => f.id === x.id),
    ).toBe(false);
  });

  it("con un destino explícito usa ese destino", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "distinta", 1)[0]!;
    const destino = DESTINOS.find(
      (d) => d !== x.destinoPropuesto && d !== x.regla!.destino,
    )!;
    await comoDueno((tx) =>
      reemplazarCandidata(tx, {
        clienteId: c.id,
        candidataId: x.id,
        destino,
        versionRegla: 3,
      }),
    );
    expect(
      (await comoDueno((tx) => leerRegla(tx, c.id, x.regla!.id)))!.destino,
    ).toBe(destino);
    expect(
      (await grupoCompleto(c, "resueltas")).find((f) => f.id === x.id),
    ).toMatchObject({
      destinoElegido: destino,
      regla: { destino, version: 4 },
    });
  });

  it("versión vieja de la regla: `regla_cambiada` sin tocar nada", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "distinta", 1)[0]!;
    for (const versionRegla of [1, 2, 4]) {
      expect(
        await comoDueno((tx) =>
          reemplazarCandidata(tx, {
            clienteId: c.id,
            candidataId: x.id,
            versionRegla,
          }),
        ),
      ).toBe("regla_cambiada");
    }
    expect(
      await comoDueno((tx) => leerRegla(tx, c.id, x.regla!.id)),
    ).toMatchObject({ destino: x.regla!.destino, version: 3 });
    expect(
      (await grupoCompleto(c, "conflicto")).find((f) => f.id === x.id),
    ).toMatchObject({ estado: "pendiente", conflicto: "distinto" });
  });

  it("la regla cambió mientras tanto (la editó otra persona): `regla_cambiada`", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "distinta", 1)[0]!;
    await comoDueno((tx) =>
      editarRegla(tx, {
        clienteId: c.id,
        reglaId: x.regla!.id,
        versionBase: 3,
        activa: false,
        usuarioId: A.dueno.id,
      }),
    );
    expect(
      await comoDueno((tx) =>
        reemplazarCandidata(tx, {
          clienteId: c.id,
          candidataId: x.id,
          versionRegla: 3,
        }),
      ),
    ).toBe("regla_cambiada");
    expect(
      await comoDueno((tx) => leerRegla(tx, c.id, x.regla!.id)),
    ).toMatchObject({ destino: x.regla!.destino, version: 4, activa: false });
  });

  it("candidata ajena o inexistente: P0002", async () => {
    const { c } = await escenarioNuevo();
    const otro = await escenarioNuevo();
    for (const candidataId of [
      randomUUID(),
      deTipo(otro.esc, "distinta", 1)[0]!.id,
    ]) {
      expect(
        (
          await falla(
            comoDueno((tx) =>
              reemplazarCandidata(tx, {
                clienteId: c.id,
                candidataId,
                versionRegla: 3,
              }),
            ),
          )
        ).codigo,
      ).toBe("P0002");
    }
  });
});

describe("descartar (CA-4)", () => {
  it("descarta las pendientes, que pasan a resueltas sin regla, y no crea reglas", async () => {
    const { c, esc } = await escenarioNuevo();
    const elegidas = [
      ...deTipo(esc, "propuesta", 3),
      ...deTipo(esc, "sin_criterio", 1),
      ...deTipo(esc, "ya_aprendida", 1),
    ];
    const antes = await reglasDe(c);
    const r = await comoDueno((tx) =>
      descartarCandidatas(tx, {
        clienteId: c.id,
        ids: elegidas.map((x) => x.id),
      }),
    );
    expect([...r.descartadas].sort()).toEqual(ids(elegidas));
    expect(r.omitidas).toEqual([]);
    expect(await reglasDe(c)).toEqual(antes);
    const resueltas = await grupoCompleto(c, "resueltas");
    for (const x of elegidas) {
      expect(resueltas.find((f) => f.id === x.id)).toMatchObject({
        estado: "descartada",
        destinoElegido: null,
        regla: null,
      });
    }
    const quedan = new Set(
      [
        ...(await grupoCompleto(c, "propuestas")),
        ...(await grupoCompleto(c, "sin_criterio")),
        ...(await grupoCompleto(c, "conflicto")),
      ].map((f) => f.id),
    );
    for (const x of elegidas) expect(quedan.has(x.id)).toBe(false);
  });

  it("las que ya no están pendientes se informan como omitidas", async () => {
    const { c, esc } = await escenarioNuevo();
    const pendiente = deTipo(esc, "propuesta", 1)[0]!;
    const activada = deTipo(esc, "activada", 1)[0]!;
    const descartada = deTipo(esc, "descartada", 1)[0]!;
    const r = await comoDueno((tx) =>
      descartarCandidatas(tx, {
        clienteId: c.id,
        ids: [pendiente.id, activada.id, descartada.id],
      }),
    );
    expect(r.descartadas).toEqual([pendiente.id]);
    expect([...r.omitidas].sort()).toEqual([activada.id, descartada.id].sort());
    expect(
      (await grupoCompleto(c, "resueltas")).find((f) => f.id === activada.id),
    ).toMatchObject({ estado: "activada" });
  });

  it("una descartada ya no se activa con `todas` ni por id (`no_pendiente`)", async () => {
    const { c, esc } = await escenarioNuevo();
    const x = deTipo(esc, "propuesta", 1)[0]!;
    await comoDueno((tx) =>
      descartarCandidatas(tx, { clienteId: c.id, ids: [x.id] }),
    );
    const r = await comoDueno((tx) =>
      activarCandidatas(tx, { clienteId: c.id, items: [{ id: x.id }] }),
    );
    expect(r).toEqual({
      activadas: [],
      omitidas: [{ id: x.id, motivo: "no_pendiente" }],
    });
    const todas = await comoDueno((tx) =>
      activarCandidatas(tx, { clienteId: c.id, todas: esc.importacionId }),
    );
    expect(todas.activadas).not.toContain(x.id);
  });
});

describe("traducción de errores (tx falsa): solo el SQLSTATE, nunca el mensaje ni el detalle", () => {
  const CLIENTE = "01990000-0000-7000-8000-000000000001";
  const CANDIDATA = "01990000-0000-7000-8000-000000000002";
  const IMPORTACION = "01990000-0000-7000-8000-000000000003";
  const CANARIO = "CANARIO-RUC-20100070970-RAZON-SOCIAL";
  const llamadas: Array<[string, (tx: never) => Promise<unknown>]> = [
    [
      "listar",
      (tx) =>
        listarCandidatas(tx, {
          clienteId: CLIENTE,
          grupo: "propuestas",
          posicion: null,
          limite: 10,
        }),
    ],
    [
      "activar por ids",
      (tx) =>
        activarCandidatas(tx, {
          clienteId: CLIENTE,
          items: [{ id: CANDIDATA }],
        }),
    ],
    [
      "activar todas",
      (tx) => activarCandidatas(tx, { clienteId: CLIENTE, todas: IMPORTACION }),
    ],
    [
      "reemplazar",
      (tx) =>
        reemplazarCandidata(tx, {
          clienteId: CLIENTE,
          candidataId: CANDIDATA,
          versionRegla: 1,
        }),
    ],
    [
      "descartar",
      (tx) => descartarCandidatas(tx, { clienteId: CLIENTE, ids: [CANDIDATA] }),
    ],
  ];

  describe.each(llamadas)("%s", (_nombre, llamar) => {
    it.each(["P0002", "55000", "23505", "22023", "42501"])(
      "conserva solo el SQLSTATE %s",
      async (codigo) => {
        const { tx } = txFalso(errorPg(codigo, CANARIO));
        const e = await llamar(tx).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(AprendizajeRepoError);
        const err = e as AprendizajeRepoError;
        expect(err.codigo).toBe(codigo);
        expect(err.message).not.toContain(CANARIO);
        expect(JSON.stringify({ ...err, message: err.message })).not.toContain(
          CANARIO,
        );
        expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
      },
    );

    it("sin SQLSTATE: desconocido", async () => {
      const { tx } = txFalso(errorPg(undefined, CANARIO));
      const e = (await llamar(tx).then(
        () => null,
        (x: unknown) => x,
      )) as AprendizajeRepoError;
      expect(e).toBeInstanceOf(AprendizajeRepoError);
      expect(e.codigo).toBe("desconocido");
    });
  });

  it("reemplazar: CA409 no es un error, vuelve como `regla_cambiada` (el backend lo traduce a 409)", async () => {
    const { tx } = txFalso(errorPg("CA409", CANARIO));
    await expect(
      reemplazarCandidata(tx, {
        clienteId: CLIENTE,
        candidataId: CANDIDATA,
        versionRegla: 1,
      }),
    ).resolves.toBe("regla_cambiada");
  });

  it("activar llama a la función acotada con el cliente y las candidatas (o la importación) como parámetros", async () => {
    const porIds = txFalso(errorPg("P0002"));
    await activarCandidatas(porIds.tx, {
      clienteId: CLIENTE,
      items: [{ id: CANDIDATA, destino: "DNG" }],
    }).catch(() => undefined);
    expect(porIds.llamadas).toHaveLength(1);
    expect(porIds.llamadas[0]!.texto).toContain("reglas_candidatas_activar");
    expect(porIds.llamadas[0]!.valores[0]).toBe(CLIENTE);
    expect(JSON.stringify(porIds.llamadas[0]!.valores)).toContain(CANDIDATA);
    const todas = txFalso(errorPg("P0002"));
    await activarCandidatas(todas.tx, {
      clienteId: CLIENTE,
      todas: IMPORTACION,
    }).catch(() => undefined);
    expect(todas.llamadas[0]!.valores).toContain(IMPORTACION);
  });

  it("las consultas del listado son SQL estático: el cliente, el grupo y la posición viajan como parámetros", async () => {
    const f = txFalso({ rows: [], rowCount: 0 });
    await listarCandidatas(f.tx, {
      clienteId: CLIENTE,
      grupo: "conflicto",
      posicion: { docTipo: "6", docNumero: "20100070970" },
      limite: 7,
    }).catch(() => undefined);
    expect(f.llamadas.length).toBeGreaterThan(0);
    for (const l of f.llamadas) {
      expect(l.texto).not.toContain(CLIENTE);
      expect(l.texto).not.toContain("20100070970");
    }
    expect(JSON.stringify(f.llamadas.map((l) => l.valores))).toContain(CLIENTE);
  });
});

// Una referencia explícita al oráculo de una sola fila evita que `esperada` quede sin uso si cambia el listado completo.
describe("oráculo", () => {
  it("una candidata sembrada se ve igual que la esperada", async () => {
    const x = deTipo(GRANDE.esc, "ya_aprendida", 1)[0]!;
    const fila = (await grupoCompleto(GRANDE.c, "conflicto")).find(
      (f) => f.id === x.id,
    );
    expect(fila).toEqual(esperada(x, GRANDE.esc));
  });
});

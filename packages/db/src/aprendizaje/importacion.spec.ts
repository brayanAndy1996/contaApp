// Spec 025 (T4, rojo): repositorio de importaciones del aprendizaje del historial (CA-3 a CA-5, D-4 a D-6). Contra la BD real, con
// el backend (iniciar, fijar trabajo y leer) y el worker (leer, completar y fallar), más una `tx` falsa para la traducción de errores.
// Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/aprendizaje/importacion.ts`; todo con la `tx` de withTenant;
// llama a las funciones acotadas de 0062 de plan.md, nunca escribe directo):
//   iniciarImportacion(tx, { clienteId, periodos: string[] }) -> id            `reglas_importacion_iniciar`
//   fijarTrabajoImportacion(tx, { importacionId, trabajoId }) -> void          `reglas_importacion_trabajo`
//   ultimaImportacion(tx, clienteId) -> ImportacionFila | null                la más reciente del cliente (por `solicitada_en`), sea cual
//       sea su estado; `resumen` solo si está `completada`; cliente de otro estudio o inexistente: null (RLS).
//   leerImportacion(tx, importacionId) -> { id, clienteId, estado, periodos, ruc } | null     (worker: el RUC es el del cliente)
//   completarImportacion(tx, { importacionId, resumen, candidatas }) -> n insertadas           `reglas_importacion_completar` (worker)
//   fallarImportacion(tx, { importacionId, motivo }) -> void                                   `reglas_importacion_fallar` (worker)
//   AprendizajeRepoError { codigo }: de todo error de `pg` solo se conserva el SQLSTATE (P0002, 55000, 23505, 22023, 42501...) o
//       "desconocido"; nunca el mensaje, el detalle ni la tabla (pueden traer RUC o razón social).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "../client";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import type { Tx } from "../with-tenant";
import {
  AprendizajeRepoError,
  completarImportacion,
  fallarImportacion,
  fijarTrabajoImportacion,
  iniciarImportacion,
  leerImportacion,
  ultimaImportacion,
  type CandidataNueva,
} from "./index";
import {
  abrirAdmin,
  abrirDb,
  exigirEntorno,
  sembrarEstudio,
  sembrarTrabajo,
  type Estudio,
} from "./soporte-prueba";

let admin: Pool;
let backend: ContappDb;
let worker: ContappDb;
let A: Estudio;
let B: Estudio; // otro estudio: nunca debe verse desde A
const limpiezas: Array<() => Promise<void>> = [];

beforeAll(async () => {
  exigirEntorno();
  admin = abrirAdmin();
  backend = abrirDb("contapp_backend");
  worker = abrirDb("contapp_worker");
  A = await sembrarEstudio(admin);
  limpiezas.push(A.limpiar);
  B = await sembrarEstudio(admin);
  limpiezas.push(B.limpiar);
}, 60_000);

afterAll(async () => {
  for (const l of limpiezas) await l().catch(() => undefined);
  await backend?.close();
  await worker?.close();
  await admin?.end();
});

const comoDueno = <T>(fn: (tx: Tx) => Promise<T>, e: Estudio = A): Promise<T> =>
  backend.withTenant({ tenantId: e.tenantId, userId: e.dueno.id }, fn);
const comoWorker = <T>(
  fn: (tx: Tx) => Promise<T>,
  e: Estudio = A,
): Promise<T> => worker.withTenant({ tenantId: e.tenantId }, fn);

async function falla(p: Promise<unknown>): Promise<AprendizajeRepoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AprendizajeRepoError);
    return e as AprendizajeRepoError;
  }
  throw new Error("se esperaba un AprendizajeRepoError y no falló");
}

const PERIODOS_6 = ["202610", "202609", "202608", "202607", "202606", "202605"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Importación sembrada con el superusuario (para estados que el backend no puede crear directo). */
async function sembrarImportacion(
  clienteId: string,
  o: {
    estado: "completada" | "fallida";
    hace?: string;
    sinDatos?: string[];
    candidatas?: number;
    sinCriterio?: number;
    motivo?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into regla_importacion (id, tenant_id, cliente_id, estado, periodos, periodo_hasta, solicitada_por, solicitada_en,
       terminada_en, periodos_leidos, periodos_sin_datos, candidatas, sin_criterio, motivo)
     values ($1, $2, $3, $4, $5::char(6)[], '202610', $6, now() - $7::interval, now() - $7::interval + interval '2 minutes', $8,
       $9::char(6)[], $10, $11, $12)`,
    [
      id,
      A.tenantId,
      clienteId,
      o.estado,
      PERIODOS_6,
      A.dueno.id,
      o.hace ?? "1 hour",
      o.estado === "completada" ? 6 - (o.sinDatos?.length ?? 0) : 0,
      o.estado === "completada" ? (o.sinDatos ?? []) : [],
      o.candidatas ?? 0,
      o.sinCriterio ?? 0,
      o.estado === "fallida" ? (o.motivo ?? "credencial_invalida") : null,
    ],
  );
  return id;
}

describe("iniciar y última importación (CA-5)", () => {
  it("iniciar crea una importación en curso con los periodos pedidos y quien la pidió", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    expect(id).toMatch(UUID);
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u).not.toBeNull();
    expect(u!.id).toBe(id);
    expect(u!.estado).toBe("en_curso");
    expect([...u!.periodos].sort()).toEqual([...PERIODOS_6].sort());
    expect(u!.solicitadaPor).toEqual({
      id: A.dueno.id,
      nombre: A.dueno.nombre,
    });
    expect(u!.solicitadaEn).toBeInstanceOf(Date);
    expect(u!.terminadaEn).toBeNull();
    expect(u!.resumen).toBeNull();
    expect(u!.motivo).toBeNull();
    expect(u!.trabajoId).toBeNull();
  });

  it("iniciar con un solo periodo y con los 12 periodos pasa", async () => {
    const uno = await A.nuevoCliente();
    const doce = await A.nuevoCliente();
    const periodos12 = Array.from(
      { length: 12 },
      (_, i) => `2025${String(i + 1).padStart(2, "0")}`,
    );
    await expect(
      comoDueno((tx) =>
        iniciarImportacion(tx, { clienteId: uno.id, periodos: ["202610"] }),
      ),
    ).resolves.toMatch(UUID);
    await expect(
      comoDueno((tx) =>
        iniciarImportacion(tx, { clienteId: doce.id, periodos: periodos12 }),
      ),
    ).resolves.toMatch(UUID);
  });

  it("fijar el trabajo lo deja visible en la última importación", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    const trabajoId = await sembrarTrabajo(admin, A, c);
    await comoDueno((tx) =>
      fijarTrabajoImportacion(tx, { importacionId: id, trabajoId }),
    );
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.trabajoId).toBe(trabajoId);
    expect(u!.estado).toBe("en_curso");
  });

  it("un cliente sin importaciones: null", async () => {
    const c = await A.nuevoCliente();
    expect(await comoDueno((tx) => ultimaImportacion(tx, c.id))).toBeNull();
  });

  it("devuelve la más reciente, aunque una anterior esté completada", async () => {
    const c = await A.nuevoCliente();
    const vieja = await sembrarImportacion(c.id, {
      estado: "completada",
      hace: "3 days",
      candidatas: 5,
    });
    expect((await comoDueno((tx) => ultimaImportacion(tx, c.id)))!.id).toBe(
      vieja,
    );
    const nueva = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.id).toBe(nueva);
    expect(u!.estado).toBe("en_curso");
  });

  it("completada: trae el resumen con los periodos sin datos y la fecha de término", async () => {
    const c = await A.nuevoCliente();
    await sembrarImportacion(c.id, {
      estado: "completada",
      sinDatos: ["202605"],
      candidatas: 12,
      sinCriterio: 3,
    });
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.estado).toBe("completada");
    expect(u!.resumen).toEqual({
      periodosLeidos: 5,
      periodosSinDatos: ["202605"],
      candidatas: 12,
      sinCriterio: 3,
    });
    expect(u!.terminadaEn).toBeInstanceOf(Date);
    expect(u!.motivo).toBeNull();
  });

  it("fallida: trae el motivo y no trae resumen", async () => {
    const c = await A.nuevoCliente();
    await sembrarImportacion(c.id, {
      estado: "fallida",
      motivo: "credencial_invalida",
    });
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.estado).toBe("fallida");
    expect(u!.motivo).toBe("credencial_invalida");
    expect(u!.resumen).toBeNull();
    expect(u!.terminadaEn).toBeInstanceOf(Date);
  });

  it("no mezcla clientes ni estudios", async () => {
    const c1 = await A.nuevoCliente();
    const c2 = await A.nuevoCliente();
    const cb = await B.nuevoCliente();
    await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c1.id, periodos: PERIODOS_6 }),
    );
    await comoDueno(
      (tx) =>
        iniciarImportacion(tx, { clienteId: cb.id, periodos: PERIODOS_6 }),
      B,
    );
    expect(await comoDueno((tx) => ultimaImportacion(tx, c2.id))).toBeNull();
    expect(await comoDueno((tx) => ultimaImportacion(tx, cb.id))).toBeNull(); // el cliente de B, visto desde A
    expect(
      await comoDueno((tx) => ultimaImportacion(tx, randomUUID())),
    ).toBeNull();
  });
});

describe("iniciar: errores traducidos con el SQLSTATE", () => {
  const hay = async (clienteId: string): Promise<boolean> =>
    (await comoDueno((tx) => ultimaImportacion(tx, clienteId))) !== null;

  it("cliente de otro estudio o inexistente: P0002, sin escribir", async () => {
    const cb = await B.nuevoCliente();
    expect(
      (
        await falla(
          comoDueno((tx) =>
            iniciarImportacion(tx, { clienteId: cb.id, periodos: PERIODOS_6 }),
          ),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          comoDueno((tx) =>
            iniciarImportacion(tx, {
              clienteId: randomUUID(),
              periodos: PERIODOS_6,
            }),
          ),
        )
      ).codigo,
    ).toBe("P0002");
    expect(await comoDueno((tx) => ultimaImportacion(tx, cb.id), B)).toBeNull();
  });

  it("cliente archivado: 55000", async () => {
    const e = await falla(
      comoDueno((tx) =>
        iniciarImportacion(tx, {
          clienteId: A.archivado.id,
          periodos: PERIODOS_6,
        }),
      ),
    );
    expect(e.codigo).toBe("55000");
    expect(await hay(A.archivado.id)).toBe(false);
  });

  it("ya hay una en curso: 23505 y la primera queda intacta", async () => {
    const c = await A.nuevoCliente();
    const primera = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    const e = await falla(
      comoDueno((tx) =>
        iniciarImportacion(tx, { clienteId: c.id, periodos: ["202610"] }),
      ),
    );
    expect(e.codigo).toBe("23505");
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.id).toBe(primera);
    expect(u!.estado).toBe("en_curso");
  });

  it.each([
    ["ningún periodo", []],
    [
      "13 periodos",
      [
        "202601",
        "202512",
        "202511",
        "202510",
        "202509",
        "202508",
        "202507",
        "202506",
        "202505",
        "202504",
        "202503",
        "202502",
        "202501",
      ],
    ],
    ["periodos repetidos", ["202610", "202610"]],
    ["periodo con formato inválido", ["2026-10"]],
    ["mes 13", ["202613"]],
  ])("%s: 22023 y no escribe", async (_nombre, periodos) => {
    const c = await A.nuevoCliente();
    const e = await falla(
      comoDueno((tx) => iniciarImportacion(tx, { clienteId: c.id, periodos })),
    );
    expect(e.codigo).toBe("22023");
    expect(await hay(c.id)).toBe(false);
  });

  it("sin usuario en el contexto: 42501", async () => {
    const c = await A.nuevoCliente();
    const e = await falla(
      backend.withTenant({ tenantId: A.tenantId }, (tx) =>
        iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
      ),
    );
    expect(e.codigo).toBe("42501");
  });
});

describe("traducción de errores (tx falsa): solo el SQLSTATE, nunca el mensaje ni el detalle", () => {
  const CLIENTE = "01990000-0000-7000-8000-000000000001";
  const IMPORTACION = "01990000-0000-7000-8000-000000000002";
  const CANARIO = "CANARIO-RUC-20100070970-RAZON-SOCIAL";
  const llamadas: Array<[string, (tx: never) => Promise<unknown>]> = [
    [
      "iniciar",
      (tx) =>
        iniciarImportacion(tx, { clienteId: CLIENTE, periodos: ["202610"] }),
    ],
    [
      "fijar trabajo",
      (tx) =>
        fijarTrabajoImportacion(tx, {
          importacionId: IMPORTACION,
          trabajoId: CLIENTE,
        }),
    ],
    ["última", (tx) => ultimaImportacion(tx, CLIENTE)],
    ["leer", (tx) => leerImportacion(tx, IMPORTACION)],
    [
      "completar",
      (tx) =>
        completarImportacion(tx, {
          importacionId: IMPORTACION,
          resumen: {
            periodosLeidos: 1,
            periodosSinDatos: [],
            candidatas: 0,
            sinCriterio: 0,
          },
          candidatas: [],
        }),
    ],
    [
      "fallar",
      (tx) =>
        fallarImportacion(tx, {
          importacionId: IMPORTACION,
          motivo: "credencial_invalida",
        }),
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
        expect(
          JSON.stringify({ ...err, message: err.message, stack: undefined }),
        ).not.toContain(CANARIO);
        expect(
          Object.keys(err).filter((k) =>
            ["detail", "where", "constraint", "table", "column"].includes(k),
          ),
        ).toEqual([]);
        expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
      },
    );

    it("sin SQLSTATE (o con uno mal formado): desconocido", async () => {
      for (const codigo of [undefined, "x", "toolong1"]) {
        const { tx } = txFalso(errorPg(codigo, CANARIO));
        const e = (await llamar(tx).then(
          () => null,
          (x: unknown) => x,
        )) as AprendizajeRepoError;
        expect(e).toBeInstanceOf(AprendizajeRepoError);
        expect(e.codigo).toBe("desconocido");
      }
    });
  });

  it("iniciar llama a la función acotada con el cliente y los periodos como parámetros", async () => {
    const { tx, llamadas: l } = txFalso(errorPg("P0002"));
    await iniciarImportacion(tx, {
      clienteId: CLIENTE,
      periodos: ["202610", "202609"],
    }).catch(() => undefined);
    expect(l).toHaveLength(1);
    expect(l[0]!.texto).toContain("reglas_importacion_iniciar");
    expect(l[0]!.valores).toEqual([CLIENTE, ["202610", "202609"]]);
  });
});

describe("worker: leer, completar y fallar (D-1, D-2, D-4)", () => {
  const candidata = (
    n: number,
    o: Partial<CandidataNueva> = {},
  ): CandidataNueva => ({
    proveedor: { tipo: "6", numero: `2010007097${n}` },
    razonSocial: `PROVEEDOR SINTETICO ${n} SAC`,
    destino: "DNG",
    conteos: { DG: 0, DGNG: 0, DNG: 4, mixto: 1, total: 5 },
    periodosConProveedor: 3,
    ...o,
  });
  const resumen = (candidatas: number, sinCriterio = 0) => ({
    periodosLeidos: 5,
    periodosSinDatos: ["202605"],
    candidatas,
    sinCriterio,
  });
  const filasCandidata = async (importacionId: string) =>
    (
      await admin.query(
        `select doc_tipo, doc_numero, razon_social, destino_propuesto, n_dg, n_dgng, n_dng, n_mixto, n_total,
                periodos_con_proveedor, estado
           from regla_candidata where importacion_id = $1 order by doc_tipo, doc_numero`,
        [importacionId],
      )
    ).rows;
  const reglasDe = async (clienteId: string): Promise<number> =>
    Number(
      (
        await admin.query(
          "select count(*) as n from regla_aprendida where cliente_id = $1",
          [clienteId],
        )
      ).rows[0].n,
    );

  it("leer devuelve el cliente, los periodos y el RUC del cliente", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    const l = await comoWorker((tx) => leerImportacion(tx, id));
    expect(l).not.toBeNull();
    expect(l!.id).toBe(id);
    expect(l!.clienteId).toBe(c.id);
    expect(l!.estado).toBe("en_curso");
    expect([...l!.periodos].sort()).toEqual([...PERIODOS_6].sort());
    expect(l!.ruc).toBe(c.ruc);
  });

  it("leer una importación de otro estudio o inexistente: null", async () => {
    const cb = await B.nuevoCliente();
    const idB = await comoDueno(
      (tx) =>
        iniciarImportacion(tx, { clienteId: cb.id, periodos: PERIODOS_6 }),
      B,
    );
    expect(await comoWorker((tx) => leerImportacion(tx, idB))).toBeNull();
    expect(
      await comoWorker((tx) => leerImportacion(tx, randomUUID())),
    ).toBeNull();
  });

  it("completar inserta las candidatas pendientes, deja el resumen y no crea reglas", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    const nuevas = [
      candidata(1),
      candidata(2, {
        destino: null,
        conteos: { DG: 2, DGNG: 0, DNG: 2, mixto: 0, total: 4 },
        razonSocial: null,
      }),
      candidata(3, {
        proveedor: { tipo: "1", numero: "45678912" },
        destino: "DG",
        conteos: { DG: 2, DGNG: 0, DNG: 0, mixto: 0, total: 2 },
      }),
    ];
    const n = await comoWorker((tx) =>
      completarImportacion(tx, {
        importacionId: id,
        resumen: resumen(3, 1),
        candidatas: nuevas,
      }),
    );
    expect(n).toBe(3);

    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.estado).toBe("completada");
    expect(u!.resumen).toEqual(resumen(3, 1));
    expect(u!.terminadaEn).toBeInstanceOf(Date);
    const filas = await filasCandidata(id);
    expect(filas).toHaveLength(3);
    expect(
      filas.map((f) => [
        f.doc_tipo,
        f.doc_numero,
        f.destino_propuesto,
        f.estado,
      ]),
    ).toEqual([
      ["1", "45678912", "DG", "pendiente"],
      ["6", "20100070971", "DNG", "pendiente"],
      ["6", "20100070972", null, "pendiente"],
    ]);
    expect(filas[1]).toMatchObject({
      razon_social: "PROVEEDOR SINTETICO 1 SAC",
      n_dg: 0,
      n_dgng: 0,
      n_dng: 4,
      n_mixto: 1,
      n_total: 5,
      periodos_con_proveedor: 3,
    });
    expect(filas[2]!.razon_social).toBeNull();
    expect(await reglasDe(c.id)).toBe(0);
  });

  it("completar con una candidata fuera de la gramática o del umbral: 22023 y no escribe nada", async () => {
    const malas: CandidataNueva[] = [
      candidata(1, { destino: "DG" }), // 0 de 5 en DG: no cumple el umbral
      candidata(1, { proveedor: { tipo: "6", numero: "123" } }), // RUC con largo inválido
      candidata(1, { conteos: { DG: 0, DGNG: 0, DNG: 4, mixto: 1, total: 9 } }), // el total no suma
      candidata(1, { destino: "XX" as never }),
    ];
    for (const mala of malas) {
      const c = await A.nuevoCliente();
      const id = await comoDueno((tx) =>
        iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
      );
      const e = await falla(
        comoWorker((tx) =>
          completarImportacion(tx, {
            importacionId: id,
            resumen: resumen(2),
            candidatas: [candidata(2), mala],
          }),
        ),
      );
      expect(e.codigo).toBe("22023");
      expect(await filasCandidata(id)).toEqual([]);
      expect(
        (await comoDueno((tx) => ultimaImportacion(tx, c.id)))!.estado,
      ).toBe("en_curso");
    }
  });

  it("fallar cierra la importación en curso con el motivo, sin candidatas", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    await comoWorker((tx) =>
      fallarImportacion(tx, {
        importacionId: id,
        motivo: "credencial_invalida",
      }),
    );
    const u = await comoDueno((tx) => ultimaImportacion(tx, c.id));
    expect(u!.estado).toBe("fallida");
    expect(u!.motivo).toBe("credencial_invalida");
    expect(u!.resumen).toBeNull();
    expect(u!.terminadaEn).toBeInstanceOf(Date);
    expect(await filasCandidata(id)).toEqual([]);
    // Cerrada la anterior, se puede pedir otra.
    await expect(
      comoDueno((tx) =>
        iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
      ),
    ).resolves.toMatch(UUID);
  });

  it("completar o fallar una importación que ya no está en curso: 55000", async () => {
    const c = await A.nuevoCliente();
    const id = await comoDueno((tx) =>
      iniciarImportacion(tx, { clienteId: c.id, periodos: PERIODOS_6 }),
    );
    await comoWorker((tx) =>
      fallarImportacion(tx, {
        importacionId: id,
        motivo: "credencial_invalida",
      }),
    );
    const tarde = await falla(
      comoWorker((tx) =>
        completarImportacion(tx, {
          importacionId: id,
          resumen: resumen(1),
          candidatas: [candidata(1)],
        }),
      ),
    );
    expect(tarde.codigo).toBe("55000");
    expect(await filasCandidata(id)).toEqual([]);
    expect((await comoDueno((tx) => ultimaImportacion(tx, c.id)))!.estado).toBe(
      "fallida",
    );
  });

  it("completar una importación de otro estudio o inexistente: P0002 o 55000, sin escribir", async () => {
    const cb = await B.nuevoCliente();
    const idB = await comoDueno(
      (tx) =>
        iniciarImportacion(tx, { clienteId: cb.id, periodos: PERIODOS_6 }),
      B,
    );
    for (const importacionId of [idB, randomUUID()]) {
      const e = await falla(
        comoWorker((tx) =>
          completarImportacion(tx, {
            importacionId,
            resumen: resumen(1),
            candidatas: [candidata(1)],
          }),
        ),
      );
      expect(["P0002", "55000"]).toContain(e.codigo);
    }
    expect(await filasCandidata(idB)).toEqual([]);
    expect(
      (await comoDueno((tx) => ultimaImportacion(tx, cb.id), B))!.estado,
    ).toBe("en_curso");
  });
});

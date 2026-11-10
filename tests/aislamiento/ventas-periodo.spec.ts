// Spec 012b (T4, rojo): estado del periodo de ventas (`venta_periodo`, 0039; P-1, D5, CA-10) y el trigger `periodo_worker_acotado`
// del worker sobre `compra_periodo` y `venta_periodo` (lección de 016: ningún grant amplio al worker). Contra la BD real.
// Hasta T10 fallan por tabla/trigger/función inexistente. Contrato completo: encabezado de `archivos-soporte.ts`.
//   leerEstadoPeriodoVentas(tx, clienteId, periodo, opciones?: { compartido?: boolean }): Promise<EstadoPeriodo>
//   fijarEstadoPeriodoVentas(tx, clienteId, periodo, desde, hacia, usuarioId): Promise<EstadoPeriodo | null>
//     (mismo contrato que `leerEstadoPeriodo` y `fijarEstadoPeriodo` de compras, 014; el estado de ventas es independiente).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import { abrirPool, intentar, type ContappDb, type Tx } from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import { barrera, codigoDe, conPlazo } from "./compras-soporte";
import {
  checksDe,
  columnasDe,
  fksDe,
  funcionesSinSearchPath,
  grantsColumnas,
  grantsTabla,
  rlsDe,
  triggersDe,
  unicasDe,
} from "./archivos-catalogo";
import {
  EscenarioArchivos,
  PERIODO,
  sostener,
  type EstadoPeriodoDb,
  type Libro,
} from "./archivos-soporte";

interface EstadoPeriodo {
  estado: EstadoPeriodoDb;
  marcadoPor: string | null;
  marcadoEn: Date | null;
}
const leerEstadoPeriodoVentas = (
  tx: Tx,
  c: string,
  p: string,
  o?: { compartido?: boolean },
) =>
  exportado<
    (tx: Tx, c: string, p: string, o?: unknown) => Promise<EstadoPeriodo>
  >("leerEstadoPeriodoVentas")(tx, c, p, o);
const fijarEstadoPeriodoVentas = (
  tx: Tx,
  c: string,
  p: string,
  desde: string,
  hacia: string,
  u: string,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      d: string,
      h: string,
      u: string,
    ) => Promise<EstadoPeriodo | null>
  >("fijarEstadoPeriodoVentas")(tx, c, p, desde, hacia, u);
const leerEstadoPeriodo = (
  tx: Tx,
  c: string,
  p: string,
  o?: { compartido?: boolean },
) =>
  exportado<
    (tx: Tx, c: string, p: string, o?: unknown) => Promise<EstadoPeriodo>
  >("leerEstadoPeriodo")(tx, c, p, o);

let admin: Pool;
let app: Pool;
let ec: EscenarioArchivos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cy: ClientePrueba;
let ux: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  app = abrirPool(2);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  uy = await ec.usuarioDe(Y);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((d) => d?.catch(() => undefined)),
  );
  await app?.end();
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const estadoEn = async (tabla: string, c: ClientePrueba, periodo = PERIODO) =>
  (
    await admin.query(
      `select estado, marcado_por from ${tabla} where cliente_id = $1 and periodo = $2`,
      [c.id, periodo],
    )
  ).rows;
const TABLAS: [Libro, string][] = [
  ["compras", "compra_periodo"],
  ["ventas", "venta_periodo"],
];

// =================================================================================================
describe("0039 · venta_periodo: forma igual a compra_periodo (P-1)", () => {
  it("mismas columnas, tipos y obligatoriedad que compra_periodo", async () => {
    const v = await columnasDe(admin, "venta_periodo");
    expect(
      v.map((c) => c.column_name),
      "falta venta_periodo (migracion 0039)",
    ).not.toHaveLength(0);
    const forma = (xs: typeof v) =>
      xs.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`).sort();
    expect(forma(v)).toEqual(forma(await columnasDe(admin, "compra_periodo")));
    expect(v.map((c) => c.column_name).sort()).toEqual(
      [
        "cliente_id",
        "estado",
        "marcado_en",
        "marcado_por",
        "periodo",
        "tenant_id",
      ].sort(),
    );
  });

  it("PK (tenant_id, cliente_id, periodo); FK compuestas a cliente y a membresia (marcado_por)", async () => {
    const pk = (await unicasDe(admin, "venta_periodo")).find((u) => u.pk);
    expect(pk?.columnas).toEqual(["tenant_id", "cliente_id", "periodo"]);
    const fk = await fksDe(admin, "venta_periodo");
    expect(fk.find((f) => f.destino === "cliente")).toMatchObject({
      columnas: ["tenant_id", "cliente_id"],
      destinos: ["tenant_id", "id"],
    });
    expect(fk.find((f) => f.destino === "membresia")).toMatchObject({
      columnas: ["tenant_id", "marcado_por"],
      destinos: ["tenant_id", "usuario_id"],
    });
  });

  it("CHECK de periodo AAAAMM y de estado (abierto, revisado, generado)", async () => {
    const defs = (await checksDe(admin, "venta_periodo"))
      .map((c) => c.def)
      .join("\n");
    expect(defs, "falta la tabla").not.toBe("");
    expect(defs).toContain("abierto");
    expect(defs).toContain("revisado");
    expect(defs).toContain("generado");
    const c = await ec.cliente(X);
    const b = (periodo: string, estado: string) =>
      intentar(
        backend,
        { tenantId: X },
        "insert into venta_periodo (cliente_id, periodo, estado) values ($1, $2, $3)",
        [c.id, periodo, estado],
      );
    expect(codigo(await b("2026-1", "abierto"))).toBe("23514");
    expect(codigo(await b("202613", "abierto"))).toBe("23514");
    expect(codigo(await b(PERIODO, "cerrado"))).toBe("23514");
    expect(codigo(await b(PERIODO, "abierto"))).toBe("ok");
  });

  it("RLS ENABLE + FORCE con tenant_isolation FOR ALL; dueno contapp_migrator", async () => {
    const { tabla, politicas } = await rlsDe(admin, "venta_periodo");
    expect(tabla, "falta venta_periodo (0039)").toBeDefined();
    expect(tabla).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      dueno: "contapp_migrator",
    });
    expect(politicas.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    expect(politicas[0].polcmd).toBe("*");
    expect(politicas[0].usando).toContain("app.tenant_id");
    expect(politicas[0].con_check).toContain("app.tenant_id");
  });

  it("grants exactos: backend y worker SELECT e INSERT y UPDATE solo de (estado, marcado_por, marcado_en); sin DELETE ni TRUNCATE; nadie mas", async () => {
    expect(await grantsTabla(admin, "venta_periodo")).toEqual({
      contapp_backend: ["INSERT", "SELECT"],
      contapp_worker: ["INSERT", "SELECT"],
    });
    const cols = ["estado", "marcado_en", "marcado_por"];
    expect(await grantsColumnas(admin, "venta_periodo")).toEqual({
      contapp_backend: { UPDATE: cols },
      contapp_worker: { UPDATE: cols },
    });
  });

  it("no hay dos filas para el mismo (cliente, periodo) (23505) y marcado_por tiene que ser miembro del estudio (23503)", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("ventas", X, c, PERIODO, "abierto");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          "insert into venta_periodo (cliente_id, periodo, estado) values ($1, $2, 'revisado')",
          [c.id, PERIODO],
        ),
      ),
    ).toBe("23505");
    const c2 = await ec.cliente(X);
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          "insert into venta_periodo (cliente_id, periodo, estado, marcado_por, marcado_en) values ($1, $2, 'revisado', $3, now())",
          [c2.id, PERIODO, uy],
        ),
      ),
    ).toBe("23503");
  });

  it("aislamiento: el otro estudio y la consulta sin contexto ven 0 filas; no se escribe para un cliente ajeno", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("ventas", X, c, PERIODO, "revisado", ux);
    expect(
      (
        await comoBackend((tx) =>
          tx.query("select 1 from venta_periodo where cliente_id = $1", [c.id]),
        )
      ).rows,
    ).toHaveLength(1);
    for (const db of [backend, worker])
      expect(
        (
          await db.withTenant({ tenantId: Y }, (tx) =>
            tx.query("select 1 from venta_periodo where cliente_id = $1", [
              c.id,
            ]),
          )
        ).rows,
      ).toEqual([]);
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          "insert into venta_periodo (cliente_id, periodo, estado) values ($1, $2, 'abierto')",
          [cy.id, PERIODO],
        ),
      ),
    ).toBe("23503");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: Y },
          "update venta_periodo set estado = 'abierto' where cliente_id = $1",
          [c.id],
        ),
      ),
    ).toBe("ok");
    expect(await estadoEn("venta_periodo", c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
  });
});

// =================================================================================================
describe("estado del periodo de ventas · repositorio (P-1, D5, CA-10)", () => {
  it("sin fila el periodo esta abierto y leer sin compartido no crea nada; con compartido crea la fila una sola vez", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) => leerEstadoPeriodoVentas(tx, c.id, PERIODO)),
    ).toEqual({
      estado: "abierto",
      marcadoPor: null,
      marcadoEn: null,
    });
    expect(await estadoEn("venta_periodo", c)).toEqual([]);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await comoBackend((tx) =>
            leerEstadoPeriodoVentas(tx, c.id, PERIODO, { compartido: true }),
          )
        ).estado,
      ).toBe("abierto");
    expect(await estadoEn("venta_periodo", c)).toEqual([
      { estado: "abierto", marcado_por: null },
    ]);
  });

  it("lee el estado sembrado con quien lo marco y cuando", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("ventas", X, c, PERIODO, "revisado", ux);
    expect(
      await comoBackend((tx) =>
        leerEstadoPeriodoVentas(tx, c.id, PERIODO, { compartido: true }),
      ),
    ).toEqual({
      estado: "revisado",
      marcadoPor: ux,
      marcadoEn: expect.any(Date),
    });
  });

  it("compare-and-set: abierto -> revisado marca quien y cuando (aun sin fila previa); repetirlo o esperar otro estado devuelve null", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) =>
        fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
      ),
    ).toEqual({
      estado: "revisado",
      marcadoPor: ux,
      marcadoEn: expect.any(Date),
    });
    expect(await estadoEn("venta_periodo", c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
    expect(
      await comoBackend((tx) =>
        fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
      ),
    ).toBeNull();
    expect(
      await comoBackend((tx) =>
        fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "generado", "abierto", ux),
      ),
    ).toBeNull();
    expect(await estadoEn("venta_periodo", c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
  });

  it("reabrir: revisado -> abierto y generado -> abierto (backend); el worker marca generado desde revisado y desde abierto", async () => {
    const c = await ec.cliente(X);
    await comoBackend((tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(
      (
        await comoBackend((tx) =>
          fijarEstadoPeriodoVentas(
            tx,
            c.id,
            PERIODO,
            "revisado",
            "abierto",
            ux,
          ),
        )
      )?.estado,
    ).toBe("abierto");
    await comoBackend((tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    const g = await worker.withTenant({ tenantId: X }, (tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "revisado", "generado", ux),
    );
    expect(g).toEqual({
      estado: "generado",
      marcadoPor: ux,
      marcadoEn: expect.any(Date),
    });
    expect(
      (
        await comoBackend((tx) =>
          fijarEstadoPeriodoVentas(
            tx,
            c.id,
            PERIODO,
            "generado",
            "abierto",
            ux,
          ),
        )
      )?.estado,
    ).toBe("abierto");
    const c2 = await ec.cliente(X);
    expect(
      (
        await worker.withTenant({ tenantId: X }, (tx) =>
          fijarEstadoPeriodoVentas(
            tx,
            c2.id,
            PERIODO,
            "abierto",
            "generado",
            ux,
          ),
        )
      )?.estado,
    ).toBe("generado");
  });

  it("el estado de ventas es independiente del de compras (mismo cliente y periodo)", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    expect(
      (await comoBackend((tx) => leerEstadoPeriodoVentas(tx, c.id, PERIODO)))
        .estado,
    ).toBe("abierto");
    await comoBackend((tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(
      (await comoBackend((tx) => leerEstadoPeriodo(tx, c.id, PERIODO))).estado,
    ).toBe("generado");
    expect(await estadoEn("compra_periodo", c)).toEqual([
      { estado: "generado", marcado_por: ux },
    ]);
    expect(await estadoEn("venta_periodo", c)).toEqual([
      { estado: "revisado", marcado_por: ux },
    ]);
  });

  it("un estado fuera de los tres valores no se guarda, y un periodo o cliente de otro estudio devuelve null/abierto", async () => {
    const c = await ec.cliente(X);
    expect(
      await codigoDe(
        comoBackend((tx) =>
          fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "cerrado", ux),
        ),
      ),
    ).not.toBe("ok");
    expect(await estadoEn("venta_periodo", c)).not.toContainEqual({
      estado: "cerrado",
      marcado_por: ux,
    });
    await ec.periodoDe("ventas", X, c, PERIODO, "revisado", ux);
    expect(
      (
        await backend.withTenant({ tenantId: Y }, (tx) =>
          leerEstadoPeriodoVentas(tx, c.id, PERIODO),
        )
      ).estado,
      "otro estudio: ve abierto",
    ).toBe("abierto");
  });

  it("10 rondas: dos cambios simultaneos abierto -> revisado, uno gana y el otro recibe null", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const llegar = barrera(2);
      const cambiar = () =>
        comoBackend(async (tx) => {
          await llegar();
          return fijarEstadoPeriodoVentas(
            tx,
            c.id,
            PERIODO,
            "abierto",
            "revisado",
            ux,
          );
        });
      const r = await Promise.all([cambiar(), cambiar()]);
      expect(
        r.filter((x) => x !== null),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      expect(await estadoEn("venta_periodo", c)).toEqual([
        { estado: "revisado", marcado_por: ux },
      ]);
    }
  });

  it("FOR SHARE frente a FOR UPDATE: cambiar el estado espera a quien lo lee en una escritura, y viceversa; dos escrituras no se bloquean", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("ventas", X, c, PERIODO, "abierto");
    const escritura = sostener(backend, X, (tx) =>
      leerEstadoPeriodoVentas(tx, c.id, PERIODO, { compartido: true }),
    );
    await escritura.dentro;
    const otra = comoBackend((tx) =>
      leerEstadoPeriodoVentas(tx, c.id, PERIODO, { compartido: true }),
    );
    expect(
      await conPlazo(otra, 1500),
      "dos escrituras (FOR SHARE) no se bloquean",
    ).not.toBe("pendiente");
    const cambio = comoBackend((tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "abierto", "revisado", ux),
    );
    expect(
      await conPlazo(cambio, 500),
      "el cambio de estado espera a la escritura",
    ).toBe("pendiente");
    escritura.soltar();
    await escritura.fin;
    expect((await cambio)?.estado).toBe("revisado");
    const reabrir = sostener(backend, X, (tx) =>
      fijarEstadoPeriodoVentas(tx, c.id, PERIODO, "revisado", "abierto", ux),
    );
    await reabrir.dentro;
    const siguiente = comoBackend((tx) =>
      leerEstadoPeriodoVentas(tx, c.id, PERIODO, { compartido: true }),
    );
    expect(
      await conPlazo(siguiente, 500),
      "la escritura espera al cambio de estado",
    ).toBe("pendiente");
    reabrir.soltar();
    await reabrir.fin;
    expect((await siguiente).estado).toBe("abierto");
  });
});

// =================================================================================================
describe("trigger periodo_worker_acotado (lección de 016): el worker no gana privilegios amplios", () => {
  it.each(TABLAS)(
    "%s: trigger BEFORE INSERT OR UPDATE por fila, de dueno contapp_migrator, con search_path fijo",
    async (_l, tabla) => {
      const t = (await triggersDe(admin, tabla)).filter(
        (x) => x.nombre === "periodo_worker_acotado",
      );
      expect(t, `falta periodo_worker_acotado en ${tabla} (0039)`).toHaveLength(
        1,
      );
      expect(t[0]).toMatchObject({
        porFila: true,
        antes: true,
        insert: true,
        update: true,
        delete: false,
        habilitado: "O",
        dueno: "contapp_migrator",
      });
      expect(
        (await funcionesSinSearchPath(admin, tabla)).map((x) => x.nombre),
      ).not.toContain("periodo_worker_acotado");
    },
  );

  describe.each(TABLAS)("%s", (libro, tabla) => {
    const INSERTAR = `insert into ${tabla} (cliente_id, periodo, estado, marcado_por, marcado_en)
      values ($1, $2, $3, $4::uuid, $5::timestamptz)`;
    const ACTUALIZAR = `update ${tabla} set estado = $3, marcado_por = $4::uuid, marcado_en = now() where cliente_id = $1 and periodo = $2`;

    it("el worker solo INSERTA `abierto` sin marca; `revisado`, `generado` o una marca dan 42501", async () => {
      const c = await ec.cliente(X);
      const w = (estado: string, por: string | null, en: string | null) =>
        intentar(worker, { tenantId: X }, INSERTAR, [
          c.id,
          PERIODO,
          estado,
          por,
          en,
        ]);
      expect(codigo(await w("abierto", null, null))).toBe("ok");
      expect(codigo(await w("revisado", null, null)), "revisado").toBe("42501");
      expect(
        codigo(await w("revisado", ux, new Date().toISOString())),
        "revisado marcado",
      ).toBe("42501");
      expect(
        codigo(await w("generado", ux, new Date().toISOString())),
        "generado",
      ).toBe("42501");
      expect(
        codigo(await w("abierto", ux, new Date().toISOString())),
        "abierto con marca",
      ).toBe("42501");
      expect(
        codigo(await w("abierto", ux, null)),
        "abierto con marcado_por",
      ).toBe("42501");
      expect(
        codigo(await w("abierto", null, new Date().toISOString())),
        "abierto con marcado_en",
      ).toBe("42501");
    });

    it("INSERT ... ON CONFLICT DO NOTHING del worker sobre una fila existente (incluso generada) no lanza ni cambia nada", async () => {
      const c = await ec.cliente(X);
      await ec.periodoDe(libro, X, c, PERIODO, "generado", ux);
      const r = await intentar(
        worker,
        { tenantId: X },
        `insert into ${tabla} (cliente_id, periodo, estado) values ($1, $2, 'abierto') on conflict do nothing`,
        [c.id, PERIODO],
      );
      expect(r).toEqual({ ok: true, rowCount: 0 });
      expect(await estadoEn(tabla, c)).toEqual([
        { estado: "generado", marcado_por: ux },
      ]);
    });

    it("el worker solo ACTUALIZA de abierto|revisado a generado con marcado_por no nulo", async () => {
      const casos: [
        string,
        EstadoPeriodoDb,
        string,
        string | null,
        "ok" | "42501",
      ][] = [
        ["abierto -> generado con marca", "abierto", "generado", ux, "ok"],
        ["revisado -> generado con marca", "revisado", "generado", ux, "ok"],
        [
          "abierto -> generado sin marcado_por",
          "abierto",
          "generado",
          null,
          "42501",
        ],
        [
          "revisado -> generado sin marcado_por",
          "revisado",
          "generado",
          null,
          "42501",
        ],
        ["abierto -> revisado", "abierto", "revisado", ux, "42501"],
        ["abierto -> abierto con marca", "abierto", "abierto", ux, "42501"],
        [
          "revisado -> abierto (reabrir es del backend)",
          "revisado",
          "abierto",
          null,
          "42501",
        ],
        ["revisado -> revisado", "revisado", "revisado", ux, "42501"],
        [
          "generado -> abierto (reabrir es del backend)",
          "generado",
          "abierto",
          null,
          "42501",
        ],
        ["generado -> revisado", "generado", "revisado", ux, "42501"],
        [
          "generado -> generado (otra marca)",
          "generado",
          "generado",
          ux,
          "42501",
        ],
      ];
      for (const [nombre, desde, hacia, por, esperado] of casos) {
        const c = await ec.cliente(X);
        await ec.periodoDe(
          libro,
          X,
          c,
          PERIODO,
          desde,
          desde === "abierto" ? null : ux,
        );
        const r = await intentar(worker, { tenantId: X }, ACTUALIZAR, [
          c.id,
          PERIODO,
          hacia,
          por,
        ]);
        expect(codigo(r), nombre).toBe(esperado);
        if (esperado === "ok")
          expect(r).toMatchObject({ ok: true, rowCount: 1 });
      }
    });

    it("el worker no puede cambiar solo la marca (marcado_por) de un periodo en ningun estado", async () => {
      for (const estado of ["abierto", "revisado", "generado"] as const) {
        const c = await ec.cliente(X);
        await ec.periodoDe(
          libro,
          X,
          c,
          PERIODO,
          estado,
          estado === "abierto" ? null : ux,
        );
        const r = await intentar(
          worker,
          { tenantId: X },
          `update ${tabla} set marcado_por = $3::uuid, marcado_en = now() where cliente_id = $1 and periodo = $2`,
          [c.id, PERIODO, ux],
        );
        expect(codigo(r), estado).toBe("42501");
      }
    });

    it("el rechazo es del trigger con mensaje fijo (sin cliente, periodo, usuario ni estado)", async () => {
      const c = await ec.cliente(X);
      await ec.periodoDe(libro, X, c, PERIODO, "generado", ux);
      const r = await intentar(worker, { tenantId: X }, ACTUALIZAR, [
        c.id,
        PERIODO,
        "abierto",
        null,
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        for (const dato of [c.id, PERIODO, ux, X])
          expect(r.message).not.toContain(dato);
      }
    });

    it("el backend sigue igual: inserta revisado, marca, reabre desde generado y lee con FOR SHARE", async () => {
      const c = await ec.cliente(X);
      expect(
        codigo(
          await intentar(backend, { tenantId: X }, INSERTAR, [
            c.id,
            PERIODO,
            "revisado",
            ux,
            new Date().toISOString(),
          ]),
        ),
      ).toBe("ok");
      await ec.periodoDe(libro, X, c, "202609", "generado", ux);
      for (const [hacia, por] of [
        ["abierto", null],
        ["revisado", ux],
        ["generado", ux],
      ] as const)
        expect(
          codigo(
            await intentar(backend, { tenantId: X }, ACTUALIZAR, [
              c.id,
              "202609",
              hacia,
              por,
            ]),
          ),
          `backend -> ${hacia}`,
        ).toBe("ok");
    });

    it("el worker lee con FOR SHARE un periodo en cualquier estado (la descarga de 014 y 016 sigue funcionando)", async () => {
      for (const estado of ["abierto", "revisado", "generado"] as const) {
        const c = await ec.cliente(X);
        await ec.periodoDe(
          libro,
          X,
          c,
          PERIODO,
          estado,
          estado === "abierto" ? null : ux,
        );
        const r = await worker.withTenant({ tenantId: X }, (tx) =>
          tx.query(
            `select estado from ${tabla} where cliente_id = $1 and periodo = $2 for share`,
            [c.id, PERIODO],
          ),
        );
        expect(r.rows).toEqual([{ estado }]);
      }
    });

    it("el worker no puede borrar filas del periodo (sin DELETE)", async () => {
      const c = await ec.cliente(X);
      await ec.periodoDe(libro, X, c, PERIODO, "abierto");
      expect(
        codigo(
          await intentar(
            worker,
            { tenantId: X },
            `delete from ${tabla} where cliente_id = $1`,
            [c.id],
          ),
        ),
      ).toBe("42501");
    });
  });

  it("el worker marca `generado` con las funciones de 014 y de 012b, desde abierto y desde revisado", async () => {
    const fijarCompras =
      exportado<
        (
          tx: Tx,
          c: string,
          p: string,
          d: string,
          h: string,
          u: string,
        ) => Promise<EstadoPeriodo | null>
      >("fijarEstadoPeriodo");
    for (const desde of ["abierto", "revisado"] as const) {
      const c = await ec.cliente(X);
      if (desde === "revisado") {
        await ec.periodoDe("compras", X, c, PERIODO, "revisado", ux);
        await ec.periodoDe("ventas", X, c, PERIODO, "revisado", ux);
      }
      const a = await worker.withTenant({ tenantId: X }, (tx) =>
        fijarCompras(tx, c.id, PERIODO, desde, "generado", ux),
      );
      const b = await worker.withTenant({ tenantId: X }, (tx) =>
        fijarEstadoPeriodoVentas(tx, c.id, PERIODO, desde, "generado", ux),
      );
      expect([a?.estado, b?.estado], desde).toEqual(["generado", "generado"]);
    }
  });
});

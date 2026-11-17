// Spec 023 (T4, rojo): tablas del buzon SOL en BD real (D-3, D-4, P-10; CA-9, CA-13). Catalogo (RLS FORCE, politica, columnas), grants
// por rol y por columna, integridad (FK compuesta, CHECK de rutas y de valores, unicas), trigger de inmutabilidad, aislamiento entre
// estudios con el mismo id de SUNAT y retencion al archivar. Falla hoy porque las migraciones 0054-0056 aun no existen. El contrato
// esta en la cabecera de buzon-soporte.ts.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnasConPriv, privTabla } from "./notificaciones-soporte";
import {
  abrirPool,
  enRollback,
  intentar,
  intentarRaw,
  type ContappDb,
} from "./soporte";
import {
  abrirAdmin,
  CATEGORIAS,
  comoRol,
  crearDb,
  enTx,
  EscenarioBuzon,
  insertarAdjunto,
  insertarMensaje,
  probar,
  ROLES_APP,
  rutaBuzon,
  sqlMensaje,
  TABLAS_BUZON,
  upsertEstado,
  type ClientePrueba,
} from "./buzon-soporte";

let admin: Pool;
let eb: EscenarioBuzon;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let uX: string; // miembro de X
let cx1: ClientePrueba;
let cx2: ClientePrueba;
let cx3: ClientePrueba;
let cx4: ClientePrueba;
let cy1: ClientePrueba;

beforeAll(async () => {
  admin = abrirAdmin(6);
  eb = new EscenarioBuzon(admin);
  X = (await eb.estudio()).id;
  Y = (await eb.estudio()).id;
  uX = (await eb.et.miembro(X, "contador")).id;
  cx1 = await eb.et.cliente(X);
  cx2 = await eb.et.cliente(X);
  cx3 = await eb.et.cliente(X);
  cx4 = await eb.et.cliente(X);
  cy1 = await eb.et.cliente(Y);
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await eb?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const ctxB = () => ({ tenantId: X, userId: uX });
const ctxW = () => ({ tenantId: X });
const rechazo = (r: { ok: boolean; code?: string }, code: string) => {
  expect(r.ok, "la sentencia debia fallar").toBe(false);
  if (!r.ok) expect((r as { code: string }).code).toBe(code);
};

/** Mensaje, adjunto y estado de X sembrados una sola vez (committed) con el superusuario. */
let sembrado: Promise<{ m: string; a: string; ruta: string }> | undefined;
const sembrar = () =>
  (sembrado ??= (async () => {
    await upsertEstado(admin, X, cx1.id, { capturaHace: "1 hour" });
    const m = await insertarMensaje(admin, X, cx1.id, {
      idSunat: "SEMBRADO-1",
      declarados: 1,
    });
    const ruta = rutaBuzon(X, cx1.id, "pdf");
    const a = await insertarAdjunto(admin, X, cx1.id, m, { ruta });
    return { m, a, ruta };
  })());

describe("catalogo: RLS forzada, politica y columnas (D-3, D-4)", () => {
  it.each(TABLAS_BUZON)(
    "%s tiene RLS ENABLE + FORCE y la politica tenant_isolation (prueba de catalogo de 002)",
    async (tabla) => {
      const c = await admin.query(
        `select c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where c.relname = $1`,
        [tabla],
      );
      expect(c.rows[0], `${tabla} existe`).toEqual({
        rls: true,
        forzada: true,
      });
      const p = await admin.query(
        "select policyname from pg_policies where schemaname = 'public' and tablename = $1",
        [tabla],
      );
      expect(p.rows.map((r) => r.policyname)).toContain("tenant_isolation");
      const col = await admin.query(
        `select a.attnotnull as no_nula, t.typname as tipo from pg_attribute a join pg_type t on t.oid = a.atttypid
        where a.attrelid = $1::regclass and a.attname = 'tenant_id' and not a.attisdropped`,
        [`public.${tabla}`],
      );
      expect(col.rows[0]).toEqual({ no_nula: true, tipo: "uuid" });
    },
  );

  const COLUMNAS: Record<string, string[]> = {
    buzon_estado_cliente: [
      "tenant_id",
      "cliente_id",
      "ultima_programada_en",
      "ultima_solicitud_en",
      "ultima_captura_en",
      "sincronizado_en",
      "cursor_pendiente",
    ],
    buzon_mensaje: [
      "id",
      "tenant_id",
      "cliente_id",
      "id_sunat",
      "asunto",
      "remitente",
      "fecha",
      "codigo_tipo",
      "categoria",
      "critico",
      "motivo_critico",
      "version_catalogo",
      "avisado",
      "leido_sunat",
      "primera_captura_en",
      "ultima_captura_en",
      "adjuntos_declarados",
      "contenido_ruta",
      "contenido_bytes",
      "contenido_obtenido_en",
    ],
    buzon_adjunto: [
      "id",
      "tenant_id",
      "cliente_id",
      "mensaje_id",
      "id_sunat",
      "nombre",
      "mime",
      "tamano",
      "sha256",
      "ruta",
      "omitido",
      "creado_en",
    ],
  };
  it.each(Object.keys(COLUMNAS))(
    "%s tiene las columnas del plan",
    async (tabla) => {
      const r = await admin.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
        [tabla],
      );
      expect(r.rows.map((x) => x.column_name)).toEqual(
        expect.arrayContaining(COLUMNAS[tabla]!),
      );
    },
  );

  it("buzon_programacion existe con su fila unica y las columnas del ciclo", async () => {
    const r = await admin.query("select * from buzon_programacion");
    expect(r.rows).toHaveLength(1);
    expect(Object.keys(r.rows[0]).sort()).toEqual(
      expect.arrayContaining([
        "ciclo_dueno",
        "ciclo_hasta",
        "intervalo_min",
        "lote_estudio",
        "reserva_interactiva",
        "ultimo_ciclo_fin",
        "ultimo_ciclo_inicio",
      ]),
    );
    expect(r.rows[0]).toMatchObject({
      intervalo_min: 15,
      reserva_interactiva: 50,
      lote_estudio: 1000,
    });
  });
});

describe("grants (D-3: nadie DELETE; backend sin INSERT en mensaje; worker sin UPDATE de categoria, critico ni avisado)", () => {
  it.each(ROLES_APP)(
    "%s no tiene DELETE ni TRUNCATE en ninguna tabla de buzon",
    async (rol) => {
      for (const t of [...TABLAS_BUZON, "buzon_programacion"]) {
        expect(
          await privTabla(admin, rol, t, "DELETE"),
          `${rol} DELETE ${t}`,
        ).toBe(false);
        expect(
          await privTabla(admin, rol, t, "TRUNCATE"),
          `${rol} TRUNCATE ${t}`,
        ).toBe(false);
      }
    },
  );

  it("buzon_programacion no da ningun privilegio a los roles de la app", async () => {
    for (const rol of [...ROLES_APP, "contapp_enumerador"]) {
      for (const priv of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        expect(
          await privTabla(admin, rol, "buzon_programacion", priv),
          `${rol} ${priv}`,
        ).toBe(false);
      }
    }
  });

  it("contapp_app y contapp_platform no tienen ningun privilegio sobre las tres tablas", async () => {
    for (const rol of ["contapp_app", "contapp_platform"]) {
      for (const t of TABLAS_BUZON) {
        for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
          expect(
            await privTabla(admin, rol, t, priv),
            `${rol} ${priv} ${t}`,
          ).toBe(false);
        }
      }
    }
  });

  it("backend: SELECT en las tres, sin INSERT en mensaje ni adjunto, UPDATE solo de ultima_solicitud_en en el estado", async () => {
    for (const t of TABLAS_BUZON)
      expect(
        await privTabla(admin, "contapp_backend", t, "SELECT"),
        `SELECT ${t}`,
      ).toBe(true);
    expect(
      await privTabla(admin, "contapp_backend", "buzon_mensaje", "INSERT"),
    ).toBe(false);
    expect(
      await privTabla(admin, "contapp_backend", "buzon_adjunto", "INSERT"),
    ).toBe(false);
    expect(
      await columnasConPriv(
        admin,
        "contapp_backend",
        "buzon_mensaje",
        "UPDATE",
      ),
    ).toEqual([]);
    expect(
      await columnasConPriv(
        admin,
        "contapp_backend",
        "buzon_adjunto",
        "UPDATE",
      ),
    ).toEqual([]);
    expect(
      await columnasConPriv(
        admin,
        "contapp_backend",
        "buzon_estado_cliente",
        "UPDATE",
      ),
    ).toEqual(["ultima_solicitud_en"]);
  });

  it("worker: mensaje SELECT e INSERT; UPDATE solo de leido_sunat, ultima_captura_en y contenido_* (sin categoria, critico ni avisado)", async () => {
    expect(
      await privTabla(admin, "contapp_worker", "buzon_mensaje", "SELECT"),
    ).toBe(true);
    expect(
      await privTabla(admin, "contapp_worker", "buzon_mensaje", "INSERT"),
    ).toBe(true);
    expect(
      await columnasConPriv(admin, "contapp_worker", "buzon_mensaje", "UPDATE"),
    ).toEqual([
      "contenido_bytes",
      "contenido_obtenido_en",
      "contenido_ruta",
      "leido_sunat",
      "ultima_captura_en",
    ]);
  });

  it("worker: adjunto SELECT e INSERT sin UPDATE; estado SELECT, INSERT y UPDATE solo de ultima_captura_en, sincronizado_en y cursor_pendiente", async () => {
    expect(
      await privTabla(admin, "contapp_worker", "buzon_adjunto", "SELECT"),
    ).toBe(true);
    expect(
      await privTabla(admin, "contapp_worker", "buzon_adjunto", "INSERT"),
    ).toBe(true);
    expect(
      await columnasConPriv(admin, "contapp_worker", "buzon_adjunto", "UPDATE"),
    ).toEqual([]);
    expect(
      await privTabla(
        admin,
        "contapp_worker",
        "buzon_estado_cliente",
        "SELECT",
      ),
    ).toBe(true);
    expect(
      await privTabla(
        admin,
        "contapp_worker",
        "buzon_estado_cliente",
        "INSERT",
      ),
    ).toBe(true);
    expect(
      await columnasConPriv(
        admin,
        "contapp_worker",
        "buzon_estado_cliente",
        "UPDATE",
      ),
    ).toEqual(["cursor_pendiente", "sincronizado_en", "ultima_captura_en"]);
  });
});

describe("grants en accion: lo que cada rol puede y no puede hacer (D-3)", () => {
  it("el backend lee los mensajes y adjuntos de su estudio", async () => {
    const s = await sembrar();
    const r = await enRollback(backend, ctxB(), async (tx) => ({
      m: (await tx.query("select id from buzon_mensaje")).rows.map((x) => x.id),
      a: (await tx.query("select id from buzon_adjunto")).rows.map((x) => x.id),
    }));
    expect(r.m).toContain(s.m);
    expect(r.a).toContain(s.a);
  });

  it("el backend no inserta mensajes ni adjuntos (42501)", async () => {
    const s = await sembrar();
    const m = sqlMensaje(X, cx2.id, {});
    rechazo(await intentar(backend, ctxB(), m.text, m.values), "42501");
    rechazo(
      await intentar(
        backend,
        ctxB(),
        `insert into buzon_adjunto (tenant_id, cliente_id, mensaje_id, id_sunat, nombre, omitido) values ($1, $2, $3, 'A-x', 'n', 'mime')`,
        [X, cx1.id, s.m],
      ),
      "42501",
    );
  });

  it("el backend solo cambia ultima_solicitud_en del estado", async () => {
    await sembrar();
    const ok = await intentar(
      backend,
      ctxB(),
      "update buzon_estado_cliente set ultima_solicitud_en = now() where cliente_id = $1",
      [cx1.id],
    );
    expect(ok).toEqual({ ok: true, rowCount: 1 });
    for (const col of [
      "ultima_captura_en",
      "sincronizado_en",
      "ultima_programada_en",
    ]) {
      rechazo(
        await intentar(
          backend,
          ctxB(),
          `update buzon_estado_cliente set ${col} = now() where cliente_id = $1`,
          [cx1.id],
        ),
        "42501",
      );
    }
    rechazo(
      await intentar(
        backend,
        ctxB(),
        "update buzon_mensaje set leido_sunat = true",
      ),
      "42501",
    );
  });

  it("nadie borra: ni el backend ni el worker pueden hacer DELETE en las tres tablas (42501)", async () => {
    await sembrar();
    for (const t of TABLAS_BUZON) {
      rechazo(await intentar(backend, ctxB(), `delete from ${t}`), "42501");
      rechazo(await intentar(worker, ctxW(), `delete from ${t}`), "42501");
    }
  });

  it("el worker inserta un mensaje y actualiza leido_sunat y ultima_captura_en", async () => {
    const s = await sembrar();
    const m = sqlMensaje(X, cx2.id, { idSunat: "W-1" });
    expect(await intentar(worker, ctxW(), m.text, m.values)).toEqual({
      ok: true,
      rowCount: 1,
    });
    expect(
      await intentar(
        worker,
        ctxW(),
        "update buzon_mensaje set leido_sunat = true, ultima_captura_en = now() where id = $1",
        [s.m],
      ),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("el worker no cambia categoria, critico, motivo, avisado, asunto ni fecha de un mensaje ya guardado (42501)", async () => {
    const s = await sembrar();
    for (const set of [
      "categoria = 'coactiva'",
      "critico = true",
      "motivo_critico = 'duda'",
      "avisado = true",
      "asunto = 'otro asunto'",
      "fecha = now()",
      "cliente_id = gen_random_uuid()",
    ]) {
      rechazo(
        await intentar(
          worker,
          ctxW(),
          `update buzon_mensaje set ${set} where id = $1`,
          [s.m],
        ),
        "42501",
      );
    }
  });

  it("el worker no actualiza adjuntos (42501)", async () => {
    const s = await sembrar();
    rechazo(
      await intentar(
        worker,
        ctxW(),
        "update buzon_adjunto set nombre = 'x' where id = $1",
        [s.a],
      ),
      "42501",
    );
  });

  it("el worker crea el estado del cliente y cambia solo ultima_captura_en, sincronizado_en y cursor_pendiente", async () => {
    await sembrar();
    const crear = await intentar(
      worker,
      ctxW(),
      "insert into buzon_estado_cliente (tenant_id, cliente_id, ultima_captura_en) values ($1, $2, now())",
      [X, cx2.id],
    );
    expect(crear).toEqual({ ok: true, rowCount: 1 });
    expect(
      await intentar(
        worker,
        ctxW(),
        "update buzon_estado_cliente set ultima_captura_en = now(), sincronizado_en = now(), cursor_pendiente = 'c1' where cliente_id = $1",
        [cx1.id],
      ),
    ).toEqual({ ok: true, rowCount: 1 });
    for (const col of ["ultima_programada_en", "ultima_solicitud_en"]) {
      rechazo(
        await intentar(
          worker,
          ctxW(),
          `update buzon_estado_cliente set ${col} = now() where cliente_id = $1`,
          [cx1.id],
        ),
        "42501",
      );
    }
  });

  it("contapp_app (el login) no lee nada de buzon: 42501", async () => {
    for (const t of TABLAS_BUZON) {
      rechazo(
        await intentarRaw(
          poolApp(),
          "contapp_app",
          `select count(*) from ${t}`,
        ),
        "42501",
      );
    }
  });
});

let poolAppCache: Pool | undefined;
const poolApp = (): Pool => (poolAppCache ??= abrirPool(2));
afterAll(async () => {
  await poolAppCache?.end();
});

describe("integridad de mensaje, adjunto y estado (D-3, D-4)", () => {
  /** Ejecuta `pasos` en el superusuario, con rollback; devuelve el resultado de la ULTIMA sentencia probada. */
  const enAdmin = <T>(pasos: (c: PoolClient) => Promise<T>) =>
    enTx(admin, null, pasos);

  it("la FK compuesta de mensaje rechaza un cliente de otro estudio y uno inexistente (23503)", async () => {
    const otro = sqlMensaje(X, cy1.id);
    const inexistente = sqlMensaje(X, randomUUID());
    const r = await enAdmin(async (c) => [
      await probar(c, otro.text, otro.values),
      await probar(c, inexistente.text, inexistente.values),
    ]);
    for (const x of r) rechazo(x, "23503");
  });

  it("(tenant, cliente, id de SUNAT) es unico: repetirlo da 23505, y con ON CONFLICT DO NOTHING no inserta", async () => {
    const r = await enAdmin(async (c) => {
      await insertarMensaje(c, X, cx1.id, { idSunat: "UNICO-1" });
      const dup = sqlMensaje(X, cx1.id, { idSunat: "UNICO-1" });
      const ignorado = sqlMensaje(X, cx1.id, {
        idSunat: "UNICO-1",
        conflicto: true,
      });
      return [
        await probar(c, dup.text, dup.values),
        await probar(c, ignorado.text, ignorado.values),
      ];
    });
    rechazo(r[0]!, "23505");
    expect(r[1]).toMatchObject({ ok: true, rowCount: 0 });
  });

  it("el mismo id de SUNAT en otro cliente del mismo estudio si se admite", async () => {
    const r = await enAdmin(async (c) => {
      await insertarMensaje(c, X, cx1.id, { idSunat: "MISMO" });
      const otro = sqlMensaje(X, cx2.id, { idSunat: "MISMO" });
      return probar(c, otro.text, otro.values);
    });
    expect(r.ok).toBe(true);
  });

  it("CHECK de valores del mensaje: id de SUNAT 1..64, asunto <= 500, remitente <= 200, categoria, motivo y avisado -> critico (23514)", async () => {
    const malos = [
      sqlMensaje(X, cx1.id, { idSunat: "" }),
      sqlMensaje(X, cx1.id, { idSunat: "x".repeat(65) }),
      sqlMensaje(X, cx1.id, { asunto: "a".repeat(501) }),
      sqlMensaje(X, cx1.id, { remitente: "r".repeat(201) }),
      sqlMensaje(X, cx1.id, { categoria: "factura" }),
      sqlMensaje(X, cx1.id, {
        critico: true,
        avisado: true,
        motivo: "otro_motivo",
      }),
      sqlMensaje(X, cx1.id, { critico: false, avisado: true }),
    ];
    const r = await enAdmin(async (c) => {
      const salida = [];
      for (const m of malos) salida.push(await probar(c, m.text, m.values));
      return salida;
    });
    r.forEach((x, i) =>
      expect(x.ok === false && x.code, `caso ${i}`).toBe("23514"),
    );
  });

  it("acepta las cinco categorias y los limites exactos (id de 64, asunto de 500, remitente de 200)", async () => {
    const r = await enAdmin(async (c) => {
      const salida = [];
      for (const categoria of CATEGORIAS) {
        const m = sqlMensaje(X, cx1.id, {
          categoria,
          critico: categoria !== "otro",
          avisado: categoria !== "otro",
        });
        salida.push(await probar(c, m.text, m.values));
      }
      const limites = sqlMensaje(X, cx2.id, {
        idSunat: "i".repeat(64),
        asunto: "a".repeat(500),
        remitente: "r".repeat(200),
      });
      salida.push(await probar(c, limites.text, limites.values));
      return salida;
    });
    r.forEach((x, i) => expect(x.ok, `caso ${i}`).toBe(true));
  });

  it("CHECK de ruta de contenido: solo 'buzon/{estudio}/{cliente}/{uuid}.{ext}' de la propia fila (23514)", async () => {
    const buenas = [rutaBuzon(X, cx1.id, "txt")];
    const malas = [
      rutaBuzon(Y, cx1.id, "txt"), // otro estudio
      rutaBuzon(X, cx2.id, "txt"), // otro cliente
      `buzon/${X}/${cx1.id}/factura-marzo.txt`, // nombre original, no uuid
      `buzon/${X}/${cx1.id}/${randomUUID()}`, // sin extension
      `buzon/${X}/${cx1.id}/../${randomUUID()}.txt`, // escape de carpeta
      `xml/${X}/${cx1.id}/${randomUUID()}.txt`, // otro prefijo
      `/buzon/${X}/${cx1.id}/${randomUUID()}.txt`, // absoluta
    ];
    const r = await enAdmin(async (c) => {
      const salida = [];
      for (const ruta of [...buenas, ...malas]) {
        const m = sqlMensaje(X, cx1.id, { contenidoRuta: ruta });
        salida.push(await probar(c, m.text, m.values));
      }
      return salida;
    });
    expect(r[0]!.ok, "ruta valida").toBe(true);
    r.slice(1).forEach((x, i) =>
      expect(x.ok === false && x.code, `ruta mala ${i}`).toBe("23514"),
    );
  });

  it("la FK compuesta del adjunto impide un mensaje de otro cliente o de otro estudio (ids cruzados, 23503)", async () => {
    const r = await enAdmin(async (c) => {
      const m1 = await insertarMensaje(c, X, cx1.id);
      const mY = await insertarMensaje(c, Y, cy1.id);
      const cruzadoCliente = sqlAdjuntoCrudo(X, cx2.id, m1); // mensaje de cx1 con cliente cx2
      const cruzadoEstudio = sqlAdjuntoCrudo(X, cx1.id, mY); // mensaje de otro estudio
      const cruzadoTodo = sqlAdjuntoCrudo(Y, cy1.id, m1); // estudio y cliente de Y con el mensaje de X
      return [
        await probar(c, cruzadoCliente.text, cruzadoCliente.values),
        await probar(c, cruzadoEstudio.text, cruzadoEstudio.values),
        await probar(c, cruzadoTodo.text, cruzadoTodo.values),
      ];
    });
    r.forEach((x, i) =>
      expect(x.ok === false && x.code, `cruce ${i}`).toBe("23503"),
    );
  });

  it("un adjunto del mensaje correcto se inserta y (tenant, mensaje, id de SUNAT) es unico", async () => {
    const r = await enAdmin(async (c) => {
      const m = await insertarMensaje(c, X, cx1.id);
      const a = sqlAdjuntoCrudo(X, cx1.id, m, { idSunat: "ADJ-1" });
      const bien = await probar(c, a.text, a.values);
      const repetido = await probar(c, a.text, a.values);
      return [bien, repetido];
    });
    expect(r[0]!.ok).toBe(true);
    rechazo(r[1]!, "23505");
  });

  it("CHECK del adjunto: (ruta IS NULL) = (omitido IS NOT NULL), motivo valido y sha256 de 32 bytes (23514)", async () => {
    const r = await enAdmin(async (c) => {
      const m = await insertarMensaje(c, X, cx1.id);
      const casos = [
        sqlAdjuntoCrudo(X, cx1.id, m, { ruta: null, omitido: null }), // sin ruta y sin motivo
        sqlAdjuntoCrudo(X, cx1.id, m, { omitido: "mime" }), // con ruta y con motivo
        sqlAdjuntoCrudo(X, cx1.id, m, {
          ruta: null,
          omitido: "virus",
          mime: null,
          tamano: null,
          sha256: null,
        }),
        sqlAdjuntoCrudo(X, cx1.id, m, { sha256: Buffer.alloc(31, 1) }),
        sqlAdjuntoCrudo(X, cx1.id, m, {
          ruta: `buzon/${Y}/${cx1.id}/${randomUUID()}.pdf`,
        }), // ruta de otro estudio
        sqlAdjuntoCrudo(X, cx1.id, m, {
          ruta: `buzon/${X}/${cx1.id}/factura.pdf`,
        }), // nombre original
      ];
      const salida = [];
      for (const k of casos) salida.push(await probar(c, k.text, k.values));
      return salida;
    });
    r.forEach((x, i) =>
      expect(x.ok === false && x.code, `caso ${i}`).toBe("23514"),
    );
  });

  it("un adjunto omitido (mime, tamano, tope_mensaje) no lleva ruta, tipo, tamano ni hash", async () => {
    const r = await enAdmin(async (c) => {
      const m = await insertarMensaje(c, X, cx1.id);
      const salida = [];
      for (const omitido of ["mime", "tamano", "tope_mensaje"]) {
        const a = sqlAdjuntoCrudo(X, cx1.id, m, {
          omitido,
          ruta: null,
          mime: null,
          tamano: null,
          sha256: null,
        });
        salida.push(await probar(c, a.text, a.values));
      }
      return salida;
    });
    r.forEach((x, i) => expect(x.ok, `omitido ${i}`).toBe(true));
  });

  it("estado: cursor_pendiente <= 200 (23514), clave (tenant, cliente) unica (23505) y cliente ajeno (23503)", async () => {
    const insertar = `insert into buzon_estado_cliente (tenant_id, cliente_id, cursor_pendiente) values ($1, $2, $3)`;
    const r = await enAdmin(async (c) => {
      const ok = await probar(c, insertar, [X, cx3.id, "c".repeat(200)]);
      const repetido = await probar(c, insertar, [X, cx3.id, null]);
      const largo = await probar(c, insertar, [X, cx4.id, "c".repeat(201)]);
      const ajeno = await probar(c, insertar, [X, cy1.id, null]);
      return { ok, repetido, largo, ajeno };
    });
    expect(r.ok.ok).toBe(true);
    rechazo(r.repetido, "23505");
    rechazo(r.largo, "23514");
    rechazo(r.ajeno, "23503");
  });
});

/** INSERT de adjunto sin las ayudas que arman la fila correcta: deja pasar ids y rutas cruzados. */
function sqlAdjuntoCrudo(
  tenantId: string,
  clienteId: string,
  mensajeId: string,
  o: {
    idSunat?: string;
    ruta?: string | null;
    omitido?: string | null;
    mime?: string | null;
    tamano?: number | null;
    sha256?: Buffer | null;
  } = {},
) {
  const omitido = o.omitido === undefined ? null : o.omitido;
  return {
    text: `insert into buzon_adjunto (tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido)
           values ($1, $2, $3, $4, 'factura.pdf', $5, $6, $7, $8, $9)`,
    values: [
      tenantId,
      clienteId,
      mensajeId,
      o.idSunat ?? `A-${randomUUID().slice(0, 10)}`,
      o.mime === undefined ? "application/pdf" : o.mime,
      o.tamano === undefined ? 100 : o.tamano,
      o.sha256 === undefined ? Buffer.alloc(32, 7) : o.sha256,
      o.ruta === undefined ? rutaBuzon(tenantId, clienteId, "pdf") : o.ruta,
      omitido,
    ],
  };
}

describe("trigger buzon_mensaje_inmutable: el worker no reescribe lo ya guardado (D-3)", () => {
  it("contenido_ruta pasa una sola vez de NULL a un valor; cambiarla despues da 42501", async () => {
    const m = await insertarMensaje(admin, X, cx1.id, {
      idSunat: `INM-${randomUUID().slice(0, 8)}`,
    });
    const ruta1 = rutaBuzon(X, cx1.id, "txt");
    const ruta2 = rutaBuzon(X, cx1.id, "txt");
    const poner = (ruta: string) =>
      intentar(
        worker,
        ctxW(),
        "update buzon_mensaje set contenido_ruta = $2, contenido_bytes = 10, contenido_obtenido_en = now() where id = $1",
        [m, ruta],
      );
    // Primera vez (confirmada con el rol del worker): NULL -> valor.
    const primero = await worker.withTenant(ctxW(), async (tx) => {
      const r = await tx.query(
        "update buzon_mensaje set contenido_ruta = $2, contenido_bytes = 10, contenido_obtenido_en = now() where id = $1",
        [m, ruta1],
      );
      return { ok: true, rowCount: r.rowCount };
    });
    expect(primero).toEqual({ ok: true, rowCount: 1 });
    rechazo(await poner(ruta2), "42501");
    rechazo(
      await intentar(
        worker,
        ctxW(),
        "update buzon_mensaje set contenido_ruta = null where id = $1",
        [m],
      ),
      "42501",
    );
    const fila = (
      await admin.query(
        "select contenido_ruta from buzon_mensaje where id = $1",
        [m],
      )
    ).rows[0];
    expect(fila.contenido_ruta).toBe(ruta1);
  });

  it("el superusuario si puede reclasificar un mensaje (categoria distinta, sigue critico)", async () => {
    const r = await enTx(admin, null, async (c) => {
      const m = await insertarMensaje(c, X, cx2.id, {
        critico: true,
        avisado: true,
        categoria: "coactiva",
      });
      return probar(
        c,
        "update buzon_mensaje set categoria = 'resolucion_multa' where id = $1",
        [m],
      );
    });
    expect(r.ok).toBe(true);
  });
});

describe("aislamiento entre estudios (CA-9): el mismo id de SUNAT en dos estudios no se mezcla", () => {
  it("cada estudio ve solo lo suyo y sin withTenant no se ve nada", async () => {
    const idSunat = `COMUN-${randomUUID().slice(0, 8)}`;
    const mX = await insertarMensaje(admin, X, cx1.id, { idSunat });
    const mY = await insertarMensaje(admin, Y, cy1.id, { idSunat });
    const ver = (db: ContappDb, tenantId: string) =>
      enRollback(db, { tenantId, userId: uX }, async (tx) =>
        (
          await tx.query("select id from buzon_mensaje where id_sunat = $1", [
            idSunat,
          ])
        ).rows.map((r) => r.id),
      );
    expect(await ver(backend, X)).toEqual([mX]);
    expect(await ver(backend, Y)).toEqual([mY]);
    expect(await ver(worker, X)).toEqual([mX]);
    expect(await ver(worker, Y)).toEqual([mY]);
    // Sin app.tenant_id (rol con SELECT, sin withTenant): RLS FORCE deja cero filas.
    for (const rol of ["contapp_backend", "contapp_worker"]) {
      const filas = await comoRol(
        admin,
        rol,
        null,
        async (c) =>
          (
            await c.query("select id from buzon_mensaje where id_sunat = $1", [
              idSunat,
            ])
          ).rows,
      );
      expect(filas, rol).toEqual([]);
      for (const t of ["buzon_adjunto", "buzon_estado_cliente"]) {
        const f = await comoRol(
          admin,
          rol,
          null,
          async (c) =>
            (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n,
        );
        expect(f, `${rol} ${t}`).toBe(0);
      }
    }
  });

  it("el worker de X no inserta, ni lee, un mensaje del estudio Y (RLS: 42501)", async () => {
    const m = sqlMensaje(Y, cy1.id, { idSunat: "CRUCE" });
    rechazo(await intentar(worker, ctxW(), m.text, m.values), "42501");
    const filas = await enRollback(
      worker,
      ctxW(),
      async (tx) =>
        (
          await tx.query("select id from buzon_mensaje where cliente_id = $1", [
            cy1.id,
          ])
        ).rows,
    );
    expect(filas).toEqual([]);
  });
});

describe("retencion (P-10, CA-13): archivar el cliente conserva mensajes, contenido y adjuntos", () => {
  it("las filas siguen legibles tras archivar y ninguna funcion de purga de buzon existe", async () => {
    const c = await eb.clienteCon(X, { cred: "configurada" });
    const ruta = rutaBuzon(X, c.id, "txt");
    const m = await insertarMensaje(admin, X, c.id, {
      idSunat: "RET-1",
      contenidoRuta: ruta,
      declarados: 2,
    });
    await insertarAdjunto(admin, X, c.id, m, { idSunat: "RET-A1" });
    await insertarAdjunto(admin, X, c.id, m, {
      idSunat: "RET-A2",
      omitido: "tamano",
    });
    await upsertEstado(admin, X, c.id, {
      capturaHace: "1 day",
      sincronizadoHace: "1 day",
    });
    const antes = await contar(c.id);
    expect(antes).toEqual({ mensajes: 1, adjuntos: 2, estados: 1 });
    await admin.query("update cliente set archivado_at = now() where id = $1", [
      c.id,
    ]);
    const despues = await enRollback(backend, ctxB(), async (tx) => ({
      mensajes: (
        await tx.query(
          "select count(*)::int as n from buzon_mensaje where cliente_id = $1 and contenido_ruta = $2",
          [c.id, ruta],
        )
      ).rows[0].n,
      adjuntos: (
        await tx.query(
          "select count(*)::int as n from buzon_adjunto where cliente_id = $1",
          [c.id],
        )
      ).rows[0].n,
      estados: (
        await tx.query(
          "select count(*)::int as n from buzon_estado_cliente where cliente_id = $1",
          [c.id],
        )
      ).rows[0].n,
    }));
    expect(despues).toEqual({ mensajes: 1, adjuntos: 2, estados: 1 });
    const purgas = await admin.query(
      `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname ~ 'buzon' and p.proname ~ '(purg|borr|elimin|limpi)'`,
    );
    expect(purgas.rows).toEqual([]);
  });

  it("las filas cuelgan del cliente: un mensaje o adjunto de un cliente que no existe no se inserta (23503)", async () => {
    const r = await enTx(admin, null, async (c) => {
      const a = sqlAdjuntoCrudo(X, randomUUID(), randomUUID());
      return probar(c, a.text, a.values);
    });
    rechazo(r, "23503");
  });
});

async function contar(clienteId: string) {
  const f = async (t: string) =>
    (
      await admin.query(
        `select count(*)::int as n from ${t} where cliente_id = $1`,
        [clienteId],
      )
    ).rows[0].n as number;
  return {
    mensajes: await f("buzon_mensaje"),
    adjuntos: await f("buzon_adjunto"),
    estados: await f("buzon_estado_cliente"),
  };
}

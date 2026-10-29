// Spec 008 (T3, rojo): comportamiento de la BD de trabajos (CA-4, CA-9, CA-12, CA-13, CA-15; D2, D8, D13, D16, D18, D19).
// Cada archivo crea sus estudios, usuarios, clientes, credenciales y trabajos con el rol administrativo
// (EscenarioTrabajos) y los borra al final; ninguna prueba toca el seed ni deja datos (las que confirman cambios
// lo hacen sobre filas propias; las de auth.purgar corren dentro de una transaccion que se revierte).
//
// Contrato que fija (T7, migraciones 0017 y 0018; ver el encabezado de trabajos.spec.ts para el catalogo):
// - job_registro: RLS por estudio (sin contexto, 0 filas; INSERT con tenant_id ajeno -> 42501; FK compuestas -> 23503);
//   CHECK (23514) de tipo ^[a-z]+(\.[a-z_]+)+$, cola, canal, prioridad, estado, motivo, parametros y resultado <= 4096
//   octetos (octet_length(x::text), no caracteres) y clave_dedupe de 32 bytes; indice unico parcial (tenant_id,
//   clave_dedupe) solo con estado en_cola/ejecutando (23505). Valores por defecto: id, tenant_id (contexto), intentos 0,
//   disponible_desde, creado_en y actualizado_en (el INSERT del backend no los manda).
// - grants por columna (comportamiento): el backend solo puede actualizar estado, motivo, terminado_en y actualizado_en
//   (sin intentos ni resultado); el worker, esas mas intentos, resultado, disponible_desde e iniciado_en; ninguno inserta
//   (el worker) ni trunca. El worker borra SOLO estados terminales (en_cola/ejecutando: 0 filas, sin error).
// - config_sistema: filas por defecto de D12 y CHECK (23514) de rangos y de concurrencia_tenant <= max(1, global/2) (D19);
//   solo contapp_migrator escribe.
// - credencial.estado: trigger credencial_reinicia_estado (UPDATE OF ciphertext -> 'configurada', estado_motivo NULL,
//   estado_at = now()); reenvolver la DEK (dek_envuelta/kek_id) NO lo cambia; el backend no escribe estado.
// - sistema.estudios_ids() y sistema.estudios_con_trabajos(estados, antiguedad_seg): solo uuid, solo contapp_worker;
//   estudios_con_trabajos devuelve estudios con algun trabajo en esos estados cuyo actualizado_en es <= now() - antiguedad.
// - withSistema(fn) (solo con rolApp = contapp_worker; con backend lanza ConfiguracionDbError): SET LOCAL ROLE contapp_worker
//   sin app.tenant_id, nunca anidado con withTenant/withSistema (WithTenantAnidadoError), no ve filas de negocio.
// - auth.purgar(sesion, token, intento, limite): D16 (sesiones revocadas o vencidas > 30 d; tokens usados, invalidados o
//   vencidos > 7 d; intento_login sin bloqueo vigente > 90 d desde ventana_inicio; limite_tasa > 1 d desde
//   ventana_inicio); devuelve los 4 conteos; retencion < 1 dia en cualquiera -> error y no borra nada.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import {
  abrirPool,
  enRollback,
  filasRaw,
  intentar,
  intentarRaw,
  semilla,
  type ContappDb,
} from "./soporte";
import {
  codigo,
  conSistema,
  crearDb,
  enTx,
  EscenarioTrabajos,
  exportado,
  probar,
  TERMINALES,
  UUID,
  type ClientePrueba,
  type SistemaDb,
} from "./trabajos-soporte";

let admin: Pool;
let pool: Pool; // contapp_app
let et: EscenarioTrabajos;
const dbs: ContappDb[] = [];
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let usuarioX: string; // miembro de X
let usuarioY: string; // miembro solo de Y

beforeAll(async () => {
  admin = abrirAdmin(6);
  pool = abrirPool(2);
  et = new EscenarioTrabajos(admin);
  X = (await et.estudio()).id;
  Y = (await et.estudio()).id;
  cx = await et.cliente(X);
  cy = await et.cliente(Y);
  usuarioX = (await et.miembro(X, "contador")).id;
  usuarioY = (await et.miembro(Y, "contador")).id;
});
afterAll(async () => {
  await et?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await pool?.end();
  await admin?.end();
});

const dbDe = (
  rol: "contapp_backend" | "contapp_worker",
  max = 2,
): ContappDb => {
  const d = crearDb(rol, max);
  dbs.push(d);
  return d;
};
const adm = async (sql: string, v: unknown[] = []) =>
  (await admin.query(sql, v)).rows;

// ---- INSERT directo con el superusuario (aplica CHECK, FK e indices; no RLS) --------------------------------------------
const JSONB = new Set(["parametros", "resultado"]);
const valida = (
  tenantId: string,
  c: ClientePrueba,
): Record<string, unknown> => ({
  tenant_id: tenantId,
  cliente_id: c.id,
  ruc: c.ruc,
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  estado: "en_cola",
  parametros: '{"n":1}',
  clave_dedupe: randomBytes(32),
  creado_por: null,
  max_intentos: 3,
  motivo: null,
  resultado: null,
});
async function insertarFila(
  c: {
    query(
      t: string,
      v?: unknown[],
    ): Promise<{ rows: any[]; rowCount: number | null }>;
  },
  sobre: Record<string, unknown> = {},
  tenantId = X,
  cli: ClientePrueba = cx,
) {
  const fila = { ...valida(tenantId, cli), ...sobre };
  const cols = Object.keys(fila);
  const sql = `insert into job_registro (${cols.join(", ")}) values (${cols
    .map((k, i) => (JSONB.has(k) ? `$${i + 1}::jsonb` : `$${i + 1}`))
    .join(", ")})`;
  return probar(c, sql, Object.values(fila));
}
const enRollbackAdmin = <T>(
  fn: (c: Parameters<typeof insertarFila>[0]) => Promise<T>,
) => enTx(admin, null, fn);

// =================================================================================================
describe("job_registro: RLS y aislamiento entre estudios (CA-15)", () => {
  it("el backend solo ve los trabajos de su estudio, y el worker igual", async () => {
    const jx = await et.job(X, cx);
    const jy = await et.job(Y, cy);
    for (const rol of ["contapp_backend", "contapp_worker"] as const) {
      const db = dbDe(rol);
      const ven = await db.withTenant({ tenantId: X }, async (tx) =>
        (await tx.query("select id from job_registro")).rows.map((r) => r.id),
      );
      expect(ven, `${rol} ve el propio`).toContain(jx);
      expect(ven, `${rol} no ve el ajeno`).not.toContain(jy);
      const venY = await db.withTenant({ tenantId: Y }, async (tx) =>
        (await tx.query("select id from job_registro")).rows.map((r) => r.id),
      );
      expect(venY).toContain(jy);
      expect(venY).not.toContain(jx);
    }
  });

  it.each(["contapp_backend", "contapp_worker"])(
    "%s sin contexto de estudio no ve ninguna fila (falla cerrado)",
    async (rol) => {
      await et.job(X, cx);
      expect(await filasRaw(admin, rol, "select id from job_registro")).toEqual(
        [],
      );
    },
  );

  it("el backend no puede insertar un trabajo con tenant_id de otro estudio (42501 por RLS)", async () => {
    const r = await intentar(
      dbDe("contapp_backend"),
      { tenantId: X },
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, max_intentos)
       values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'en_cola', '{}'::jsonb, $4, 3)`,
      [Y, cy.id, cy.ruc, randomBytes(32)],
    );
    expect(codigo(r)).toBe("42501");
  });

  it("control: el backend inserta un trabajo propio sin mandar tenant_id, intentos ni fechas (usan sus DEFAULT)", async () => {
    const r = await enRollback(
      dbDe("contapp_backend"),
      { tenantId: X },
      async (tx) => {
        const ins = await tx.query(
          `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
         values ($1, $2, 'prueba.eco', 'sire', 'sire', 'interactivo', 'en_cola', '{"n":1}'::jsonb, $3, $4, 3)
         returning id, tenant_id, intentos, disponible_desde, creado_en, actualizado_en, iniciado_en, terminado_en`,
          [cx.id, cx.ruc, randomBytes(32), usuarioX],
        );
        return ins.rows[0];
      },
    );
    expect(r.id).toMatch(UUID);
    expect(r.tenant_id).toBe(X);
    expect(r.intentos).toBe(0);
    expect(r.disponible_desde).toBeInstanceOf(Date);
    expect(r.creado_en).toBeInstanceOf(Date);
    expect(r.actualizado_en).toBeInstanceOf(Date);
    expect(r.iniciado_en).toBeNull();
    expect(r.terminado_en).toBeNull();
  });

  it("UPDATE y DELETE de un trabajo de otro estudio afectan 0 filas y no lo tocan", async () => {
    const jy = await et.job(Y, cy, { estado: "completado", hace: 10 });
    const bk = await intentar(
      dbDe("contapp_backend"),
      { tenantId: X },
      "update job_registro set estado = 'cancelado' where id = $1",
      [jy],
    );
    expect(bk).toEqual({ ok: true, rowCount: 0 });
    const wk = await intentar(
      dbDe("contapp_worker"),
      { tenantId: X },
      "delete from job_registro where id = $1",
      [jy],
    );
    expect(wk).toEqual({ ok: true, rowCount: 0 });
    expect((await et.fila(jy)).estado).toBe("completado");
  });

  it("contapp_platform (BYPASSRLS) y contapp_app no tienen acceso a la tabla (42501)", async () => {
    expect(
      codigo(
        await intentarRaw(
          admin,
          "contapp_platform",
          "select count(*) from job_registro",
        ),
      ),
    ).toBe("42501");
    expect(
      codigo(
        await intentarRaw(pool, null, "select count(*) from job_registro"),
      ),
    ).toBe("42501");
  });
});

// =================================================================================================
describe("job_registro: FK compuestas con el estudio (23503)", () => {
  it("control: un trabajo con cliente y creador del mismo estudio entra", async () => {
    const r = await enRollbackAdmin((c) =>
      insertarFila(c, { creado_por: usuarioX }),
    );
    expect(codigo(r)).toBe("ok");
  });

  it("creado_por NULL entra (trabajos programados, D17)", async () => {
    expect(
      codigo(
        await enRollbackAdmin((c) => insertarFila(c, { creado_por: null })),
      ),
    ).toBe("ok");
  });

  it("un cliente de otro estudio -> 23503", async () => {
    const r = await enRollbackAdmin((c) =>
      insertarFila(c, { cliente_id: cy.id, ruc: cy.ruc }),
    );
    expect(codigo(r)).toBe("23503");
  });

  it("un creador que no es miembro del estudio (membresia de otro estudio) -> 23503", async () => {
    const r = await enRollbackAdmin((c) =>
      insertarFila(c, { creado_por: usuarioY }),
    );
    expect(codigo(r)).toBe("23503");
  });

  it("un cliente inexistente -> 23503 y cliente_id NULL -> 23502", async () => {
    expect(
      codigo(
        await enRollbackAdmin((c) =>
          insertarFila(c, {
            cliente_id: "00000000-0000-4000-8000-000000000000",
          }),
        ),
      ),
    ).toBe("23503");
    expect(
      codigo(
        await enRollbackAdmin((c) => insertarFila(c, { cliente_id: null })),
      ),
    ).toBe("23502");
  });
});

// =================================================================================================
describe("job_registro: restricciones CHECK (23514)", () => {
  const rechaza = async (sobre: Record<string, unknown>) =>
    codigo(await enRollbackAdmin((c) => insertarFila(c, sobre)));
  /** jsonb cuyo texto (parametros::text) mide exactamente `octetos` bytes: {"a": "<relleno>"} = 9 + relleno. */
  const jsonDe = (octetos: number, caracter = "x") => {
    const resto = octetos - 9;
    const n =
      caracter === "x"
        ? resto
        : Math.floor(resto / Buffer.byteLength(caracter));
    return JSON.stringify({ a: caracter.repeat(n) });
  };

  it("control: la fila base pasa los CHECK", async () => {
    expect(await rechaza({})).toBe("ok");
  });

  it.each([
    "prueba.eco",
    "sire.reemplazo.enviar",
    "kek.rotar",
    "auth.purgar",
    "buzon.programar",
    "sire.propuesta_descargar",
  ])("tipo valido %s entra", async (tipo) => {
    expect(await rechaza({ tipo })).toBe("ok");
  });

  it.each([
    ["con mayusculas", "Prueba.eco"],
    ["sin punto", "prueba"],
    ["punto final", "prueba."],
    ["punto inicial", ".eco"],
    ["con espacio", "prueba eco"],
    ["con guion bajo en el primer segmento", "prue_ba.eco"],
    ["con digitos", "prueba.eco1"],
    ["con inyeccion", "prueba.eco'; drop table job_registro;--"],
    ["vacio", ""],
    ["salto de linea final", "prueba.eco\n"],
  ])("tipo %s -> 23514", async (_n, tipo) => {
    expect(await rechaza({ tipo })).toBe("23514");
  });

  it.each(["sire", "sol", "xml", "archivos", "programados", "notificaciones"])(
    "cola %s entra",
    async (cola) => {
      expect(await rechaza({ cola })).toBe("ok");
    },
  );
  it.each(["otra", "SIRE", "", "sire "])("cola '%s' -> 23514", async (cola) => {
    expect(await rechaza({ cola })).toBe("23514");
  });

  it.each(["sire", "sol", "ninguno"])("canal %s entra", async (canal) => {
    expect(await rechaza({ canal })).toBe("ok");
  });
  it.each(["xml", "SOL", ""])("canal '%s' -> 23514", async (canal) => {
    expect(await rechaza({ canal })).toBe("23514");
  });

  it.each(["interactivo", "programado"])(
    "prioridad %s entra",
    async (prioridad) => {
      expect(await rechaza({ prioridad })).toBe("ok");
    },
  );
  it.each(["urgente", "Interactivo", ""])(
    "prioridad '%s' -> 23514",
    async (prioridad) => {
      expect(await rechaza({ prioridad })).toBe("23514");
    },
  );

  it.each(["en_cola", "ejecutando", "completado", "error", "cancelado"])(
    "estado %s entra",
    async (estado) => {
      expect(await rechaza({ estado })).toBe("ok");
    },
  );
  it.each(["pendiente", "EN_COLA", "", "terminado"])(
    "estado '%s' -> 23514",
    async (estado) => {
      expect(await rechaza({ estado })).toBe("23514");
    },
  );

  it.each([
    "sunat_no_responde",
    "credencial_invalida",
    "datos_invalidos",
    "portal_cambio",
    "interrumpido",
    "acceso_retirado",
    "cancelado_usuario",
    "error_interno",
  ])("motivo %s entra (con estado error)", async (motivo) => {
    expect(await rechaza({ estado: "error", motivo })).toBe("ok");
  });
  it.each([
    "otro",
    "SUNAT_NO_RESPONDE",
    "",
    "mensaje crudo del adaptador: 401 Unauthorized",
  ])("motivo '%s' -> 23514", async (motivo) => {
    expect(await rechaza({ estado: "error", motivo })).toBe("23514");
  });

  it("parametros: 4096 octetos entran y 4097 no (23514)", async () => {
    expect(await rechaza({ parametros: jsonDe(4096) })).toBe("ok");
    expect(await rechaza({ parametros: jsonDe(4097) })).toBe("23514");
  });

  it("parametros se mide en octetos, no en caracteres (4095 octetos entran; 4097 octetos en solo ~2050 caracteres no)", async () => {
    expect(
      await rechaza({ parametros: JSON.stringify({ a: "ñ".repeat(2043) }) }),
    ).toBe("ok"); // 9 + 4086 = 4095 octetos
    expect(
      await rechaza({ parametros: JSON.stringify({ a: "ñ".repeat(2044) }) }),
    ).toBe("23514"); // 4097 octetos
  });

  it("resultado: NULL entra; 4096 octetos entran y 4097 no (23514)", async () => {
    expect(await rechaza({ resultado: null })).toBe("ok");
    expect(
      await rechaza({ estado: "completado", resultado: jsonDe(4096) }),
    ).toBe("ok");
    expect(
      await rechaza({ estado: "completado", resultado: jsonDe(4097) }),
    ).toBe("23514");
  });

  it("parametros NULL -> 23502 (NOT NULL)", async () => {
    expect(await rechaza({ parametros: null })).toBe("23502");
  });

  it("clave_dedupe: 32 bytes entran; 0, 31 y 33 bytes -> 23514", async () => {
    expect(await rechaza({ clave_dedupe: randomBytes(32) })).toBe("ok");
    for (const n of [0, 1, 31, 33, 64]) {
      expect(
        await rechaza({ clave_dedupe: randomBytes(n) }),
        `${n} bytes`,
      ).toBe("23514");
    }
  });
});

// =================================================================================================
describe("job_registro: indice unico de dedupe solo con estados vivos (D8)", () => {
  it.each([
    ["en_cola", "en_cola", "23505"],
    ["en_cola", "ejecutando", "23505"],
    ["ejecutando", "en_cola", "23505"],
    ["ejecutando", "ejecutando", "23505"],
    ["completado", "en_cola", "ok"],
    ["en_cola", "completado", "ok"],
    ["error", "en_cola", "ok"],
    ["cancelado", "ejecutando", "ok"],
    ["completado", "completado", "ok"],
    ["error", "error", "ok"],
    ["cancelado", "cancelado", "ok"],
    ["completado", "error", "ok"],
  ])("misma clave y estudio: %s luego %s -> %s", async (a, b, esperado) => {
    const clave = randomBytes(32);
    const r = await enRollbackAdmin(async (c) => {
      const p = await insertarFila(c, { clave_dedupe: clave, estado: a });
      const s = await insertarFila(c, { clave_dedupe: clave, estado: b });
      return [codigo(p), codigo(s)];
    });
    expect(r).toEqual(["ok", esperado]);
  });

  it("la misma clave en otro estudio no choca (el indice es por tenant_id)", async () => {
    const clave = randomBytes(32);
    const r = await enRollbackAdmin(async (c) => {
      const p = await insertarFila(c, { clave_dedupe: clave });
      const s = await insertarFila(c, { clave_dedupe: clave }, Y, cy);
      return [codigo(p), codigo(s)];
    });
    expect(r).toEqual(["ok", "ok"]);
  });

  it("al terminar el trabajo vivo la clave se libera: se puede encolar otro igual", async () => {
    const clave = randomBytes(32);
    const r = await enRollbackAdmin(async (c) => {
      await insertarFila(c, { clave_dedupe: clave });
      const choca = await insertarFila(c, { clave_dedupe: clave });
      await c.query(
        "update job_registro set estado = 'completado' where tenant_id = $1 and clave_dedupe = $2",
        [X, clave],
      );
      const libre = await insertarFila(c, { clave_dedupe: clave });
      return [codigo(choca), codigo(libre)];
    });
    expect(r).toEqual(["23505", "ok"]);
  });

  it("volver a poner en_cola un trabajo cuando ya hay otro vivo igual -> 23505; si el otro ya termino, entra", async () => {
    const clave = randomBytes(32);
    const pasarAEnCola =
      "update job_registro set estado = 'en_cola' where tenant_id = $1 and clave_dedupe = $2 and estado = 'completado'";
    const r = await enRollbackAdmin(async (c) => {
      await insertarFila(c, { clave_dedupe: clave, estado: "ejecutando" });
      await insertarFila(c, { clave_dedupe: clave, estado: "completado" });
      const choca = await probar(c, pasarAEnCola, [X, clave]);
      await c.query(
        "update job_registro set estado = 'error' where tenant_id = $1 and clave_dedupe = $2 and estado = 'ejecutando'",
        [X, clave],
      );
      const libre = await probar(c, pasarAEnCola, [X, clave]);
      return [codigo(choca), codigo(libre)];
    });
    expect(r).toEqual(["23505", "ok"]);
  });
});

// =================================================================================================
describe("job_registro: grants por columna en accion (CA-15, D2)", () => {
  const COLS_PROHIBIDAS_BACKEND = [
    "id",
    "tenant_id",
    "cliente_id",
    "ruc",
    "tipo",
    "cola",
    "canal",
    "prioridad",
    "parametros",
    "clave_dedupe",
    "creado_por",
    "intentos",
    "max_intentos",
    "resultado",
    "disponible_desde",
    "creado_en",
    "iniciado_en",
  ];
  const COLS_PROHIBIDAS_WORKER = [
    "id",
    "tenant_id",
    "cliente_id",
    "ruc",
    "tipo",
    "cola",
    "canal",
    "prioridad",
    "parametros",
    "clave_dedupe",
    "creado_por",
    "max_intentos",
    "creado_en",
  ];

  it("el backend cancela: UPDATE de estado, motivo, terminado_en y actualizado_en de un en_cola propio", async () => {
    const id = await et.job(X, cx);
    const r = await intentar(
      dbDe("contapp_backend"),
      { tenantId: X },
      `update job_registro set estado = 'cancelado', motivo = 'cancelado_usuario', terminado_en = now(), actualizado_en = now()
        where id = $1 and estado = 'en_cola'`,
      [id],
    );
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it.each(COLS_PROHIBIDAS_BACKEND)(
    "el backend no puede actualizar %s (42501)",
    async (col) => {
      const id = await et.job(X, cx);
      const r = await intentar(
        dbDe("contapp_backend"),
        { tenantId: X },
        `update job_registro set ${col} = ${col} where id = $1`,
        [id],
      );
      expect(codigo(r)).toBe("42501");
    },
  );

  it("el backend no puede borrar ni truncar (42501)", async () => {
    const id = await et.job(X, cx, { estado: "completado", hace: 5 });
    const db = dbDe("contapp_backend");
    expect(
      codigo(
        await intentar(
          db,
          { tenantId: X },
          "delete from job_registro where id = $1",
          [id],
        ),
      ),
    ).toBe("42501");
    expect(
      codigo(await intentar(db, { tenantId: X }, "truncate job_registro")),
    ).toBe("42501");
  });

  it("el worker actualiza las 8 columnas del ejecutor", async () => {
    const id = await et.job(X, cx);
    const r = await intentar(
      dbDe("contapp_worker"),
      { tenantId: X },
      `update job_registro set estado = estado, intentos = intentos, motivo = motivo, resultado = resultado,
              disponible_desde = disponible_desde, iniciado_en = iniciado_en, terminado_en = terminado_en, actualizado_en = now()
        where id = $1`,
      [id],
    );
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it.each(COLS_PROHIBIDAS_WORKER)(
    "el worker no puede actualizar %s (42501)",
    async (col) => {
      const id = await et.job(X, cx);
      const r = await intentar(
        dbDe("contapp_worker"),
        { tenantId: X },
        `update job_registro set ${col} = ${col} where id = $1`,
        [id],
      );
      expect(codigo(r)).toBe("42501");
    },
  );

  it("el worker no puede insertar ni truncar (42501)", async () => {
    const db = dbDe("contapp_worker");
    const ins = await intentar(
      db,
      { tenantId: X },
      `insert into job_registro (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, max_intentos)
       values ($1, $2, 'prueba.eco', 'sire', 'sire', 'interactivo', 'en_cola', '{}'::jsonb, $3, 3)`,
      [cx.id, cx.ruc, randomBytes(32)],
    );
    expect(codigo(ins)).toBe("42501");
    expect(
      codigo(await intentar(db, { tenantId: X }, "truncate job_registro")),
    ).toBe("42501");
  });

  it("el worker borra SOLO estados terminales: en_cola y ejecutando no se borran (0 filas, sin error)", async () => {
    const ids: Record<string, string> = {};
    for (const estado of ["en_cola", "ejecutando", ...TERMINALES])
      ids[estado] = await et.job(X, cx, { estado, hace: 3600 });
    const r = await enRollback(
      dbDe("contapp_worker"),
      { tenantId: X },
      async (tx) => {
        const vivos = await tx.query(
          "delete from job_registro where id = any($1::uuid[])",
          [[ids.en_cola, ids.ejecutando]],
        );
        const terminales = await tx.query(
          "delete from job_registro where id = any($1::uuid[])",
          [TERMINALES.map((e) => ids[e])],
        );
        const quedan = await tx.query(
          "select estado from job_registro where id = any($1::uuid[]) order by estado",
          [Object.values(ids)],
        );
        return {
          vivos: vivos.rowCount,
          terminales: terminales.rowCount,
          quedan: quedan.rows.map((x) => x.estado),
        };
      },
    );
    expect(r.vivos).toBe(0);
    expect(r.terminales).toBe(3);
    expect(r.quedan).toEqual(["en_cola", "ejecutando"].sort());
  });

  it("un DELETE masivo del worker (sin WHERE de estado) deja intactos los trabajos vivos del estudio", async () => {
    const vivo = await et.job(X, cx, { estado: "ejecutando" });
    const term = await et.job(X, cx, {
      estado: "error",
      hace: 100,
      motivo: "sunat_no_responde",
    });
    const r = await enRollback(
      dbDe("contapp_worker"),
      { tenantId: X },
      async (tx) => {
        await tx.query("delete from job_registro");
        return (
          await tx.query(
            "select id from job_registro where id = any($1::uuid[])",
            [[vivo, term]],
          )
        ).rows.map((x) => x.id);
      },
    );
    expect(r).toEqual([vivo]);
  });
});

// =================================================================================================
describe("config_sistema: filas por defecto de D12 y CHECK de rangos (CA-4, D19)", () => {
  const leer = async () => {
    const f = await adm(
      "select * from config_sistema where cola in ('sire', 'sol', 'xml') order by cola",
    );
    return Object.fromEntries(
      f.map((r) => [
        r.cola,
        [
          r.concurrencia_global,
          r.concurrencia_tenant,
          r.espera_ruc_ms,
          r.reintentos,
          r.backoff_base_ms,
          r.max_pendientes_tenant,
        ],
      ]),
    );
  };

  it("sire 4/2, sol 2/1, xml 8/4; espera 2000 ms, 3 reintentos, base 5000 ms y 2000 pendientes por estudio", async () => {
    expect(await leer()).toEqual({
      sire: [4, 2, 2000, 3, 5000, 2000],
      sol: [2, 1, 2000, 3, 5000, 2000],
      xml: [8, 4, 2000, 3, 5000, 2000],
    });
  });

  it("actualizado_en tiene valor en todas las filas", async () => {
    const r = await adm(
      "select count(*)::int as n from config_sistema where actualizado_en is null",
    );
    expect(r[0].n).toBe(0);
  });

  /** UPDATE de la fila `sire` (4/2) como superusuario con rollback: el CHECK es de la tabla, no del rol. */
  const cambia = async (set: string) =>
    codigo(
      await intentarRaw(
        admin,
        null,
        `update config_sistema set ${set} where cola = 'sire'`,
      ),
    );

  it.each([
    ["global 0", "concurrencia_global = 0"],
    ["global -1", "concurrencia_global = -1"],
    ["global 65", "concurrencia_global = 65"],
    ["global enorme", "concurrencia_global = 32767"],
    ["tenant 0", "concurrencia_tenant = 0"],
    ["tenant -3", "concurrencia_tenant = -3"],
    ["tenant enorme", "concurrencia_tenant = 32767"],
    ["tenant 3 con global 4 (> global/2, D19)", "concurrencia_tenant = 3"],
    ["global 1 con tenant 2 (> max(1, 0))", "concurrencia_global = 1"],
    [
      "global 64 con tenant 33",
      "concurrencia_global = 64, concurrencia_tenant = 33",
    ],
    [
      "global 5 con tenant 3",
      "concurrencia_global = 5, concurrencia_tenant = 3",
    ],
    ["espera -1", "espera_ruc_ms = -1"],
    ["espera 600001", "espera_ruc_ms = 600001"],
    ["espera enorme", "espera_ruc_ms = 2147483647"],
    ["reintentos -1", "reintentos = -1"],
    ["reintentos 11", "reintentos = 11"],
    ["reintentos enormes", "reintentos = 32767"],
    ["backoff 0", "backoff_base_ms = 0"],
    ["backoff 99", "backoff_base_ms = 99"],
    ["backoff negativo", "backoff_base_ms = -5000"],
    ["backoff 600001", "backoff_base_ms = 600001"],
    ["pendientes 0", "max_pendientes_tenant = 0"],
    ["pendientes -1", "max_pendientes_tenant = -1"],
    ["pendientes 100001", "max_pendientes_tenant = 100001"],
    ["pendientes enormes", "max_pendientes_tenant = 2147483647"],
    ["cola desconocida", "cola = 'otra'"],
  ])("%s -> 23514", async (_n, set) => {
    expect(await cambia(set)).toBe("23514");
  });

  it.each([
    [
      "global 64 con tenant 32 (maximo)",
      "concurrencia_global = 64, concurrencia_tenant = 32",
    ],
    [
      "global 1 con tenant 1 (el minimo es 1 aunque global/2 sea 0)",
      "concurrencia_global = 1, concurrencia_tenant = 1",
    ],
    [
      "global 5 con tenant 2",
      "concurrencia_global = 5, concurrencia_tenant = 2",
    ],
    [
      "global 4 con tenant 2",
      "concurrencia_global = 4, concurrencia_tenant = 2",
    ],
    ["espera 0", "espera_ruc_ms = 0"],
    ["espera 600000", "espera_ruc_ms = 600000"],
    ["reintentos 0", "reintentos = 0"],
    ["reintentos 10", "reintentos = 10"],
    ["backoff 100", "backoff_base_ms = 100"],
    ["backoff 600000", "backoff_base_ms = 600000"],
    ["pendientes 1", "max_pendientes_tenant = 1"],
    ["pendientes 100000", "max_pendientes_tenant = 100000"],
  ])("limite valido: %s entra", async (_n, set) => {
    expect(await cambia(set)).toBe("ok");
  });

  it("solo contapp_migrator escribe: lo hace; backend, worker, platform y la app reciben 42501", async () => {
    const upd =
      "update config_sistema set reintentos = reintentos where cola = 'sire'";
    expect(await intentarRaw(admin, "contapp_migrator", upd)).toEqual({
      ok: true,
      rowCount: 1,
    });
    for (const rol of [
      "contapp_backend",
      "contapp_worker",
      "contapp_platform",
    ]) {
      for (const sql of [
        upd,
        "insert into config_sistema (cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant) values ('archivos', 4, 2, 2000, 3, 5000, 2000)",
        "delete from config_sistema where cola = 'sire'",
        "truncate config_sistema",
      ]) {
        expect(
          codigo(await intentarRaw(admin, rol, sql)),
          `${rol}: ${sql.slice(0, 30)}`,
        ).toBe("42501");
      }
    }
    expect(codigo(await intentarRaw(pool, null, upd))).toBe("42501");
  });

  it.each(["contapp_backend", "contapp_worker"])(
    "%s lee config_sistema (sin contexto de estudio)",
    async (rol) => {
      const f = await filasRaw(
        admin,
        rol,
        "select cola from config_sistema order by cola",
      );
      expect(f.map((x) => x.cola)).toEqual(
        expect.arrayContaining(["sire", "sol", "xml"]),
      );
    },
  );
});

// =================================================================================================
describe("credencial.estado (D13, CA-9): CHECK, trigger y grants en accion", () => {
  const estadoDe = async (id: string) =>
    (
      await adm(
        "select estado, estado_motivo, estado_at from credencial where id = $1",
        [id],
      )
    )[0];
  const marcarInvalida = (id: string) =>
    dbDe("contapp_worker").withTenant({ tenantId: X }, (tx) =>
      tx.query(
        "update credencial set estado = 'invalida', estado_motivo = 'credencial_invalida', estado_at = now() where id = $1",
        [id],
      ),
    );
  const nuevoSobre = () => [randomBytes(64), randomBytes(12), randomBytes(16)];
  const reemplazarCiphertext = (id: string) =>
    dbDe("contapp_backend").withTenant({ tenantId: X }, (tx) =>
      tx.query(
        "update credencial set ciphertext = $2, nonce = $3, tag = $4, updated_at = now() where id = $1",
        [id, ...nuevoSobre()],
      ),
    );

  it("una credencial nueva nace 'configurada', sin motivo ni estado_at", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    expect(await estadoDe(id)).toEqual({
      estado: "configurada",
      estado_motivo: null,
      estado_at: null,
    });
  });

  it("el worker marca 'invalida' (credencial_invalida) y el backend la lee", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await marcarInvalida(id);
    expect(await estadoDe(id)).toMatchObject({
      estado: "invalida",
      estado_motivo: "credencial_invalida",
    });
    expect((await estadoDe(id)).estado_at).toBeInstanceOf(Date);
    const leido = await dbDe("contapp_backend").withTenant(
      { tenantId: X },
      async (tx) =>
        (
          await tx.query(
            "select estado, estado_motivo, estado_at from credencial where id = $1",
            [id],
          )
        ).rows[0],
    );
    expect(leido.estado).toBe("invalida");
    expect(leido.estado_motivo).toBe("credencial_invalida");
  });

  it("reemplazar el ciphertext la devuelve a 'configurada' (estado_motivo NULL, estado_at = ahora)", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await marcarInvalida(id);
    const antes = Date.now();
    await reemplazarCiphertext(id);
    const e = await estadoDe(id);
    expect(e.estado).toBe("configurada");
    expect(e.estado_motivo).toBeNull();
    expect(e.estado_at).toBeInstanceOf(Date);
    expect(Math.abs((e.estado_at as Date).getTime() - antes)).toBeLessThan(
      60_000,
    );
  });

  it("tambien 'verificada' vuelve a 'configurada' al cambiar el ciphertext", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await adm(
      "update credencial set estado = 'verificada', estado_at = now() where id = $1",
      [id],
    );
    await reemplazarCiphertext(id);
    expect((await estadoDe(id)).estado).toBe("configurada");
  });

  it("guardar el sobre con el upsert del backend (INSERT ... ON CONFLICT DO UPDATE SET ciphertext) tambien la reinicia", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await marcarInvalida(id);
    await dbDe("contapp_backend").withTenant({ tenantId: X }, (tx) =>
      tx.query(
        `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
         values ($1, 'sol', $2, $3, $4, $5, 'k1', 1)
         on conflict (tenant_id, cliente_id, tipo) do update set
           ciphertext = $2, nonce = $3, tag = $4, dek_envuelta = $5, kek_id = 'k1', version = 1, updated_at = now()`,
        [cli.id, ...nuevoSobre(), randomBytes(512)],
      ),
    );
    expect((await estadoDe(id)).estado).toBe("configurada");
  });

  it("re-envolver la DEK (dek_envuelta, kek_id, updated_at) NO cambia estado, motivo ni estado_at (rotacion de KEK)", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await marcarInvalida(id);
    const antes = await estadoDe(id);
    await dbDe("contapp_worker").withTenant({ tenantId: X }, (tx) =>
      tx.query(
        "update credencial set dek_envuelta = $2, kek_id = 'k2', updated_at = now() where id = $1",
        [id, randomBytes(512)],
      ),
    );
    expect(await estadoDe(id)).toEqual(antes);
    expect((await estadoDe(id)).estado).toBe("invalida");
  });

  it("un UPDATE que no toca el ciphertext (p. ej. solo nonce, del backend) no reinicia el estado", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    await marcarInvalida(id);
    await dbDe("contapp_backend").withTenant({ tenantId: X }, (tx) =>
      tx.query("update credencial set nonce = $2 where id = $1", [
        id,
        randomBytes(12),
      ]),
    );
    expect((await estadoDe(id)).estado).toBe("invalida");
  });

  it("el backend no puede escribir estado, estado_motivo ni estado_at (42501), ni en INSERT ni en UPDATE", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    const db = dbDe("contapp_backend");
    for (const set of [
      "estado = 'verificada'",
      "estado_motivo = null",
      "estado_at = now()",
    ]) {
      expect(
        codigo(
          await intentar(
            db,
            { tenantId: X },
            `update credencial set ${set} where id = $1`,
            [id],
          ),
        ),
        set,
      ).toBe("42501");
    }
    const ins = await intentar(
      db,
      { tenantId: X },
      `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version, estado)
       values ($1, 'sire_api', $2, $3, $4, $5, 'k1', 1, 'verificada')`,
      [cli.id, ...nuevoSobre(), randomBytes(512)],
    );
    expect(codigo(ins)).toBe("42501");
  });

  it("CHECK: estado fuera de configurada|verificada|invalida y estado_motivo distinto de credencial_invalida -> 23514", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    const db = dbDe("contapp_worker");
    for (const set of [
      "estado = 'otra'",
      "estado = ''",
      "estado = 'INVALIDA'",
      "estado_motivo = 'otro'",
      "estado_motivo = 'sunat_no_responde'",
    ]) {
      expect(
        codigo(
          await intentar(
            db,
            { tenantId: X },
            `update credencial set ${set} where id = $1`,
            [id],
          ),
        ),
        set,
      ).toBe("23514");
    }
    for (const set of [
      "estado = 'verificada'",
      "estado = 'invalida', estado_motivo = 'credencial_invalida'",
      "estado_motivo = null",
    ]) {
      expect(
        codigo(
          await intentar(
            db,
            { tenantId: X },
            `update credencial set ${set} where id = $1`,
            [id],
          ),
        ),
        set,
      ).toBe("ok");
    }
  });

  it("estado es NOT NULL (23502)", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    const r = await intentar(
      dbDe("contapp_worker"),
      { tenantId: X },
      "update credencial set estado = null where id = $1",
      [id],
    );
    expect(codigo(r)).toBe("23502");
  });

  it("el worker de otro estudio no puede marcar la credencial (0 filas)", async () => {
    const cli = await et.cliente(X);
    const id = await et.credencial(X, cli.id);
    const r = await intentar(
      dbDe("contapp_worker"),
      { tenantId: Y },
      "update credencial set estado = 'invalida' where id = $1",
      [id],
    );
    expect(r).toEqual({ ok: true, rowCount: 0 });
    expect((await estadoDe(id)).estado).toBe("configurada");
  });
});

// =================================================================================================
describe("contapp_enumerador y sistema.*: solo uuid, solo contapp_worker (D18, CA-12)", () => {
  const comoWorker = <T>(
    fn: (c: Parameters<typeof insertarFila>[0]) => Promise<T>,
  ) => enTx(admin, "contapp_worker", fn);

  it("sistema.estudios_ids() devuelve una sola columna de tipo uuid con TODOS los estudios (sin BYPASSRLS en el worker)", async () => {
    const s = semilla();
    const filas = await comoWorker(
      async (c) => (await c.query("select * from sistema.estudios_ids()")).rows,
    );
    const todos = (await adm("select id from tenant"))
      .map((r) => r.id as string)
      .sort();
    expect(filas.length).toBe(todos.length);
    for (const f of filas) {
      expect(Object.keys(f)).toHaveLength(1);
      expect(Object.values(f)[0]).toMatch(UUID);
    }
    const ids = filas.map((f) => Object.values(f)[0] as string).sort();
    expect(ids).toEqual(todos);
    expect(ids).toEqual(expect.arrayContaining([s.tenantA, s.tenantB, X, Y]));
  });

  it("el worker NO ve filas de negocio por su cuenta: sin contexto, tenant, cliente, membresia y job_registro estan vacios", async () => {
    await et.job(X, cx);
    const r = await comoWorker(async (c) => {
      const out: Record<string, number> = {};
      for (const t of ["cliente", "membresia", "job_registro", "credencial"]) {
        out[t] = (
          await c.query(`select count(*)::int as n from ${t}`)
        ).rows[0].n;
      }
      return out;
    });
    expect(r).toEqual({
      cliente: 0,
      membresia: 0,
      job_registro: 0,
      credencial: 0,
    });
  });

  describe("sistema.estudios_con_trabajos(estados, antiguedad_seg)", () => {
    let eViejo: string; // en_cola desde hace 10 min
    let eReciente: string; // en_cola ahora
    let eTerminado: string; // completado hace 10 min
    let eEjecutando: string; // ejecutando desde hace 1 h
    let eVacio: string; // sin trabajos
    beforeAll(async () => {
      const mk = async (estado: string, hace: number | null) => {
        const t = (await et.estudio()).id;
        if (hace !== null)
          await et.job(t, await et.cliente(t), { estado, hace });
        return t;
      };
      eViejo = await mk("en_cola", 600);
      eReciente = await mk("en_cola", 0);
      eTerminado = await mk("completado", 600);
      eEjecutando = await mk("ejecutando", 3600);
      eVacio = await mk("en_cola", null);
    });
    const llama = (estados: string[], antiguedad: number) =>
      comoWorker(async (c) =>
        (
          await c.query(
            "select * from sistema.estudios_con_trabajos($1::text[], $2::int)",
            [estados, antiguedad],
          )
        ).rows.map((f) => Object.values(f)[0] as string),
      );

    it("en_cola con antiguedad >= 300 s: solo el estudio con un en_cola viejo", async () => {
      const r = await llama(["en_cola"], 300);
      expect(r).toContain(eViejo);
      for (const otro of [eReciente, eTerminado, eEjecutando, eVacio])
        expect(r).not.toContain(otro);
    });

    it("antiguedad 0: incluye al reciente; varios estados: une los conjuntos", async () => {
      expect(await llama(["en_cola"], 0)).toEqual(
        expect.arrayContaining([eViejo, eReciente]),
      );
      const r = await llama(["en_cola", "ejecutando"], 300);
      expect(r).toEqual(expect.arrayContaining([eViejo, eEjecutando]));
      expect(r).not.toContain(eReciente);
      expect(r).not.toContain(eTerminado);
    });

    it("estados terminales y lista vacia", async () => {
      expect(await llama(["completado"], 300)).toContain(eTerminado);
      expect(await llama(["completado"], 300)).not.toContain(eViejo);
      const vacia = await llama([], 0);
      for (const t of [eViejo, eReciente, eTerminado, eEjecutando])
        expect(vacia).not.toContain(t);
    });

    it("devuelve cada estudio una sola vez y solo uuid (sin filas de trabajo, tipos ni parametros)", async () => {
      await et.job(
        eViejo,
        (
          await adm(
            "select id, ruc from cliente where tenant_id = $1 limit 1",
            [eViejo],
          )
        )[0],
        { estado: "en_cola", hace: 700 },
      );
      const r = await llama(["en_cola"], 300);
      expect(r.filter((t) => t === eViejo)).toHaveLength(1);
      for (const t of r) expect(t).toMatch(UUID);
    });
  });

  it("el backend, platform y la app no pueden llamar a sistema.* (42501)", async () => {
    for (const rol of ["contapp_backend", "contapp_platform"]) {
      expect(
        codigo(
          await intentarRaw(admin, rol, "select * from sistema.estudios_ids()"),
        ),
        `${rol} estudios_ids`,
      ).toBe("42501");
      expect(
        codigo(
          await intentarRaw(
            admin,
            rol,
            "select * from sistema.estudios_con_trabajos('{en_cola}', 0)",
          ),
        ),
        `${rol} con_trabajos`,
      ).toBe("42501");
    }
    expect(
      codigo(
        await intentarRaw(pool, null, "select * from sistema.estudios_ids()"),
      ),
    ).toBe("42501");
  });
});

// =================================================================================================
describe("withSistema (D18): contexto sin estudio, no se anida, no ve negocio", () => {
  let worker: SistemaDb;
  beforeAll(() => {
    worker = conSistema("contapp_worker", 1);
    dbs.push(worker);
  });

  it("corre como contapp_worker, sin app.tenant_id, y devuelve la conexion limpia (contapp_app) al terminar", async () => {
    // poolMax = 1: la misma conexion sirve a withTenant y luego a withSistema (el contexto anterior no debe filtrarse).
    await worker.withTenant({ tenantId: X }, async (tx) =>
      tx.query("select 1"),
    );
    const dentro = await worker.withSistema(async (tx) => {
      const r = await tx.query(
        "select current_user as u, nullif(current_setting('app.tenant_id', true), '') as t",
      );
      return r.rows[0];
    });
    expect(dentro).toEqual({ u: "contapp_worker", t: null });
    expect(
      (await worker.pool.query("select current_user as u")).rows[0].u,
    ).toBe("contapp_app");
  });

  it("llama a sistema.estudios_ids() y lee config_sistema, pero no ve filas de negocio", async () => {
    await et.job(X, cx);
    const r = await worker.withSistema(async (tx) => ({
      estudios: (await tx.query("select * from sistema.estudios_ids()")).rows
        .length,
      config: (
        await tx.query("select cola from config_sistema order by cola")
      ).rows.map((x) => x.cola),
      jobs: (await tx.query("select count(*)::int as n from job_registro"))
        .rows[0].n,
      clientes: (await tx.query("select count(*)::int as n from cliente"))
        .rows[0].n,
    }));
    expect(r.estudios).toBeGreaterThanOrEqual(4);
    expect(r.config).toEqual(expect.arrayContaining(["sire", "sol", "xml"]));
    expect(r.jobs).toBe(0);
    expect(r.clientes).toBe(0);
  });

  it("withSistema dentro de withTenant, withTenant dentro de withSistema y withSistema dentro de withSistema -> WithTenantAnidadoError", async () => {
    const Anidado = exportado<new (...a: any[]) => Error>(
      "WithTenantAnidadoError",
    );
    const db = conSistema("contapp_worker", 3);
    dbs.push(db);
    await expect(
      db.withTenant({ tenantId: X }, () => db.withSistema(async () => 1)),
    ).rejects.toBeInstanceOf(Anidado);
    await expect(
      db.withSistema(() => db.withTenant({ tenantId: X }, async () => 1)),
    ).rejects.toBeInstanceOf(Anidado);
    await expect(
      db.withSistema(() => db.withSistema(async () => 1)),
    ).rejects.toBeInstanceOf(Anidado);
  });

  it("con rolApp = contapp_backend no existe withSistema util: rechaza con ConfiguracionDbError (el backend no enumera estudios)", async () => {
    const Config = exportado<new (...a: any[]) => Error>(
      "ConfiguracionDbError",
    );
    const db = dbDe("contapp_backend");
    const f = (db as unknown as Partial<SistemaDb>).withSistema;
    expect(
      typeof f,
      "ContappDb debe exponer withSistema (implementacion pendiente, T7)",
    ).toBe("function");
    await expect(
      (db as SistemaDb).withSistema(async () => 1),
    ).rejects.toBeInstanceOf(Config);
  });

  it("una excepcion dentro de withSistema revierte y la conexion no queda como contapp_worker", async () => {
    await expect(
      worker.withSistema(async (tx) => {
        await tx.query("select 1");
        throw new Error("falla de la prueba");
      }),
    ).rejects.toThrow("falla de la prueba");
    expect(
      (await worker.pool.query("select current_user as u")).rows[0].u,
    ).toBe("contapp_app");
  });
});

// =================================================================================================
describe("auth.purgar (D16, CA-13): borra solo lo terminado y vencido", () => {
  const dias = (n: number) => `now() - interval '${n} days'`;
  const S = {} as Record<string, string>; // etiqueta -> id (sesion)
  const T = {} as Record<string, string>; // etiqueta -> id (token_recuperacion)
  const claves = {} as Record<string, Buffer>; // etiqueta -> clave (intento_login)
  const sujetos = {} as Record<string, string>; // etiqueta -> sujeto (limite_tasa)
  let usuario: string;

  beforeAll(async () => {
    usuario = (await et.ea.cuenta()).id;
    const sesion = async (
      k: string,
      o: { expira: string; revocada?: string },
    ) => {
      S[k] = (
        await adm(
          `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta, revocada_en, motivo)
           values ($1, $2, now() - interval '200 days', now() - interval '200 days', ${o.expira}, ${o.revocada ?? "null"}, ${o.revocada ? "'logout'" : "null"}) returning id`,
          [randomBytes(32), usuario],
        )
      )[0].id;
    };
    await sesion("vigente_vieja", { expira: "now() + interval '12 hours'" });
    await sesion("revocada_31d", {
      expira: "now() + interval '1 day'",
      revocada: dias(31),
    });
    await sesion("revocada_29d", {
      expira: "now() + interval '1 day'",
      revocada: dias(29),
    });
    await sesion("vencida_31d", { expira: dias(31) });
    await sesion("vencida_29d", { expira: dias(29) });
    await sesion("revocada_ayer", {
      expira: "now() + interval '1 day'",
      revocada: dias(1),
    });

    const token = async (
      k: string,
      col: "usado_en" | "invalidado_en" | "expira_en" | "vigente",
      cuando: string,
    ) => {
      T[k] = (
        await adm(
          `insert into auth.token_recuperacion (token_hash, usuario_id, creado_en, expira_en, usado_en, invalidado_en)
           values ($1, $2, now() - interval '200 days',
                   ${col === "expira_en" ? cuando : "now() + interval '30 minutes'"},
                   ${col === "usado_en" ? cuando : "null"},
                   ${col === "invalidado_en" ? cuando : "null"}) returning id`,
          [randomBytes(32), usuario],
        )
      )[0].id;
    };
    await token("usado_8d", "usado_en", dias(8));
    await token("usado_6d", "usado_en", dias(6));
    await token("invalidado_8d", "invalidado_en", dias(8));
    await token("invalidado_6d", "invalidado_en", dias(6));
    await token("vencido_8d", "expira_en", dias(8));
    await token("vencido_6d", "expira_en", dias(6));
    await token("vigente", "vigente", "now()");

    const intento = async (k: string, ventana: string, bloqueo: string) => {
      claves[k] = randomBytes(32);
      await adm(
        "insert into auth.intento_login (clave, fallos, ventana_inicio, bloqueado_hasta) values ($1, 5, " +
          ventana +
          ", " +
          bloqueo +
          ")",
        [claves[k]],
      );
    };
    await intento("sin_bloqueo_91d", dias(91), "null");
    await intento("bloqueo_vigente_91d", dias(91), "now() + interval '1 hour'");
    await intento("bloqueo_vencido_91d", dias(91), dias(1));
    await intento("sin_bloqueo_89d", dias(89), "null");

    const limite = async (k: string, ventana: string) => {
      sujetos[k] = et.ea.esc.sujeto(k);
      await adm(
        "insert into auth.limite_tasa (tipo, sujeto, ventana_inicio, conteo) values ('login_ip', $1, " +
          ventana +
          ", 3)",
        [sujetos[k]],
      );
    };
    await limite("limite_3d", dias(3));
    await limite("limite_1h", "now() - interval '1 hour'");
  });
  afterAll(async () => {
    await adm("delete from auth.intento_login where clave = any($1::bytea[])", [
      Object.values(claves),
    ]).catch(() => undefined);
    await adm("delete from auth.limite_tasa where sujeto = any($1::text[])", [
      Object.values(sujetos),
    ]).catch(() => undefined);
    await adm("delete from auth.token_recuperacion where usuario_id = $1", [
      usuario,
    ]).catch(() => undefined);
    await adm("delete from auth.sesion where usuario_id = $1", [usuario]).catch(
      () => undefined,
    );
  });

  const retenciones = ["30 days", "7 days", "90 days", "1 day"];
  const PURGAR =
    "select * from auth.purgar($1::interval, $2::interval, $3::interval, $4::interval)";

  /** Llama a auth.purgar como contapp_worker dentro de una transaccion que se REVIERTE; devuelve conteos y lo que sobrevive. */
  async function purgando(ret: string[] = retenciones) {
    return enTx(admin, "contapp_worker", async (c) => {
      const conteos = (await c.query(PURGAR, ret)).rows;
      await c.query("RESET ROLE");
      const vivos = async (tabla: string, expr: string, ids: string[]) =>
        new Set(
          (
            await c.query(
              `select ${expr}::text as k from auth.${tabla} where ${expr}::text = any($1::text[])`,
              [ids],
            )
          ).rows.map((r) => r.k as string),
        );
      return {
        conteos,
        sesiones: await vivos("sesion", "id", Object.values(S)),
        tokens: await vivos("token_recuperacion", "id", Object.values(T)),
        intentos: await vivos(
          "intento_login",
          "encode(clave, 'hex')",
          Object.values(claves).map((b) => b.toString("hex")),
        ),
        limites: await vivos("limite_tasa", "sujeto", Object.values(sujetos)),
        contrasenas: (
          await c.query(
            "select count(*)::int as n from auth.usuario_contrasena",
          )
        ).rows[0].n,
      };
    });
  }

  it("devuelve una fila con los cuatro conteos (sesiones, tokens, intentos, limites)", async () => {
    const r = await purgando();
    expect(r.conteos).toHaveLength(1);
    expect(Object.keys(r.conteos[0]).sort()).toEqual([
      "intentos",
      "limites",
      "sesiones",
      "tokens",
    ]);
    // Las filas de esta prueba aportan al menos: sesiones 2, tokens 3, intentos 2, limites 1 (la BD puede traer mas filas viejas).
    expect(r.conteos[0].sesiones).toBeGreaterThanOrEqual(2);
    expect(r.conteos[0].tokens).toBeGreaterThanOrEqual(3);
    expect(r.conteos[0].intentos).toBeGreaterThanOrEqual(2);
    expect(r.conteos[0].limites).toBeGreaterThanOrEqual(1);
  });

  it("sesiones: borra revocadas y vencidas hace > 30 dias; deja la vigente (aunque sea vieja), las de 29 dias y la revocada de ayer", async () => {
    const r = await purgando();
    expect([...r.sesiones].sort()).toEqual(
      [S.vigente_vieja, S.revocada_29d, S.vencida_29d, S.revocada_ayer].sort(),
    );
  });

  it("tokens de recuperacion: borra usados, invalidados o vencidos hace > 7 dias; deja los de 6 dias y el vigente", async () => {
    const r = await purgando();
    expect([...r.tokens].sort()).toEqual(
      [T.usado_6d, T.invalidado_6d, T.vencido_6d, T.vigente].sort(),
    );
  });

  it("intento_login: borra los de > 90 dias sin bloqueo vigente; deja el bloqueado vigente y el de 89 dias", async () => {
    const r = await purgando();
    expect([...r.intentos].sort()).toEqual(
      [
        claves.bloqueo_vigente_91d.toString("hex"),
        claves.sin_bloqueo_89d.toString("hex"),
      ].sort(),
    );
  });

  it("limite_tasa: borra la ventana de hace 3 dias y deja la de hace 1 hora", async () => {
    const r = await purgando();
    expect([...r.limites]).toEqual([sujetos.limite_1h]);
  });

  it("no toca usuario_contrasena ni ninguna otra tabla de auth fuera de las 4 de la retencion", async () => {
    const antes = (
      await adm("select count(*)::int as n from auth.usuario_contrasena")
    )[0].n;
    const r = await purgando();
    expect(r.contrasenas).toBe(antes);
  });

  it("es idempotente: una segunda llamada seguida no encuentra nada de esta prueba que borrar", async () => {
    const r = await enTx(admin, "contapp_worker", async (c) => {
      await c.query(PURGAR, retenciones);
      return (await c.query(PURGAR, retenciones)).rows[0];
    });
    expect(r).toEqual({ sesiones: 0, tokens: 0, intentos: 0, limites: 0 });
  });

  it("retencion de exactamente 1 dia (el minimo) se acepta", async () => {
    const r = await enTx(admin, "contapp_worker", (c) =>
      probar(c, PURGAR, ["1 day", "1 day", "1 day", "1 day"]),
    );
    expect(codigo(r)).toBe("ok");
  });

  /** Corre la funcion con retenciones validas (control: existe y el worker puede) y la deshace; luego la llamada a probar. */
  async function conControl(ret: Array<string | null>) {
    return enTx(admin, "contapp_worker", async (c) => {
      await c.query("SAVEPOINT control");
      const control = await c.query(PURGAR, retenciones).then(
        () => "ok",
        (e: { code?: string }) => String(e.code ?? "?"),
      );
      await c.query("ROLLBACK TO SAVEPOINT control");
      const intento = await probar(c, PURGAR, ret);
      await c.query("RESET ROLE");
      const n = (
        await c.query(
          "select count(*)::int as n from auth.sesion where id::text = any($1::text[])",
          [Object.values(S)],
        )
      ).rows[0].n;
      return { control, intento, n };
    });
  }

  it.each([
    ["sesion", ["23 hours", "7 days", "90 days", "1 day"]],
    ["token", ["30 days", "0", "90 days", "1 day"]],
    ["intento", ["30 days", "7 days", "-1 day", "1 day"]],
    ["limite", ["30 days", "7 days", "90 days", "59 minutes"]],
    ["todas en 0", ["0", "0", "0", "0"]],
  ])(
    "retencion < 1 dia (%s) -> error de la funcion (no de permisos) y no borra nada",
    async (_n, ret) => {
      const r = await conControl(ret);
      expect(
        r.control,
        "control: con retenciones validas la funcion corre",
      ).toBe("ok");
      expect(r.intento.ok).toBe(false);
      expect(r.intento.ok ? "" : r.intento.code).not.toMatch(
        /^(42501|42883|3F000)$/,
      );
      expect(r.n).toBe(Object.values(S).length);
    },
  );

  it("NULL en una retencion no se acepta como 'sin limite' (error o 0 filas borradas, nunca borra todo)", async () => {
    const r = await conControl([null, "7 days", "90 days", "1 day"]);
    expect(r.control, "control: con retenciones validas la funcion corre").toBe(
      "ok",
    );
    expect(r.n).toBe(Object.values(S).length);
  });

  it("solo contapp_worker la ejecuta: backend, platform y la app reciben 42501", async () => {
    for (const rol of ["contapp_backend", "contapp_platform"]) {
      expect(
        codigo(await intentarRaw(admin, rol, PURGAR, retenciones)),
        rol,
      ).toBe("42501");
    }
    expect(codigo(await intentarRaw(pool, null, PURGAR, retenciones))).toBe(
      "42501",
    );
  });

  it("contapp_worker, fuera de la funcion, no puede borrar ni leer las tablas de auth (42501)", async () => {
    for (const sql of [
      "delete from auth.sesion",
      "select * from auth.sesion",
      "delete from auth.limite_tasa",
    ]) {
      expect(codigo(await intentarRaw(admin, "contapp_worker", sql)), sql).toBe(
        "42501",
      );
    }
  });
});

// Spec 008, T13a (adversario, ronda 1a, caja negra): `config_sistema` hostil, enumeración de estudios de `kek.rotar`
// y escrituras forjadas sobre `job_registro` desde los roles de la app. Solo tablas, roles y funciones del plan
// (BD 0017–0018). Todo dentro de transacciones con ROLLBACK, salvo el escenario, que se borra al final.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  codigo,
  crearDb,
  enTx,
  EscenarioTrabajos,
  probar,
  type ClientePrueba,
} from "./trabajos-soporte";
import { abrirAdmin } from "./auth-soporte";
import { intentar, type ContappDb } from "./soporte";

let admin: Pool;
let e: EscenarioTrabajos;
let backend: ContappDb;
let worker: ContappDb;
let A: string;
let B: string;
let cA: ClientePrueba;
let cB: ClientePrueba;
let jobB: string;
let jobATerminado: string;
let jobAEnCola: string;

beforeAll(async () => {
  admin = abrirAdmin(4);
  e = new EscenarioTrabajos(admin);
  backend = crearDb("contapp_backend", 2);
  worker = crearDb("contapp_worker", 2);
  A = (await e.estudio()).id;
  B = (await e.estudio()).id;
  cA = await e.cliente(A);
  cB = await e.cliente(B);
  jobB = await e.job(B, cB);
  jobAEnCola = await e.job(A, cA);
  jobATerminado = await e.job(A, cA, { estado: "completado", hace: 10 });
  await e.credencial(B, cB.id, "sol");
});

afterAll(async () => {
  await e?.limpiar();
  await Promise.all([backend?.close(), worker?.close()]);
  await admin?.end();
});

/** UPDATE de config_sistema dentro de una transacción con ROLLBACK, como superusuario: código de PG o "ok". */
async function cambiarConfig(
  columna: string,
  valor: unknown,
  cola = "sire",
): Promise<string> {
  if (!/^[a-z_]+$/.test(columna))
    throw new Error("columna inválida en la prueba");
  return enTx(admin, null, async (c) =>
    codigo(
      await probar(
        c,
        `update config_sistema set ${columna} = $2 where cola = $1`,
        [cola, valor],
      ),
    ),
  );
}

describe("CA-4 · config_sistema con 0, negativos, enormes y nulos", () => {
  it("cada columna rechaza 0/negativo/encima del máximo y también NULL (un NULL pasa un CHECK y dejaría al despachador sin límite)", async () => {
    const casos: Array<[string, unknown]> = [
      ["concurrencia_global", 0],
      ["concurrencia_global", -1],
      ["concurrencia_global", 65],
      ["concurrencia_global", 32767],
      ["concurrencia_tenant", 0],
      ["concurrencia_tenant", -5],
      ["concurrencia_tenant", 3], // sire global 4 → máximo 2 (D19)
      ["espera_ruc_ms", -1],
      ["espera_ruc_ms", 600_001],
      ["espera_ruc_ms", 2_147_483_647],
      ["reintentos", -1],
      ["reintentos", 11],
      ["backoff_base_ms", 0],
      ["backoff_base_ms", 99],
      ["backoff_base_ms", 600_001],
      ["max_pendientes_tenant", 0],
      ["max_pendientes_tenant", 100_001],
      ["concurrencia_global", null],
      ["concurrencia_tenant", null],
      ["espera_ruc_ms", null],
      ["reintentos", null],
      ["backoff_base_ms", null],
      ["max_pendientes_tenant", null],
    ];
    const aceptados: string[] = [];
    for (const [col, v] of casos) {
      const r = await cambiarConfig(col, v);
      if (!["23514", "23502", "22003"].includes(r))
        aceptados.push(`${col}=${String(v)} → ${r}`);
    }
    expect(aceptados).toEqual([]);
  });

  it("D19 con división entera: global 3 admite tenant 1 pero no 2; bajar global por debajo de 2·tenant se rechaza", async () => {
    const r = await enTx(admin, null, async (c) => {
      const g3t2 = codigo(
        await probar(
          c,
          "update config_sistema set concurrencia_global = 3, concurrencia_tenant = 2 where cola = 'sire'",
        ),
      );
      const g3t1 = codigo(
        await probar(
          c,
          "update config_sistema set concurrencia_global = 3, concurrencia_tenant = 1 where cola = 'sire'",
        ),
      );
      const g1t1 = codigo(
        await probar(
          c,
          "update config_sistema set concurrencia_global = 1, concurrencia_tenant = 1 where cola = 'sire'",
        ),
      );
      const bajarGlobal = codigo(
        await probar(
          c,
          "update config_sistema set concurrencia_global = 64, concurrencia_tenant = 32 where cola = 'sire'",
        ),
      );
      const g63 = codigo(
        await probar(
          c,
          "update config_sistema set concurrencia_global = 63 where cola = 'sire'",
        ),
      );
      const colaNueva = codigo(
        await probar(
          c,
          `insert into config_sistema (cola, concurrencia_global, concurrencia_tenant, espera_ruc_ms, reintentos, backoff_base_ms, max_pendientes_tenant)
           values ('hostil', 4, 2, 0, 0, 100, 10)`,
        ),
      );
      return { g3t2, g3t1, g1t1, bajarGlobal, g63, colaNueva };
    });
    expect(r).toEqual({
      g3t2: "23514",
      g3t1: "ok",
      g1t1: "ok",
      bajarGlobal: "ok",
      g63: "23514",
      colaNueva: "23514",
    });
  });

  it("ningún rol de la app escribe config_sistema y contapp_platform ni la lee", async () => {
    const res: Record<string, string> = {};
    for (const rol of [
      "contapp_backend",
      "contapp_worker",
      "contapp_platform",
    ]) {
      await enTx(admin, rol, async (c) => {
        res[`${rol}:update`] = codigo(
          await probar(
            c,
            "update config_sistema set reintentos = 10 where cola = 'sire'",
          ),
        );
        res[`${rol}:delete`] = codigo(
          await probar(c, "delete from config_sistema where cola = 'sire'"),
        );
        res[`${rol}:insert`] = codigo(
          await probar(c, "insert into config_sistema (cola) values ('sol')"),
        );
        if (rol === "contapp_platform")
          res[`${rol}:select`] = codigo(
            await probar(c, "select * from config_sistema"),
          );
      });
    }
    expect(Object.entries(res).filter(([, v]) => v !== "42501")).toEqual([]);
  });
});

describe("CA-12 · kek.rotar no ve datos de otro estudio", () => {
  it("sistema.estudios_ids devuelve solo uuid; el worker no puede asumir contapp_enumerador y ningún rol con login tiene BYPASSRLS", async () => {
    const r = await enTx(admin, "contapp_worker", async (c) => {
      const ids = await c.query("select * from sistema.estudios_ids() as t");
      const hostil = await probar(
        c,
        "select * from sistema.estudios_con_trabajos($1::text[], $2)",
        [["en_cola') or true --", null], -2_147_483_648],
      );
      const nulos = await probar(
        c,
        "select * from sistema.estudios_con_trabajos(null, null)",
      );
      return {
        columnas: ids.fields.map((f) => f.name).length,
        tipoUuid: ids.fields[0]?.dataTypeID === 2950,
        incluyeAyB:
          ids.rows.some((f) => Object.values(f)[0] === A) &&
          ids.rows.some((f) => Object.values(f)[0] === B),
        hostil: hostil.ok ? (hostil.rows ?? []).length : codigo(hostil),
        nulos: nulos.ok ? (nulos.rows ?? []).length : codigo(nulos),
      };
    });
    // SET ROLE se comprueba contra el usuario de la sesión: se intenta con la conexión real del worker (no superusuario).
    const asumir = codigo(
      await intentar(
        worker,
        { tenantId: A },
        "set local role contapp_enumerador",
      ),
    );
    const conLogin = await admin.query(
      `select rolname from pg_roles where rolcanlogin and rolbypassrls and not rolsuper and rolname like 'contapp%'
       union select m.rolname from pg_auth_members am join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member
        where r.rolname = 'contapp_enumerador'`,
    );
    expect({
      ...r,
      asumir,
      conLoginOMiembros: conLogin.rows.map((f) => f.rolname),
    }).toEqual({
      columnas: 1,
      tipoUuid: true,
      incluyeAyB: true,
      asumir: "42501",
      hostil: 0,
      nulos: 0,
      conLoginOMiembros: [],
    });
  });

  it("dentro de withTenant(A), el worker no lee ni re-envuelve la credencial de B ni ve el nombre de B", async () => {
    const lee = await worker
      .withTenant(
        { tenantId: A },
        async (tx) =>
          (
            await tx.query("select id from credencial where tenant_id = $1", [
              B,
            ])
          ).rows.length,
      )
      .catch(() => -1);
    const nombre = await worker
      .withTenant(
        { tenantId: A },
        async (tx) =>
          (await tx.query("select nombre from tenant where id = $1", [B])).rows
            .length,
      )
      .catch(() => -1);
    const reenv = await intentar(
      worker,
      { tenantId: A },
      "update credencial set dek_envuelta = $2, kek_id = 'k2' where tenant_id = $1",
      [B, Buffer.alloc(512)],
    );
    expect({
      lee,
      nombre,
      reenv: reenv.ok ? reenv.rowCount : reenv.code,
    }).toEqual({ lee: 0, nombre: 0, reenv: 0 });
  });
});

describe("CA-15 · escrituras forjadas sobre job_registro", () => {
  it("el backend no inserta en otro estudio, ni con un cliente ajeno, ni toca columnas fuera de la cancelación, ni borra", async () => {
    const ins = (tenant: string, cliente: string, ruc: string) =>
      intentar(
        backend,
        { tenantId: A },
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, max_intentos)
         values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'en_cola', '{}'::jsonb, decode(repeat('ab', 32), 'hex'), 3)`,
        [tenant, cliente, ruc],
      );
    const r = {
      otroEstudio: codigo(await ins(B, cB.id, cB.ruc)),
      clienteAjeno: ["23503", "42501"].includes(
        codigo(await ins(A, cB.id, cB.ruc)),
      )
        ? "rechazado"
        : "aceptado",
      parametros: codigo(
        await intentar(
          backend,
          { tenantId: A },
          "update job_registro set parametros = '{\"n\":9}' where id = $1",
          [jobAEnCola],
        ),
      ),
      intentos: codigo(
        await intentar(
          backend,
          { tenantId: A },
          "update job_registro set intentos = 0 where id = $1",
          [jobAEnCola],
        ),
      ),
      tenant: codigo(
        await intentar(
          backend,
          { tenantId: A },
          "update job_registro set tenant_id = $2 where id = $1",
          [jobAEnCola, B],
        ),
      ),
      cancelarAjeno: codigo(
        await intentar(
          backend,
          { tenantId: A },
          "update job_registro set estado = 'cancelado' where id = $1",
          [jobB],
        ),
      ),
      borrar: codigo(
        await intentar(
          backend,
          { tenantId: A },
          "delete from job_registro where id = $1",
          [jobATerminado],
        ),
      ),
    };
    const filaB = await e.fila(jobB);
    expect({ ...r, estadoB: filaB.estado }).toEqual({
      otroEstudio: "42501",
      clienteAjeno: "rechazado",
      parametros: "42501",
      intentos: "42501",
      tenant: "42501",
      cancelarAjeno: "ok",
      borrar: "42501",
      estadoB: "en_cola",
    });
    // `cancelarAjeno` "ok" con 0 filas: lo comprueba la fila de B, que sigue en_cola.
  });

  it("el worker solo borra terminados y no reescribe identidad ni parámetros del trabajo", async () => {
    const borrarVivo = await intentar(
      worker,
      { tenantId: A },
      "delete from job_registro where id = $1",
      [jobAEnCola],
    );
    const borrarTerminado = await intentar(
      worker,
      { tenantId: A },
      "delete from job_registro where id = $1",
      [jobATerminado],
    );
    const borrarAjeno = await intentar(
      worker,
      { tenantId: A },
      "delete from job_registro where tenant_id = $1",
      [B],
    );
    const cols: Record<string, string> = {};
    for (const [col, v] of [
      ["parametros", "'{}'::jsonb"],
      ["tipo", "'prueba.no_idempotente'"],
      ["cliente_id", `'${cB.id}'::uuid`],
      ["ruc", "'20000000001'"],
      ["tenant_id", `'${B}'::uuid`],
      ["creado_por", "null"],
      ["clave_dedupe", "decode(repeat('cd', 32), 'hex')"],
    ] as const)
      cols[col] = codigo(
        await intentar(
          worker,
          { tenantId: A },
          `update job_registro set ${col} = ${v} where id = $1`,
          [jobAEnCola],
        ),
      );
    expect({
      borrarVivo: borrarVivo.ok ? borrarVivo.rowCount : borrarVivo.code,
      borrarTerminado: borrarTerminado.ok
        ? borrarTerminado.rowCount
        : borrarTerminado.code,
      borrarAjeno: borrarAjeno.ok ? borrarAjeno.rowCount : borrarAjeno.code,
      cols,
    }).toEqual({
      borrarVivo: 0,
      borrarTerminado: 1,
      borrarAjeno: 0,
      cols: Object.fromEntries(Object.keys(cols).map((k) => [k, "42501"])),
    });
  });
});

// T3 (030) · CA-11 (escala): el guard de permisos y el listado de `/roles` no crecen con los roles de OTROS estudios.
// Medición: tiempo de pared del mínimo de varias peticiones, alternando «sin ruido» y «con ruido» en ≥ 5 rondas intercaladas (como
// `medirEscala`, pero async: cada ronda siembra y borra el ruido por SQL). Ruido: 100 estudios x 20 roles x 5 permisos (2.000 roles y
// 10.000 filas de rol_permiso). La razón con ruido / sin ruido (con un piso de 10 ms por el ruido de HTTP) no pasa de TOPE; no se sube
// un tope para que pase. Bajo cobertura la parte funcional corre y la de tiempo no se evalúa (`BAJO_COBERTURA`, 020 DT-1).
// Fuera de la cobertura: va en `*.rendimiento.int.spec.ts` (T14 lo excluye de `vitest.cobertura.config.mts`).
// Rojo: `/roles` (T9), las tablas `rol`/`rol_permiso` y `membresia.rol_id` (T6) y el guard con permisos efectivos (T8) aún no existen.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../../test/soporte-acceso.js";
import { BAJO_COBERTURA } from "../../../../test/tiempos.js";
import { crearOk, listar, miembroConRol, propiosDe } from "../../../../test/soporte-roles.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const ESTUDIOS_RUIDO = 100;
const ROLES_POR_ESTUDIO = 20; // U9: el máximo por estudio
const RONDAS = 5; // «≥ 5 corridas intercaladas»
const MUESTRAS = 6; // peticiones por lado y por ronda; se toma el mínimo
const PISO_MS = 10;
const TOPE = 2.5;

let b: Banco;
let E: Estudio;
let D: Actor;
let M: Actor;
let ruido: string[] = [];

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  D = E.titular;
  const rol = await crearOk(b, D, { permisos: ["clientes.ver", "clientes.crear", "buzon.ver"], alcance: "asignado" });
  await crearOk(b, D, { permisos: ["reglas.ver", "clientes.ver"], alcance: "global" });
  M = await miembroConRol(b, D, rol.id);
  const [c] = (await b.clientes(E.tenantId, 1)) as [string];
  await b.asignar(E.tenantId, c, M.id, "colaborador");
  const filas = await b.sql<{ id: string }>(
    "insert into tenant (id, nombre) select gen_random_uuid(), 'Ruido t030 ' || g from generate_series(1, $1::int) g returning id",
    [ESTUDIOS_RUIDO],
  );
  ruido = filas.map((f) => f.id);
});
afterAll(async () => {
  if (b && ruido.length > 0) {
    await quitarRuido().catch(() => undefined);
    await b.sql("delete from tenant where id = any($1::uuid[])", [ruido]).catch(() => undefined);
  }
  await b?.cerrar();
});

async function ponerRuido(): Promise<void> {
  await b.sql(
    `with r as (
       insert into rol (tenant_id, id, nombre, alcance)
       select t, gen_random_uuid(), 'Ruido ' || g, case when g % 2 = 0 then 'global' else 'asignado' end
         from unnest($1::uuid[]) t cross join generate_series(1, $2::int) g
       returning tenant_id, id)
     insert into rol_permiso (tenant_id, rol_id, permiso)
     select r.tenant_id, r.id, p from r cross join unnest(array['clientes.ver','clientes.crear','buzon.ver','reglas.ver','prorrata.ver']) p`,
    [ruido, ROLES_POR_ESTUDIO],
  );
}
async function quitarRuido(): Promise<void> {
  await b.sql("delete from rol_permiso where tenant_id = any($1::uuid[])", [ruido]);
  await b.sql("delete from rol where tenant_id = any($1::uuid[])", [ruido]);
}

/** Mínimo en ms de `n` ejecuciones seguidas de `f` (la primera, de calentamiento, no cuenta). */
async function minimo(n: number, f: () => Promise<unknown>): Promise<number> {
  await f();
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

/** `RONDAS` rondas: mide sin ruido, siembra, mide con ruido y borra; devuelve el mínimo de cada lado y su razón. */
async function medirIntercalado(f: () => Promise<unknown>): Promise<{ sinMs: number; conMs: number; razon: number }> {
  let sinMs = Infinity;
  let conMs = Infinity;
  for (let ronda = 0; ronda < RONDAS; ronda++) {
    if (ronda % 2 === 0) {
      sinMs = Math.min(sinMs, await minimo(MUESTRAS, f));
      await ponerRuido();
      try {
        conMs = Math.min(conMs, await minimo(MUESTRAS, f));
      } finally {
        await quitarRuido();
      }
    } else {
      await ponerRuido();
      try {
        conMs = Math.min(conMs, await minimo(MUESTRAS, f));
      } finally {
        await quitarRuido();
      }
      sinMs = Math.min(sinMs, await minimo(MUESTRAS, f));
    }
  }
  return { sinMs, conMs, razon: conMs / Math.max(sinMs, PISO_MS) };
}

describe("CA-11 · la escala no depende de los roles de otros estudios", () => {
  it("el guard con rol propio (GET /clientes de un miembro de alcance asignado) responde igual con 2.000 roles ajenos", async () => {
    const pedir = async () => {
      const r = await b.llamar(M, "GET", "/clientes");
      expect(r.status, r.text).toBe(200);
      expect(r.body).toHaveLength(1);
    };
    const m = await medirIntercalado(pedir);
    if (!BAJO_COBERTURA) {
      expect(m.razon, `sin ruido ${m.sinMs.toFixed(1)} ms, con ruido ${m.conMs.toFixed(1)} ms`).toBeLessThan(TOPE);
    }
  });

  it("el guard de un Dueño (rol de sistema) tampoco cambia, y /acceso/yo del miembro propio sigue igual", async () => {
    const m = await medirIntercalado(async () => {
      expect((await b.llamar(D, "GET", "/usuarios")).status).toBe(200);
      const yo = await b.llamar(M, "GET", "/acceso/yo");
      expect(yo.status, yo.text).toBe(200);
    });
    if (!BAJO_COBERTURA) {
      expect(m.razon, `sin ruido ${m.sinMs.toFixed(1)} ms, con ruido ${m.conMs.toFixed(1)} ms`).toBeLessThan(TOPE);
    }
  });

  it("GET /roles lista solo los roles del estudio y su tiempo no crece con los roles de otros estudios", async () => {
    const propios = propiosDe(await listar(b, D)).length;
    expect(propios).toBeGreaterThanOrEqual(2);
    const m = await medirIntercalado(async () => {
      const r = await listar(b, D);
      expect(r.status, r.text).toBe(200);
      expect(propiosDe(r)).toHaveLength(propios);
    });
    if (!BAJO_COBERTURA) {
      expect(m.razon, `sin ruido ${m.sinMs.toFixed(1)} ms, con ruido ${m.conMs.toFixed(1)} ms`).toBeLessThan(TOPE);
    }
  });

  it("con el ruido puesto, ningún id ajeno es visible ni asignable desde este estudio", async () => {
    await ponerRuido();
    try {
      const ajeno = (await b.sql<{ id: string }>("select id from rol where tenant_id = $1 limit 1", [ruido[0]]))[0]!.id;
      expect((await b.llamar(D, "PATCH", `/roles/${ajeno}`, { nombre: "x" })).status).toBe(404);
      expect((await b.llamar(D, "DELETE", `/roles/${ajeno}`)).status).toBe(404);
      expect((await b.llamar(D, "PATCH", `/usuarios/${M.id}/rol`, { rol: { rolId: ajeno } })).status).toBe(404);
      expect(JSON.stringify((await listar(b, D)).body)).not.toContain(ajeno);
    } finally {
      await quitarRuido();
    }
  });
});

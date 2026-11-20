// Spec 024 (T2, rojo): concurrencia de la atencion del buzon en BD real (D-6; CA-7; riesgo «Interbloqueo atencion <-> captura» del plan).
// Orden de bloqueo de la funcion: cliente (FOR SHARE, en orden de id) -> mensaje (FOR UPDATE, en orden de id) -> evento -> auditoria.
// Dos marcas del mismo mensaje dejan un solo evento; dos lotes de 100 solapados en orden inverso y un lote contra la actualizacion de
// conocidos de la captura no se interbloquean (sin 40P01); archivar el cliente contra marcar da uno de los dos resultados validos.
// Falla hoy porque la migracion 0060 aun no existe. El contrato esta en buzon-atencion-soporte.ts.
import { actualizarConocidosBuzon } from "@contapp/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "./soporte";
import {
  abrirAdmin,
  aplicar,
  crearDb,
  dormir,
  EscenarioAtencion,
  eventosDe,
  type ClientePrueba,
  type FilaAplicar,
} from "./buzon-atencion-soporte";

let admin: Pool;
let ea: EscenarioAtencion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let uA: string;
let uB: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ea = new EscenarioAtencion(admin);
  X = (await ea.estudio()).id;
  uA = (await ea.et.miembro(X, "contador")).id;
  uB = (await ea.et.miembro(X, "asistente")).id;
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ea?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

const ctx = (userId: string) => ({ tenantId: X, userId });
const codigo = (r: PromiseSettledResult<unknown>): string =>
  r.status === "fulfilled"
    ? "ok"
    : String(
        (r.reason as { code?: string }).code ??
          (r.reason as { message?: string }).message,
      );

let serie = 0;
/** `n` mensajes nuevos repartidos entre los clientes (superusuario, una sentencia); devuelve ids e ids de SUNAT por mensaje. */
async function sembrarLote(
  clientes: ClientePrueba[],
  n: number,
): Promise<{ id: string; idSunat: string; clienteId: string }[]> {
  const marca = `C24-${++serie}-${Date.now()}`;
  const r = await admin.query(
    `insert into buzon_mensaje
        (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, version_catalogo, avisado, leido_sunat,
         primera_captura_en, ultima_captura_en, adjuntos_declarados)
       select $1, ($2::uuid[])[1 + (g % cardinality($2::uuid[]))], $3::text || '-' || g, 'Asunto de prueba', 'SUNAT',
              now() - make_interval(mins => g), 'otro', false, 1, false, false, now(), now(), 0
         from generate_series(1, $4::int) g
       returning id, id_sunat, cliente_id`,
    [X, clientes.map((c) => c.id), marca, n],
  );
  return (r.rows as { id: string; id_sunat: string; cliente_id: string }[])
    .map((x) => ({ id: x.id, idSunat: x.id_sunat, clienteId: x.cliente_id }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe("dos marcas simultaneas del mismo mensaje (CA-7)", () => {
  it("10 rondas: un solo evento, un aplicado = true y un aplicado = false; el segundo ve al primero como autor", async () => {
    const c = await ea.et.cliente(X);
    for (let ronda = 0; ronda < 10; ronda++) {
      const [m] = await sembrarLote([c], 1);
      // Pares: A sostiene su transaccion y B espera el candado; impares: al reves; cada tercera, sin esperas.
      const sinEsperas = ronda % 3 === 2;
      const sostenerA = sinEsperas ? 0 : ronda % 2 === 0 ? 70 : 0;
      const sostenerB = sinEsperas ? 0 : ronda % 2 === 1 ? 70 : 0;
      const [a, b] = await Promise.allSettled([
        (async () => {
          if (ronda % 2 === 1 && !sinEsperas) await dormir(20);
          return aplicar(
            backend,
            ctx(uA),
            c.id,
            [m!.id],
            "marcar",
            "Nota A",
            sostenerA,
          );
        })(),
        (async () => {
          if (ronda % 2 === 0 && !sinEsperas) await dormir(20);
          return aplicar(
            backend,
            ctx(uB),
            c.id,
            [m!.id],
            "marcar",
            "Nota B",
            sostenerB,
          );
        })(),
      ]);
      expect([codigo(a), codigo(b)], `ronda ${ronda}`).toEqual(["ok", "ok"]);
      const filas = [a, b].map(
        (x) => (x as PromiseFulfilledResult<FilaAplicar[]>).value[0]!,
      );
      expect(
        filas.filter((f) => f.aplicado).length,
        `ronda ${ronda}: uno aplica`,
      ).toBe(1);
      expect(
        filas.filter((f) => !f.aplicado).length,
        `ronda ${ronda}: el otro no`,
      ).toBe(1);
      const ev = await eventosDe(admin, m!.id);
      expect(ev, `ronda ${ronda}: un solo evento`).toHaveLength(1);
      const ganador = filas.find((f) => f.aplicado)!;
      const perdedor = filas.find((f) => !f.aplicado)!;
      expect(ev[0]!.usuario_id).toBe(ganador.atendido_por);
      expect(perdedor.atendido_por, `ronda ${ronda}: ve al autor`).toBe(
        ganador.atendido_por,
      );
      const e = (
        await admin.query(
          "select atendido_por from buzon_mensaje where id = $1",
          [m!.id],
        )
      ).rows[0];
      expect(e.atendido_por).toBe(ganador.atendido_por);
    }
  }, 60_000);

  it("marcar y deshacer a la vez del mismo mensaje atendido: el estado final coincide con el ultimo evento", async () => {
    const c = await ea.et.cliente(X);
    for (let ronda = 0; ronda < 5; ronda++) {
      const [m] = await sembrarLote([c], 1);
      await aplicar(backend, ctx(uA), c.id, [m!.id], "marcar", "Inicial");
      const [d1, d2] = await Promise.allSettled([
        aplicar(backend, ctx(uA), c.id, [m!.id], "deshacer", null, 40),
        aplicar(backend, ctx(uB), c.id, [m!.id], "deshacer", null),
      ]);
      expect([codigo(d1), codigo(d2)], `ronda ${ronda}`).toEqual(["ok", "ok"]);
      const ev = await eventosDe(admin, m!.id);
      expect(
        ev.map((x) => x.accion),
        `ronda ${ronda}`,
      ).toEqual(["atendido", "deshecho"]);
      const e = (
        await admin.query(
          "select atendido_en, atendido_por from buzon_mensaje where id = $1",
          [m!.id],
        )
      ).rows[0];
      expect(e).toEqual({ atendido_en: null, atendido_por: null });
    }
  }, 60_000);
});

describe("dos lotes de 100 solapados en orden inverso (orden de bloqueo por id)", () => {
  it("5 rondas con dos clientes: sin 40P01, cada mensaje se marca una sola vez y quedan 100 eventos", async () => {
    const c1 = await ea.et.cliente(X);
    const c2 = await ea.et.cliente(X);
    for (let ronda = 0; ronda < 5; ronda++) {
      const ms = await sembrarLote([c1, c2], 100);
      const asc = ms.map((m) => m.id);
      const desc = [...asc].reverse();
      const [a, b] = await Promise.allSettled([
        aplicar(backend, ctx(uA), null, asc, "marcar", "Lote A"),
        aplicar(backend, ctx(uB), null, desc, "marcar", "Lote B"),
      ]);
      expect(
        [codigo(a), codigo(b)],
        `ronda ${ronda}: sin interbloqueo`,
      ).toEqual(["ok", "ok"]);
      const filas = [a, b].flatMap(
        (x) => (x as PromiseFulfilledResult<FilaAplicar[]>).value,
      );
      expect(filas, `ronda ${ronda}`).toHaveLength(200);
      expect(
        filas.filter((f) => f.aplicado),
        `ronda ${ronda}: aplicados`,
      ).toHaveLength(100);
      expect(
        filas.filter((f) => !f.aplicado),
        `ronda ${ronda}: omitidos`,
      ).toHaveLength(100);
      const n = (
        await admin.query(
          "select count(*)::int as n from buzon_atencion where mensaje_id = any($1::uuid[])",
          [asc],
        )
      ).rows[0].n;
      expect(n, `ronda ${ronda}: un evento por mensaje`).toBe(100);
    }
  }, 120_000);

  it("lotes parcialmente solapados (0..69 ascendente y 30..99 descendente): sin 40P01 y 100 eventos", async () => {
    const c1 = await ea.et.cliente(X);
    const c2 = await ea.et.cliente(X);
    for (let ronda = 0; ronda < 5; ronda++) {
      const ms = await sembrarLote([c1, c2], 100);
      const ids = ms.map((m) => m.id);
      const [a, b] = await Promise.allSettled([
        aplicar(backend, ctx(uA), null, ids.slice(0, 70), "marcar", "Lote A"),
        aplicar(
          backend,
          ctx(uB),
          null,
          ids.slice(30).reverse(),
          "marcar",
          "Lote B",
        ),
      ]);
      expect([codigo(a), codigo(b)], `ronda ${ronda}`).toEqual(["ok", "ok"]);
      const n = (
        await admin.query(
          "select count(*)::int as n from buzon_atencion where mensaje_id = any($1::uuid[])",
          [ids],
        )
      ).rows[0].n;
      expect(n, `ronda ${ronda}`).toBe(100);
    }
  }, 120_000);
});

describe("lote contra la actualizacion de conocidos de la captura (escritura.ts, orden de bloqueo por id)", () => {
  it("20 rondas: el lote de 100 y actualizarConocidosBuzon sobre los mismos mensajes en orden inverso no dan 40P01", async () => {
    const c = await ea.et.cliente(X);
    for (let ronda = 0; ronda < 20; ronda++) {
      const ms = await sembrarLote([c], 100);
      const asc = ms.map((m) => m.id);
      const inverso = [...ms].reverse().map((m) => ({
        idSunat: m.idSunat,
        leidoEnSunat: true,
      }));
      const [lote, captura] = await Promise.allSettled([
        aplicar(backend, ctx(uA), c.id, asc, "marcar", "Lote contra captura"),
        worker.withTenant({ tenantId: X }, (tx) =>
          actualizarConocidosBuzon(tx as never, c.id, inverso),
        ),
      ]);
      expect(
        [codigo(lote), codigo(captura)],
        `ronda ${ronda}: sin interbloqueo`,
      ).toEqual(["ok", "ok"]);
      expect(
        (lote as PromiseFulfilledResult<FilaAplicar[]>).value.every(
          (f) => f.aplicado,
        ),
        `ronda ${ronda}: todos marcados`,
      ).toBe(true);
      const r = (
        await admin.query(
          `select count(*) filter (where atendido_en is not null)::int as atendidos, count(*) filter (where leido_sunat)::int as leidos
             from buzon_mensaje where id = any($1::uuid[])`,
          [asc],
        )
      ).rows[0];
      expect(r, `ronda ${ronda}: ambas escrituras llegaron`).toEqual({
        atendidos: 100,
        leidos: 100,
      });
    }
  }, 120_000);

  it("la captura no cambia la atencion: tras marcar, actualizar los conocidos deja atendido_en y atendido_por como estaban", async () => {
    const c = await ea.et.cliente(X);
    const ms = await sembrarLote([c], 3);
    await aplicar(
      backend,
      ctx(uA),
      c.id,
      ms.map((m) => m.id),
      "marcar",
      "Antes de la captura",
    );
    const antes = (
      await admin.query(
        "select id, atendido_en, atendido_por, historico from buzon_mensaje where id = any($1::uuid[]) order by id",
        [ms.map((m) => m.id)],
      )
    ).rows;
    await worker.withTenant({ tenantId: X }, (tx) =>
      actualizarConocidosBuzon(
        tx as never,
        c.id,
        ms.map((m) => ({ idSunat: m.idSunat, leidoEnSunat: true })),
      ),
    );
    const despues = (
      await admin.query(
        "select id, atendido_en, atendido_por, historico from buzon_mensaje where id = any($1::uuid[]) order by id",
        [ms.map((m) => m.id)],
      )
    ).rows;
    expect(despues).toEqual(antes);
    expect(
      antes.every((f) => f.atendido_en !== null && f.atendido_por === uA),
    ).toBe(true);
  });
});

describe("archivar el cliente contra marcar (U-1, bloqueo FOR SHARE del cliente)", () => {
  const archivar = (
    tx: { query(t: string, v?: unknown[]): Promise<unknown> },
    id: string,
  ) =>
    tx.query(
      "update cliente set archivado_at = now(), updated_at = now() where id = $1 and archivado_at is null",
      [id],
    );

  it("10 rondas: si marcar toma el cliente primero, aplica y archivar espera; si archivar va primero, marcar da 55000 y no deja evento", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ea.et.cliente(X);
      const [m] = await sembrarLote([c], 1);
      const modo = ronda % 3; // 0: marcar sostiene; 1: archivar sostiene; 2: sin esperas
      const marcar = async () => {
        if (modo === 1) await dormir(25);
        return aplicar(
          backend,
          ctx(uA),
          c.id,
          [m!.id],
          "marcar",
          "Nota",
          modo === 0 ? 80 : 0,
        );
      };
      const archivarTx = async () => {
        if (modo === 0) await dormir(25);
        return backend.withTenant(ctx(uB), async (tx) => {
          await archivar(tx, c.id);
          if (modo === 1) await tx.query("select pg_sleep(0.08)");
        });
      };
      const [r1, r2] = await Promise.allSettled([marcar(), archivarTx()]);
      expect(codigo(r2), `ronda ${ronda}: archivar termina`).toBe("ok");
      const ev = await eventosDe(admin, m!.id);
      const archivado = (
        await admin.query("select archivado_at from cliente where id = $1", [
          c.id,
        ])
      ).rows[0].archivado_at;
      expect(
        archivado,
        `ronda ${ronda}: el cliente queda archivado`,
      ).not.toBeNull();
      const resultado = codigo(r1);
      // Solo hay dos resultados validos: marcado antes de archivar, o 55000 sin evento.
      if (resultado === "ok") {
        expect(
          (r1 as PromiseFulfilledResult<FilaAplicar[]>).value[0]!.aplicado,
          `ronda ${ronda}`,
        ).toBe(true);
        expect(ev, `ronda ${ronda}: un evento`).toHaveLength(1);
      } else {
        expect(resultado, `ronda ${ronda}: archivado antes`).toBe("55000");
        expect(
          ev,
          `ronda ${ronda}: ningun evento en un archivado`,
        ).toHaveLength(0);
      }
      if (modo === 0)
        expect(resultado, `ronda ${ronda}: marcar tenia el cliente`).toBe("ok");
      if (modo === 1)
        expect(resultado, `ronda ${ronda}: archivar tenia el cliente`).toBe(
          "55000",
        );
    }
  }, 60_000);
});

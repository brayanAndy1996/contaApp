import { PERMISOS_POR_ROL, ROLES, type Permiso } from "@contapp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Despachador, crearClaves, registrarTipo } from "./index.js";
import {
  bd,
  dbFalsa,
  uuidDe,
  type FilaTrabajo,
} from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

vi.mock(
  "@contapp/db",
  async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso,
);

// T4b (plan 008, Despachador y "Ratificaciones" (4); D17, CA-14): lo que el despachador pasa a
// `revalidarEncolado` y a `transicionar` (firmas definitivas: encabezado de
// tests/aislamiento/trabajos-repos.spec.ts, reflejadas en soporte-pruebas/bd-falsa.ts).
//  - revalidarEncolado(tx, { clienteId, creadoPor, rolesPermitidos, ...resto del despacho }):
//    rolesPermitidos = roles de PERMISOS_POR_ROL que tienen `definicionDe(tipo).permiso`, o `null`
//    si el tipo no exige permiso. El doble devuelve `acceso_retirado` si el rol que la prueba asigna
//    en `bd.roles` al creador no esta en rolesPermitidos.
//  - transicionar(tx, id, desde, hacia, campos?): quien llama NUNCA pasa fechas (iniciadoEn,
//    terminadoEn, actualizadoEn): las fija la BD.
const [TA, TB] = [uuidDe(0xa1), uuidDe(0xb1)];
const CREADOR = uuidDe(0xe1);

const registrar = (tipo: string, permiso: Permiso | null): void =>
  registrarTipo({
    tipo,
    cola: "sire",
    canal: "sire",
    credencial: null,
    permiso,
    idempotente: true,
    parametros: z.object({}),
  });

registrar("test.rev.descargar", "sire.descargar");
registrar("test.rev.plan", "plan.gestionar");
registrar("test.rev.ver", "clientes.ver");
registrar("test.rev.libre", null);

let reloj: RelojFalso;
let redis: RedisFalso;
let agregados: unknown[];
let contador = 0;

const rolesCon = (permiso: Permiso): string[] =>
  ROLES.filter((r) => PERMISOS_POR_ROL[r].has(permiso));

const despachador = (): Despachador =>
  new Despachador({
    db: dbFalsa as never,
    redis: redis as never,
    reloj,
    prefijo: "p1:",
    agregarACola: async (_cola: string, payload: unknown) => {
      agregados.push(payload);
    },
  });

async function sembrar(o: Partial<FilaTrabajo> & { tipo: string }) {
  contador++;
  const k = crearClaves("p1:");
  const id = bd.siguienteId();
  const creadoEn = new Date(reloj.ms() - 3_600_000 + contador);
  const fila: FilaTrabajo = {
    id,
    tenantId: TA,
    clienteId: uuidDe(0x2000 + contador),
    ruc: `2010${String(contador).padStart(7, "0")}`,
    cola: "sire",
    canal: "sire",
    prioridad: "interactivo",
    estado: "en_cola",
    intentos: 0,
    motivo: null,
    creadoPor: CREADOR,
    creadoEn,
    disponibleDesde: creadoEn,
    iniciadoEn: null,
    terminadoEn: null,
    claveDedupe: id,
    parametros: {},
    ...o,
  };
  bd.trabajos.set(id, fila);
  await redis.sadd(k.tenants(fila.cola), fila.tenantId);
  await redis.zadd(k.pend(fila.cola, fila.tenantId), 0, id);
  return fila;
}

beforeEach(() => {
  bd.reiniciar();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  agregados = [];
  contador = 0;
});

describe("argumentos de revalidarEncolado (D17)", () => {
  it("pasa clienteId, creadoPor y rolesPermitidos al repo, dentro del withTenant del trabajo", async () => {
    const f = await sembrar({ tipo: "test.rev.descargar", tenantId: TB });
    await despachador().ciclo();
    expect(bd.revalidaciones).toHaveLength(1);
    const r = bd.revalidaciones[0]!;
    expect(r.tenantId).toBe(TB);
    expect(r.args.clienteId).toBe(f.clienteId);
    expect(r.args.creadoPor).toBe(CREADOR);
    expect(Array.isArray(r.args.rolesPermitidos)).toBe(true);
  });

  it("sire.descargar -> dueno, admin, contador y asistente (lectura no)", async () => {
    await sembrar({ tipo: "test.rev.descargar" });
    await despachador().ciclo();
    const roles = bd.revalidaciones[0]!.args.rolesPermitidos as string[];
    expect([...roles].sort()).toEqual(
      ["admin", "asistente", "contador", "dueno"].sort(),
    );
  });

  it.each([
    ["sire.descargar", "test.rev.descargar", "sire.descargar"],
    ["plan.gestionar", "test.rev.plan", "plan.gestionar"],
    ["clientes.ver", "test.rev.ver", "clientes.ver"],
  ] as const)(
    "rolesPermitidos de %s sale de PERMISOS_POR_ROL",
    async (_n, tipo, permiso) => {
      await sembrar({ tipo });
      await despachador().ciclo();
      const roles = bd.revalidaciones[0]!.args.rolesPermitidos as string[];
      expect([...roles].sort()).toEqual([...rolesCon(permiso)].sort());
    },
  );

  it("plan.gestionar solo lo tiene el dueno; clientes.ver los cinco roles", async () => {
    await sembrar({ tipo: "test.rev.plan" });
    await sembrar({ tipo: "test.rev.ver" });
    const d = despachador();
    await d.ciclo(); // un trabajo por tenant y ciclo
    await d.ciclo();
    const porTipo = bd.revalidaciones.map((r) => r.args.rolesPermitidos);
    expect(porTipo).toContainEqual(["dueno"]);
    expect(
      porTipo.some(
        (rs) => Array.isArray(rs) && new Set(rs).size === ROLES.length,
      ),
    ).toBe(true);
  });

  it("un tipo sin permiso pasa rolesPermitidos = null", async () => {
    const f = await sembrar({ tipo: "test.rev.libre" });
    await despachador().ciclo();
    expect(bd.revalidaciones[0]!.args.rolesPermitidos).toBeNull();
    expect(f.estado).toBe("ejecutando");
  });

  it("un programado (creadoPor null) pasa creadoPor null y se despacha", async () => {
    const f = await sembrar({
      tipo: "test.rev.descargar",
      creadoPor: null,
      prioridad: "programado",
    });
    await despachador().ciclo();
    expect(bd.revalidaciones[0]!.args.creadoPor).toBeNull();
    expect(f.estado).toBe("ejecutando");
    expect(agregados).toHaveLength(1);
  });
});

describe("el rol del creador decide el despacho (CA-14)", () => {
  it("rol sin el permiso del tipo: cancelado/acceso_retirado, sin agregar a la cola ni gastar cupo", async () => {
    bd.roles.set(CREADOR, "lectura");
    const f = await sembrar({ tipo: "test.rev.descargar" });
    await despachador().ciclo();
    expect(f.estado).toBe("cancelado");
    expect(f.motivo).toBe("acceso_retirado");
    expect(agregados).toHaveLength(0);
    expect(await redis.zcard(crearClaves("p1:").cupoGlobal("sire"))).toBe(0);
    expect(await redis.exists(crearClaves("p1:").lockRuc("sire", f.ruc))).toBe(
      0,
    );
  });

  it.each([
    ["dueno", true],
    ["admin", true],
    ["contador", true],
    ["asistente", true],
    ["lectura", false],
  ] as const)(
    "creador %s con sire.descargar: despacha = %s",
    async (rol, ok) => {
      bd.roles.set(CREADOR, rol);
      const f = await sembrar({ tipo: "test.rev.descargar" });
      await despachador().ciclo();
      expect(f.estado).toBe(ok ? "ejecutando" : "cancelado");
    },
  );

  it("plan.gestionar: un admin creador se retira, el dueno pasa", async () => {
    bd.roles.set(CREADOR, "admin");
    bd.roles.set(uuidDe(0xe2), "dueno");
    const admin = await sembrar({ tipo: "test.rev.plan" });
    const dueno = await sembrar({
      tipo: "test.rev.plan",
      tenantId: TB,
      creadoPor: uuidDe(0xe2),
    });
    await despachador().ciclo();
    expect(admin.estado).toBe("cancelado");
    expect(admin.motivo).toBe("acceso_retirado");
    expect(dueno.estado).toBe("ejecutando");
  });

  it("tipo sin permiso: cualquier rol del creador pasa", async () => {
    bd.roles.set(CREADOR, "lectura");
    const f = await sembrar({ tipo: "test.rev.libre" });
    await despachador().ciclo();
    expect(f.estado).toBe("ejecutando");
  });
});

describe("transicionar sin fechas del llamador (Ratificaciones (4))", () => {
  const FECHAS = ["iniciadoEn", "terminadoEn", "actualizadoEn", "creadoEn"];

  it("al despachar no pasa fechas y la BD fija iniciadoEn", async () => {
    const f = await sembrar({ tipo: "test.rev.libre" });
    await despachador().ciclo();
    expect(bd.transiciones).toHaveLength(1);
    const t = bd.transiciones[0]!;
    expect([t.id, t.desde, t.hacia]).toEqual([f.id, "en_cola", "ejecutando"]);
    for (const campo of FECHAS)
      expect(t.campos ?? {}).not.toHaveProperty(campo);
    for (const v of Object.values(t.campos ?? {})) {
      expect(v instanceof Date).toBe(false);
    }
    expect(f.iniciadoEn).toEqual(bd.ahora());
    expect(f.terminadoEn).toBeNull();
  });

  it("al retirar el acceso (estado terminal) tampoco pasa fechas y la BD fija terminadoEn", async () => {
    bd.roles.set(CREADOR, "lectura");
    const f = await sembrar({ tipo: "test.rev.descargar" });
    await despachador().ciclo();
    expect(bd.transiciones.length).toBeGreaterThanOrEqual(1);
    for (const t of bd.transiciones) {
      for (const campo of FECHAS)
        expect(t.campos ?? {}).not.toHaveProperty(campo);
      for (const v of Object.values(t.campos ?? {})) {
        expect(v instanceof Date).toBe(false);
      }
    }
    expect(f.terminadoEn).toEqual(bd.ahora());
    expect(f.iniciadoEn).toBeNull();
  });

  it("el doble ignora fechas que le pasen en campos (como el repo real)", async () => {
    const { moduloDbFalso } = await import("./soporte-pruebas/bd-falsa.js");
    const f = await sembrar({ tipo: "test.rev.libre" });
    const falsa = new Date("2000-01-01T00:00:00.000Z");
    const ok = await moduloDbFalso.transicionar(
      { tenantId: f.tenantId },
      f.id,
      "en_cola",
      "ejecutando",
      { iniciadoEn: falsa, terminadoEn: falsa, actualizadoEn: falsa } as never,
    );
    expect(ok).toBe(true);
    expect(f.iniciadoEn).toEqual(bd.ahora());
    expect(f.terminadoEn).toBeNull();
  });
});

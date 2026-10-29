import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registrarTipo } from "./catalogo.js";
import {
  armar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  suscribirEventos,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";

// Spec 008, T5 (integración con PostgreSQL y Redis reales): revalidación al despachar (CA-14, D17) y credencial inválida
// en el despachador (CA-9, D13). Contrato que fija (ya implementado en T9): al despachar un `en_cola` se revalida, con el
// estado de ese momento, que quien lo encoló (si hay `creadoPor`) tenga membresía activa, un rol con el permiso del tipo y
// —salvo Dueño y Administrador— una asignación al cliente; si no, el trabajo pasa a `cancelado` con motivo `acceso_retirado`
// sin ejecutarse (evento SSE incluido). Un programado sin usuario solo exige que el cliente exista. Un tipo con credencial
// cuyo `credencial.estado = 'invalida'` pasa a `cancelado`/`credencial_invalida`; reemplazar `ciphertext` lo desbloquea
// (trigger de 0018). Una cancelación no gasta el despacho: el siguiente candidato del estudio sale en el mismo ciclo.
// Los cambios de acceso se hacen con el rol administrativo ANTES del primer ciclo (el despachador se maneja a mano).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Tipo propio de la prueba, con credencial SOL (el catálogo real los registra cada spec de negocio).
registrarTipo({
  tipo: "prueba.credencial_sol",
  cola: "sire",
  canal: "sire",
  credencial: "sol",
  permiso: "sire.descargar",
  idempotente: true,
  parametros: z.object({ n: z.number().int().optional() }),
});

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijos: string[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Despachador a mano, eventos suscritos y un helper para encolar con el rol backend. */
async function escenario() {
  const prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  const T = await e.estudio();
  const a = await armar({ prefijo, automatico: false, duracionMs: 10 });
  const ev = await suscribirEventos(prefijo, [T]);
  const encolar = (
    c: ClientePrueba,
    creadoPor: string | null,
    o: {
      tipo?: string;
      n?: number;
      prioridad?: "interactivo" | "programado";
    } = {},
  ) =>
    encolarYPublicar(backend, redis, prefijo, T, {
      tipo: o.tipo ?? "prueba.eco",
      clienteId: c.id,
      parametros: { n: o.n ?? Math.floor(Math.random() * 1e6) },
      prioridad: o.prioridad ?? "interactivo",
      creadoPor,
    }).then((r) => r.trabajo.id);
  const estado = async (id: string) => (await e.fila(id))?.estado as string;
  const ciclos = async (n = 3) => {
    for (let i = 0; i < n; i++) await a.despachador.ciclo();
  };
  const cerrar = async () => {
    await a.detener();
    await ev.cerrar();
  };
  return { T, a, ev, encolar, estado, ciclos, cerrar };
}

describe("CA-14: al despachar se revalida a quien encoló", () => {
  it("control: un contador activo y asignado al cliente se ejecuta", async () => {
    const s = await escenario();
    try {
      const u = await e.usuario(s.T, "contador");
      const c = await e.cliente(s.T);
      await e.asignar(s.T, c.id, u);
      const id = await s.encolar(c, u);
      await s.ciclos();
      await esperarHasta(
        async () => (await s.estado(id)) === "completado",
        "completado",
      );
    } finally {
      await s.cerrar();
    }
  });

  it("Dueño y Administrador se ejecutan sin asignación", async () => {
    const s = await escenario();
    try {
      const [dueno, admin1] = [
        await e.usuario(s.T, "dueno"),
        await e.usuario(s.T, "admin"),
      ];
      const [c1, c2] = [await e.cliente(s.T), await e.cliente(s.T)];
      const [i1, i2] = [
        await s.encolar(c1, dueno),
        await s.encolar(c2, admin1),
      ];
      await s.ciclos(4);
      await esperarHasta(
        async () =>
          (await s.estado(i1)) === "completado" &&
          (await s.estado(i2)) === "completado",
        "ambos completados",
      );
    } finally {
      await s.cerrar();
    }
  });

  it.each([
    [
      "se le desasigna el cliente",
      (T: string, u: string, c: ClientePrueba) =>
        admin.pool.query(
          "delete from asignacion where tenant_id = $1 and usuario_id = $2 and cliente_id = $3",
          [T, u, c.id],
        ),
    ],
    [
      "se le cambia el rol a uno sin el permiso (lectura)",
      (T: string, u: string) =>
        admin.pool.query(
          "update membresia set rol = 'lectura' where tenant_id = $1 and usuario_id = $2",
          [T, u],
        ),
    ],
    [
      "se desactiva su membresía",
      (T: string, u: string) =>
        admin.pool.query(
          "update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2",
          [T, u],
        ),
    ],
  ])(
    "%s antes del despacho: cancelado/acceso_retirado, no se ejecuta y se emite el evento",
    async (_n, cambio) => {
      const s = await escenario();
      try {
        const u = await e.usuario(s.T, "contador");
        const c = await e.cliente(s.T);
        await e.asignar(s.T, c.id, u);
        const id = await s.encolar(c, u);
        await cambio(s.T, u, c);
        await s.ciclos(4);
        const fila = await e.fila(id);
        expect(fila).toMatchObject({
          estado: "cancelado",
          motivo: "acceso_retirado",
        });
        expect(fila.iniciado_en).toBeNull();
        expect(s.a.ejecutor.iniciados).not.toContain(id);
        await esperarHasta(
          () => s.ev.de(id).some((x) => x.estado === "cancelado"),
          "evento de cancelación",
        );
        expect(s.ev.de(id).find((x) => x.estado === "cancelado")).toMatchObject(
          { motivo: "acceso_retirado", id },
        );
      } finally {
        await s.cerrar();
      }
    },
  );

  it("un programado sin usuario sigue aunque nadie esté asignado al cliente", async () => {
    const s = await escenario();
    try {
      const c = await e.cliente(s.T);
      const id = await s.encolar(c, null, { prioridad: "programado" });
      await s.ciclos();
      await esperarHasta(
        async () => (await s.estado(id)) === "completado",
        "completado",
      );
    } finally {
      await s.cerrar();
    }
  });

  it("una cancelación no gasta el despacho: tras cancelar al primero, el segundo del estudio sale en el mismo ciclo", async () => {
    const s = await escenario();
    try {
      const u = await e.usuario(s.T, "contador");
      const [c1, c2] = [await e.cliente(s.T), await e.cliente(s.T)];
      await e.asignar(s.T, c1.id, u);
      await e.asignar(s.T, c2.id, u);
      const [i1, i2] = [await s.encolar(c1, u), await s.encolar(c2, u)];
      await admin.pool.query(
        "delete from asignacion where tenant_id = $1 and usuario_id = $2 and cliente_id = $3",
        [s.T, u, c1.id],
      );
      await s.a.despachador.ciclo(); // un solo ciclo
      expect(await s.estado(i1)).toBe("cancelado");
      expect(["ejecutando", "completado"]).toContain(await s.estado(i2));
    } finally {
      await s.cerrar();
    }
  });
});

describe("CA-9 (despachador): credencial inválida del cliente", () => {
  it("los pendientes y los nuevos del cliente se cancelan con credencial_invalida sin ejecutarse; los de otro cliente siguen; reemplazar ciphertext lo desbloquea", async () => {
    const s = await escenario();
    try {
      const u = await e.usuario(s.T, "contador");
      const [c1, c2] = [await e.cliente(s.T), await e.cliente(s.T)];
      for (const c of [c1, c2]) await e.asignar(s.T, c.id, u);
      const cred1 = await e.credencial(s.T, c1.id, "sol");
      await e.credencial(s.T, c2.id, "sol");
      const pend = [
        await s.encolar(c1, u, { tipo: "prueba.credencial_sol", n: 1 }),
        await s.encolar(c1, u, { tipo: "prueba.credencial_sol", n: 2 }),
      ];
      const otro = await s.encolar(c2, u, {
        tipo: "prueba.credencial_sol",
        n: 3,
      });

      // El worker marcó la credencial del cliente 1 como inválida (lo hace T10 al recibir ErrorCredencial).
      await admin.pool.query(
        "update credencial set estado = 'invalida', estado_motivo = 'credencial_invalida', estado_at = now() where id = $1",
        [cred1],
      );
      await s.ciclos(6);
      for (const id of pend)
        expect(await e.fila(id)).toMatchObject({
          estado: "cancelado",
          motivo: "credencial_invalida",
        });
      await esperarHasta(
        async () => (await s.estado(otro)) === "completado",
        "el otro cliente se ejecuta",
      );
      expect(s.a.ejecutor.iniciados).not.toContain(pend[0]);

      // Un trabajo nuevo del cliente 1 también se cancela.
      const nuevo = await s.encolar(c1, u, {
        tipo: "prueba.credencial_sol",
        n: 4,
      });
      await s.ciclos(3);
      expect(await e.fila(nuevo)).toMatchObject({
        estado: "cancelado",
        motivo: "credencial_invalida",
      });

      // Reemplazar el ciphertext devuelve la credencial a 'configurada' y el cliente vuelve a ejecutar.
      await admin.pool.query(
        "update credencial set ciphertext = decode(repeat('ab', 64), 'hex') where id = $1",
        [cred1],
      );
      expect(
        (
          await admin.pool.query(
            "select estado, estado_motivo from credencial where id = $1",
            [cred1],
          )
        ).rows[0],
      ).toEqual({ estado: "configurada", estado_motivo: null });
      const tras = await s.encolar(c1, u, {
        tipo: "prueba.credencial_sol",
        n: 5,
      });
      await s.ciclos(3);
      await esperarHasta(
        async () => (await s.estado(tras)) === "completado",
        "el cliente desbloqueado se ejecuta",
      );
    } finally {
      await s.cerrar();
    }
  });
});

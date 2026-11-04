// Spec 007b T16 · ronda adversarial (caja blanca) del procesador de verificación: AAD cruzada con el descifrado real
// del worker (no solo con `node:crypto`). Copiar el sobre de una fila a otro cliente o a otro tipo debe fallar al
// descifrar: el puerto no recibe nada y la credencial no queda `verificada`. Claves CANARIO.
import { MockSireAuth, MockSolAuth } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SireAuthControlado,
  SolAuthControlado,
  arrancar007b,
  esperarTerminal,
  guardarCredencial,
} from "../../../test/procesadores-007b.js";
import { canario } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  registrarTiposDePrueba,
  restaurarConfig,
} from "../../../test/trabajos.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
registrarTiposDePrueba();

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
  for (const cola of ["sol", "sire"])
    await fijarConfig(admin, cola, {
      global: 4,
      tenant: 2,
      espera: 0,
      reintentos: 1,
      base: 100,
    });
});
afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Copia el sobre (ciphertext, nonce, tag, DEK envuelta, kek_id) de una fila sobre otra, como haría un atacante con BD. */
async function copiarSobre(desde: string, hacia: string): Promise<void> {
  await admin.pool.query(
    `update credencial d set ciphertext = o.ciphertext, nonce = o.nonce, tag = o.tag, dek_envuelta = o.dek_envuelta,
            kek_id = o.kek_id
       from credencial o where o.id = $1 and d.id = $2`,
    [desde, hacia],
  );
}
const estadoDe = async (clienteId: string, tipo: string) =>
  (
    await admin.pool.query(
      "select estado from credencial where cliente_id = $1 and tipo = $2",
      [clienteId, tipo],
    )
  ).rows[0]?.estado as string | undefined;

describe("T16 · AAD cruzada con el descifrado real del worker", () => {
  it("adv-w1: el sobre de otro cliente (sol) o de otro tipo (sol en la fila sire_api) no se descifra: sin llamada al puerto ni 'verificada'", async () => {
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const T = await e.estudio();
    const u = await e.usuario(T, "contador");
    const A = await e.cliente(T);
    const B = await e.cliente(T);
    const kA = canario("clave_A");
    const idA = await guardarCredencial(backend, T, A.id, "sol", {
      usuario: "UA",
      clave: kA,
    });
    const idB = await guardarCredencial(backend, T, B.id, "sol", {
      usuario: "UB",
      clave: canario("clave_B"),
    });
    const idBSire = await guardarCredencial(backend, T, B.id, "sire_api", {
      clientId: "CI",
      clientSecret: canario("s"),
    });
    await copiarSobre(idA, idB); // B.sol lleva ahora el sobre de A.sol

    const C = await e.cliente(T);
    const idCSol = await guardarCredencial(backend, T, C.id, "sol", {
      usuario: "UC",
      clave: canario("clave_C"),
    });
    const idCSire = await guardarCredencial(backend, T, C.id, "sire_api", {
      clientId: "CI",
      clientSecret: canario("s"),
    });
    await copiarSobre(idCSol, idCSire); // C.sire_api lleva el sobre de C.sol (AAD de otro tipo)
    void idBSire;

    const sol = new SolAuthControlado(new MockSolAuth());
    const sire = new SireAuthControlado(new MockSireAuth());
    const p = await arrancar007b({ prefijo, solAuth: sol, sireAuth: sire });
    try {
      const encolar = (clienteId: string, tipo: string) =>
        encolarYPublicar(backend, redis, prefijo, T, {
          tipo,
          clienteId,
          parametros: {},
          prioridad: "interactivo",
          creadoPor: u,
        }).then((r) => r.trabajo.id);
      const j1 = await encolar(B.id, "credencial.verificar_sol");
      const j2 = await encolar(C.id, "credencial.verificar_sire");
      const f1 = await esperarTerminal(e, j1, 30_000);
      const f2 = await esperarTerminal(e, j2, 30_000);
      expect(f1.estado).not.toBe("completado");
      expect(f2.estado).not.toBe("completado");
      expect(sol.recibidas).toEqual([]);
      expect(sire.recibidas).toEqual([]);
      expect(await estadoDe(B.id, "sol")).not.toBe("verificada");
      expect(await estadoDe(C.id, "sire_api")).not.toBe("verificada");
      // Ni rastro de la clave de A en el trabajo de B.
      expect(JSON.stringify(f1)).not.toContain(kA);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

// Ronda adversarial 2b (spec 003, T16b) con BD real de desarrollo (`pnpm --filter @contapp/worker test:int`):
// sobre copiado por el backend a otro cliente, tipo o estudio (AAD), auditoría por intento en el estudio
// correcto, y motivo hostil que llega a la BD saltándose la validación del servicio.
// Cada prueba afirma el comportamiento SEGURO esperado: si falla, es un hallazgo (tasks.md, T16b).
// Solo el fixture `mock`; nunca se imprimen llaves.
import { cifrarCredencial, crearKeyWrapper, type Sobre } from "@contapp/crypto";
import { crearKeyUnwrapper } from "@contapp/crypto/descifrado";
import { registrarDescifrado, type ContappDb } from "@contapp/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditoriasDe, crearDbAdmin, crearDbRol, guardar, limpiar, SEED } from "../../test/bd.js";
import { ENV_MOCK, canario, fugas, uuid } from "../../test/soporte.js";
import { crearServicioCredenciales } from "./descifrar-credencial.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const A = SEED.tenantA;
const B = SEED.tenantB;
const clientes: string[] = [];
let backend: ContappDb;
let worker: ContappDb;
let admin: ContappDb;

beforeAll(() => {
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  admin = crearDbAdmin();
});

afterEach(async () => {
  await limpiar(admin, { clientes });
});

afterAll(async () => {
  await limpiar(admin, { clientes }).catch(() => undefined);
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

const nuevoCliente = () => {
  const c = uuid();
  clientes.push(c);
  return c;
};

const servicio = () =>
  crearServicioCredenciales({
    db: worker,
    unwrapper: crearKeyUnwrapper(ENV_MOCK),
    logger: { log: () => undefined, warn: () => undefined },
  });

describe("T16b · sobre copiado por el backend a otra fila (AAD)", () => {
  it("copiado a otro cliente, a otro tipo o a otro estudio no descifra; cada intento queda auditado en su estudio", async () => {
    const c1 = nuevoCliente();
    const c2 = nuevoCliente();
    const valor = { usuario: canario("u"), clave: canario("k") };
    const sobre: Sobre = await cifrarCredencial(crearKeyWrapper(ENV_MOCK), { tenantId: A, clienteId: c1, tipo: "sol" }, valor);
    const original = await guardar(backend, A, c1, "sol", sobre);
    // El backend tiene INSERT/UPDATE del sobre: puede escribir bytes válidos en filas ajenas a su AAD.
    const copias = [
      { nombre: "otro cliente", tenant: A, cliente: c2, tipo: "sol" as const },
      { nombre: "otro tipo", tenant: A, cliente: c1, tipo: "sire_api" as const },
      { nombre: "otro estudio", tenant: B, cliente: c1, tipo: "sol" as const },
    ];
    const svc = servicio();
    for (const c of copias) {
      const id = await guardar(backend, c.tenant, c.cliente, c.tipo, sobre);
      let entregado: unknown;
      let error: unknown;
      try {
        entregado = await svc.descifrarCredencial({ tenantId: c.tenant }, id, "r2b:aad-cruzada");
      } catch (e) {
        error = e;
      }
      expect(entregado, `${c.nombre}: se entregó un secreto`).toBeUndefined();
      expect((error as { codigo?: string }).codigo, c.nombre).toBe("integridad");
      expect(fugas(error, [valor.usuario, valor.clave])).toEqual([]);
      const filas = await auditoriasDe(admin, id);
      expect(
        filas.map((f) => [f.tenant_id, f.cliente_id, f.tipo, f.motivo, f.resultado]),
        `${c.nombre}: auditoría`,
      ).toEqual([[c.tenant, c.cliente, c.tipo, "r2b:aad-cruzada", "integridad"]]);
    }
    // Control: la fila original sigue abriendo.
    const s = await svc.descifrarCredencial({ tenantId: A }, original, "r2b:control");
    expect(s.usar((v) => (v as { clave: string }).clave)).toBe(valor.clave);
    s.destruir();
  });
});

describe("T16b · motivo hostil que llega a la BD", () => {
  it("registrarDescifrado con saltos de línea, NUL o caracteres no ASCII en el motivo lo rechaza la BD sin filtrar el valor", async () => {
    const cliente = nuevoCliente();
    const credencialId = uuid();
    const marca = canario("motivo");
    const hostiles = [`job:1\nresultado=ok ${marca}`, `job:1\r\n${marca}`, `job:1 ${marca}`, `job:${marca}é`, `${marca} x`];
    for (const motivo of hostiles) {
      let error: unknown;
      try {
        await worker.withTenant({ tenantId: A }, (tx) =>
          registrarDescifrado(tx as never, { credencialId, clienteId: cliente, tipo: "sol", motivo, resultado: "ok" }),
        );
      } catch (e) {
        error = e;
      }
      expect((error as { codigo?: string } | undefined)?.codigo, JSON.stringify(motivo.slice(0, 8))).toBe("23514");
      expect(fugas(error, [marca])).toEqual([]);
    }
    expect(await auditoriasDe(admin, credencialId)).toEqual([]);
  });
});

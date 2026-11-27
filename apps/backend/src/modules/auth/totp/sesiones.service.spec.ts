// Spec 029 (T10a, CA-5): SesionesService sin BD (db falsa). Comportamiento publico: listar muestra solo campos seguros y «Otro» para las
// sesiones anteriores a 029; revocar ignora (sin tocar la BD ni responder distinto) todo id que no sea un UUID; revocarOtras es idempotente.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DbAuth, SesionResuelta } from "../auth.service.js";
import { SesionesService } from "./sesiones.service.js";

const TOKEN = "A".repeat(43);
const HASH = createHash("sha256").update(TOKEN, "utf8").digest();
const SESION = { token: TOKEN } as unknown as SesionResuelta;
const ID = "01920000-0000-7000-8000-0000000009a1";
const F1 = new Date("2026-11-25T12:00:00.000Z");
const F2 = new Date("2026-11-24T08:30:00.000Z");

function crear(filas: unknown[] = [], otras = 0) {
  const llamadas: Array<{ metodo: string; args: unknown[] }> = [];
  const sesiones = {
    listar: async (...args: unknown[]) => (llamadas.push({ metodo: "listar", args }), filas),
    revocar: async (...args: unknown[]) => void llamadas.push({ metodo: "revocar", args }),
    revocarOtras: async (...args: unknown[]) => (llamadas.push({ metodo: "revocarOtras", args }), otras),
  };
  const db = { withAuth: async (fn: (a: unknown, c: unknown) => unknown) => fn({}, { sesiones }) } as unknown as DbAuth;
  return { servicio: new SesionesService(db), llamadas };
}

describe("SesionesService.listar", () => {
  it("pregunta con el hash del token (nunca el token) y devuelve fechas ISO, dispositivo y red", async () => {
    const { servicio, llamadas } = crear([
      { id: ID, creadaEn: F2, ultimoUso: F1, dispositivo: "Chrome en Windows", ipRed: "203.0.113.0/24", actual: true },
    ]);
    const r = await servicio.listar(SESION);
    expect(r).toEqual([
      { id: ID, creadaEn: F2.toISOString(), ultimoUso: F1.toISOString(), dispositivo: "Chrome en Windows", ip: "203.0.113.0/24", actual: true },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.args).toEqual([HASH]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("una sesion anterior a 029 (sin dispositivo ni red) se muestra como «Otro» y sin ip", async () => {
    const { servicio } = crear([{ id: ID, creadaEn: F2, ultimoUso: F2, dispositivo: null, ipRed: null, actual: false }]);
    const [s] = await servicio.listar(SESION);
    expect(s!.dispositivo).toBe("Otro");
    expect(s!.ip).toBeNull();
    expect(s!.actual).toBe(false);
  });

  it("sin sesiones devuelve una lista vacia", async () => {
    expect(await crear([]).servicio.listar(SESION)).toEqual([]);
  });
});

describe("SesionesService.revocar", () => {
  it("con un UUID valido (mayusculas incluidas) revoca con el hash del token y el id", async () => {
    for (const id of [ID, ID.toUpperCase()]) {
      const { servicio, llamadas } = crear();
      await expect(servicio.revocar(SESION, id)).resolves.toBeUndefined();
      expect(llamadas).toEqual([{ metodo: "revocar", args: [HASH, id] }]);
    }
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["numero", 42],
    ["objeto", { id: ID }],
    ["arreglo", [ID]],
    ["texto vacio", ""],
    ["texto que no es UUID", "no-es-un-uuid"],
    ["UUID con relleno", ` ${ID}`],
    ["UUID con inyeccion SQL", `${ID}'; drop table auth.sesion; --`],
  ])("un id mal formado (%s) responde igual (sin error) y no toca la BD", async (_n, id) => {
    const { servicio, llamadas } = crear();
    await expect(servicio.revocar(SESION, id)).resolves.toBeUndefined();
    expect(llamadas).toEqual([]);
  });
});

describe("SesionesService.revocarOtras", () => {
  it.each([0, 3])("revoca las demas con el hash del token y no devuelve nada (%i afectadas)", async (n) => {
    const { servicio, llamadas } = crear([], n);
    await expect(servicio.revocarOtras(SESION)).resolves.toBeUndefined();
    expect(llamadas).toEqual([{ metodo: "revocarOtras", args: [HASH] }]);
  });
});

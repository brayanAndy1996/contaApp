// Unitarias del procesador `archivo.generar` (spec 012b, T5; D6, D10): lo que no necesita BD ni Redis. Los parámetros se
// revalidan en el procesador (defensa en profundidad: el catálogo ya los validó al encolar) ANTES de tocar la BD o el
// storage; el error es un `ErrorArchivo` (subclase de `ErrorDatos`: sin reintento) con `detalle` `parametros_invalidos`
// y no repite lo recibido.
import { ErrorDatos } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { canario } from "../../../test/soporte.js";
import { ErrorArchivo, generarArchivo } from "./generar-archivo.js";

const HUELLA = "a1".repeat(32);
const valido = { periodo: "202610", libro: "compras", estadoVisto: "abierto", huella: HUELLA };

const trabajo = (parametros: unknown) => ({
  id: "j-1",
  tenantId: "t-1",
  clienteId: "c-1",
  ruc: "20700000002",
  tipo: "archivo.generar",
  parametros,
  intentos: 0,
  creadoPor: "u-1",
});

function entorno(nodeEnv: string | undefined = "test") {
  const withTenant = vi.fn();
  const guardar = vi.fn();
  const eliminar = vi.fn();
  const conToken = vi.fn(<T>(usar: (t: string) => Promise<T>) => usar("tok"));
  const procesador = generarArchivo({
    db: { withTenant } as never,
    storage: { guardar, leer: vi.fn(), eliminar } as never,
    nodeEnv,
  });
  return { withTenant, guardar, eliminar, conToken, procesador };
}

describe("generarArchivo: parámetros", () => {
  it("es un procesador (función que devuelve una función)", () => {
    expect(typeof generarArchivo).toBe("function");
    expect(typeof entorno().procesador).toBe("function");
  });

  it.each([
    ["sin parámetros", undefined],
    ["null", null],
    ["periodo mal formado", { ...valido, periodo: "2026-10" }],
    ["mes 13", { ...valido, periodo: "202613" }],
    ["sin periodo", { libro: "compras", estadoVisto: "abierto", huella: HUELLA }],
    ["libro desconocido", { ...valido, libro: "rcv" }],
    ["sin libro", { periodo: "202610", estadoVisto: "abierto", huella: HUELLA }],
    ["estadoVisto generado", { ...valido, estadoVisto: "generado" }],
    ["sin estadoVisto", { periodo: "202610", libro: "compras", huella: HUELLA }],
    ["huella corta", { ...valido, huella: "ab" }],
    ["huella en mayúsculas", { ...valido, huella: "A".repeat(64) }],
    ["sin huella", { periodo: "202610", libro: "compras", estadoVisto: "abierto" }],
    ["permitirProvisional en el payload", { ...valido, permitirProvisional: true }],
    ["registro en el payload", { ...valido, registro: {} }],
    ["nodeEnv en el payload", { ...valido, nodeEnv: "development" }],
    ["cliente en el payload", { ...valido, clienteId: "x" }],
  ])("%s: ErrorArchivo parametros_invalidos sin tocar la BD ni el storage", async (_nombre, parametros) => {
    const n = entorno();
    const error = await n
      .procesador({ trabajo: trabajo(parametros), conToken: n.conToken } as never)
      .catch((x: unknown) => x);
    expect(error).toBeInstanceOf(ErrorArchivo);
    expect(error).toBeInstanceOf(ErrorDatos);
    expect(error).toMatchObject({ codigo: "datos_invalidos", detalle: "parametros_invalidos" });
    expect(n.withTenant).not.toHaveBeenCalled();
    expect(n.guardar).not.toHaveBeenCalled();
    expect(n.eliminar).not.toHaveBeenCalled();
  });

  it("el tipo no usa credencial: el procesador nunca pide el token del cliente", async () => {
    const n = entorno();
    await n
      .procesador({ trabajo: trabajo({ periodo: "no" }), conToken: n.conToken } as never)
      .catch(() => undefined);
    expect(n.conToken).not.toHaveBeenCalled();
  });

  it("el error de parámetros no repite lo recibido (canario en una clave ajena y en la huella)", async () => {
    const c = canario("param");
    const n = entorno();
    for (const parametros of [
      { ...valido, [c]: c },
      { ...valido, huella: c },
    ]) {
      const error = (await n
        .procesador({ trabajo: trabajo(parametros), conToken: n.conToken } as never)
        .catch((x: unknown) => x)) as Error;
      expect(error).toBeInstanceOf(ErrorArchivo);
      expect(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`).not.toContain(c);
    }
  });
});

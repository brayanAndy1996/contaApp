// Unitarias del procesador `xml.obtener` (spec 016, T6): lo que no necesita BD ni Redis. Los parámetros se revalidan en
// el procesador (defensa en profundidad: el catálogo ya los validó al encolar) ANTES de tocar la BD, el proveedor o el
// storage; el error es de datos (no se reintenta) y no repite lo recibido.
import { ErrorDatos } from "@contapp/sunat";
import { describe, expect, it, vi } from "vitest";
import { canario } from "../../../test/soporte.js";
import { obtenerXml } from "./obtener-xml.js";

const ids = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `0190a000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  );

const trabajo = (parametros: unknown) => ({
  id: "j-1",
  tenantId: "t-1",
  clienteId: "c-1",
  ruc: "20700000002",
  tipo: "xml.obtener",
  parametros,
  intentos: 0,
  creadoPor: "u-1",
});

function entorno() {
  const withTenant = vi.fn();
  const obtener = vi.fn();
  const guardar = vi.fn();
  const conToken = vi.fn(<T>(usar: (t: string) => Promise<T>) => usar("tok"));
  const procesador = obtenerXml({
    db: { withTenant } as never,
    xmlProvider: { obtener } as never,
    storage: { guardar, leer: vi.fn(), eliminar: vi.fn() } as never,
    xmlSimuladoEnReglas: true,
  });
  return { withTenant, obtener, guardar, conToken, procesador };
}

describe("obtenerXml: parámetros", () => {
  it("es un procesador (función que devuelve una función)", () => {
    expect(typeof obtenerXml).toBe("function");
    expect(typeof entorno().procesador).toBe("function");
  });

  it.each([
    ["sin parámetros", undefined],
    ["null", null],
    ["periodo mal formado", { periodo: "2026-10", compraIds: ids(1) }],
    ["mes 13", { periodo: "202613", compraIds: ids(1) }],
    ["sin periodo", { compraIds: ids(1) }],
    ["sin compraIds", { periodo: "202610" }],
    ["lote vacío", { periodo: "202610", compraIds: [] }],
    ["lote de 101", { periodo: "202610", compraIds: ids(101) }],
    ["id que no es uuid", { periodo: "202610", compraIds: ["../../etc/passwd"] }],
    ["ids repetidos", { periodo: "202610", compraIds: [ids(1)[0], ids(1)[0]] }],
    ["ids desordenados", { periodo: "202610", compraIds: [...ids(2)].reverse() }],
    ["clave ajena", { periodo: "202610", compraIds: ids(1), libro: "compras" }],
    ["un XML en el payload", { periodo: "202610", compraIds: ids(1), xml: "<Invoice/>" }],
  ])(
    "%s: ErrorDatos sin tocar la BD, el proveedor ni el storage",
    async (_nombre, parametros) => {
      const n = entorno();
      const error = await n
        .procesador({ trabajo: trabajo(parametros), conToken: n.conToken } as never)
        .catch((x: unknown) => x);
      expect(error).toBeInstanceOf(ErrorDatos);
      expect(error).toMatchObject({ codigo: "datos_invalidos" });
      expect(n.withTenant).not.toHaveBeenCalled();
      expect(n.obtener).not.toHaveBeenCalled();
      expect(n.guardar).not.toHaveBeenCalled();
    },
  );

  it("el tipo no usa credencial: el procesador nunca pide el token del cliente", async () => {
    const n = entorno();
    await n
      .procesador({ trabajo: trabajo({ periodo: "no", compraIds: [] }), conToken: n.conToken } as never)
      .catch(() => undefined);
    expect(n.conToken).not.toHaveBeenCalled();
  });

  it("el error de parámetros no repite lo recibido (canario en una clave ajena)", async () => {
    const c = canario("param");
    const n = entorno();
    const error = (await n
      .procesador({
        trabajo: trabajo({ periodo: "202610", compraIds: ids(1), [c]: c }),
        conToken: n.conToken,
      } as never)
      .catch((x: unknown) => x)) as Error;
    expect(error).toBeInstanceOf(ErrorDatos);
    expect(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`).not.toContain(c);
  });
});

// Spec 013 T18 · H-013-5 (rojo hasta T19, decisión D20 del usuario 2026-11-07): el layout provisional (`oficial: false`) solo
// se acepta con `NODE_ENV` exactamente `development` o `test`. Con cualquier otro valor, o sin `NODE_ENV`, la importación
// responde 422 `layout_no_oficial` (falla cerrado, como H-007b-3). El valor se lee en cada petición y jamás de la petición.
// Sin BD: el contrato HTTP completo lo cubre `importacion.int.spec.ts`; el barrido de valores, `ventas.adv.int.spec.ts` (adv-i2).
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  clienteVisible: vi.fn(async () => true),
  leerClienteDto: vi.fn(async () => ({ archivado: false })),
}));

import type { Alcance } from "@contapp/db";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";

const sesion = { tenantActivo: "t-1", usuarioId: "u-1" } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const CABECERA =
  "tipo,serie,numero,tipoDocContraparte,docContraparte,fechaEmision,moneda,tipoCambio,baseGravada,igv,exonerada,inafecta,isc,icbper,otros,total";
const BUENA = "03,B001,290,,-,2026-10-03,PEN,,100.00,18.00,0,0,0,0,0,118.00";
const archivo = new TextEncoder().encode(`${CABECERA}\r\n${BUENA}\r\n`);

function servicio() {
  const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})));
  return { s: new ImportarPropuestaService({ withTenant } as never), withTenant };
}

describe("H-013-5 · el layout provisional solo importa con NODE_ENV development o test", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it.each(["development", "test"])("caso feliz: NODE_ENV=%s lee el archivo (vista previa con 1 fila válida)", async (entorno) => {
    vi.stubEnv("NODE_ENV", entorno);
    const { s } = servicio();
    const r = await s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo);
    expect(r.validas).toBe(1);
  });

  it.each([
    ["production", "production"],
    ["prod", "prod"],
    ["Production", "Production"],
    ["PRODUCTION", "PRODUCTION"],
    ["con espacio delante", " production"],
    ["staging", "staging"],
    ["vacío", ""],
    ["Development (solo vale en minúsculas)", "Development"],
    ["TEST (solo vale en minúsculas)", "TEST"],
    ["development con espacio", "development "],
    ["otro", "qa"],
  ])("error: NODE_ENV %s: 422 layout_no_oficial sin tocar la BD ni leer el archivo", async (_n, valor) => {
    vi.stubEnv("NODE_ENV", valor);
    const { s, withTenant } = servicio();
    const esperado = { codigo: "layout_no_oficial", status: 422 };
    await expect(s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo)).rejects.toMatchObject(esperado);
    await expect(s.confirmar(sesion, alcance, new Set<string>(), "c-1", "202610", archivo)).rejects.toMatchObject(esperado);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("error: sin NODE_ENV (ausente) también es 422 layout_no_oficial", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(process.env["NODE_ENV"]).toBeUndefined();
    const { s, withTenant } = servicio();
    const esperado = { codigo: "layout_no_oficial", status: 422 };
    await expect(s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo)).rejects.toMatchObject(esperado);
    await expect(s.confirmar(sesion, alcance, new Set<string>(), "c-1", "202610", archivo)).rejects.toMatchObject(esperado);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("se lee en cada petición: pasar de development a production (o a nada) cierra la importación", async () => {
    const { s } = servicio();
    vi.stubEnv("NODE_ENV", "development");
    expect((await s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo)).validas).toBe(1);
    vi.stubEnv("NODE_ENV", "production");
    await expect(s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo)).rejects.toMatchObject({ codigo: "layout_no_oficial" });
    vi.stubEnv("NODE_ENV", undefined);
    await expect(s.vistaPrevia(sesion, alcance, "c-1", "202610", archivo)).rejects.toMatchObject({ codigo: "layout_no_oficial" });
  });
});

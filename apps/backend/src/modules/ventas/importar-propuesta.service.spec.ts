// Spec 013 (T14) · `ImportarPropuestaService` sin BD: la traducción de motivos, las celdas peligrosas, los errores del lector y
// el entorno leído en cada petición. El contrato HTTP completo (archivos reales, complemento, carreras) lo cubre
// `importacion.int.spec.ts`.
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  clienteVisible: vi.fn(async () => true),
  leerClienteDto: vi.fn(async () => ({ archivado: false })),
}));

import type { Alcance } from "@contapp/db";
import { MOTIVOS_FILA_VENTA } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { LIMITE_ARCHIVO_VENTAS } from "../../app.js";
import { LIMITES_VENTAS } from "../importacion/tipos.js";
import { ImportarPropuestaService } from "./importar-propuesta.service.js";

const sesion = { tenantActivo: "t-1", usuarioId: "u-1" } as SesionResuelta;
const alcance: Alcance = { tipo: "global" };
const CABECERA =
  "tipo,serie,numero,tipoDocContraparte,docContraparte,fechaEmision,moneda,tipoCambio,baseGravada,igv,exonerada,inafecta,isc,icbper,otros,total";
const BUENA = ["03", "B001", "290", "", "-", "2026-10-03", "PEN", "", "100.00", "18.00", "0", "0", "0", "0", "0", "118.00"];

const csv = (...filas: string[][]) => new TextEncoder().encode([CABECERA, ...filas.map((f) => f.join(","))].join("\r\n") + "\r\n");
const con = (campo: string, valor: string): string[] => {
  const f = [...BUENA];
  f[CABECERA.split(",").indexOf(campo)] = valor;
  return f;
};

function servicio() {
  return new ImportarPropuestaService({ withTenant: (_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})) } as never);
}
const previa = (cuerpo: unknown) => servicio().vistaPrevia(sesion, alcance, "c-1", "202610", cuerpo);

describe("tope de bytes de la ruta = el del lector de ventas", () => {
  it("LIMITE_ARCHIVO_VENTAS (app.ts) coincide con LIMITES_VENTAS.maxBytes", () => {
    expect(LIMITE_ARCHIVO_VENTAS).toBe(`${LIMITES_VENTAS.maxBytes / (1024 * 1024)}mb`);
  });
});

describe("celdas peligrosas", () => {
  it.each(["=1+1", "@SUM(1)", "+cmd|x", "-1+1", "  =1+1", "a\tb"])("«%s» en un texto: celda_peligrosa y nada más", async (celda) => {
    const r = await previa(csv(con("docContraparte", `"${celda}"`)));
    expect(r.filas).toEqual([{ n: 2, estado: "error", motivos: ["celda_peligrosa"], advertencias: [] }]);
  });

  it.each(["-", "-50.00", "+5"])("«%s» no lo es: el consumidor final y los números con signo", async (celda) => {
    const campo = celda === "-" ? "docContraparte" : "otros";
    const r = await previa(csv(con(campo, celda)));
    expect(r.filas[0]!.motivos).not.toContain("celda_peligrosa");
  });
});

describe("motivos de fila: los códigos del dominio, traducidos a la lista cerrada de shared", () => {
  it("cada fila dice sus motivos sin repetirlos, sin el contenido de la celda y todos están en la lista cerrada", async () => {
    const r = await previa(
      csv(
        BUENA,
        con("tipo", "X"),
        con("serie", "B0"),
        con("numero", "no es"),
        con("fechaEmision", "2026-02-30"),
        con("moneda", "EUR"),
        con("tipoCambio", "abc"), // PEN con tipo de cambio: solo vale en USD
        con("docContraparte", "a b"),
        con("total", "abc"),
        con("igv", ""),
      ),
    );
    expect(r.filas.map((f) => f.motivos)).toEqual([
      [],
      ["tipo_invalido"],
      ["serie_invalida"],
      ["numero_invalido"],
      ["fecha_invalida"],
      ["moneda_invalida"],
      ["tipo_cambio_invalido"],
      ["documento_invalido"],
      ["monto_invalido"],
      ["campo_obligatorio"],
    ]);
    expect(r).toMatchObject({ validas: 1, conError: 9 });
    for (const f of r.filas) for (const m of f.motivos) expect(MOTIVOS_FILA_VENTA).toContain(m);
  });

  it("una fila descuadrada pero legible es válida con la advertencia `descuadre` (D3, D22: se guarda tal cual llegó)", async () => {
    const r = await previa(csv(con("total", "999.00")));
    expect(r.filas[0]).toEqual({ n: 2, estado: "valida", motivos: [], advertencias: ["descuadre"] });
  });
});

describe("el archivo", () => {
  it.each([
    ["un cuerpo que no es un archivo (JSON, vacío)", {}],
    ["texto", "abc"],
    ["nada", undefined],
  ])("%s: 400 archivo_invalido", async (_n, cuerpo) => {
    await expect(previa(cuerpo)).rejects.toMatchObject({ codigo: "archivo_invalido" });
  });

  it("sin una columna obligatoria: columnas_faltantes; sin columnas opcionales: se lee", async () => {
    const sinTotal = new TextEncoder().encode("tipo,serie,numero\r\n03,B001,1\r\n");
    await expect(previa(sinTotal)).rejects.toMatchObject({ codigo: "columnas_faltantes" });
    const sinOpcionales = CABECERA.split(",").filter((c) => c !== "tipoDocContraparte" && c !== "tipoCambio");
    const fila = BUENA.filter((_v, i) => i !== 3 && i !== 7);
    const r = await previa(new TextEncoder().encode([sinOpcionales.join(","), fila.join(",")].join("\r\n")));
    expect(r.filas).toEqual([{ n: 2, estado: "valida", motivos: [], advertencias: [] }]);
  });

  it("la serie en minúsculas y los espacios alrededor de una celda no invalidan la fila", async () => {
    const r = await previa(csv(con("serie", "b001"), con("tipo", " 03 ")));
    expect(r.filas.map((f) => f.estado)).toEqual(["valida", "valida"]);
  });

  it("más de 20.000 filas (aunque estén vacías): propuesta_demasiado_grande, no demasiadas_filas", async () => {
    const texto = CABECERA + "\r\n" + ",,,,,,,,,,,,,,,\r\n".repeat(LIMITES_VENTAS.maxFilas + 1);
    await expect(previa(new TextEncoder().encode(texto))).rejects.toMatchObject({ codigo: "propuesta_demasiado_grande" });
  });

  it("más de LIMITES_VENTAS.maxBytes: archivo_demasiado_grande (413)", async () => {
    await expect(previa(new Uint8Array(LIMITES_VENTAS.maxBytes + 1).fill(0x41))).rejects.toMatchObject({
      codigo: "archivo_demasiado_grande",
      status: 413,
    });
  });
});

describe("confirmar", () => {
  it("una fila con error: 422 filas_con_errores antes de tocar la BD", async () => {
    const withTenant = vi.fn((_c: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})));
    const s = new ImportarPropuestaService({ withTenant } as never);
    await expect(s.confirmar(sesion, alcance, "c-1", "202610", csv(BUENA, con("fechaEmision", "2026-02-30")))).rejects.toMatchObject({
      codigo: "filas_con_errores",
      status: 422,
    });
    expect(withTenant).toHaveBeenCalledTimes(1); // solo la comprobación del cliente
  });
});

describe("NODE_ENV se lee en cada petición", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("production: 422 layout_no_oficial sin tocar la BD ni el archivo; fuera de producción, el mismo archivo se lee", async () => {
    const withTenant = vi.fn();
    const s = new ImportarPropuestaService({ withTenant } as never);
    vi.stubEnv("NODE_ENV", "production");
    await expect(s.vistaPrevia(sesion, alcance, "c-1", "202610", "no es un archivo")).rejects.toMatchObject({
      codigo: "layout_no_oficial",
      status: 422,
    });
    await expect(s.confirmar(sesion, alcance, "c-1", "202610", undefined)).rejects.toMatchObject({ codigo: "layout_no_oficial" });
    expect(withTenant).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "development");
    expect((await previa(csv(BUENA))).validas).toBe(1);
  });

  it("un periodo mal formado es 400 solicitud_invalida", async () => {
    await expect(servicio().vistaPrevia(sesion, alcance, "c-1", "2026-10", csv(BUENA))).rejects.toMatchObject({
      codigo: "solicitud_invalida",
    });
  });
});

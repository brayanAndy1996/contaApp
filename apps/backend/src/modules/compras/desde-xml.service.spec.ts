// Spec 016, T17a · `DesdeXmlComprasService` (vista previa y alta desde XML; HU-18, D-8, P-9, CA-13) sin BD ni storage reales:
// dobles del repositorio de `@contapp/db`, de las reglas de escritura de 014 y del storage. Lo que se fija: que la vista previa no
// escribe nada, cómo se busca la compra existente (páginas y vistas), qué errores salen antes de tocar el XML o el storage, el orden
// de bloqueo del alta y qué se limpia cuando algo falla (D-11: sin rutas ni contenido en los logs).
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerClienteDto: vi.fn(),
  listarCompras: vi.fn(),
  guardarDocumentoXml: vi.fn(),
  reevaluarComprobante: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn(),
}));
vi.mock("./escritura.js", async (original) => ({
  ...(await original<typeof import("./escritura.js")>()),
  exigirEscritura: vi.fn(),
  entornoDeReglas: vi.fn(),
  evaluarPorPeriodo: vi.fn(),
}));
vi.mock("./acciones.service.js", async (original) => ({
  ...(await original<typeof import("./acciones.service.js")>()),
  altaCompra: vi.fn(),
  respuestaDe: vi.fn(),
}));

import { guardarDocumentoXml, leerClienteDto, listarCompras, reevaluarComprobante } from "@contapp/db";
import { claveComprobante } from "@contapp/domain";
import { AccesoError } from "../acceso/errores.js";
import { altaCompra, respuestaDe } from "./acciones.service.js";
import { exigirCliente } from "./apoyo.js";
import { DesdeXmlComprasService } from "./desde-xml.service.js";
import { XmlError } from "./errores-xml.js";
import { ComprasError } from "./errores.js";
import { entornoDeReglas, evaluarPorPeriodo, exigirEscritura } from "./escritura.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const RUC_CLIENTE = "20700000002";
const TX = { tx: true };
const sesion = { tenantActivo: TENANT, usuarioId: USUARIO } as never;
const alcance = { tipo: "global" } as never;
const permisos = new Set(["compras.escribir"]) as ReadonlySet<string>;

const XML = readFileSync(
  fileURLToPath(new URL("../../../../../fixtures/xml/20700000045-01-F001-2056.xml", import.meta.url)),
  "utf8",
);
const conId = (id: string): string => XML.replace("<cbc:ID>F001-2056</cbc:ID>", `<cbc:ID>${id}</cbc:ID>`);
const usd = (): string => XML.replaceAll("PEN", "USD");
const bytesDe = (t: string): Buffer => Buffer.from(t, "utf8");

const CLAVE = claveComprobante(
  { tipo: "01", serie: "F001", numero: "2056" },
  { tipo: "6", numero: "20700000045" },
);
const ID = (n: number): string => `0190a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compraListada = (id: string, clave = CLAVE) => ({ compra: { id, clave } });
const pagina = (filas: unknown[], siguiente: unknown = null) => ({ filas, siguiente });

let bitacora: string[];
const storage = { guardar: vi.fn(), leer: vi.fn(), eliminar: vi.fn() };
const avisos: unknown[][] = [];

function servicio() {
  const withTenant = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    try {
      const r = await fn(TX);
      bitacora.push("commit");
      return r;
    } catch (e) {
      bitacora.push("rollback");
      throw e;
    }
  });
  return { withTenant, svc: new DesdeXmlComprasService({ withTenant } as never, storage as never) };
}
const capturar = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

beforeEach(() => {
  vi.resetAllMocks();
  bitacora = [];
  avisos.length = 0;
  vi.spyOn(Logger.prototype, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a);
  });
  vi.mocked(exigirCliente).mockResolvedValue(undefined as never);
  vi.mocked(exigirEscritura).mockImplementation((async (_tx: unknown, _a: unknown, _p: unknown, _c: unknown, _per: unknown, o: { crear: boolean }) => {
    bitacora.push(o.crear ? "escritura-crear" : "escritura-leer");
  }) as never);
  vi.mocked(leerClienteDto).mockResolvedValue({ id: CLIENTE, ruc: RUC_CLIENTE } as never);
  vi.mocked(listarCompras).mockResolvedValue(pagina([]) as never);
  vi.mocked(guardarDocumentoXml).mockImplementation((async () => {
    bitacora.push("fila-xml");
    return { id: "d-1", n: 1 };
  }) as never);
  vi.mocked(entornoDeReglas).mockResolvedValue({ conocidos: [], evaluar: vi.fn() } as never);
  vi.mocked(altaCompra).mockImplementation((async () => {
    bitacora.push("alta");
    return "compra-nueva";
  }) as never);
  vi.mocked(evaluarPorPeriodo).mockReturnValue(vi.fn() as never);
  vi.mocked(reevaluarComprobante).mockImplementation((async () => {
    bitacora.push("reevaluar");
    return new Map();
  }) as never);
  vi.mocked(respuestaDe).mockResolvedValue({ fila: { id: "compra-nueva" }, cuadre: {} } as never);
  storage.guardar.mockImplementation(async () => {
    bitacora.push("archivo");
  });
  storage.eliminar.mockResolvedValue(undefined);
});

describe("DesdeXmlComprasService.vistaPrevia", () => {
  const previa = (svc: DesdeXmlComprasService, cuerpo: unknown = bytesDe(XML)) =>
    svc.vistaPrevia(sesion, alcance, CLIENTE, "202610", cuerpo);

  it("devuelve los campos del XML con la BI y el IGV en DG, los ítems y sin existente; no escribe nada ni toca el storage", async () => {
    const { svc, withTenant } = servicio();
    const v = await previa(svc);
    expect(v).toMatchObject({
      tipo: "01",
      serie: "F001",
      numero: "2056",
      proveedor: { tipo: "6", numero: "20700000045" },
      fecha: "2026-10-05",
      moneda: "PEN",
      montos: { biDg: "8.97", igvDg: "1.61", noGravado: "12.51" },
      existente: null,
      requiereTipoCambio: false,
    });
    expect(v.items.length).toBeGreaterThan(0);
    expect(withTenant.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT, userId: USUARIO });
    expect(exigirCliente).toHaveBeenCalledWith(TX, CLIENTE, alcance, false);
    expect(guardarDocumentoXml).not.toHaveBeenCalled();
    expect(altaCompra).not.toHaveBeenCalled();
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(exigirEscritura).not.toHaveBeenCalled();
  });

  it("en USD pide el tipo de cambio (P-9)", async () => {
    const v = await previa(servicio().svc, bytesDe(usd()));
    expect(v).toMatchObject({ moneda: "USD", requiereTipoCambio: true });
  });

  it("CA-13: marca la compra existente buscando entre las del proveedor con la clave exacta", async () => {
    vi.mocked(listarCompras).mockResolvedValue(
      pagina([compraListada("otra", "otra-clave"), compraListada(ID(1))]) as never,
    );
    const v = await previa(servicio().svc);
    expect(v.existente).toEqual({ id: ID(1) });
    const filtros = vi.mocked(listarCompras).mock.calls[0]?.[3];
    expect(filtros).toMatchObject({ q: "20700000045", limite: 5000 });
    expect(filtros).not.toHaveProperty("vista");
    // Hallada en la primera vista: no sigue buscando.
    expect(listarCompras).toHaveBeenCalledTimes(1);
  });

  it("recorre todas las páginas de las vivas antes de pasar a las excluidas", async () => {
    const cursor = { c: 1 };
    vi.mocked(listarCompras)
      .mockResolvedValueOnce(pagina([compraListada("x", "k")], cursor) as never)
      .mockResolvedValueOnce(pagina([compraListada(ID(2))]) as never);
    const v = await previa(servicio().svc);
    expect(v.existente).toEqual({ id: ID(2) });
    expect(vi.mocked(listarCompras).mock.calls[0]?.[3]).not.toHaveProperty("cursor");
    expect(vi.mocked(listarCompras).mock.calls[1]?.[3]).toMatchObject({ cursor });
  });

  it("también encuentra la compra excluida: cuando no está entre las vivas mira la vista «excluidas»", async () => {
    vi.mocked(listarCompras)
      .mockResolvedValueOnce(pagina([]) as never)
      .mockResolvedValueOnce(pagina([compraListada(ID(3))]) as never);
    const v = await previa(servicio().svc);
    expect(v.existente).toEqual({ id: ID(3) });
    expect(vi.mocked(listarCompras).mock.calls[1]?.[3]).toMatchObject({ vista: "excluidas" });
  });

  it("sin compra en ninguna vista, existente es null", async () => {
    const v = await previa(servicio().svc);
    expect(v.existente).toBeNull();
    expect(listarCompras).toHaveBeenCalledTimes(2);
  });

  it("un XML de otro receptor es xml_ajeno (receptor) y no se busca la existente", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue({ id: CLIENTE, ruc: "20700000099" } as never);
    const e = await capturar(previa(servicio().svc));
    expect(e).toBeInstanceOf(XmlError);
    expect((e as XmlError).cuerpo).toEqual({ codigo: "xml_ajeno", campos: ["receptor"] });
    expect(listarCompras).not.toHaveBeenCalled();
  });

  it("el cliente inexistente es no_encontrado", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    expect(await capturar(previa(servicio().svc))).toMatchObject({ codigo: "no_encontrado" });
  });

  it("sin cuerpo XML: xml_invalido antes de abrir ninguna transacción", async () => {
    const { svc, withTenant } = servicio();
    expect(await capturar(previa(svc, null))).toMatchObject({ codigo: "xml_invalido" });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("un comprobante cuyos datos no caben en una compra (número de más de 8 dígitos) es xml_invalido", async () => {
    const e = await capturar(previa(servicio().svc, bytesDe(conId("F001-123456789"))));
    expect(e).toBeInstanceOf(XmlError);
    expect(e).toMatchObject({ codigo: "xml_invalido" });
  });
});

describe("DesdeXmlComprasService.agregar", () => {
  const agregar = (
    svc: DesdeXmlComprasService,
    query: unknown = { destino: "DG" },
    cuerpo: unknown = bytesDe(XML),
  ) => svc.agregar(sesion, alcance, permisos, CLIENTE, "202610", query, cuerpo);

  it("crea la compra y guarda el XML (subido) en una sola transacción: lee el estado, escribe el archivo, la fila y recién entonces el alta", async () => {
    const { svc, withTenant } = servicio();
    await expect(agregar(svc)).resolves.toEqual({ id: "compra-nueva" });
    expect(bitacora).toEqual(["escritura-leer", "archivo", "fila-xml", "escritura-crear", "alta", "reevaluar", "commit"]);
    // H-016-11: el XML es del comprobante; se re-evalúan las demás compras vivas del mismo comprobante (no la recién creada).
    expect(vi.mocked(reevaluarComprobante).mock.calls[0]).toEqual([
      TX,
      CLIENTE,
      { rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056" },
      { evaluarDe: vi.mocked(evaluarPorPeriodo).mock.results[0]?.value, bloqueo: "fila", excluir: ["compra-nueva"] },
    ]);
    expect(evaluarPorPeriodo).toHaveBeenCalledWith(TX, CLIENTE);
    expect(withTenant).toHaveBeenCalledTimes(1);
    const [ruta, bytes] = storage.guardar.mock.calls[0] as [string, Uint8Array];
    expect(ruta.startsWith(`xml/${TENANT}/${CLIENTE}/`)).toBe(true);
    expect(Buffer.from(bytes).equals(bytesDe(XML))).toBe(true);
    expect(vi.mocked(guardarDocumentoXml).mock.calls[0]?.[1]).toMatchObject({
      clienteId: CLIENTE,
      rucEmisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      origen: "subido",
      ruta,
      tamano: bytes.length,
      subidoPor: USUARIO,
    });
    // El alta recibe la compra con los montos del destino elegido y el usuario de la sesión.
    const alta = vi.mocked(altaCompra).mock.calls[0] as unknown as unknown[];
    expect(alta.slice(0, 4)).toEqual([TX, USUARIO, CLIENTE, "202610"]);
    expect(alta[4]).toMatchObject({ moneda: "PEN", proveedor: { numero: "20700000045" }, montos: { biDg: "8.97", igvDg: "1.61" } });
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it.each([
    ["DGNG", { biDgng: "8.97", igvDgng: "1.61" }],
    ["DNG", { biDng: "8.97", igvDng: "1.61" }],
  ])("el destino %s lleva la BI y el IGV a su par de columnas", async (destino, par) => {
    await agregar(servicio().svc, { destino });
    expect((vi.mocked(altaCompra).mock.calls[0] as unknown as Array<{ montos: unknown }>)[4]?.montos).toMatchObject(par);
  });

  it("en USD con tipo de cambio crea la compra con ese tipo de cambio", async () => {
    await agregar(servicio().svc, { destino: "DG", tipoCambio: "3.752" }, bytesDe(usd()));
    expect((vi.mocked(altaCompra).mock.calls[0] as unknown as Array<Record<string, unknown>>)[4]).toMatchObject({
      moneda: "USD",
      tipoCambio: "3.752",
    });
  });

  it.each([
    ["sin destino", {}],
    ["destino fuera del catálogo", { destino: "XX" }],
    ["sin query", null],
  ])("query inválida (%s): solicitud_invalida antes de mirar el XML, el cliente o el storage", async (_n, query) => {
    const { svc, withTenant } = servicio();
    // Aun con un cuerpo que no es XML: manda el 400 de la query.
    const e = await capturar(agregar(svc, query, Buffer.from("no es xml")));
    expect(e).toBeInstanceOf(AccesoError);
    expect(e).toMatchObject({ codigo: "solicitud_invalida" });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("un tenantId o clienteId en la query se descarta: no cambia el estudio ni el cliente del alta", async () => {
    await agregar(servicio().svc, { destino: "DG", tenantId: "x", clienteId: "y" });
    expect(vi.mocked(exigirEscritura).mock.calls[0]?.[3]).toBe(CLIENTE);
    expect(vi.mocked(altaCompra).mock.calls[0]?.[2]).toBe(CLIENTE);
  });

  it("P-9: en USD sin tipo de cambio es solicitud_invalida (400), no xml_invalido", async () => {
    const e = await capturar(agregar(servicio().svc, { destino: "DG" }, bytesDe(usd())));
    expect(e).toBeInstanceOf(AccesoError);
    expect(e).toMatchObject({ codigo: "solicitud_invalida" });
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("P-9: en PEN con tipo de cambio también es solicitud_invalida", async () => {
    const e = await capturar(agregar(servicio().svc, { destino: "DG", tipoCambio: "3.752" }));
    expect(e).toMatchObject({ codigo: "solicitud_invalida" });
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("sin cuerpo XML: xml_invalido", async () => {
    expect(await capturar(agregar(servicio().svc, { destino: "DG" }, null))).toMatchObject({ codigo: "xml_invalido" });
  });

  it("un comprobante cuyos datos no caben en una compra es xml_invalido y no escribe nada", async () => {
    const { svc, withTenant } = servicio();
    expect(await capturar(agregar(svc, { destino: "DG" }, bytesDe(conId("F001-123456789"))))).toMatchObject({
      codigo: "xml_invalido",
    });
    expect(withTenant).not.toHaveBeenCalled();
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("un XML de otro receptor es xml_ajeno: ni archivo, ni fila, ni compra", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue({ id: CLIENTE, ruc: "20700000099" } as never);
    const e = await capturar(agregar(servicio().svc));
    expect((e as XmlError).cuerpo).toEqual({ codigo: "xml_ajeno", campos: ["receptor"] });
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(guardarDocumentoXml).not.toHaveBeenCalled();
    expect(altaCompra).not.toHaveBeenCalled();
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it("el cliente inexistente es no_encontrado, sin escribir el archivo", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    expect(await capturar(agregar(servicio().svc))).toMatchObject({ codigo: "no_encontrado" });
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("H-016-12 (P-6): con un XML real o subido ya guardado responde 409 xml_existente, no crea la compra, revierte y borra el archivo nuevo", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    const e = await capturar(agregar(servicio().svc));
    expect(e).toBeInstanceOf(XmlError);
    expect(e).toMatchObject({ codigo: "xml_existente" });
    expect((e as XmlError).getStatus()).toBe(409);
    expect(altaCompra).not.toHaveBeenCalled();
    expect(reevaluarComprobante).not.toHaveBeenCalled();
    expect(respuestaDe).not.toHaveBeenCalled();
    expect(bitacora).toEqual(["escritura-leer", "archivo", "rollback"]);
    const ruta = (storage.guardar.mock.calls[0] as [string])[0];
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
    expect(storage.eliminar).toHaveBeenCalledWith(ruta);
  });

  it("H-016-12: si además la compra ya existe en este periodo manda el 409 duplicado de CA-13, con su id", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    vi.mocked(listarCompras).mockResolvedValue(pagina([compraListada(ID(7))]) as never);
    const e = await capturar(agregar(servicio().svc));
    expect(e).toBeInstanceOf(ComprasError);
    expect(e).toMatchObject({ codigo: "duplicado" });
    expect((e as ComprasError).getStatus()).toBe(409);
    expect((e as ComprasError).cuerpo).toMatchObject({ id: ID(7) });
    expect(altaCompra).not.toHaveBeenCalled();
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
  });

  it("H-016-12: si el borrado del archivo nuevo falla, el 409 xml_existente sale igual y solo queda un aviso sin ruta", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    storage.eliminar.mockRejectedValue(new Error("storage caído"));
    expect(await capturar(agregar(servicio().svc))).toMatchObject({ codigo: "xml_existente" });
    expect(altaCompra).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(1);
    const ruta = (storage.guardar.mock.calls[0] as [string])[0];
    expect(JSON.stringify(avisos)).not.toContain(ruta);
    expect(JSON.stringify(avisos)).not.toContain("storage caído");
  });

  it("si la re-evaluación de las demás compras del comprobante falla: se revierte, el error sale tal cual y el archivo se borra", async () => {
    const fallo = new Error("bd caída");
    vi.mocked(reevaluarComprobante).mockRejectedValue(fallo);
    expect(await capturar(agregar(servicio().svc))).toBe(fallo);
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
  });

  it("periodo que no admite escribir: el error de 014 sale tal cual, antes de escribir el archivo", async () => {
    const cerrado = new AccesoError("permiso_denegado");
    vi.mocked(exigirEscritura).mockRejectedValueOnce(cerrado);
    expect(await capturar(agregar(servicio().svc))).toBe(cerrado);
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it("si la segunda comprobación de escritura (ya con el archivo y la fila) falla: se revierte y el archivo se borra", async () => {
    const cerrado = new AccesoError("permiso_denegado");
    vi.mocked(exigirEscritura).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(cerrado);
    expect(await capturar(agregar(servicio().svc))).toBe(cerrado);
    expect(bitacora).toEqual(["archivo", "fila-xml", "rollback"]);
    expect(storage.eliminar).toHaveBeenCalledWith((storage.guardar.mock.calls[0] as [string])[0]);
    expect(altaCompra).not.toHaveBeenCalled();
  });

  it("si el alta falla (p. ej. duplicado): el error sale tal cual y el archivo se borra", async () => {
    const duplicado = new Error("duplicado");
    vi.mocked(altaCompra).mockRejectedValue(duplicado);
    expect(await capturar(agregar(servicio().svc))).toBe(duplicado);
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
  });

  it("si el archivo no se pudo escribir no hay nada que borrar", async () => {
    const fallo = new Error("disco lleno");
    storage.guardar.mockRejectedValue(fallo);
    expect(await capturar(agregar(servicio().svc))).toBe(fallo);
    expect(storage.eliminar).not.toHaveBeenCalled();
  });
});

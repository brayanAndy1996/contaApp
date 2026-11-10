// Spec 016, T17a · `XmlComprasService` (subir, descargar, obtener) sin BD, Redis ni storage reales: dobles del repositorio de
// `@contapp/db`, de la transacción (`withTenant` registra confirmación o reversión), del storage y del encolador.
// Lo que se fija: el orden (parsear antes de tocar nada, archivo antes de la fila), qué se revierte y se limpia en cada fallo, y
// que ningún error ni log lleva rutas, hashes ni contenido del XML (D-11).
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { ArchivoNoEncontradoError } from "@contapp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerClienteDto: vi.fn(),
  leerDetalleXml: vi.fn(),
  guardarDocumentoXml: vi.fn(),
  reevaluarCompra: vi.fn(),
  fijarObtencion: vi.fn(),
}));
vi.mock("./apoyo.js", async (original) => ({
  ...(await original<typeof import("./apoyo.js")>()),
  exigirCliente: vi.fn(),
}));
vi.mock("./escritura.js", async (original) => ({
  ...(await original<typeof import("./escritura.js")>()),
  entornoDeReglas: vi.fn(),
}));

import {
  ComprasReglaError,
  fijarObtencion,
  guardarDocumentoXml,
  leerClienteDto,
  leerDetalleXml,
  reevaluarCompra,
} from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import { exigirCliente } from "./apoyo.js";
import { XmlError } from "./errores-xml.js";
import { entornoDeReglas } from "./escritura.js";
import { XmlComprasService } from "./xml.service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "33333333-3333-4333-8333-333333333333";
const COMPRA = "0190A000-0000-4000-8000-000000000001";
const RUC_CLIENTE = "20700000002";
const TX = { tx: true };
const sesion = { tenantActivo: TENANT, usuarioId: USUARIO } as never;
const alcance = { tipo: "global" } as never;

const XML = readFileSync(
  fileURLToPath(new URL("../../../../../fixtures/xml/20700000045-01-F001-2056.xml", import.meta.url)),
  "utf8",
);
const bytesXml = (texto = XML): Buffer => Buffer.from(texto, "utf8");

/** Lo que `leerDetalleXml` devuelve para la mixta F001-2056 sin XML guardado. */
const previo = (o: { xml?: { origen: string; ruta: string } | null; compra?: Record<string, unknown> } = {}) => ({
  compra: { tipoDoc: "01", serie: "F001", numero: "2056", docTipo: "6", docNumero: "20700000045", ...o.compra },
  identidad: { rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056" },
  xml: o.xml ?? null,
  obtencion: null,
});

let bitacora: string[];
const storage = { guardar: vi.fn(), leer: vi.fn(), eliminar: vi.fn() };
const encolarCon = vi.fn();
const detalle = { leer: vi.fn() };
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
  return {
    withTenant,
    svc: new XmlComprasService(
      { withTenant } as never,
      { encolarCon } as never,
      storage as never,
      detalle as never,
    ),
  };
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
  vi.mocked(leerClienteDto).mockResolvedValue({ id: CLIENTE, ruc: RUC_CLIENTE } as never);
  vi.mocked(leerDetalleXml).mockResolvedValue(previo() as never);
  vi.mocked(guardarDocumentoXml).mockResolvedValue({ id: "d-1", n: 1 });
  vi.mocked(reevaluarCompra).mockResolvedValue(undefined as never);
  vi.mocked(entornoDeReglas).mockResolvedValue({ conocidos: [], evaluar: vi.fn() } as never);
  vi.mocked(fijarObtencion).mockResolvedValue(undefined as never);
  storage.guardar.mockImplementation(async () => {
    bitacora.push("archivo");
  });
  storage.eliminar.mockResolvedValue(undefined);
  detalle.leer.mockResolvedValue({ estado: "listo" });
});

describe("XmlComprasService.subir", () => {
  const subir = (svc: XmlComprasService, cuerpo: unknown = bytesXml()) =>
    svc.subir(sesion, alcance, CLIENTE, "202610", COMPRA, cuerpo);

  it("camino feliz: archivo antes que la fila, re-evalúa sin versión nueva y responde con el detalle de la lupa", async () => {
    vi.mocked(guardarDocumentoXml).mockImplementation((async () => {
      bitacora.push("fila");
      return { id: "d-1", n: 1 };
    }) as never);
    const { svc, withTenant } = servicio();
    await expect(subir(svc)).resolves.toEqual({ estado: "listo" });
    expect(bitacora).toEqual(["archivo", "fila", "commit"]);
    expect(withTenant.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT, userId: USUARIO });
    const [ruta, bytes] = storage.guardar.mock.calls[0] as [string, Uint8Array];
    expect(ruta.startsWith(`xml/${TENANT}/${CLIENTE}/`)).toBe(true);
    expect(Buffer.from(bytes).equals(bytesXml())).toBe(true);
    expect(vi.mocked(guardarDocumentoXml).mock.calls[0]?.[1]).toMatchObject({
      clienteId: CLIENTE,
      rucEmisor: "20700000045",
      origen: "subido",
      ruta,
      tamano: bytes.length,
      subidoPor: USUARIO,
    });
    // El id de la compra se normaliza a minúsculas y la re-evaluación va en la misma transacción.
    expect(vi.mocked(reevaluarCompra).mock.calls[0]?.slice(0, 2)).toEqual([TX, COMPRA.toLowerCase()]);
    expect(detalle.leer).toHaveBeenCalledWith(TX, CLIENTE, "202610", COMPRA.toLowerCase());
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it.each([
    ["sin cuerpo", null],
    ["cuerpo que no es XML crudo", { xml: "<Invoice/>" }],
    ["un archivo que no es un comprobante", Buffer.from("esto no es un comprobante")],
  ])("%s: xml_invalido antes de tocar la BD o el storage", async (_n, cuerpo) => {
    const { svc, withTenant } = servicio();
    const e = await capturar(subir(svc, cuerpo));
    expect(e).toBeInstanceOf(XmlError);
    expect(e).toMatchObject({ codigo: "xml_invalido" });
    expect(withTenant).not.toHaveBeenCalled();
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("un XML de otro receptor es xml_ajeno con los campos que difieren, sin escribir el archivo ni la fila", async () => {
    vi.mocked(leerClienteDto).mockResolvedValue({ id: CLIENTE, ruc: "20700000099" } as never);
    const { svc } = servicio();
    const e = await capturar(subir(svc));
    expect(e).toBeInstanceOf(XmlError);
    expect(e).toMatchObject({ codigo: "xml_ajeno" });
    expect((e as XmlError).cuerpo).toEqual({ codigo: "xml_ajeno", campos: ["receptor"] });
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(guardarDocumentoXml).not.toHaveBeenCalled();
    expect(bitacora).toEqual(["rollback"]);
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it("un XML de otra serie es xml_ajeno", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ compra: { serie: "F002" } }) as never);
    const { svc } = servicio();
    const e = await capturar(subir(svc));
    expect(e).toMatchObject({ codigo: "xml_ajeno" });
    expect((e as XmlError).cuerpo).toEqual({ codigo: "xml_ajeno", campos: ["serie"] });
  });

  it.each(["real", "subido"])("P-6: con un XML %s ya vigente responde xml_existente sin escribir el archivo", async (origen) => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ xml: { origen, ruta: "xml/previo.xml" } }) as never);
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toMatchObject({ codigo: "xml_existente" });
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it("P-6: un XML simulado vigente sí se reemplaza", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ xml: { origen: "simulado", ruta: "xml/sim.xml" } }) as never);
    const { svc } = servicio();
    await expect(subir(svc)).resolves.toEqual({ estado: "listo" });
    expect(guardarDocumentoXml).toHaveBeenCalledTimes(1);
  });

  it("carrera con P-6: si la fila resulta existente_no_simulado, xml_existente, se revierte y se borra el archivo ya escrito", async () => {
    vi.mocked(guardarDocumentoXml).mockResolvedValue("existente_no_simulado");
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toMatchObject({ codigo: "xml_existente" });
    expect(bitacora).toEqual(["archivo", "rollback"]);
    const ruta = (storage.guardar.mock.calls[0] as [string])[0];
    expect(storage.eliminar).toHaveBeenCalledWith(ruta);
    expect(reevaluarCompra).not.toHaveBeenCalled();
  });

  it("la compra o el cliente inexistentes son no_encontrado, sin escribir nada", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(null);
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toMatchObject({ codigo: "no_encontrado" });
    vi.mocked(leerClienteDto).mockResolvedValue(null);
    expect(await capturar(subir(servicio().svc))).toMatchObject({ codigo: "no_encontrado" });
    expect(storage.guardar).not.toHaveBeenCalled();
  });

  it("si exigirCliente rechaza (archivado o fuera de alcance) el error sale tal cual y no se escribe nada", async () => {
    const rechazo = new AccesoError("cliente_archivado");
    vi.mocked(exigirCliente).mockRejectedValue(rechazo);
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toBe(rechazo);
    expect(storage.guardar).not.toHaveBeenCalled();
    expect(storage.eliminar).not.toHaveBeenCalled();
  });

  it("si la compra dejó de existir al re-evaluar: no_encontrado, se revierte y el archivo se borra", async () => {
    vi.mocked(reevaluarCompra).mockRejectedValue(new ComprasReglaError("no_encontrada"));
    const { svc } = servicio();
    const e = await capturar(subir(svc));
    expect(e).toBeInstanceOf(AccesoError);
    expect(e).toMatchObject({ codigo: "no_encontrado" });
    expect(bitacora).toEqual(["archivo", "rollback"]);
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
  });

  it("un error de la BD al guardar la fila se propaga y deja el archivo borrado", async () => {
    const fallo = new Error("bd caída");
    vi.mocked(guardarDocumentoXml).mockRejectedValue(fallo);
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toBe(fallo);
    expect(storage.eliminar).toHaveBeenCalledTimes(1);
  });

  it("si además el borrado falla: sale el error original, queda un aviso y nada de la ruta ni del hash en el log", async () => {
    const fallo = new Error("bd caída");
    vi.mocked(guardarDocumentoXml).mockRejectedValue(fallo);
    storage.eliminar.mockRejectedValue(new Error("storage caído"));
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toBe(fallo);
    expect(avisos).toHaveLength(1);
    const ruta = (storage.guardar.mock.calls[0] as [string])[0];
    expect(JSON.stringify(avisos)).not.toContain(ruta);
    expect(JSON.stringify(avisos)).not.toContain("storage caído");
  });

  it("si el archivo no se pudo escribir no hay nada que borrar", async () => {
    const fallo = new Error("disco lleno");
    storage.guardar.mockRejectedValue(fallo);
    const { svc } = servicio();
    expect(await capturar(subir(svc))).toBe(fallo);
    expect(storage.eliminar).not.toHaveBeenCalled();
  });
});

describe("XmlComprasService.descargar", () => {
  const descargar = (svc: XmlComprasService) => svc.descargar(sesion, alcance, CLIENTE, "202610", COMPRA);
  const guardado = (identidad: Record<string, string> = {}) =>
    ({
      ...previo({ xml: { origen: "subido", ruta: "xml/t/c/u.xml" } }),
      identidad: { rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056", ...identidad },
    }) as never;

  it("devuelve los bytes tal cual con el nombre armado con la identidad del comprobante", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(guardado());
    storage.leer.mockResolvedValue(bytesXml());
    const r = await descargar(servicio().svc);
    expect(r.nombre).toBe("20700000045-01-F001-2056.xml");
    expect(Buffer.from(r.bytes).equals(bytesXml())).toBe(true);
    expect(storage.leer).toHaveBeenCalledWith("xml/t/c/u.xml");
  });

  it("el nombre del adjunto solo lleva letras, dígitos, punto y guion", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(guardado({ serie: 'F0"1/../x', numero: "20 56" }));
    storage.leer.mockResolvedValue(new Uint8Array());
    expect((await descargar(servicio().svc)).nombre).toBe("20700000045-01-F0_1_.._x-20_56.xml");
  });

  it.each([
    ["la compra no existe", null],
    ["la compra no tiene XML", previo()],
  ])("%s: no_encontrado sin tocar el storage", async (_n, d) => {
    vi.mocked(leerDetalleXml).mockResolvedValue(d as never);
    expect(await capturar(descargar(servicio().svc))).toMatchObject({ codigo: "no_encontrado" });
    expect(storage.leer).not.toHaveBeenCalled();
  });

  it("si el archivo ya no está en el storage, para quien pide es como si no hubiera XML (404, no 500)", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(guardado());
    storage.leer.mockRejectedValue(new ArchivoNoEncontradoError());
    const e = await capturar(descargar(servicio().svc));
    expect(e).toBeInstanceOf(AccesoError);
    expect(e).toMatchObject({ codigo: "no_encontrado" });
  });

  it("otro fallo del storage no se disfraza de 404: se propaga", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(guardado());
    const fallo = new Error("storage caído");
    storage.leer.mockRejectedValue(fallo);
    expect(await capturar(descargar(servicio().svc))).toBe(fallo);
  });
});

describe("XmlComprasService.obtener", () => {
  /** El encolador doble corre `antes` en la transacción, como el real, y devuelve el trabajo. */
  beforeEach(() => {
    encolarCon.mockImplementation(async (_ctx: unknown, _e: unknown, antes: (tx: unknown) => Promise<void>) => {
      await antes(TX);
      return { trabajo: { id: "trabajo-1" }, nuevo: true };
    });
  });
  const obtener = () => servicio().svc.obtener(sesion, alcance, CLIENTE, "202610", COMPRA);

  it("pone la obtención en pendiente y encola un lote de 1, interactivo, con el id en minúsculas", async () => {
    await expect(obtener()).resolves.toEqual({ trabajoId: "trabajo-1" });
    expect(encolarCon.mock.calls[0]?.[0]).toEqual({ tenantId: TENANT, userId: USUARIO });
    expect(encolarCon.mock.calls[0]?.[1]).toEqual({
      tipo: "xml.obtener",
      clienteId: CLIENTE,
      parametros: { periodo: "202610", compraIds: [COMPRA.toLowerCase()] },
      prioridad: "interactivo",
      creadoPor: USUARIO,
    });
    expect(fijarObtencion).toHaveBeenCalledWith(
      TX,
      CLIENTE,
      { rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056" },
      "pendiente",
    );
  });

  it("un XML simulado vigente no impide pedir el real (P-6)", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ xml: { origen: "simulado", ruta: "x" } }) as never);
    await expect(obtener()).resolves.toEqual({ trabajoId: "trabajo-1" });
    expect(fijarObtencion).toHaveBeenCalledTimes(1);
  });

  it.each(["real", "subido"])("con un XML %s ya vigente: xml_existente y no se marca ni se encola nada", async (origen) => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ xml: { origen, ruta: "x" } }) as never);
    expect(await capturar(obtener())).toMatchObject({ codigo: "xml_existente" });
    expect(fijarObtencion).not.toHaveBeenCalled();
  });

  it("la compra inexistente es no_encontrado", async () => {
    vi.mocked(leerDetalleXml).mockResolvedValue(null);
    expect(await capturar(obtener())).toMatchObject({ codigo: "no_encontrado" });
    expect(fijarObtencion).not.toHaveBeenCalled();
  });

  it.each([
    ["un tipo de comprobante sin XML (14)", { tipoDoc: "14" }],
    ["un proveedor sin RUC (DNI)", { docTipo: "1" }],
  ])("%s: solicitud_invalida, porque encolar sería trabajo perdido", async (_n, compra) => {
    vi.mocked(leerDetalleXml).mockResolvedValue(previo({ compra }) as never);
    const e = await capturar(obtener());
    expect(e).toBeInstanceOf(AccesoError);
    expect(e).toMatchObject({ codigo: "solicitud_invalida" });
    expect(fijarObtencion).not.toHaveBeenCalled();
  });

  it("si el cliente está archivado o fuera de alcance, el error sale tal cual y no se marca nada", async () => {
    const rechazo = new AccesoError("cliente_archivado");
    vi.mocked(exigirCliente).mockRejectedValue(rechazo);
    expect(await capturar(obtener())).toBe(rechazo);
    expect(leerDetalleXml).not.toHaveBeenCalled();
    expect(fijarObtencion).not.toHaveBeenCalled();
  });

  it("si el encolador rechaza (cola llena) el error sale tal cual", async () => {
    const lleno = new Error("cola llena");
    encolarCon.mockRejectedValue(lleno);
    expect(await capturar(obtener())).toBe(lleno);
  });
});

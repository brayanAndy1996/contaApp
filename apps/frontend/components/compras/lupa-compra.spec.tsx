import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import { MENSAJES } from "../../lib/acceso";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_1040_ISC,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  TEXTO_HOSTIL,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  type OpcionesCompras,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  AUTOR_XML,
  AUTOR_XML_DTO,
  GLOSA_HOSTIL,
  detalleLupaDe,
  detalleMixto,
  detalleSinXml,
  rutaDescargarXml,
  rutaDetalle,
  rutaObtenerXml,
} from "../../pruebas/lupa-compras";
import { LupaCompra } from "./lupa-compra";

// Spec 016 · T15 (nivel C): la lupa del comprobante. Un caso feliz y uno de error por comportamiento: abrir con XML,
// navegar con el teclado, aceptar (con 409), estados del XML, simulado/subido, aviso de moneda, descarga y `<script>`
// como texto. El backend no existe todavía: `fetch` simula el contrato de `shared` (cada detalle se valida con
// `detalleLupaSchema` al construirlo).

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const aceptarRuta = (id: string) => `POST ${BASE}/${id}/sugerencias/aceptar`;
const TRABAJO = "00000009-0000-4000-8000-000000000001";

function instalar(extra: NonNullable<OpcionesCompras["extra"]>) {
  return instalarFetchCompras({ extra });
}

function Montar({
  filas,
  inicial,
  contexto,
  alCerrar,
  alAvisar,
}: {
  filas: readonly FilaCompraVista[];
  inicial: string;
  contexto: ReturnType<typeof contextoDe>;
  alCerrar: () => void;
  alAvisar: () => void;
}) {
  const [id, setId] = useState(inicial);
  return (
    <LupaCompra
      contexto={contexto}
      filas={filas}
      orden={filas.map((f) => f.id)}
      compraId={id}
      alCambiar={setId}
      alCerrar={alCerrar}
      alAvisarDe={() => alAvisar}
    />
  );
}

function montar(
  filas: readonly FilaCompraVista[],
  opciones: { inicial?: string; contexto?: ReturnType<typeof contextoDe> } = {},
) {
  const contexto = opciones.contexto ?? contextoDe();
  const alCerrar = vi.fn();
  const alAvisar = vi.fn();
  render(
    <Montar
      filas={filas}
      inicial={opciones.inicial ?? filas[0]!.id}
      contexto={contexto}
      alCerrar={alCerrar}
      alAvisar={alAvisar}
    />,
  );
  return { contexto, alCerrar, alAvisar, usuario: userEvent.setup() };
}

const seccion = (nombre: string) => screen.getByRole("region", { name: nombre });
const titulo = (comprobante: string) =>
  screen.findByRole("heading", { name: L.tituloModal(comprobante) });

describe("Lupa · abrir con XML (CA-14)", () => {
  it("feliz: cabecera, ítems con afectación, comparación con la diferencia en texto y R-MIX, e historial del proveedor", async () => {
    instalar({ [rutaDetalle(C_2056_MIXTA.id)]: { status: 200, cuerpo: detalleMixto(C_2056_MIXTA) } });
    montar([C_2056_MIXTA]);

    await titulo("F001-2056");
    expect(screen.getByRole("dialog", { name: L.tituloModal("F001-2056") }).getAttribute("aria-modal")).toBe("true");

    const cabecera = await screen.findByRole("region", { name: L.secciones.cabecera });
    expect(within(cabecera).getByText("20700000045")).toBeTruthy();
    expect(within(cabecera).getByText("PRUEBA PROVEEDOR MIXTO S.A.C.")).toBeTruthy();
    expect(within(cabecera).getByText("Factura (01)")).toBeTruthy();
    expect(within(cabecera).getByText("F001-2056")).toBeTruthy();
    expect(within(cabecera).getByText("2026-10-05")).toBeTruthy();
    expect(within(cabecera).getByText("Electrónica")).toBeTruthy();

    const items = within(seccion(L.secciones.items));
    expect(items.getByText("Servicio de consultoría")).toBeTruthy();
    expect(items.getByText("Gravado (10)")).toBeTruthy();
    expect(items.getByText("Exonerado (20)")).toBeTruthy();
    expect(items.getByText("6.255")).toBeTruthy();

    const comparacion = seccion(L.secciones.comparacion);
    const filaBi = within(comparacion).getByRole("row", { name: new RegExp(L.comparacion.columnas.bi.replace(/[()+]/g, "\\$&")) });
    expect(filaBi.getAttribute("data-difiere")).toBe("true");
    expect(within(filaBi).getByText(L.comparacion.difiere)).toBeTruthy();
    expect(within(filaBi).getByText("21.48")).toBeTruthy();
    expect(within(filaBi).getByText("8.97")).toBeTruthy();
    expect(within(filaBi).getByText(`R-MIX · ${M.hallazgos["R-MIX"]}`)).toBeTruthy();
    expect(within(filaBi).getByText(C_2056_MIXTA.hallazgos[0]!.explicacion)).toBeTruthy();
    const filaIgv = within(comparacion).getByRole("row", { name: /^IGV/ });
    expect(filaIgv.getAttribute("data-difiere")).toBe("false");
    expect(within(filaIgv).getByText(L.comparacion.coincide)).toBeTruthy();

    const proveedor = within(seccion(L.secciones.historialProveedor));
    expect(proveedor.getByText("F001-900")).toBeTruthy();
    expect(proveedor.getByText("202609")).toBeTruthy();
    expect(proveedor.getByText(M.destinos.DG)).toBeTruthy();
  });

  it("error: sin XML no hay ítems ni comparación; un 404 muestra el error y «Reintentar» lo recupera", async () => {
    const f = instalar({
      [rutaDetalle(C_1040_ISC.id)]: (_llamada, vez) =>
        vez === 1
          ? { status: 404, cuerpo: { codigo: "no_encontrada" } }
          : { status: 200, cuerpo: detalleSinXml(C_1040_ISC, { estado: "sin_solicitar" }) },
    });
    const { usuario } = montar([C_1040_ISC]);

    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES.noEncontrado);
    expect(screen.queryByRole("region", { name: L.secciones.cabecera })).toBeNull();
    await usuario.click(screen.getByRole("button", { name: L.reintentar }));

    await screen.findByRole("region", { name: L.secciones.cabecera });
    expect(f.de(rutaDetalle(C_1040_ISC.id))).toHaveLength(2);
    expect(within(seccion(L.secciones.items)).getByText(L.items.sinXml)).toBeTruthy();
    const comparacion = seccion(L.secciones.comparacion);
    expect(within(comparacion).getByText(L.comparacion.sinXmlNota)).toBeTruthy();
    expect(within(comparacion).getAllByText(L.comparacion.sinXml).length).toBeGreaterThan(0);
  });

  it("error: una respuesta que no cumple el esquema (monto como número) no se pinta", async () => {
    const roto = { ...detalleLupaDe(C_1040_ISC), comparacion: [{ columna: "bi", sire: 770, xml: 770, difiere: false }] };
    instalar({ [rutaDetalle(C_1040_ISC.id)]: { status: 200, cuerpo: roto } });
    montar([C_1040_ISC]);

    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES.errorGeneral);
    expect(screen.queryByRole("region", { name: L.secciones.comparacion })).toBeNull();
  });
});

describe("Lupa · glosas y razón social como texto (CA-17)", () => {
  it("feliz: un <script> en la glosa y la razón social se ve como texto y no se ejecuta", async () => {
    const fila = filaDe({
      ...C_1040_ISC,
      proveedor: { tipo: "6", numero: "20700000011", razonSocial: TEXTO_HOSTIL },
    });
    const base = detalleLupaDe(fila);
    instalar({
      [rutaDetalle(fila.id)]: {
        status: 200,
        cuerpo: { ...base, items: [{ ...base.items[0]!, descripcion: GLOSA_HOSTIL }] },
      },
    });
    montar([fila]);

    const items = await screen.findByRole("region", { name: L.secciones.items });
    expect(within(items).getByText(GLOSA_HOSTIL)).toBeTruthy();
    expect(within(await screen.findByRole("region", { name: L.secciones.cabecera })).getByText(TEXTO_HOSTIL)).toBeTruthy();
    const dialogo = screen.getByRole("dialog", { name: L.tituloModal("F001-1040") });
    expect(dialogo.querySelector("script")).toBeNull();
    expect(dialogo.querySelector("img")).toBeNull();
  });
});

describe("Lupa · teclado y navegación (CA-15)", () => {
  const A = C_1040_ISC;
  const B = C_2056_MIXTA;

  it("feliz: → y ← recorren el orden recibido, el contador lo dice y Esc cierra recargando la fila", async () => {
    const f = instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [rutaDetalle(B.id)]: { status: 200, cuerpo: detalleMixto(B) },
    });
    const { usuario, contexto, alCerrar } = montar([A, B]);

    await titulo("F001-1040");
    expect(screen.getByText(L.posicion(1, 2))).toBeTruthy();
    expect((screen.getByRole("button", { name: L.anterior }) as HTMLButtonElement).disabled).toBe(true);

    await usuario.keyboard("{ArrowRight}");
    await titulo("F001-2056");
    expect(screen.getByText(L.posicion(2, 2))).toBeTruthy();
    await vi.waitFor(() => expect(f.de(rutaDetalle(B.id))).toHaveLength(1));
    expect(await screen.findByText("8.97")).toBeTruthy();

    // En la última, → no hace nada; ← vuelve.
    await usuario.keyboard("{ArrowRight}");
    expect(screen.getByText(L.posicion(2, 2))).toBeTruthy();
    await usuario.keyboard("{ArrowLeft}");
    await titulo("F001-1040");

    await usuario.keyboard("{Escape}");
    expect(alCerrar).toHaveBeenCalledTimes(1);
    expect(contexto.recargarFila).toHaveBeenCalledWith(A.id);
  });

  it("error: si el detalle de la vecina no existe (404) lo dice, y al volver la anterior sigue bien", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [rutaDetalle(B.id)]: { status: 404, cuerpo: { codigo: "no_encontrada" } },
    });
    const { usuario } = montar([A, B]);

    await titulo("F001-1040");
    await screen.findByRole("region", { name: L.secciones.cabecera });
    await usuario.click(screen.getByRole("button", { name: L.siguiente }));
    await titulo("F001-2056");
    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES.noEncontrado);
    // Nada de la compra anterior queda pintado bajo el título de esta.
    expect(screen.queryByRole("region", { name: L.secciones.cabecera })).toBeNull();

    await usuario.click(screen.getByRole("button", { name: L.anterior }));
    await titulo("F001-1040");
    await screen.findByRole("region", { name: L.secciones.cabecera });
  });

  it("el foco se queda dentro del modal con Tab y las flechas no se roban dentro de un campo", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const { usuario } = montar([A, B]);
    await screen.findByRole("region", { name: L.secciones.cabecera });

    const dialogo = screen.getByRole("dialog", { name: L.tituloModal("F001-1040") });
    expect(document.activeElement).toBe(dialogo);
    for (let i = 0; i < 40; i += 1) {
      await usuario.tab();
      expect(dialogo.contains(document.activeElement)).toBe(true);
    }
  });
});

describe("Lupa · aceptar la sugerencia (CA-15, 409 y 422 como en la grilla)", () => {
  const A = C_1040_ISC;

  it("feliz: Enter abre la aceptación, Enter la elige, se confirma y la fila se recarga con el aviso", async () => {
    const aceptada = filaDe({ ...A, version: 2, hallazgos: [], montos: montosDe({ isc: "770.00" }) });
    const f = instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [aceptarRuta(A.id)]: { status: 200, cuerpo: accionDe(aceptada) },
    });
    const { usuario, contexto, alAvisar } = montar([A]);
    await screen.findByRole("region", { name: L.secciones.cabecera });

    await usuario.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: `${M.aceptarSugerencias} F001-1040` })).toBeTruthy();
    await usuario.keyboard("{Enter}");
    await usuario.click(await screen.findByRole("button", { name: M.confirmar }));

    await vi.waitFor(() => expect(contexto.recargarFila).toHaveBeenCalledWith(A.id));
    expect(f.de(aceptarRuta(A.id))[0]!.body).toEqual({ versionBase: 1, regla: "R-ISC", confirmar: true });
    expect(alAvisar).toHaveBeenCalledWith(M.sugerenciaAceptada, "ok");
    expect((await screen.findAllByText(M.sugerenciaAceptada)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: `${M.aceptarSugerencias} F001-1040` })).toBeNull();
  });

  it("error: 409 revisar_de_nuevo muestra el mensaje, recarga la fila y la lupa sigue abierta", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [aceptarRuta(A.id)]: { status: 409, cuerpo: { codigo: "revisar_de_nuevo" } },
    });
    const { usuario, contexto, alCerrar } = montar([A]);
    await screen.findByRole("region", { name: L.secciones.cabecera });

    await usuario.click(screen.getByRole("button", { name: L.hallazgos.aceptar }));
    await usuario.click(await screen.findByRole("button", { name: `${M.aceptar} R-ISC` }));
    await usuario.click(await screen.findByRole("button", { name: M.confirmar }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.errores.revisar_de_nuevo);
    expect(contexto.recargarFila).toHaveBeenCalledWith(A.id);
    expect(alCerrar).not.toHaveBeenCalled();
    // Esc cierra la ventana de aceptación, no la lupa.
    await usuario.keyboard("{Escape}");
    expect(alCerrar).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: L.tituloModal("F001-1040") })).toBeTruthy();
  });

  it("solo lectura: las acciones salen deshabilitadas con el motivo y Enter no abre nada", async () => {
    const contexto = contextoDe({ soloLectura: M.soloLectura.revisadoSinAprobar });
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const { usuario } = montar([A], { contexto });
    await screen.findByRole("region", { name: L.secciones.cabecera });

    const aceptar = screen.getByRole("button", { name: L.hallazgos.aceptar }) as HTMLButtonElement;
    expect(aceptar.disabled).toBe(true);
    expect(aceptar.title).toBe(M.soloLectura.revisadoSinAprobar);
    expect((screen.getByRole("button", { name: `${M.columnas.acciones} F001-1040` }) as HTMLButtonElement).disabled).toBe(true);
    await usuario.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: `${M.aceptarSugerencias} F001-1040` })).toBeNull();
  });

  it("sin permiso de clasificar no hay acciones de escritura", async () => {
    const contexto = contextoDe({ permisos: { clasificar: false } });
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    montar([A], { contexto });
    await screen.findByRole("region", { name: L.secciones.cabecera });

    expect(screen.queryByRole("button", { name: L.hallazgos.aceptar })).toBeNull();
    expect(screen.queryByRole("button", { name: `${M.columnas.acciones} F001-1040` })).toBeNull();
  });
});

describe("Lupa · estado del XML (CA-9, CA-11, CA-16)", () => {
  const A = C_1040_ISC;

  it("feliz: «XML simulado», «XML real» y «XML subido por … el …» según el origen", async () => {
    let origen: "simulado" | "real" | "subido" = "simulado";
    instalar({
      [rutaDetalle(A.id)]: () => ({
        status: 200,
        cuerpo: detalleLupaDe(A, {
          xml:
            origen === "subido"
              ? { estado: "disponible", origen, subidoPor: AUTOR_XML, autor: AUTOR_XML_DTO, subidoEn: "2026-10-21T10:30:00.000Z" }
              : { estado: "disponible", origen },
        }),
      }),
    });
    montar([A]);

    expect(await screen.findByText(L.xml.simulado)).toBeTruthy();
    expect(screen.getByRole("button", { name: L.xml.descargar })).toBeTruthy();

    origen = "real";
    cleanup();
    montar([A]);
    expect(await screen.findByText(L.xml.real)).toBeTruthy();

    origen = "subido";
    cleanup();
    montar([A]);
    expect(await screen.findByText(L.xml.subidoPor("Rosa Quispe", "2026-10-21 10:30 UTC"))).toBeTruthy();
  });

  it("aviso de moneda: PEN con XML en USD muestra el aviso sin convertir; sin discrepancia no hay aviso", async () => {
    let con = true;
    instalar({
      [rutaDetalle(A.id)]: () => ({
        status: 200,
        cuerpo: detalleLupaDe(A, {
          xml: {
            estado: "disponible",
            origen: "real",
            ...(con ? { avisoMoneda: { monedaXml: "USD" as const, monedaFila: "PEN" as const } } : {}),
          },
        }),
      }),
    });
    montar([A]);
    expect((await screen.findByRole("note")).textContent).toBe(L.xml.avisoMoneda("USD", "PEN"));

    cleanup();
    con = false;
    montar([A]);
    await screen.findByText(L.xml.real);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("no disponible: dice la causa sin filtrar nada interno y «Reintentar» pasa a pendiente y luego al XML", async () => {
    const f = instalar({
      [rutaDetalle(A.id)]: (_llamada, vez) => ({
        status: 200,
        cuerpo: detalleSinXml(
          A,
          vez === 1
            ? { estado: "no_disponible", codigo: "no_encontrado" }
            : vez === 2
              ? { estado: "pendiente" }
              : { estado: "disponible", origen: "real" },
        ),
      }),
      [rutaObtenerXml(A.id)]: { status: 202, cuerpo: { trabajoId: TRABAJO } },
    });
    const { usuario } = montar([A]);

    expect(await screen.findByText(L.xml.noDisponible)).toBeTruthy();
    expect(screen.getByText(L.xml.causas.no_encontrado)).toBeTruthy();
    await usuario.click(screen.getByRole("button", { name: L.xml.reintentarObtener }));

    expect(await screen.findByText(L.xml.pendiente)).toBeTruthy();
    expect(f.de(rutaObtenerXml(A.id))).toHaveLength(1);
    // El trabajo ya no está vivo al abrir el seguimiento: se vuelve a leer el detalle y llega el XML.
    expect(await screen.findByText(L.xml.real)).toBeTruthy();
    expect(f.de(rutaDetalle(A.id))).toHaveLength(3);
    expect(f.de("GET /api/trabajos").length).toBeGreaterThan(0);
  });

  it("error: 409 xml_existente al reintentar muestra su mensaje y recarga el detalle; «no aplica» no ofrece reintentar", async () => {
    const f = instalar({
      [rutaDetalle(A.id)]: (_llamada, vez) => ({
        status: 200,
        cuerpo: detalleSinXml(
          A,
          vez === 1
            ? { estado: "no_disponible", codigo: "transitorio" }
            : { estado: "disponible", origen: "subido", subidoPor: AUTOR_XML, autor: AUTOR_XML_DTO, subidoEn: "2026-10-21T10:30:00.000Z" },
        ),
      }),
      [rutaObtenerXml(A.id)]: { status: 409, cuerpo: { codigo: "xml_existente" } },
    });
    const { usuario } = montar([A]);

    await screen.findByText(L.xml.causas.transitorio);
    await usuario.click(screen.getByRole("button", { name: L.xml.reintentarObtener }));
    expect((await screen.findAllByText(L.errores.xml_existente)).length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(f.de(rutaDetalle(A.id))).toHaveLength(2));
    expect(await screen.findByText(/XML subido por/)).toBeTruthy();

    cleanup();
    instalar({
      [rutaDetalle(A.id)]: {
        status: 200,
        cuerpo: detalleSinXml(A, { estado: "no_disponible", codigo: "no_aplica" }),
      },
    });
    montar([A]);
    await screen.findByText(L.xml.causas.no_aplica);
    expect(screen.queryByRole("button", { name: L.xml.reintentarObtener })).toBeNull();
  });

  it("sin solicitar ofrece «Obtener XML»; con el cliente archivado queda deshabilitado", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleSinXml(A, { estado: "sin_solicitar" }) },
    });
    const { usuario } = montar([A]);
    const obtener = (await screen.findByRole("button", { name: L.xml.obtener })) as HTMLButtonElement;
    expect(obtener.disabled).toBe(false);
    await usuario.click(screen.getByRole("button", { name: L.cerrar }));

    cleanup();
    montar([A], { contexto: contextoDe({ soloLectura: M.soloLectura.clienteArchivado }) });
    const archivado = (await screen.findByRole("button", { name: L.xml.obtener })) as HTMLButtonElement;
    expect(archivado.disabled).toBe(true);
    expect(archivado.title).toBe(M.soloLectura.clienteArchivado);
  });

  it("T16 deja «Subir XML» en su lugar: con el XML no disponible se muestra lo que entrega `subir`", async () => {
    instalar({
      [rutaDetalle(A.id)]: {
        status: 200,
        cuerpo: detalleSinXml(A, { estado: "no_disponible", codigo: "no_encontrado" }),
      },
    });
    const contexto = contextoDe();
    render(
      <LupaCompra
        contexto={contexto}
        filas={[A]}
        orden={[A.id]}
        compraId={A.id}
        alCambiar={vi.fn()}
        alCerrar={vi.fn()}
        subir={() => <button type="button">Subir XML</button>}
      />,
    );
    expect(await screen.findByRole("button", { name: "Subir XML" })).toBeTruthy();
  });
});

describe("Lupa · descargar XML (CA-17)", () => {
  const A = C_1040_ISC;

  function prepararDescarga() {
    const crear = vi.fn(() => "blob:xml");
    const revocar = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: revocar }));
    const clic = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    return { crear, clic };
  }

  it("feliz: pide el adjunto de la compra y lo guarda sin interpretarlo", async () => {
    const { crear, clic } = prepararDescarga();
    const f = instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [rutaDescargarXml(A.id)]: { status: 200, cuerpo: {} },
    });
    const { usuario } = montar([A]);

    await usuario.click(await screen.findByRole("button", { name: L.xml.descargar }));
    await vi.waitFor(() => expect(clic).toHaveBeenCalledTimes(1));
    expect(f.de(rutaDescargarXml(A.id))).toHaveLength(1);
    expect(crear).toHaveBeenCalledTimes(1);
  });

  it("error: un 404 se avisa y no guarda nada", async () => {
    const { crear, clic } = prepararDescarga();
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) },
      [rutaDescargarXml(A.id)]: { status: 404, cuerpo: { codigo: "no_encontrado" } },
    });
    const { usuario } = montar([A]);

    await usuario.click(await screen.findByRole("button", { name: L.xml.descargar }));
    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES.noEncontrado);
    expect(clic).not.toHaveBeenCalled();
    expect(crear).not.toHaveBeenCalled();
  });
});

describe("Lupa · historial", () => {
  it("«Historial» muestra el de 015 dentro del modal y se oculta", async () => {
    const A = C_3064_BOLSAS;
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const { usuario } = montar([A]);
    await screen.findByRole("region", { name: L.secciones.cabecera });

    await usuario.click(screen.getByRole("button", { name: L.historial }));
    expect(await screen.findByText(M.valorOriginal)).toBeTruthy();
    await usuario.click(screen.getByRole("button", { name: L.ocultarHistorial }));
    expect(screen.queryByText(M.valorOriginal)).toBeNull();
  });
});

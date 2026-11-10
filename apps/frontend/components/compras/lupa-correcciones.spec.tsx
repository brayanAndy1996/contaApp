import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import { MENSAJES_LUPA as L, TOPE_XML_BYTES } from "../../lib/lupa-compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  C_1040_ISC,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  filaDe,
  instalarFetchCompras,
  type OpcionesCompras,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  archivoXml,
  detalleLupaDe,
  detalleSinXml,
  rutaDetalle,
  rutaObtenerXml,
  rutaSubirXml,
} from "../../pruebas/lupa-compras";
import { GrillaCompras, type PropsGrillaCompras } from "./grilla-compras";
import { LupaCompra } from "./lupa-compra";

// Spec 016 · T24a (nivel C): defectos de pantalla de la prueba manual. P-1 foco tras «Obtener XML» o «Reintentar»,
// P-2 error del servidor junto al aviso de tamaño, P-3 «Editar» en la lupa (grilla de 015) y el texto de ayuda de
// Enter. Un caso feliz y uno de error por corrección.

beforeEach(() => {
  reiniciarSesion();
  // jsdom no mide el diseño: ancho de sobra para que estén pintadas todas las columnas de la grilla.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A = C_2056_MIXTA;
const TRABAJO = "00000009-0000-4000-8000-000000000001";
const SIN_XML = detalleSinXml(A, { estado: "no_disponible", codigo: "no_encontrado" });

function instalar(extra: NonNullable<OpcionesCompras["extra"]>) {
  return instalarFetchCompras({ extra });
}

function montarLupa(
  o: {
    fila?: FilaCompraVista;
    contexto?: ReturnType<typeof contextoDe>;
    alEditar?: (id: string) => void;
    alCambiar?: (id: string) => void;
    orden?: string[];
  } = {},
) {
  const fila = o.fila ?? A;
  const contexto = o.contexto ?? contextoDe();
  const alCerrar = vi.fn();
  render(
    <LupaCompra
      contexto={contexto}
      filas={[fila]}
      orden={o.orden ?? [fila.id]}
      compraId={fila.id}
      alCambiar={o.alCambiar ?? vi.fn()}
      alCerrar={alCerrar}
      alEditar={o.alEditar}
    />,
  );
  return { contexto, alCerrar, usuario: userEvent.setup() };
}

const dialogo = () => screen.getByRole("dialog", { name: L.tituloModal("F001-2056") });

describe("P-1 · el foco vuelve a la lupa tras «Obtener XML» y «Reintentar»", () => {
  it("feliz: tras «Reintentar» el estado pasa a pendiente, el foco queda en la lupa y Esc cierra", async () => {
    const f = instalar({
      [rutaDetalle(A.id)]: (_llamada, vez) => ({
        status: 200,
        cuerpo: vez === 1 ? SIN_XML : detalleSinXml(A, { estado: "pendiente" }),
      }),
      [rutaObtenerXml(A.id)]: { status: 202, cuerpo: { trabajoId: TRABAJO } },
    });
    const { usuario, alCerrar } = montarLupa();

    const boton = await screen.findByRole("button", { name: L.xml.reintentarObtener });
    await usuario.click(boton);
    expect(await screen.findByText(L.xml.pendiente)).toBeTruthy();
    expect(f.de(rutaObtenerXml(A.id))).toHaveLength(1);

    // El botón ya no existe: el foco no puede quedar en BODY.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(dialogo());
    await usuario.keyboard("{Escape}");
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("feliz: tras «Obtener XML» (sin solicitar) las flechas siguen cambiando de compra", async () => {
    const B = C_1040_ISC;
    instalar({
      [rutaDetalle(A.id)]: (_llamada, vez) => ({
        status: 200,
        cuerpo: vez === 1 ? detalleSinXml(A, { estado: "sin_solicitar" }) : detalleSinXml(A, { estado: "pendiente" }),
      }),
      [rutaDetalle(B.id)]: { status: 200, cuerpo: detalleLupaDe(B) },
      [rutaObtenerXml(A.id)]: { status: 202, cuerpo: { trabajoId: TRABAJO } },
    });
    const alCambiar = vi.fn();
    const { usuario } = montarLupa({ alCambiar, orden: [A.id, B.id] });

    await usuario.click(await screen.findByRole("button", { name: L.xml.obtener }));
    expect(await screen.findByText(L.xml.pendiente)).toBeTruthy();
    await usuario.keyboard("{ArrowRight}");
    expect(alCambiar).toHaveBeenCalledWith(B.id);
  });

  it("error: si el servidor rechaza la solicitud el mensaje se ve, el foco sigue en la lupa y Esc cierra", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [rutaObtenerXml(A.id)]: { status: 500, cuerpo: { codigo: "error_interno" } },
    });
    const { usuario, alCerrar } = montarLupa();

    await usuario.click(await screen.findByRole("button", { name: L.xml.reintentarObtener }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);

    expect(document.activeElement).not.toBe(document.body);
    expect(dialogo().contains(document.activeElement)).toBe(true);
    await usuario.keyboard("{Escape}");
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("no roba el foco a quien lo tiene dentro de la lupa: un botón habilitado conserva el suyo", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML } });
    const { usuario } = montarLupa();
    const historial = await screen.findByRole("button", { name: L.historial });
    await usuario.click(historial);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: L.ocultarHistorial }));
  });
});

describe("P-2 · un archivo rechazado limpia el error anterior del servidor", () => {
  it("feliz: tras un error del servidor, un archivo de más de 1 MiB deja solo el aviso de tamaño", async () => {
    const f = instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [rutaSubirXml(A.id)]: { status: 422, cuerpo: { codigo: "xml_invalido" } },
    });
    const { usuario } = montarLupa();
    await screen.findByText(L.xml.noDisponible);

    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("no-es-xml.txt", "hola"));
    expect((await screen.findByRole("alert")).textContent).toContain(L.errores.xml_invalido);

    await usuario.upload(
      screen.getByLabelText(L.subir.boton),
      new File([new Uint8Array(TOPE_XML_BYTES + 1)], "grande.xml", { type: "text/xml" }),
    );
    const alertas = screen.getAllByRole("alert");
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.textContent).toBe(L.subir.grande);
    expect(screen.queryByText(L.errores.xml_invalido)).toBeNull();
    expect(f.de(rutaSubirXml(A.id))).toHaveLength(1);
  });

  it("feliz: un archivo vacío también limpia el error anterior", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [rutaSubirXml(A.id)]: { status: 422, cuerpo: { codigo: "xml_invalido" } },
    });
    const { usuario } = montarLupa();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("a.txt", "hola"));
    await screen.findByText(L.errores.xml_invalido);

    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("vacio.xml", ""));
    const alertas = screen.getAllByRole("alert");
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.textContent).toBe(L.subir.vacio);
  });

  it("error: un archivo válido que el servidor vuelve a rechazar sigue mostrando el error del servidor", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [rutaSubirXml(A.id)]: { status: 422, cuerpo: { codigo: "xml_invalido" } },
    });
    const { usuario } = montarLupa();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("a.txt", "hola"));
    await screen.findByText(L.errores.xml_invalido);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("b.txt", "adios"));
    expect((await screen.findByRole("alert")).textContent).toContain(L.errores.xml_invalido);
  });
});

describe("P-3 · «Editar» en la lupa", () => {
  it("feliz: recarga la fila, avisa a quien abre la edición con el id y la lupa no edita por su cuenta", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const alEditar = vi.fn();
    const { usuario, contexto } = montarLupa({ alEditar });
    await screen.findByRole("region", { name: L.secciones.cabecera });

    await usuario.click(screen.getByRole("button", { name: L.editar }));
    await vi.waitFor(() => expect(alEditar).toHaveBeenCalledWith(A.id));
    expect(contexto.recargarFila).toHaveBeenCalledWith(A.id);
    expect(contexto.recargarFila.mock.invocationCallOrder[0]!).toBeLessThan(alEditar.mock.invocationCallOrder[0]!);
  });

  it("error: en solo lectura sale deshabilitado con el motivo y no hace nada", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const alEditar = vi.fn();
    const contexto = contextoDe({ soloLectura: M.soloLectura.revisadoSinAprobar });
    const { usuario } = montarLupa({ alEditar, contexto });
    await screen.findByRole("region", { name: L.secciones.cabecera });

    const boton = screen.getByRole("button", { name: L.editar }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(boton.title).toBe(M.soloLectura.revisadoSinAprobar);
    await usuario.click(boton);
    expect(alEditar).not.toHaveBeenCalled();
  });

  it("error: una compra excluida lo deshabilita con su motivo", async () => {
    const excluida = filaDe({ ...A, excluida: true });
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(excluida) } });
    const alEditar = vi.fn();
    montarLupa({ fila: excluida, alEditar });
    await screen.findByRole("region", { name: L.secciones.cabecera });

    const boton = screen.getByRole("button", { name: L.editar }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(boton.title).toBe(M.errores.fila_excluida);
  });

  it("error: sin permiso de clasificar, o sin quien abra la edición, no se ofrece", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    const { unmount } = render(
      <LupaCompra
        contexto={contextoDe({ permisos: { clasificar: false } })}
        filas={[A]}
        orden={[A.id]}
        compraId={A.id}
        alCambiar={vi.fn()}
        alCerrar={vi.fn()}
        alEditar={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: L.secciones.cabecera });
    expect(screen.queryByRole("button", { name: L.editar })).toBeNull();
    unmount();

    montarLupa();
    await screen.findByRole("region", { name: L.secciones.cabecera });
    expect(screen.queryByRole("button", { name: L.editar })).toBeNull();
  });
});

describe("P-3 · la grilla atiende la edición pedida por la lupa", () => {
  function montarGrilla(extra: Partial<PropsGrillaCompras> = {}) {
    const props: PropsGrillaCompras = {
      filas: FILAS_014,
      cargando: false,
      seleccion: new Set<string>(),
      alCambiarSeleccion: vi.fn(),
      renderAcciones: () => null,
      alAbrirHistorial: vi.fn(),
      alGuardarFila: vi.fn(async () => undefined),
      edicionPedida: C_3064_BOLSAS.id,
      alAtenderEdicion: vi.fn(),
      ...extra,
    };
    render(<GrillaCompras {...props} />);
    return props;
  }
  const campo = () => document.querySelector<HTMLInputElement>("input[data-edicion]");

  it("feliz: abre la fila pedida en su primera celda de monto, con el foco en el campo", async () => {
    const props = montarGrilla();
    await vi.waitFor(() => expect(campo()).not.toBeNull());
    expect(props.alAtenderEdicion).toHaveBeenCalledWith(true);
    expect(props.alAtenderEdicion).toHaveBeenCalledTimes(1);
    expect(campo()!.closest("[data-fila]")!.getAttribute("data-fila")).toBe(C_3064_BOLSAS.id);
    expect(document.activeElement).toBe(campo());
    expect(screen.getByRole("region", { name: M.editandoFila("F001-3064") })).toBeTruthy();
    // Es la edición de 015: Esc descarta sin enviar nada.
    await act(async () => {
      await userEvent.setup().keyboard("{Escape}");
    });
    expect(campo()).toBeNull();
    expect(props.alGuardarFila).not.toHaveBeenCalled();
  });

  it("error: en solo lectura no abre nada y lo dice (false)", async () => {
    const props = montarGrilla({ soloLectura: M.soloLectura.revisadoSinAprobar });
    await vi.waitFor(() => expect(props.alAtenderEdicion).toHaveBeenCalledWith(false));
    expect(campo()).toBeNull();
  });

  it("error: una fila que no está en la lista, o excluida, no abre nada (false)", async () => {
    const inexistente = montarGrilla({ edicionPedida: "00000000-0000-4000-8000-00000000ffff" });
    await vi.waitFor(() => expect(inexistente.alAtenderEdicion).toHaveBeenCalledWith(false));
    expect(campo()).toBeNull();
    cleanup();

    const excluida = filaDe({ ...C_3064_BOLSAS, excluida: true });
    const props = montarGrilla({ filas: [excluida, C_1040_ISC], edicionPedida: excluida.id });
    await vi.waitFor(() => expect(props.alAtenderEdicion).toHaveBeenCalledWith(false));
    expect(campo()).toBeNull();
  });

  it("mientras la lista carga espera y no responde", async () => {
    const props = montarGrilla({ cargando: true });
    await act(async () => undefined);
    expect(props.alAtenderEdicion).not.toHaveBeenCalled();
    expect(within(document.body).queryByRole("region", { name: M.editandoFila("F001-3064") })).toBeNull();
  });
});

describe("Ayuda de teclado de la lupa", () => {
  it("dice que Enter abre la aceptación y un segundo Enter la confirma", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    montarLupa();
    await screen.findByRole("region", { name: L.secciones.cabecera });
    const ayuda = screen.getByText(L.ayudaTeclado);
    expect(ayuda.textContent).toContain("Enter abre la aceptación");
    expect(ayuda.textContent).toContain("un segundo Enter la confirma");
    expect(ayuda.textContent).not.toContain("Enter acepta");
  });
});

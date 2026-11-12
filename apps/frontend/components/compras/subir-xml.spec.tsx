import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES } from "../../lib/acceso";
import { fechaHoraLima } from "../../lib/fechas";
import { MENSAJES_LUPA as L, TOPE_XML_BYTES } from "../../lib/lupa-compras";
import { reiniciarSesion } from "../../lib/sesion";
import { C_2056_MIXTA, MENSAJES_COMPRAS as M, instalarFetchCompras, type OpcionesCompras } from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { AUTOR_XML, AUTOR_XML_DTO, archivoXml, detalleLupaDe, detalleSinXml, rutaDetalle, rutaSubirXml } from "../../pruebas/lupa-compras";
import { LupaCompra } from "./lupa-compra";

// Spec 016 · T16 (nivel C; CA-12, D-3, P-6): «Subir XML» dentro de la lupa. Un caso feliz (completa el modal sin
// recargar) y los de error por código (`xml_ajeno` con el campo, `xml_invalido`, `xml_incompleto`, `xml_existente`,
// 413) más el tope de 1 MiB comprobado en el navegador. El backend no existe todavía: `fetch` simula el contrato.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = C_2056_MIXTA;
const SUBIR = rutaSubirXml(A.id);
const SIN_XML = detalleSinXml(A, { estado: "no_disponible", codigo: "no_encontrado" });

function instalar(extra: NonNullable<OpcionesCompras["extra"]>, opciones: Omit<OpcionesCompras, "extra"> = {}) {
  return instalarFetchCompras({ ...opciones, extra });
}

function montar(contexto = contextoDe()) {
  render(
    <LupaCompra
      contexto={contexto}
      filas={[A]}
      orden={[A.id]}
      compraId={A.id}
      alCambiar={vi.fn()}
      alCerrar={vi.fn()}
    />,
  );
  return { contexto, usuario: userEvent.setup() };
}

describe("Subir XML en la lupa · caso feliz (CA-12)", () => {
  it("envía el XML como cuerpo crudo y la lupa se completa sin recargar la página", async () => {
    const subido = detalleLupaDe(A, {
      xml: { estado: "disponible", origen: "subido", subidoPor: AUTOR_XML, autor: AUTOR_XML_DTO, subidoEn: "2026-10-20T15:00:00.000Z" },
    });
    let hecho = false;
    const f = instalar({
      [rutaDetalle(A.id)]: () => ({ status: 200, cuerpo: hecho ? subido : SIN_XML }),
      [SUBIR]: () => {
        hecho = true;
        return { status: 200, cuerpo: subido };
      },
    });
    const { usuario } = montar();

    expect(await screen.findByText(L.xml.noDisponible)).toBeTruthy();
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("factura.xml", "<Invoice>12345</Invoice>"));

    const textoSubido = await screen.findByText(/^XML subido por Rosa Quispe el /);
    expect(textoSubido.textContent).toBe(L.xml.subidoPor("Rosa Quispe", fechaHoraLima("2026-10-20T15:00:00.000Z")));
    expect(document.body.textContent).toMatch(/20\/10\/26,? 10:00\s?a\.\s?m\./);
    expect(f.de(SUBIR)).toHaveLength(1);
    expect(f.de(SUBIR)[0]!.bytes).toBe("<Invoice>12345</Invoice>".length);
    expect(f.de(SUBIR)[0]!.headers["content-type"]).toBe("application/octet-stream");
    // El detalle se volvió a pedir (sin recargar la página) y ahora hay ítems y comparación.
    expect(f.de(rutaDetalle(A.id))).toHaveLength(2);
    expect(screen.getByRole("table", { name: L.items.tabla })).toBeTruthy();
  });
});

describe("Subir XML en la lupa · errores (CA-12, D-3, P-6)", () => {
  it.each([
    [
      "xml_ajeno nombra el campo que difiere",
      422,
      { codigo: "xml_ajeno", campos: ["serie", "numero"] },
      "El XML no corresponde a este comprobante: no coincide la serie y el número.",
    ],
    ["xml_ajeno de otro receptor", 422, { codigo: "xml_ajeno", campos: ["receptor"] }, "no coincide el RUC del receptor"],
    ["xml_invalido", 422, { codigo: "xml_invalido" }, L.errores.xml_invalido],
    ["xml_incompleto", 422, { codigo: "xml_incompleto" }, L.errores.xml_incompleto],
    ["xml_existente (P-6)", 409, { codigo: "xml_existente" }, L.errores.xml_existente],
    ["413 por tamaño", 413, null, L.subir.grande],
  ])("%s: muestra el mensaje y el modal queda como estaba", async (_n, status, cuerpo, texto) => {
    const f = instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [SUBIR]: { status, cuerpo },
    });
    const { usuario } = montar();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml());

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    // Nada del cuerpo crudo ni de otro campo.
    expect(alerta.textContent).not.toContain("codigo");
    expect(screen.getByText(L.xml.noDisponible)).toBeTruthy();
    expect(f.de(rutaDetalle(A.id))).toHaveLength(1);
    // Se puede volver a elegir un archivo.
    expect((screen.getByLabelText(L.subir.boton) as HTMLInputElement).disabled).toBe(false);
  });

  it("un archivo de más de 1 MiB no se envía: lo dice el navegador", async () => {
    const f = instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML } });
    const { usuario } = montar();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(
      screen.getByLabelText(L.subir.boton),
      new File([new Uint8Array(TOPE_XML_BYTES + 1)], "grande.xml", { type: "text/xml" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(L.subir.grande);
    expect(f.de(SUBIR)).toHaveLength(0);
  });

  it("un archivo vacío no se envía", async () => {
    const f = instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML } });
    const { usuario } = montar();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml("vacio.xml", ""));
    expect((await screen.findByRole("alert")).textContent).toBe(L.subir.vacio);
    expect(f.de(SUBIR)).toHaveLength(0);
  });

  it("una respuesta 200 que no cumple el esquema no completa nada y da el error genérico", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML },
      [SUBIR]: { status: 200, cuerpo: { cabecera: "roto" } },
    });
    const { usuario } = montar();
    await screen.findByText(L.xml.noDisponible);
    await usuario.upload(screen.getByLabelText(L.subir.boton), archivoXml());
    expect((await screen.findByRole("alert")).textContent).toBe(MENSAJES.errorGeneral);
  });
});

describe("Subir XML en la lupa · dónde se ofrece", () => {
  it("un XML simulado se puede reemplazar (P-6); uno real no ofrece subir", async () => {
    instalar({
      [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A, { xml: { estado: "disponible", origen: "simulado" } }) },
    });
    montar();
    expect(await screen.findByLabelText(L.subir.boton)).toBeTruthy();
    cleanup();
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: detalleLupaDe(A) } });
    montar();
    await screen.findByText(L.xml.real);
    expect(screen.queryByLabelText(L.subir.boton)).toBeNull();
  });

  it("sin permiso de clasificar no hay «Subir XML»; con el cliente archivado queda deshabilitado con el motivo", async () => {
    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML } });
    montar(contextoDe({ permisos: { clasificar: false } }));
    await screen.findByText(L.xml.noDisponible);
    expect(screen.queryByLabelText(L.subir.boton)).toBeNull();
    cleanup();

    instalar({ [rutaDetalle(A.id)]: { status: 200, cuerpo: SIN_XML } });
    montar(contextoDe({ soloLectura: M.soloLectura.clienteArchivado }));
    await screen.findByText(L.xml.noDisponible);
    expect((screen.getByLabelText(L.subir.boton) as HTMLInputElement).disabled).toBe(true);
  });
});

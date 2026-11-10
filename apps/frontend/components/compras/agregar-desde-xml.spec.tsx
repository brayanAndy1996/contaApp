import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_COMPRAS as M, instalarFetchCompras, uuidDe } from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  GLOSA_HOSTIL,
  RUTA_DESDE_XML,
  RUTA_VISTA_PREVIA,
  archivoXml,
  filaDesdeXml,
  vistaPreviaDe,
} from "../../pruebas/lupa-compras";
import { AgregarCompra } from "./agregar-compra";

// Spec 016 · T16 (nivel C; CA-13, D-8, P-9): «Agregar desde XML». Caso feliz (PEN: vista previa, prellenado, solo
// destino, alta con el archivo) y de error (vista previa rechazada, 409 duplicado con enlace) más USD con tipo de
// cambio (viaja en la query) y USD sin él (no se envía). El backend no existe todavía: `fetch` simula el contrato.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(contexto = contextoDe()) {
  const alAgregar = vi.fn();
  const alUbicarExistente = vi.fn();
  const alAvisar = vi.fn();
  render(
    <AgregarCompra
      contexto={contexto}
      alAgregar={alAgregar}
      alCancelar={vi.fn()}
      alUbicarExistente={alUbicarExistente}
      alAvisar={alAvisar}
    />,
  );
  return { contexto, alAgregar, alUbicarExistente, alAvisar, usuario: userEvent.setup() };
}

const consulta = (url: string) => new URL(url, "http://localhost").searchParams;

async function subir(usuario: ReturnType<typeof userEvent.setup>, archivo = archivoXml()) {
  await usuario.upload(screen.getByLabelText(M.subirXml), archivo);
}

describe("Agregar desde XML · caso feliz en PEN (CA-13)", () => {
  it("la vista previa prellena los datos, pide solo el destino y crea la compra enviando el mismo XML", async () => {
    const creada = filaDesdeXml();
    const f = instalarFetchCompras({
      extra: {
        [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: vistaPreviaDe() },
        [RUTA_DESDE_XML]: { status: 201, cuerpo: creada },
      },
    });
    const { contexto, alAgregar, alAvisar, usuario } = montar();

    await subir(usuario, archivoXml("f.xml", "<Invoice>abc</Invoice>"));
    const dialogo = await screen.findByRole("dialog", { name: L.desdeXml.titulo });
    expect(f.de(RUTA_VISTA_PREVIA)[0]!.bytes).toBe("<Invoice>abc</Invoice>".length);

    // Prellenado: comprobante, proveedor, fecha, moneda, montos con formato e ítems (la glosa hostil, como texto).
    expect(within(dialogo).getByText("Factura (01)")).toBeTruthy();
    expect(within(dialogo).getByText("F001-2056")).toBeTruthy();
    expect(within(dialogo).getByText("2026-10-05")).toBeTruthy();
    expect(within(dialogo).getByText("20700000045 · PRUEBA PROVEEDOR MIXTO S.A.C.")).toBeTruthy();
    const montos = within(dialogo).getByRole("table", { name: L.desdeXml.montos });
    expect(within(montos).getByText("8.97")).toBeTruthy();
    expect(within(montos).getByText("12.51")).toBeTruthy();
    expect(within(dialogo).getByText(GLOSA_HOSTIL)).toBeTruthy();
    expect(dialogo.querySelector("script")).toBeNull();
    // En PEN no se pide tipo de cambio.
    expect(within(dialogo).queryByLabelText(L.desdeXml.tipoCambio)).toBeNull();

    await usuario.selectOptions(within(dialogo).getByLabelText(L.desdeXml.destino), "DG");
    await usuario.click(within(dialogo).getByRole("button", { name: L.desdeXml.agregar }));

    await vi.waitFor(() => expect(alAgregar).toHaveBeenCalledWith(creada));
    const alta = f.de(RUTA_DESDE_XML);
    expect(alta).toHaveLength(1);
    expect(consulta(alta[0]!.url).get("destino")).toBe("DG");
    expect(consulta(alta[0]!.url).has("tipoCambio")).toBe(false);
    expect(alta[0]!.bytes).toBe("<Invoice>abc</Invoice>".length);
    expect(contexto.recargarFila).toHaveBeenCalledWith(creada.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(L.desdeXml.agregada, "ok");
  });

  it("sin elegir destino no se envía", async () => {
    const f = instalarFetchCompras({ extra: { [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: vistaPreviaDe() } } });
    const { usuario } = montar();
    await subir(usuario);
    await usuario.click(await screen.findByRole("button", { name: L.desdeXml.agregar }));
    expect((await screen.findByRole("alert")).textContent).toBe(L.desdeXml.destinoObligatorio);
    expect(f.de(RUTA_DESDE_XML)).toHaveLength(0);
  });
});

describe("Agregar desde XML · errores (CA-13, D-3)", () => {
  it.each([
    ["xml_ajeno de otro receptor", 422, { codigo: "xml_ajeno", campos: ["receptor"] }, "El XML no corresponde a este cliente: no coincide el RUC del receptor."],
    ["xml_invalido", 422, { codigo: "xml_invalido" }, L.errores.xml_invalido],
    ["xml_incompleto", 422, { codigo: "xml_incompleto" }, L.errores.xml_incompleto],
    ["413", 413, null, L.subir.grande],
  ])("la vista previa rechaza con %s: lo dice y el formulario manual sigue ahí", async (_n, status, cuerpo, texto) => {
    instalarFetchCompras({ extra: { [RUTA_VISTA_PREVIA]: { status, cuerpo } } });
    const { usuario } = montar();
    await subir(usuario);
    expect((await screen.findByRole("alert")).textContent).toBe(texto);
    expect(screen.queryByRole("dialog", { name: L.desdeXml.titulo })).toBeNull();
    expect(screen.getByRole("button", { name: M.agregar })).toBeTruthy();
  });

  it("un archivo de más de 1 MiB no llega al servidor", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await subir(usuario, new File([new Uint8Array(1024 * 1024 + 1)], "grande.xml", { type: "text/xml" }));
    expect((await screen.findByRole("alert")).textContent).toBe(L.subir.grande);
    expect(f.de(RUTA_VISTA_PREVIA)).toHaveLength(0);
  });

  it("409 duplicado al agregar: avisa «Ya existe en la propuesta» con el enlace a la compra existente", async () => {
    const existente = uuidDe(3, 1);
    instalarFetchCompras({
      extra: {
        [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: vistaPreviaDe() },
        [RUTA_DESDE_XML]: { status: 409, cuerpo: { codigo: "duplicado", id: existente } },
      },
    });
    const { alAgregar, alUbicarExistente, usuario } = montar();
    await subir(usuario);
    await usuario.selectOptions(await screen.findByLabelText(L.desdeXml.destino), "DNG");
    await usuario.click(screen.getByRole("button", { name: L.desdeXml.agregar }));

    expect((await screen.findByRole("alert")).textContent).toContain(M.yaExisteEnPropuesta);
    await usuario.click(screen.getByRole("button", { name: M.ubicarExistente }));
    expect(alUbicarExistente).toHaveBeenCalledWith(existente);
    expect(alAgregar).not.toHaveBeenCalled();
    // Ya no se puede insistir.
    expect((screen.getByRole("button", { name: L.desdeXml.agregar }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("si la vista previa ya dice que existe, ofrece ubicarla y no deja agregar", async () => {
    const existente = uuidDe(3, 2);
    const f = instalarFetchCompras({
      extra: { [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: vistaPreviaDe({ existente: { id: existente } }) } },
    });
    const { alUbicarExistente, usuario } = montar();
    await subir(usuario);
    await usuario.click(await screen.findByRole("button", { name: M.ubicarExistente }));
    expect(alUbicarExistente).toHaveBeenCalledWith(existente);
    expect((screen.getByRole("button", { name: L.desdeXml.agregar }) as HTMLButtonElement).disabled).toBe(true);
    expect(f.de(RUTA_DESDE_XML)).toHaveLength(0);
  });

  it("un error del alta (422 xml_ajeno) se muestra y se puede quitar el XML para volver al formulario", async () => {
    instalarFetchCompras({
      extra: {
        [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: vistaPreviaDe() },
        [RUTA_DESDE_XML]: { status: 422, cuerpo: { codigo: "xml_ajeno", campos: ["receptor"] } },
      },
    });
    const { usuario } = montar();
    await subir(usuario);
    await usuario.selectOptions(await screen.findByLabelText(L.desdeXml.destino), "DG");
    await usuario.click(screen.getByRole("button", { name: L.desdeXml.agregar }));
    expect((await screen.findByRole("alert")).textContent).toContain("RUC del receptor");
    await usuario.click(screen.getByRole("button", { name: L.desdeXml.volver }));
    expect(screen.getByRole("button", { name: M.agregar })).toBeTruthy();
  });
});

describe("Agregar desde XML · USD (P-9)", () => {
  const USD = vistaPreviaDe({
    serie: "F001",
    numero: "4062",
    moneda: "USD",
    montos: { biDg: "0.15", igvDg: "0.03" },
    requiereTipoCambio: true,
  });

  it("pide el tipo de cambio además del destino y lo manda en la query", async () => {
    const f = instalarFetchCompras({
      extra: {
        [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: USD },
        [RUTA_DESDE_XML]: { status: 201, cuerpo: filaDesdeXml({ moneda: "USD", tipoCambio: "3.752", numero: "4062" }) },
      },
    });
    const { alAgregar, usuario } = montar();
    await subir(usuario);
    await usuario.selectOptions(await screen.findByLabelText(L.desdeXml.destino), "DG");
    await usuario.type(screen.getByLabelText(L.desdeXml.tipoCambio), "3.752");
    await usuario.click(screen.getByRole("button", { name: L.desdeXml.agregar }));

    await vi.waitFor(() => expect(alAgregar).toHaveBeenCalledTimes(1));
    const q = consulta(f.de(RUTA_DESDE_XML)[0]!.url);
    expect(q.get("destino")).toBe("DG");
    expect(q.get("tipoCambio")).toBe("3.752");
  });

  it.each([
    ["sin tipo de cambio", "", M.tipoCambioObligatorio],
    ["con tipo de cambio cero", "0.000", L.desdeXml.tipoCambioInvalido],
    ["con 4 decimales", "3.7521", L.desdeXml.tipoCambioInvalido],
    ["con coma decimal", "3,75", L.desdeXml.tipoCambioInvalido],
  ])("USD %s: no se envía", async (_n, valor, mensaje) => {
    const f = instalarFetchCompras({ extra: { [RUTA_VISTA_PREVIA]: { status: 200, cuerpo: USD } } });
    const { usuario } = montar();
    await subir(usuario);
    await usuario.selectOptions(await screen.findByLabelText(L.desdeXml.destino), "DG");
    if (valor !== "") await usuario.type(screen.getByLabelText(L.desdeXml.tipoCambio), valor);
    await usuario.click(screen.getByRole("button", { name: L.desdeXml.agregar }));
    expect((await screen.findByRole("alert")).textContent).toBe(mensaje);
    expect(f.de(RUTA_DESDE_XML)).toHaveLength(0);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { AgregarCompra } from "./agregar-compra";

// Spec 015 · T9 (CA-11, D-11, P-7): agregar una compra a mano.

const AGREGAR = `POST ${BASE}`;

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

/** Escribe en un campo reemplazando su contenido. */
async function escribir(usuario: ReturnType<typeof userEvent.setup>, etiqueta: string, valor: string) {
  const campo = screen.getByLabelText(etiqueta);
  await usuario.clear(campo);
  await usuario.type(campo, valor);
}

async function llenarBasico(usuario: ReturnType<typeof userEvent.setup>) {
  await escribir(usuario, M.campos.serie, "f001");
  await escribir(usuario, M.campos.numero, "9001");
  await escribir(usuario, M.campos.documento, "20100070970");
  await escribir(usuario, M.campos.razonSocial, "PROVEEDOR NUEVO S.A.C.");
  await usuario.type(screen.getByLabelText(M.campos.fecha), "2026-10-20");
  await escribir(usuario, M.casilleros.biDg, "100");
  await escribir(usuario, M.casilleros.igvDg, "18");
}

describe("AgregarCompra · caso feliz (CA-11)", () => {
  it("el total en vivo suma las columnas; envía la compra validada con los montos canónicos y la deja «Agregada»", async () => {
    const creada = filaDe({
      id: uuidDe(3, 1),
      origen: "agregada",
      numero: "9001",
      montos: montosDe({ biDg: "100.00", igvDg: "18.00" }),
    });
    const f = instalarFetchCompras({ extra: { [AGREGAR]: { status: 201, cuerpo: accionDe(creada) } } });
    const { contexto, alAgregar, alAvisar, usuario } = montar();

    await llenarBasico(usuario);
    expect(screen.getByLabelText(M.casilleros.total, { selector: "output" }).textContent).toBe("118.00");
    await usuario.click(screen.getByRole("button", { name: M.agregar }));

    await vi.waitFor(() => expect(alAgregar).toHaveBeenCalledWith(creada));
    expect(f.de(AGREGAR)).toHaveLength(1);
    expect(f.de(AGREGAR)[0]!.body).toEqual({
      tipo: "01",
      serie: "F001",
      numero: "9001",
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR NUEVO S.A.C." },
      fecha: "2026-10-20",
      moneda: "PEN",
      montos: {
        biDg: "100.00",
        igvDg: "18.00",
        biDgng: "0.00",
        igvDgng: "0.00",
        biDng: "0.00",
        igvDng: "0.00",
        noGravado: "0.00",
        isc: "0.00",
        icbper: "0.00",
        otrosTributos: "0.00",
      },
    });
    expect(contexto.recargarFila).toHaveBeenCalledWith(creada.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(M.compraAgregada, "ok");
  });

  it("USD pide el tipo de cambio y lo envía con la compra", async () => {
    const f = instalarFetchCompras({
      extra: { [AGREGAR]: { status: 201, cuerpo: accionDe(filaDe({ origen: "agregada", moneda: "USD", tipoCambio: "3.300" })) } },
    });
    const { usuario } = montar();
    await llenarBasico(usuario);
    await usuario.selectOptions(screen.getByLabelText(M.campos.moneda), "USD");
    await escribir(usuario, M.campos.tipoCambio, "3.300");
    await usuario.click(screen.getByRole("button", { name: M.agregar }));
    await vi.waitFor(() => expect(f.de(AGREGAR)).toHaveLength(1));
    expect(f.de(AGREGAR)[0]!.body).toMatchObject({ moneda: "USD", tipoCambio: "3.300" });
  });
});

describe("AgregarCompra · errores", () => {
  it("USD sin tipo de cambio no se envía y lo explica", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await llenarBasico(usuario);
    await usuario.selectOptions(screen.getByLabelText(M.campos.moneda), "USD");
    await usuario.click(screen.getByRole("button", { name: M.agregar }));
    expect((await screen.findByRole("alert")).textContent).toBe(M.tipoCambioObligatorio);
    expect(f.de(AGREGAR)).toHaveLength(0);
  });

  it("un monto con 3 decimales no se envía: se marca el campo y el total en vivo queda en «—»", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await llenarBasico(usuario);
    await escribir(usuario, M.casilleros.biDg, "100.005");
    expect(screen.getByLabelText(M.casilleros.biDg).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText(M.casilleros.total, { selector: "output" }).textContent).toBe("—");
    await usuario.click(screen.getByRole("button", { name: M.agregar }));
    expect((await screen.findByRole("alert")).textContent).toContain("2 decimales");
    expect(f.de(AGREGAR)).toHaveLength(0);
  });

  it("datos que no calzan con el esquema (sin serie ni fecha) no se envían y nombran los campos", async () => {
    const f = instalarFetchCompras();
    const { usuario } = montar();
    await usuario.click(screen.getByRole("button", { name: M.agregar }));
    const alerta = (await screen.findByRole("alert")).textContent ?? "";
    expect(alerta).toContain(M.datosInvalidos);
    expect(alerta).toContain(M.campos.serie);
    expect(alerta).toContain(M.campos.fecha);
    expect(f.de(AGREGAR)).toHaveLength(0);
  });

  it("409 duplicado: avisa «Ya existe en la propuesta» con un enlace que ubica la compra existente", async () => {
    const existente = uuidDe(1, 1040);
    instalarFetchCompras({
      extra: { [AGREGAR]: { status: 409, cuerpo: { codigo: "duplicado", id: existente } } },
    });
    const { alUbicarExistente, alAgregar, usuario } = montar();
    await llenarBasico(usuario);
    await usuario.click(screen.getByRole("button", { name: M.agregar }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.yaExisteEnPropuesta);
    await usuario.click(screen.getByRole("button", { name: M.ubicarExistente }));
    expect(alUbicarExistente).toHaveBeenCalledWith(existente);
    expect(alAgregar).not.toHaveBeenCalled();
  });
});

describe("AgregarCompra · «Subir XML» y permisos", () => {
  it("«Subir XML» ya está disponible (016): ofrece elegir el archivo", () => {
    instalarFetchCompras();
    montar();
    const campo = screen.getByLabelText(M.subirXml) as HTMLInputElement;
    expect(campo.type).toBe("file");
    expect(campo.disabled).toBe(false);
  });

  it("en solo lectura no hay formulario: solo la explicación", () => {
    instalarFetchCompras();
    montar(contextoDe({ estado: "generado", soloLectura: M.soloLectura.generado }));
    expect(screen.getByText(M.soloLectura.generado)).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.agregar })).toBeNull();
  });
});

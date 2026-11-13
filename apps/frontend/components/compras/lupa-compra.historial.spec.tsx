import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import { MENSAJES_LUPA as L } from "../../lib/lupa-compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  accionDe,
  detalleDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
  versionOriginalDe,
} from "../../pruebas/compras";
import { detalleLupaDe, rutaDetalle } from "../../pruebas/lupa-compras";
import type { Manejador } from "../../pruebas/soporte";
import {
  MENSAJES_REGLAS as R,
  mencionaDestino,
  RUTA_RECORDAR,
  contextoConReglas,
  reglaDe,
  type ContextoReglasPrueba,
} from "../../pruebas/reglas";
import { LupaCompra } from "./lupa-compra";

// Spec 021 · T6 (rojo; CA-1, CA-2, CA-3, P-3). «Según historial» y «Recordar» en la lupa de 016. Contrato (T14):
//   - La cabecera de la lupa muestra el texto «Según historial» si la fila tiene `segunHistorial`; si no, nada.
//   - El historial de versiones nombra la versión `historial` como «Según historial» (`accionesVersion.historial`).
//   - Se habilita el botón «Recordar para este proveedor» (016 P-8 lo dejó fuera): visible solo con
//     `permisos.gestionarReglas` y con la fila clasificada; al pulsarlo aparece el aviso (role status) con el destino
//     vigente de la fila y se acepta como en la grilla (botón «Recordar» o Alt+R).
//   - Clasificar desde el menú de la lupa ofrece el mismo aviso con el destino elegido.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clasificarRuta = (id: string) => `POST ${BASE}/${id}/clasificar`;

function Montar({
  filas,
  contexto,
  alAvisar,
}: {
  filas: readonly FilaCompraVista[];
  contexto: ContextoReglasPrueba;
  alAvisar: () => void;
}) {
  const [id, setId] = useState(filas[0]!.id);
  return (
    <LupaCompra
      contexto={contexto}
      filas={filas}
      orden={filas.map((f) => f.id)}
      compraId={id}
      alCambiar={setId}
      alCerrar={vi.fn()}
      alAvisarDe={() => alAvisar}
    />
  );
}

function montar(
  fila: FilaCompraVista,
  contexto: ContextoReglasPrueba,
  extra: Record<string, Manejador> = {},
) {
  const f = instalarFetchCompras({
    extra: {
      [rutaDetalle(fila.id)]: { status: 200, cuerpo: detalleLupaDe(fila) },
      [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ proveedor: fila.proveedor }) },
      ...extra,
    },
  });
  const alAvisar = vi.fn();
  render(<Montar filas={[fila]} contexto={contexto} alAvisar={alAvisar} />);
  return { f, alAvisar, usuario: userEvent.setup() };
}

const cabecera = () => screen.findByRole("region", { name: L.secciones.cabecera });
const botonRecordarProveedor = () => screen.queryByRole("button", { name: R.recordarProveedor }) as HTMLButtonElement | null;

describe("Lupa · «Según historial» (CA-2, CA-3)", () => {
  it("la fila de R-HIS muestra la etiqueta de texto; una fila normal no", async () => {
    const historial = filaDe({
      id: uuidDe(3, 31),
      numero: "9001",
      version: 2,
      montos: montosDe({ biDng: "100.00", igvDng: "18.00" }),
      segunHistorial: { reglaId: uuidDe(7, 1) },
    });
    montar(historial, contextoConReglas());
    await cabecera();
    const dialogo = screen.getByRole("dialog", { name: L.tituloModal("F001-9001") });
    expect(within(dialogo).getByText(R.segunHistorial)).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    montar(filaDe({ id: uuidDe(3, 32), numero: "9002" }), contextoConReglas());
    await cabecera();
    expect(screen.queryByText(R.segunHistorial)).toBeNull();
  });

  it("el historial de versiones nombra la versión 2 del worker como «Según historial»", async () => {
    const original = filaDe({ id: uuidDe(3, 33), numero: "9003", clasificada: false, proveedorNuevo: true });
    const vigente = filaDe({
      ...original,
      version: 2,
      clasificada: true,
      montos: montosDe({ biDng: "100.00", igvDng: "18.00" }),
      segunHistorial: { reglaId: uuidDe(7, 1) },
    });
    const v1 = versionOriginalDe(original);
    const detalle = {
      ...detalleDe(vigente),
      original: v1,
      versiones: [v1, { ...v1, n: 2, accion: "historial", clasificada: true, montos: vigente.montos }],
    };
    const { usuario } = montar(vigente, contextoConReglas(), {
      [`GET ${BASE}/${vigente.id}`]: { status: 200, cuerpo: detalle },
    });
    await cabecera();

    await usuario.click(screen.getByRole("button", { name: L.historial }));

    const versiones = await screen.findByRole("region", { name: M.versiones });
    expect(versiones.textContent).toContain(R.segunHistorial);
    expect(versiones.textContent).not.toContain("undefined");
  });
});

describe("Lupa · «Recordar para este proveedor» (CA-1, 016 P-8)", () => {
  const CLASIFICADA = filaDe({ id: uuidDe(3, 41), numero: "9101", montos: montosDe({ biDg: "100.00", igvDg: "18.00" }) });

  it("feliz: el botón ofrece el aviso con el destino vigente y «Recordar» crea la regla", async () => {
    const contexto = contextoConReglas();
    const { f, usuario, alAvisar } = montar(CLASIFICADA, contexto);
    await cabecera();
    expect(screen.queryByRole("status")).toBeNull();

    await usuario.click(botonRecordarProveedor()!);

    const aviso = await screen.findByRole("status");
    expect(aviso.textContent).toContain(R.pregunta);
    expect(mencionaDestino(aviso.textContent, "DG")).toBe(true);
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);

    await usuario.click(screen.getByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [CLASIFICADA.id], destino: "DG", versionBase: null });
    await vi.waitFor(() => expect(contexto.reglas.recargar).toHaveBeenCalledTimes(1));
    expect(alAvisar).toHaveBeenCalledWith(R.recordada, "ok");
  });

  it("sin reglas.gestionar el botón no se ofrece y la lupa sigue igual (control: con el permiso está)", async () => {
    montar(CLASIFICADA, contextoConReglas());
    await cabecera();
    expect(botonRecordarProveedor()).not.toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    montar(CLASIFICADA, contextoConReglas([], { gestionar: false }));
    await cabecera();

    expect(botonRecordarProveedor()).toBeNull();
    expect(screen.getByRole("button", { name: L.historial })).toBeTruthy();
  });

  it("con la fila por clasificar no hay destino que recordar: el botón no está o está deshabilitado (control: clasificada, habilitado)", async () => {
    montar(CLASIFICADA, contextoConReglas());
    await cabecera();
    expect(botonRecordarProveedor()?.disabled).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    montar(C_3064_BOLSAS, contextoConReglas());
    await cabecera();

    const boton = botonRecordarProveedor();
    expect(boton === null || boton.disabled).toBe(true);
  });

  it("clasificar desde el menú de la lupa ofrece «Recordar» con el destino elegido; Alt+R lo acepta", async () => {
    const contexto = contextoConReglas();
    const nueva = filaDe({ ...C_3064_BOLSAS, version: 2, clasificada: true, montos: montosDe({ biDgng: "100.00", igvDgng: "18.00", icbper: "1.50" }) });
    const { f, usuario } = montar(C_3064_BOLSAS, contexto, {
      [clasificarRuta(C_3064_BOLSAS.id)]: { status: 200, cuerpo: accionDe(nueva) },
    });
    await cabecera();

    await usuario.click(screen.getByRole("button", { name: `${M.columnas.acciones} F001-3064` }));
    await usuario.click(screen.getByRole("menuitem", { name: M.clasificarComo("DGNG") }));

    const aviso = await screen.findByRole("status");
    expect(mencionaDestino(aviso.textContent, "DGNG")).toBe(true);
    expect(aviso.contains(document.activeElement)).toBe(false);

    await usuario.keyboard("{Alt>}r{/Alt}");

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [C_3064_BOLSAS.id], destino: "DGNG", versionBase: null });
  });
});

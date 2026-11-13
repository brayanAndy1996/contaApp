import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import {
  FILTROS_INICIALES,
  MENSAJES_COMPRAS as M,
  consultaDeListado,
  type FiltrosCompras,
} from "../../lib/compras";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_3064_BOLSAS,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
  type OpcionesCompras,
} from "../../pruebas/compras";
import {
  MENSAJES_REGLAS as R,
  mencionaDestino,
  RUTA_RECORDAR,
  contextoConReglas,
  reglaDe,
  type ContextoReglasPrueba,
} from "../../pruebas/reglas";
import { AccionesFilaCompras } from "./acciones-fila-compras";
import { FiltrosListado } from "./filtros-compras";
import { GrillaCompras } from "./grilla-compras";

// Spec 021 · T6 (rojo; CA-1, CA-3, P-3). «Según historial» y «Recordar» en la grilla de 015. La grilla recibe la
// celda de acciones por `renderAcciones` (aquí, el menú real de 015, `AccionesFilaCompras`), así que el aviso nace al
// terminar de clasificar con ese menú, igual que en la lupa. Contrato (T14), además de lo de `recordar-proveedor.spec`:
//   - La fila con `segunHistorial` muestra la etiqueta de texto «Según historial» (no solo color); sin él, no.
//   - FiltrosCompras suma `segunHistorial: boolean` (FILTROS_INICIALES lo trae en false); FiltrosListado pinta el
//     checkbox «Según historial» y `consultaDeListado` manda `segunHistorial=true` solo si está marcado.
//   - Tras clasificar OK en la fila, si `contexto.permisos.gestionarReglas` y no hay una regla activa del proveedor
//     con ese destino en `contexto.reglas.lista`, aparece el aviso (role status). Alt+R lo acepta con el foco en la
//     celda. Tras crear la regla se llama a `contexto.reglas.recargar()`.

const ANCHO_VENTANA = 1400;
const ALTO_VENTANA = 480;

beforeEach(() => {
  reiniciarSesion();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(ANCHO_VENTANA);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(ALTO_VENTANA);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clasificarRuta = (id: string) => `POST ${BASE}/${id}/clasificar`;
const REGLA_ID = uuidDe(7, 1);

/** Fila ya clasificada en DNG por R-HIS (versión 2, «historial»), con la regla DNG del proveedor por omisión. */
const HISTORIAL = filaDe({
  id: uuidDe(3, 21),
  numero: "8001",
  version: 2,
  montos: montosDe({ biDng: "100.00", igvDng: "18.00" }),
  segunHistorial: { reglaId: REGLA_ID },
});
const NORMAL = filaDe({ id: uuidDe(3, 22), numero: "8002", montos: montosDe({ biDg: "50.00", igvDg: "9.00" }) });

function montar(
  filas: readonly FilaCompraVista[],
  contexto: ContextoReglasPrueba,
  extra: NonNullable<OpcionesCompras["extra"]> = {},
) {
  const f = instalarFetchCompras({ extra });
  const alAvisar = vi.fn();
  const dibujar = (lista: readonly FilaCompraVista[]) => (
    <GrillaCompras
      filas={lista}
      cargando={false}
      seleccion={new Set<string>()}
      alCambiarSeleccion={vi.fn()}
      alAbrirHistorial={vi.fn()}
      renderAcciones={(fila) => <AccionesFilaCompras contexto={contexto} fila={fila} alAvisar={alAvisar} />}
    />
  );
  const resultado = render(dibujar(filas));
  return { f, alAvisar, contexto, usuario: userEvent.setup(), rerender: (lista: readonly FilaCompraVista[]) => resultado.rerender(dibujar(lista)) };
}

const filaDeComprobante = (numero: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>("[data-fila]")].find((x) => x.textContent?.includes(`F001-${numero}`))!;

/** Clasifica F001-3064 como DNG con el menú de la fila (la respuesta del servidor es la fila ya clasificada). */
async function clasificarBolsas(contexto: ContextoReglasPrueba) {
  const nueva = filaDe({ ...C_3064_BOLSAS, version: 2, clasificada: true, montos: montosDe({ biDng: "100.00", igvDng: "18.00" }) });
  const escenario = montar([C_3064_BOLSAS], contexto, {
    [clasificarRuta(C_3064_BOLSAS.id)]: { status: 200, cuerpo: accionDe(nueva) },
    [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ proveedor: C_3064_BOLSAS.proveedor }) },
  });
  await clasificar(escenario.usuario, "F001-3064", "DNG");
  await vi.waitFor(() => expect(escenario.alAvisar).toHaveBeenCalledWith(M.compraClasificada, "ok"));
  return escenario;
}

async function clasificar(
  usuario: ReturnType<typeof userEvent.setup>,
  comprobante: string,
  destino: "DG" | "DGNG" | "DNG",
) {
  await usuario.click(await screen.findByRole("button", { name: `${M.columnas.acciones} ${comprobante}` }));
  await usuario.click(screen.getByRole("menuitem", { name: M.clasificarComo(destino) }));
}

describe("Grilla · etiqueta y filtro «Según historial» (CA-2, CA-3)", () => {
  it("la etiqueta es texto en la fila de R-HIS y solo ahí; al corregirla (nueva versión sin segunHistorial) desaparece", () => {
    const { rerender } = montar([HISTORIAL, NORMAL], contextoConReglas());

    expect(within(filaDeComprobante("8001")).getByText(R.segunHistorial)).toBeTruthy();
    expect(within(filaDeComprobante("8002")).queryByText(R.segunHistorial)).toBeNull();

    rerender([filaDe({ ...HISTORIAL, version: 3, segunHistorial: null }), NORMAL]);
    expect(screen.queryByText(R.segunHistorial)).toBeNull();
  });

  it("el filtro «Según historial» sube el filtro completo y la consulta lo manda solo cuando está marcado", async () => {
    const alCambiar = vi.fn();
    function Arnes() {
      const [filtros, setFiltros] = useState<FiltrosCompras>(FILTROS_INICIALES);
      return (
        <FiltrosListado
          filtros={filtros}
          retardoMs={20}
          alCambiar={(nuevo) => {
            alCambiar(nuevo);
            setFiltros(nuevo);
          }}
        />
      );
    }
    render(<Arnes />);
    const usuario = userEvent.setup();

    expect(FILTROS_INICIALES).toMatchObject({ segunHistorial: false });
    expect(consultaDeListado(FILTROS_INICIALES)).not.toContain("segunHistorial");

    await usuario.click(screen.getByRole("checkbox", { name: R.segunHistorial }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...FILTROS_INICIALES, segunHistorial: true });
    expect(new URLSearchParams(consultaDeListado({ ...FILTROS_INICIALES, segunHistorial: true })).get("segunHistorial")).toBe("true");

    await usuario.click(screen.getByRole("checkbox", { name: R.segunHistorial }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...FILTROS_INICIALES, segunHistorial: false });
    expect(consultaDeListado({ ...FILTROS_INICIALES, segunHistorial: false })).not.toContain("segunHistorial");
  });
});

describe("Grilla · «Recordar» tras clasificar (CA-1)", () => {
  it("feliz: aparece sin quitar el foco de la fila; Alt+R crea la regla con ese destino y el foco sigue en la celda", async () => {
    const contexto = contextoConReglas();
    const nueva = filaDe({ ...C_3064_BOLSAS, version: 2, clasificada: true, montos: montosDe({ biDng: "100.00", igvDng: "18.00", icbper: "1.50" }) });
    const { f, usuario, alAvisar } = montar([C_3064_BOLSAS], contexto, {
      [clasificarRuta(C_3064_BOLSAS.id)]: { status: 200, cuerpo: accionDe(nueva) },
      [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ proveedor: C_3064_BOLSAS.proveedor }) },
    });
    // Sin aviso antes de clasificar.
    expect(screen.queryByRole("status")).toBeNull();

    await clasificar(usuario, "F001-3064", "DNG");

    const aviso = await screen.findByRole("status");
    expect(aviso.getAttribute("aria-live")).toBe("polite");
    expect(aviso.textContent).toContain(R.pregunta);
    expect(mencionaDestino(aviso.textContent, "DNG")).toBe(true);
    const fila = filaDeComprobante("3064");
    const foco = document.activeElement;
    expect(fila.contains(foco)).toBe(true);
    expect(aviso.contains(foco)).toBe(false);
    // Todavía no se creó nada: es una oferta.
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);

    await usuario.keyboard("{Alt>}r{/Alt}");

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [C_3064_BOLSAS.id], destino: "DNG", versionBase: null });
    await vi.waitFor(() => expect(contexto.reglas.recargar).toHaveBeenCalledTimes(1));
    expect(alAvisar).toHaveBeenCalledWith(R.recordada, "ok");
    expect(document.activeElement).toBe(foco);
    expect(fila.contains(document.activeElement)).toBe(true);
  });

  it("sin reglas.gestionar no se ofrece: la clasificación sigue y no hay aviso ni ruta de reglas (control: con el permiso sí)", async () => {
    // Control: con el permiso el aviso aparece tras la misma clasificación.
    await clasificarBolsas(contextoConReglas());
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const { f, usuario } = await clasificarBolsas(contextoConReglas([], { gestionar: false }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
    await usuario.keyboard("{Alt>}r{/Alt}");
    expect(f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);
  });

  it("si ya hay una regla activa del proveedor con ese destino no se ofrece (control: con otro destino sí)", async () => {
    await clasificarBolsas(contextoConReglas([reglaDe({ proveedor: C_3064_BOLSAS.proveedor, destino: "DG" })]));
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const { f } = await clasificarBolsas(contextoConReglas([reglaDe({ proveedor: C_3064_BOLSAS.proveedor, destino: "DNG" })]));

    expect(screen.queryByRole("status")).toBeNull();
    expect(f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);
  });

  it("si la clasificación falla (409) no hay aviso (control: si sale bien, sí)", async () => {
    await clasificarBolsas(contextoConReglas());
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const { usuario, f } = montar([C_3064_BOLSAS], contextoConReglas(), {
      [clasificarRuta(C_3064_BOLSAS.id)]: { status: 409, cuerpo: { codigo: "version_obsoleta", versionVigente: 3 } },
    });

    await clasificar(usuario, "F001-3064", "DNG");

    // El error lo anuncia la pantalla (`alAvisar`); la fila solo lo muestra (018, P-2).
    expect(await screen.findByText(M.versionObsoleta)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);
  });
});

describe("Grilla · corregir una fila «Según historial» (P-3, CA-12)", () => {
  it("clasificar de nuevo ofrece «Recordar» con el destino nuevo y la regla no cambia sola; al aceptar manda la versión de la regla", async () => {
    // La regla DNG (versión 3) movió la fila a DNG; el contador la corrige a DG.
    const regla = reglaDe({ id: REGLA_ID, destino: "DNG", version: 3 });
    const contexto = contextoConReglas([regla]);
    const corregida = filaDe({ ...HISTORIAL, version: 3, segunHistorial: null, montos: montosDe({ biDg: "100.00", igvDg: "18.00" }) });
    const { f, usuario } = montar([HISTORIAL], contexto, {
      [clasificarRuta(HISTORIAL.id)]: { status: 200, cuerpo: accionDe(corregida) },
      [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ id: REGLA_ID, destino: "DG", version: 4 }) },
    });

    await clasificar(usuario, "F001-8001", "DG");

    const aviso = await screen.findByRole("status");
    expect(aviso.textContent).toContain(R.pregunta);
    expect(mencionaDestino(aviso.textContent, "DG")).toBe(true);
    // La regla no cambió sola: ni PATCH ni recordar hasta que el contador acepte.
    expect(f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);
    expect(contexto.reglas.recargar).not.toHaveBeenCalled();

    await usuario.click(screen.getByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toEqual({ compraIds: [HISTORIAL.id], destino: "DG", versionBase: 3 });
  });
});

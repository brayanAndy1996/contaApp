import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  MENSAJES_COMPRAS as M,
  filaDe,
  instalarFetchCompras,
  montosDe,
  uuidDe,
} from "../../pruebas/compras";
import {
  MENSAJES_REGLAS as R,
  mencionaDestino,
  RUTA_RECORDAR,
  contextoConReglas,
  reglaDe,
  type ContextoReglasPrueba,
} from "../../pruebas/reglas";
import { BarraMasiva } from "./barra-masiva";

// Spec 021 · T6 (rojo; P-2, P-3, CA-3). «Recordar» tras la clasificación masiva de 015. Contrato (T14):
//   - Se ofrece UN aviso (role status; `RecordarProveedor`) solo cuando TODAS las filas seleccionadas son del mismo
//     proveedor (tipo + número), la masiva clasificó al menos una, el usuario tiene `permisos.gestionarReglas` y no
//     hay ya una regla activa de ese proveedor con ese destino en `contexto.reglas.lista`.
//   - Con proveedores mezclados no se ofrece nada y no se llama a ninguna ruta de reglas.
//   - compraIds = las filas seleccionadas que la masiva aplicó (no las rechazadas). Alt+R o el botón lo aceptan.
//   - Sobre filas «Según historial» (CA-3) la masiva funciona igual que sobre cualquier fila.

const OP = uuidDe(9, 1);
const RUTA_CLASIFICAR = `POST ${BASE}/masivas/clasificar`;
const PROVEEDOR_X = { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR X S.A.C." };
const PROVEEDOR_Y = { tipo: "6", numero: "20555555551", razonSocial: "PROVEEDOR Y S.A.C." };

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const de = (n: number, proveedor = PROVEEDOR_X, parcial: Partial<FilaCompraVista> = {}) =>
  filaDe({
    id: uuidDe(6, n),
    serie: "F001",
    numero: String(300 + n),
    version: n,
    proveedor,
    montos: montosDe({ biDg: "100.00", igvDg: "18.00" }),
    ...parcial,
  });

function montar(
  filas: readonly FilaCompraVista[],
  contexto: ContextoReglasPrueba,
  respuesta: { aplicadas: number; rechazadas?: { compraId: string; codigo: string }[] },
) {
  const f = instalarFetchCompras({
    extra: {
      [RUTA_CLASIFICAR]: { status: 200, cuerpo: { operacionId: OP, aplicadas: respuesta.aplicadas, rechazadas: respuesta.rechazadas ?? [] } },
      [RUTA_RECORDAR]: { status: 200, cuerpo: reglaDe({ proveedor: PROVEEDOR_X }) },
    },
  });
  const alAvisar = vi.fn();
  render(
    <BarraMasiva
      contexto={contexto}
      filas={filas}
      seleccion={new Set(filas.map((x) => x.id))}
      alAvisar={alAvisar}
      alOperacion={vi.fn()}
      alLimpiarSeleccion={vi.fn()}
    />,
  );
  return { f, alAvisar, usuario: userEvent.setup() };
}

const clasificarComo = (usuario: ReturnType<typeof userEvent.setup>, destino: "DG" | "DGNG" | "DNG") =>
  usuario.click(screen.getByRole("button", { name: M.clasificarComo(destino) }));

describe("Masiva · «Recordar» con un solo proveedor (P-2)", () => {
  it("feliz: tres filas del mismo proveedor → un aviso con el destino; aceptar manda las tres y recarga las reglas", async () => {
    const filas = [de(1), de(2), de(3)];
    const contexto = contextoConReglas();
    const { f, usuario, alAvisar } = montar(filas, contexto, { aplicadas: 3 });
    expect(screen.queryByRole("status")).toBeNull();

    await clasificarComo(usuario, "DNG");

    const aviso = await screen.findByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(aviso.textContent).toContain(R.pregunta);
    expect(mencionaDestino(aviso.textContent, "DNG")).toBe(true);
    expect(f.de(RUTA_RECORDAR)).toHaveLength(0);

    await usuario.click(screen.getByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    const cuerpo = f.de(RUTA_RECORDAR)[0]!.body as { compraIds: string[]; destino: string; versionBase: number | null };
    expect([...cuerpo.compraIds].sort()).toEqual(filas.map((x) => x.id).sort());
    expect(cuerpo.destino).toBe("DNG");
    expect(cuerpo.versionBase).toBeNull();
    await vi.waitFor(() => expect(contexto.reglas.recargar).toHaveBeenCalledTimes(1));
    expect(alAvisar).toHaveBeenCalledWith(R.recordada, "ok");
  });

  it("proveedores mezclados: no se ofrece, ni aviso ni atajo ni ruta de reglas (control: del mismo proveedor sí)", async () => {
    const control = montar([de(1), de(2)], contextoConReglas(), { aplicadas: 2 });
    await clasificarComo(control.usuario, "DNG");
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const { f, usuario, alAvisar } = montar([de(1), de(2, PROVEEDOR_Y)], contextoConReglas(), { aplicadas: 2 });

    await clasificarComo(usuario, "DNG");
    await vi.waitFor(() => expect(alAvisar).toHaveBeenCalled());

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: R.recordar })).toBeNull();
    await usuario.keyboard("{Alt>}r{/Alt}");
    expect(f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);
  });

  it("sin reglas.gestionar o con una regla activa del proveedor en ese destino no se ofrece (control: con el permiso y sin regla sí)", async () => {
    const control = montar([de(1), de(2)], contextoConReglas(), { aplicadas: 2 });
    await clasificarComo(control.usuario, "DNG");
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const sinPermiso = montar([de(1), de(2)], contextoConReglas([], { gestionar: false }), { aplicadas: 2 });
    await clasificarComo(sinPermiso.usuario, "DNG");
    await vi.waitFor(() => expect(sinPermiso.alAvisar).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    const conRegla = montar([de(1), de(2)], contextoConReglas([reglaDe({ proveedor: PROVEEDOR_X, destino: "DNG" })]), { aplicadas: 2 });
    await clasificarComo(conRegla.usuario, "DNG");
    await vi.waitFor(() => expect(conRegla.alAvisar).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    expect(conRegla.f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);
  });

  it("con rechazadas, «Recordar» manda solo las filas que la masiva aplicó", async () => {
    const filas = [de(1), de(2), de(3)];
    const rechazada = filas[2]!;
    const { f, usuario } = montar(filas, contextoConReglas(), {
      aplicadas: 2,
      rechazadas: [{ compraId: rechazada.id, codigo: "version_obsoleta" }],
    });

    await clasificarComo(usuario, "DGNG");

    const aviso = await screen.findByRole("status");
    expect(mencionaDestino(aviso.textContent, "DGNG")).toBe(true);
    await usuario.click(screen.getByRole("button", { name: R.recordar }));

    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    const cuerpo = f.de(RUTA_RECORDAR)[0]!.body as { compraIds: string[]; destino: string };
    expect([...cuerpo.compraIds].sort()).toEqual([filas[0]!.id, filas[1]!.id].sort());
    expect(cuerpo.compraIds).not.toContain(rechazada.id);
    expect(cuerpo.destino).toBe("DGNG");
  });

  it("si la masiva no aplicó ninguna fila no hay nada que recordar (control: aplicada, sí)", async () => {
    const control = montar([de(1), de(2)], contextoConReglas(), { aplicadas: 2 });
    await clasificarComo(control.usuario, "DNG");
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const filas = [de(1), de(2)];
    const { usuario, alAvisar } = montar(filas, contextoConReglas(), {
      aplicadas: 0,
      rechazadas: filas.map((x) => ({ compraId: x.id, codigo: "version_obsoleta" })),
    });

    await clasificarComo(usuario, "DNG");
    await screen.findByRole("dialog");
    expect(alAvisar).toHaveBeenCalled();

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Masiva · sobre filas «Según historial» (CA-3, P-3)", () => {
  it("clasifica en masa las filas de R-HIS con su versionBase y ofrece «Recordar» con el destino nuevo y la versión de la regla", async () => {
    const reglaId = uuidDe(7, 1);
    const filas = [1, 2, 3].map((n) =>
      de(n, PROVEEDOR_X, {
        version: 2,
        montos: montosDe({ biDng: "100.00", igvDng: "18.00" }),
        segunHistorial: { reglaId },
      }),
    );
    const contexto = contextoConReglas([reglaDe({ id: reglaId, proveedor: PROVEEDOR_X, destino: "DNG", version: 6 })]);
    const { f, usuario } = montar(filas, contexto, { aplicadas: 3 });

    await clasificarComo(usuario, "DG");

    const cuerpo = f.de(RUTA_CLASIFICAR)[0]!.body as { items: { compraId: string; versionBase: number }[]; destino: string };
    expect(cuerpo.destino).toBe("DG");
    expect(cuerpo.items.map((x) => x.versionBase)).toEqual([2, 2, 2]);
    expect(contexto.recargarFilas).toHaveBeenCalledTimes(1);

    const aviso = await screen.findByRole("status");
    expect(mencionaDestino(aviso.textContent, "DG")).toBe(true);
    // La regla DNG no cambia sola.
    expect(f.llamadas.filter((l) => l.ruta.includes("/reglas"))).toHaveLength(0);

    await usuario.click(screen.getByRole("button", { name: R.recordar }));
    await vi.waitFor(() => expect(f.de(RUTA_RECORDAR)).toHaveLength(1));
    expect(f.de(RUTA_RECORDAR)[0]!.body).toMatchObject({ destino: "DG", versionBase: 6 });
  });
});

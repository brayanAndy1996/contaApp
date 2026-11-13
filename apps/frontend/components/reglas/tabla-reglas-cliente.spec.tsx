import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReglaVista } from "@contapp/shared";
import { MENSAJES } from "../../lib/acceso";
import { fechaHoraLima } from "../../lib/fechas";
import { reiniciarSesion } from "../../lib/sesion";
import { celdas, esperarFila, rutaSesion, yoDe } from "../../pruebas/acceso";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import {
  MENSAJES_REGLAS as R,
  RUTA_LISTA_REGLAS,
  reglaDe,
  rutaRegla,
} from "../../pruebas/reglas";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { TablaReglasCliente } from "./tabla-reglas-cliente";

// Spec 021 · T6 (rojo; CA-7, 409 de D-5). Pantalla de reglas del cliente.
// Contrato (T13), `components/reglas/tabla-reglas-cliente.tsx`: <TablaReglasCliente clienteId="c-1" />, sin más props.
//   - Lee GET /api/clientes/:id/reglas (ReglaVista[]) y GET /api/acceso/yo; las acciones solo con `reglas.gestionar`.
//   - role="table" con encabezados Proveedor, Destino, Estado, Aplicada, Aceptada, Actualizada (+ acciones).
//   - Editar: botón «Editar regla de <RUC>» abre un combobox «Destino» (DG, DGNG, DNG) y «Guardar» →
//     PATCH …/reglas/:reglaId {versionBase: version, destino}. Desactivar/Activar → PATCH {versionBase, activa}.
//   - Eliminar: «Eliminar regla de <RUC>» abre `ConfirmarAccion` (alertdialog; «Confirmar» / «Cancelar»); solo al
//     confirmar → DELETE …/reglas/:reglaId?versionBase=n (204) y la fila desaparece.
//   - 409 regla_cambiada → alerta con `MENSAJES_REGLAS.reglaCambiada` y la lista se vuelve a leer.
//   - La razón social viene del SIRE y se ve como texto. La fecha se muestra en hora de Lima (fechaHoraLima).
// El contador gestiona; el asistente solo ve.

const A = reglaDe({
  id: uuidDe(7, 1),
  destino: "DNG",
  version: 3,
  aplicada: 7,
  aceptada: 4,
  actualizadaEn: "2026-11-13T02:30:00.000Z", // 12/11 9:30 p. m. en Lima; 13/11 en UTC
});
const B = reglaDe({
  id: uuidDe(7, 2),
  proveedor: { tipo: "6", numero: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
  destino: "DG",
  activa: false,
  version: 2,
  aplicada: 0,
  aceptada: 0,
});
const RUC_A = A.proveedor.numero;
const RUC_B = B.proveedor.numero;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function instalar(
  lista: unknown,
  opciones: { permisos?: string[]; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", opciones.permisos ?? ["clientes.ver", "reglas.ver", "reglas.gestionar"]),
    },
    [RUTA_LISTA_REGLAS]: { status: 200, cuerpo: lista },
    ...opciones.extra,
  });
}

const montar = () => {
  render(<TablaReglasCliente clienteId="c-1" />);
  return userEvent.setup();
};

describe("<TablaReglasCliente /> · lectura (CA-7)", () => {
  it("feliz: proveedor, destino, estado, veces aplicada y aceptada y fecha en hora de Lima", async () => {
    instalar([A, B]);
    montar();

    const fa = await esperarFila(RUC_A);
    const tabla = screen.getByRole("table");
    for (const nombre of Object.values(R.columnas)) {
      expect(within(tabla).getByRole("columnheader", { name: nombre })).toBeTruthy();
    }
    expect(fa.textContent).toContain("PROVEEDOR PRUEBA S.A.C.");
    const celdasA = celdas(fa);
    expect(celdasA).toContain("DNG");
    expect(celdasA).toContain(R.activa);
    expect(celdasA).toContain("7");
    expect(celdasA).toContain("4");
    // Hora de Lima, no UTC: 02:30 UTC del 13 es 9:30 p. m. del 12.
    expect(fa.textContent).toContain(fechaHoraLima(A.actualizadaEn));
    expect(fa.textContent).toMatch(/12\/11\/26,? 9:30\s?p\.\s?m\./);

    const fb = await esperarFila(RUC_B);
    expect(celdas(fb)).toContain("DG");
    expect(celdas(fb)).toContain(R.inactiva);
    expect(celdas(fb)).not.toContain(R.activa);
  });

  it("la razón social del SIRE se ve como texto, sin interpretarse", async () => {
    instalar([reglaDe({ proveedor: { tipo: "6", numero: RUC_A, razonSocial: TEXTO_HOSTIL } })]);
    const { container } = render(<TablaReglasCliente clienteId="c-1" />);

    expect(await screen.findByText(TEXTO_HOSTIL, { exact: false })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });

  it("sin reglas muestra el mensaje y sin tabla de filas", async () => {
    instalar([]);
    montar();
    expect(await screen.findByText(R.sinReglas)).toBeTruthy();
  });

  it("error: un 403 de la lectura muestra el mensaje genérico", async () => {
    instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("lectura", ["clientes.ver"]) },
      [RUTA_LISTA_REGLAS]: { status: 403, cuerpo: { codigo: "sin_permiso" } },
    });
    montar();
    expect((await screen.findByRole("alert")).textContent).toBe(MENSAJES.sinPermiso);
  });

  it("sin reglas.gestionar se ven las reglas pero no hay editar, activar, desactivar ni eliminar", async () => {
    instalar([A, B], { permisos: ["clientes.ver", "reglas.ver"] });
    montar();

    await esperarFila(RUC_A);
    expect(screen.queryByRole("button", { name: R.editar(RUC_A) })).toBeNull();
    expect(screen.queryByRole("button", { name: R.desactivar(RUC_A) })).toBeNull();
    expect(screen.queryByRole("button", { name: R.activar(RUC_B) })).toBeNull();
    expect(screen.queryByRole("button", { name: R.eliminar(RUC_A) })).toBeNull();
  });
});

describe("<TablaReglasCliente /> · editar, desactivar y activar", () => {
  it("editar el destino manda la versión vista; la fila refleja la respuesta y la siguiente acción usa la versión nueva", async () => {
    const f = instalar([A, B], {
      extra: {
        [rutaRegla("PATCH", A.id)]: (llamada, vez) => {
          const cambios = llamada.body as { destino?: string; activa?: boolean };
          return {
            status: 200,
            cuerpo: reglaDe({ ...A, destino: (cambios.destino ?? A.destino) as ReglaVista["destino"], activa: cambios.activa ?? A.activa, version: A.version + vez }),
          };
        },
      },
    });
    const usuario = montar();
    await esperarFila(RUC_A);

    await usuario.click(screen.getByRole("button", { name: R.editar(RUC_A) }));
    await usuario.selectOptions(screen.getByRole("combobox", { name: R.campoDestino }), "DGNG");
    await usuario.click(screen.getByRole("button", { name: R.guardar }));

    await vi.waitFor(() => expect(celdas(screen.getAllByRole("row").find((r) => r.textContent?.includes(RUC_A))!)).toContain("DGNG"));
    expect(f.de(rutaRegla("PATCH", A.id))[0]!.body).toEqual({ versionBase: 3, destino: "DGNG" });

    // La versión pasó de 3 a 4: desactivar manda la nueva.
    await usuario.click(await screen.findByRole("button", { name: R.desactivar(RUC_A) }));
    await vi.waitFor(() => expect(f.de(rutaRegla("PATCH", A.id))).toHaveLength(2));
    expect(f.de(rutaRegla("PATCH", A.id))[1]!.body).toEqual({ versionBase: 4, activa: false });
  });

  it("desactivar y volver a activar: PATCH {versionBase, activa} y el estado de la fila cambia con la respuesta", async () => {
    const f = instalar([A, B], {
      extra: {
        [rutaRegla("PATCH", A.id)]: { status: 200, cuerpo: reglaDe({ ...A, activa: false, version: 4 }) },
        [rutaRegla("PATCH", B.id)]: { status: 200, cuerpo: reglaDe({ ...B, activa: true, version: 3 }) },
      },
    });
    const usuario = montar();
    await esperarFila(RUC_A);

    await usuario.click(screen.getByRole("button", { name: R.desactivar(RUC_A) }));
    await vi.waitFor(() => expect(celdas(screen.getAllByRole("row").find((r) => r.textContent?.includes(RUC_A))!)).toContain(R.inactiva));
    expect(f.de(rutaRegla("PATCH", A.id))[0]!.body).toEqual({ versionBase: 3, activa: false });

    await usuario.click(screen.getByRole("button", { name: R.activar(RUC_B) }));
    await vi.waitFor(() => expect(celdas(screen.getAllByRole("row").find((r) => r.textContent?.includes(RUC_B))!)).toContain(R.activa));
    expect(f.de(rutaRegla("PATCH", B.id))[0]!.body).toEqual({ versionBase: 2, activa: true });
  });

  it("409 regla_cambiada: mensaje en español sin el código y la lista se vuelve a leer", async () => {
    const f = instalar([A], {
      extra: { [rutaRegla("PATCH", A.id)]: { status: 409, cuerpo: { codigo: "regla_cambiada" } } },
    });
    const usuario = montar();
    await esperarFila(RUC_A);

    await usuario.click(screen.getByRole("button", { name: R.desactivar(RUC_A) }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(R.reglaCambiada);
    expect(alerta.textContent).not.toContain("regla_cambiada");
    await vi.waitFor(() => expect(f.de(RUTA_LISTA_REGLAS)).toHaveLength(2));
  });
});

describe("<TablaReglasCliente /> · eliminar con confirmación", () => {
  it("cancelar no manda nada; confirmar manda DELETE con la versión y la fila desaparece", async () => {
    const f = instalar([A, B], { extra: { [rutaRegla("DELETE", A.id)]: { status: 204 } } });
    const usuario = montar();
    await esperarFila(RUC_A);

    await usuario.click(screen.getByRole("button", { name: R.eliminar(RUC_A) }));
    let dialogo = await screen.findByRole("alertdialog");
    await usuario.click(within(dialogo).getByRole("button", { name: R.cancelar }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(f.de(rutaRegla("DELETE", A.id))).toHaveLength(0);
    expect(screen.getAllByRole("row").some((r) => r.textContent?.includes(RUC_A))).toBe(true);

    await usuario.click(screen.getByRole("button", { name: R.eliminar(RUC_A) }));
    dialogo = await screen.findByRole("alertdialog");
    expect(f.de(rutaRegla("DELETE", A.id))).toHaveLength(0);
    await usuario.click(within(dialogo).getByRole("button", { name: R.confirmar }));

    await vi.waitFor(() =>
      expect(screen.getAllByRole("row").some((r) => r.textContent?.includes(RUC_A))).toBe(false),
    );
    const borrados = f.de(rutaRegla("DELETE", A.id));
    expect(borrados).toHaveLength(1);
    expect(new URLSearchParams(borrados[0]!.url.split("?")[1]).get("versionBase")).toBe("3");
    expect(screen.getAllByRole("row").some((r) => r.textContent?.includes(RUC_B))).toBe(true);
  });

  it("409 al eliminar: mensaje y la fila sigue", async () => {
    instalar([A], { extra: { [rutaRegla("DELETE", A.id)]: { status: 409, cuerpo: { codigo: "regla_cambiada" } } } });
    const usuario = montar();
    await esperarFila(RUC_A);

    await usuario.click(screen.getByRole("button", { name: R.eliminar(RUC_A) }));
    await usuario.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: R.confirmar }));

    expect((await screen.findByRole("alert")).textContent).toBe(R.reglaCambiada);
    expect(screen.getAllByRole("row").some((r) => r.textContent?.includes(RUC_A))).toBe(true);
  });
});

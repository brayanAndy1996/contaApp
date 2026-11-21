import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { esperarFila, rutaSesion, yoDe } from "../../pruebas/acceso";
import { MENSAJES_APRENDIZAJE as M } from "../../pruebas/aprendizaje";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import { MENSAJES_REGLAS as R, RUTA_LISTA_REGLAS, reglaDe } from "../../pruebas/reglas";
import { instalarFetchFalso } from "../../pruebas/soporte";
import { TablaReglasCliente } from "./tabla-reglas-cliente";

// Spec 025 · T7 (rojo; CA-3, D-5). Origen de la regla en la pantalla de reglas del cliente.
// Contrato (T13), `components/reglas/tabla-reglas-cliente.tsx`: `ReglaVista.origen` es «contador» | «importacion».
//   - Una regla activada desde el historial se marca «Importado del historial» dentro de la celda del proveedor (insignia
//     de texto, no color solo). Las del contador («Recordar») no llevan marca.
//   - Las columnas, sus etiquetas para el diseño apilado y las acciones de 021 no cambian: es una regla normal.

const IMPORTADA = reglaDe({
  id: uuidDe(7, 50),
  origen: "importacion",
  proveedor: { tipo: "6", numero: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
  destino: "DNG",
  periodoAprendido: "202610",
} as Parameters<typeof reglaDe>[0]);
const DEL_CONTADOR = reglaDe({ id: uuidDe(7, 51), origen: "contador" } as Parameters<typeof reglaDe>[0]);

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function instalar(lista: unknown[]) {
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", ["clientes.ver", "reglas.ver", "reglas.gestionar"]),
    },
    [RUTA_LISTA_REGLAS]: { status: 200, cuerpo: lista },
  });
}

describe("<TablaReglasCliente /> · origen (D-5)", () => {
  it("feliz: la regla activada desde el historial dice «Importado del historial» y la del contador no", async () => {
    instalar([IMPORTADA, DEL_CONTADOR]);
    render(<TablaReglasCliente clienteId="c-1" />);

    const importada = await esperarFila("20700000011");
    expect(within(importada).getByText(M.origenImportacion)).toBeTruthy();
    const propia = await esperarFila("20100070970");
    expect(within(propia).queryByText(M.origenImportacion)).toBeNull();
    // Una sola marca en toda la tabla.
    expect(screen.getAllByText(M.origenImportacion)).toHaveLength(1);
  });

  it("sigue siendo una regla normal: mismas acciones de 021 y mismas columnas", async () => {
    instalar([IMPORTADA]);
    render(<TablaReglasCliente clienteId="c-1" />);

    const fila = await esperarFila("20700000011");
    for (const nombre of [R.editar("20700000011"), R.desactivar("20700000011"), R.eliminar("20700000011")]) {
      expect(within(fila).getByRole("button", { name: nombre })).toBeTruthy();
    }
    expect([...fila.querySelectorAll("td")].map((td) => td.getAttribute("data-etiqueta"))).toEqual([
      R.columnas.proveedor,
      R.columnas.destino,
      R.columnas.estado,
      R.columnas.aplicada,
      R.columnas.aceptada,
      R.columnas.actualizada,
      "Acciones",
    ]);
  });

  it("la razón social hostil de una regla importada se ve como texto", async () => {
    instalar([
      reglaDe({
        id: uuidDe(7, 52),
        origen: "importacion",
        proveedor: { tipo: "6", numero: "20700000011", razonSocial: TEXTO_HOSTIL },
      } as Parameters<typeof reglaDe>[0]),
    ]);
    render(<TablaReglasCliente clienteId="c-1" />);

    expect(await screen.findByText(TEXTO_HOSTIL, { exact: false })).toBeTruthy();
    expect(screen.getByText(M.origenImportacion)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import { uuidDe } from "../../pruebas/compras";
import {
  IMPORTACION_ID,
  MENSAJES_APRENDIZAJE as M,
  PERMISOS_SOLO_VER,
  RUTA_ACTIVAR,
  anchosFijosMayoresA390,
  instalarFetchAprendizaje,
  rutaGrilla,
} from "../../pruebas/aprendizaje";
import { ActivarCandidatas } from "./activar-candidatas";

// Spec 025 · T7 (rojo; CA-3, CA-4, CA-8, D-6, U-6, U-8). «Activar todas» con confirmación y resultado por motivo.
// Contrato (T13), `components/reglas/activar-candidatas.tsx`:
//   <ActivarCandidatas clienteId importacionId aActivar omitidas periodoAbierto alTerminar? />
//   - aActivar: propuestas pendientes sin conflicto (las que «Activar todas» crearía); omitidas: las que se saltaría
//     (con conflicto o sin criterio claro); periodoAbierto: AAAAMM de la grilla de compras a la que enlaza el aviso de U-6.
//   - Sin `reglas.gestionar` (lee GET /api/acceso/yo) no pinta nada. «Activar todas» queda deshabilitado con `aActivar` 0.
//   - Abre un `Dialog` (role dialog) con `confirmarTodas(aActivar, omitidas)` y «Confirmar» / «Cancelar»; nada se manda hasta
//     confirmar. «Confirmar» → POST …/candidatas/activar {todas: true, importacionId}.
//   - Resultado (role status): «N reglas activadas.», una línea por motivo de omisión («N omitidas · conflicto con una regla
//     vigente») con lo que el servidor devolvió en `omitidas`, el aviso de U-6 y el enlace «Ver compras del periodo» a
//     `/clientes/c-1/compras?periodo=<periodoAbierto>` (sin proveedor: son todas). `alTerminar(respuesta)` avisa a la lista.
//   - 409 cliente_archivado | 404 → role alert en español, sin el código.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(parcial: { aActivar?: number; omitidas?: number } = {}) {
  const alTerminar = vi.fn();
  const resultado = render(
    <ActivarCandidatas
      clienteId="c-1"
      importacionId={IMPORTACION_ID}
      aActivar={parcial.aActivar ?? 12}
      omitidas={parcial.omitidas ?? 3}
      periodoAbierto="202611"
      alTerminar={alTerminar}
    />,
  );
  return { alTerminar, resultado, usuario: userEvent.setup() };
}

const boton = () => screen.findByRole("button", { name: M.activarTodas }) as Promise<HTMLButtonElement>;

describe("<ActivarCandidatas /> · confirmación (D-6)", () => {
  it("el diálogo dice cuántas se activan y cuántas se omiten; «Cancelar» no manda nada", async () => {
    const f = instalarFetchAprendizaje();
    const { usuario } = montar({ aActivar: 12, omitidas: 3 });

    await usuario.click(await boton());

    const dialogo = await screen.findByRole("dialog");
    expect(within(dialogo).getByText(M.confirmarTodas(12, 3), { exact: false })).toBeTruthy();
    await usuario.click(within(dialogo).getByRole("button", { name: M.cancelar }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.de(RUTA_ACTIVAR)).toHaveLength(0);
  });

  it("sin propuestas por activar el botón queda deshabilitado", async () => {
    instalarFetchAprendizaje();
    montar({ aActivar: 0, omitidas: 4 });

    expect((await boton()).disabled).toBe(true);
  });
});

describe("<ActivarCandidatas /> · resultado (CA-3, CA-4, U-6)", () => {
  it("confirmar manda {todas: true, importacionId} y muestra activadas, omitidas por motivo, el aviso de U-6 y el enlace a la grilla", async () => {
    const activadas = Array.from({ length: 12 }, (_, i) => uuidDe(28, i + 1));
    const f = instalarFetchAprendizaje({
      extra: {
        [RUTA_ACTIVAR]: {
          status: 200,
          cuerpo: {
            activadas,
            omitidas: [
              { id: uuidDe(29, 1), motivo: "conflicto" },
              { id: uuidDe(29, 2), motivo: "conflicto" },
              { id: uuidDe(29, 3), motivo: "ya_aprendida" },
            ],
          },
        },
      },
    });
    const { alTerminar, usuario } = montar();
    await usuario.click(await boton());
    const dialogo = await screen.findByRole("dialog");

    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await vi.waitFor(() => expect(f.de(RUTA_ACTIVAR)).toHaveLength(1));
    expect(f.de(RUTA_ACTIVAR)[0]!.body).toEqual({ todas: true, importacionId: IMPORTACION_ID });
    expect(f.de(RUTA_ACTIVAR)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(await screen.findByText(M.reglasActivadas(12))).toBeTruthy();
    expect(screen.getByText(M.omitidas(2, "conflicto"))).toBeTruthy();
    expect(screen.getByText(M.omitidas(1, "ya_aprendida"))).toBeTruthy();
    expect(screen.queryByText(M.omitidas(1, "sin_criterio"))).toBeNull();
    expect(screen.getByText(M.avisoPeriodoCargado)).toBeTruthy();
    const enlace = screen.getByRole("link", { name: M.irAGrilla }) as HTMLAnchorElement;
    expect(enlace.getAttribute("href")).toBe(rutaGrilla("202611"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(alTerminar).toHaveBeenCalledTimes(1);
    expect(alTerminar.mock.calls[0]![0]).toEqual({
      activadas,
      omitidas: [
        { id: uuidDe(29, 1), motivo: "conflicto" },
        { id: uuidDe(29, 2), motivo: "conflicto" },
        { id: uuidDe(29, 3), motivo: "ya_aprendida" },
      ],
    });
  });

  it("sin omitidas no hay líneas de omisión", async () => {
    instalarFetchAprendizaje({
      extra: { [RUTA_ACTIVAR]: { status: 200, cuerpo: { activadas: [uuidDe(28, 1)], omitidas: [] } } },
    });
    const { usuario } = montar({ aActivar: 1, omitidas: 0 });
    await usuario.click(await boton());
    await usuario.click(within(await screen.findByRole("dialog")).getByRole("button", { name: M.confirmar }));

    expect(await screen.findByText(M.reglasActivadas(1))).toBeTruthy();
    expect(screen.queryByText(/omitida/)).toBeNull();
  });
});

describe("<ActivarCandidatas /> · errores y permisos", () => {
  it.each([
    [409, { codigo: "cliente_archivado" }, M.errores.cliente_archivado, "cliente_archivado"],
    [404, { codigo: "no_encontrado" }, M.noEncontrado, "no_encontrado"],
  ])("%s: mensaje en español, sin el código y sin anuncio de éxito", async (status, cuerpo, texto, codigo) => {
    instalarFetchAprendizaje({ extra: { [RUTA_ACTIVAR]: { status, cuerpo } } });
    const { alTerminar, usuario } = montar();
    await usuario.click(await boton());
    await usuario.click(within(await screen.findByRole("dialog")).getByRole("button", { name: M.confirmar }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(screen.queryByText(M.avisoPeriodoCargado)).toBeNull();
    expect(alTerminar).not.toHaveBeenCalled();
  });

  it("sin reglas.gestionar no pinta el botón (el servidor responde 403 igual)", async () => {
    instalarFetchAprendizaje({ permisos: PERMISOS_SOLO_VER });
    const { resultado } = montar();

    await asentar(60);
    expect(screen.queryByRole("button", { name: M.activarTodas })).toBeNull();
    expect(resultado.container.textContent).toBe("");
  });
});

describe("<ActivarCandidatas /> · 390 px", () => {
  it("el diálogo de confirmación no fija anchos mayores a la pantalla", async () => {
    instalarFetchAprendizaje();
    const { resultado, usuario } = montar();
    await usuario.click(await boton());
    await screen.findByRole("dialog");

    expect(anchosFijosMayoresA390(resultado.container)).toEqual([]);
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

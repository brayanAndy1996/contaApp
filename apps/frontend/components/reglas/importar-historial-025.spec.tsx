import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import { asentar } from "../../pruebas/acceso";
import {
  IMPORTACION_ID,
  MENSAJES_APRENDIZAJE as M,
  PERMISOS_SOLO_VER,
  RUTA_IMPORTAR,
  RUTA_ULTIMA,
  TIPO_TRABAJO_IMPORTAR,
  TRABAJO_IMPORTACION_ID,
  anchosFijosMayoresA390,
  importacionDe,
  instalarFetchAprendizaje,
} from "../../pruebas/aprendizaje";
import { trabajoN } from "../../pruebas/trabajos";
import { ImportarHistorial } from "./importar-historial";

// Spec 025 · T7 (rojo; CA-1, CA-5, CA-8, D-4, D-10, U-5). Importar el historial del cliente.
// Contrato (T13), `components/reglas/importar-historial.tsx`: <ImportarHistorial clienteId="c-1" alCompletar? />.
//   - Lee GET …/reglas/importaciones/ultima ({importacion}) y GET /api/acceso/yo; el botón «Importar historial» solo con
//     `reglas.gestionar` (sin él se ve el estado de la última importación, con `reglas.ver`).
//   - El botón abre un `Dialog` (role dialog, «Importar historial del cliente») con el combobox «Periodos» (1..12, 6 por omisión),
//     el aviso de que nada se aplica hasta activar y los botones «Importar» y «Cancelar».
//   - «Importar» → POST …/reglas/importaciones {periodos} → 202 {importacion, trabajoId}. El diálogo se cierra, se muestra
//     «Importando historial…» (role status) y se sigue el trabajo con `seguirTrabajos` de 008 (`lib/trabajos.ts`). Al completar
//     se vuelve a leer la última importación y se llama `alCompletar()`.
//   - Una importación `en_curso` ya leída también se sigue por su `trabajoId`; con ella en curso no se puede importar otra.
//   - Importación completada: resumen («N periodos leídos · N candidatas · N sin criterio claro») y «Sin datos en: AAAAMM, …».
//   - 409 importacion_en_curso | credencial_no_configurada | credencial_invalida | cliente_archivado → role alert con el texto
//     en español, nunca el código.

const seguimiento = vi.hoisted(() => ({ opciones: null as OpcionesSeguimiento | null }));
vi.mock("../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(async (o: OpcionesSeguimiento) => {
      seguimiento.opciones = o;
      await new Promise<void>((resolver) => o.senal.addEventListener("abort", () => resolver(), { once: true }));
    }),
  };
});

const emitir = (estado: "ejecutando" | "completado" | "error", motivo: string | null = null) =>
  seguimiento.opciones?.alEvento({
    ...trabajoN(1, TIPO_TRABAJO_IMPORTAR, estado, motivo),
    id: TRABAJO_IMPORTACION_ID,
  } as unknown as TrabajoVista);

beforeEach(() => {
  seguimiento.opciones = null;
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar(alCompletar = vi.fn()) {
  const resultado = render(<ImportarHistorial clienteId="c-1" alCompletar={alCompletar} />);
  return { alCompletar, resultado, usuario: userEvent.setup() };
}

const abrir = async (usuario: ReturnType<typeof userEvent.setup>) => {
  await usuario.click(await screen.findByRole("button", { name: M.importar }));
  return screen.findByRole("dialog", { name: M.tituloImportar });
};

describe("<ImportarHistorial /> · diálogo (U-5, D-4)", () => {
  it("feliz: el diálogo ofrece 1 a 12 periodos con 6 por omisión y avisa que nada se aplica hasta activar", async () => {
    instalarFetchAprendizaje({ importacion: null });
    const { usuario } = montar();

    const dialogo = await abrir(usuario);

    const periodos = within(dialogo).getByRole("combobox", { name: M.campoPeriodos }) as HTMLSelectElement;
    expect([...periodos.options].map((o) => o.value)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(periodos.value).toBe(M.periodosPorOmision);
    expect(within(dialogo).getByText(M.avisoSinAplicar)).toBeTruthy();
    expect(within(dialogo).getByRole("button", { name: M.confirmarImportar })).toBeTruthy();
    expect(within(dialogo).getByRole("button", { name: M.cancelar })).toBeTruthy();
  });

  it("«Importar» con 6 periodos manda {periodos: 6}, cierra el diálogo y sigue el trabajo hasta completar", async () => {
    const f = instalarFetchAprendizaje({
      importacion: null,
      extra: {
        [RUTA_IMPORTAR]: {
          status: 202,
          cuerpo: {
            importacion: importacionDe({ estado: "en_curso", terminadaEn: null, resumen: null }),
            trabajoId: TRABAJO_IMPORTACION_ID,
          },
        },
      },
    });
    const { alCompletar, usuario } = montar();
    const dialogo = await abrir(usuario);

    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmarImportar }));

    await vi.waitFor(() => expect(f.de(RUTA_IMPORTAR)).toHaveLength(1));
    expect(f.de(RUTA_IMPORTAR)[0]!.body).toEqual({ periodos: 6 });
    expect(f.de(RUTA_IMPORTAR)[0]!.headers["x-csrf-token"]).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(M.enCurso)).toBeTruthy();
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    expect(alCompletar).not.toHaveBeenCalled();

    emitir("ejecutando");
    expect(screen.getByText(M.enCurso)).toBeTruthy();
    emitir("completado");
    await vi.waitFor(() => expect(alCompletar).toHaveBeenCalledTimes(1));
    // Al completar vuelve a leer la última importación (la inicial y la de después).
    await vi.waitFor(() => expect(f.de(RUTA_ULTIMA).length).toBeGreaterThanOrEqual(2));
  });

  it("elegir 12 periodos manda {periodos: 12}", async () => {
    const f = instalarFetchAprendizaje({
      importacion: null,
      extra: {
        [RUTA_IMPORTAR]: {
          status: 202,
          cuerpo: { importacion: importacionDe({ estado: "en_curso", resumen: null }), trabajoId: TRABAJO_IMPORTACION_ID },
        },
      },
    });
    const { usuario } = montar();
    const dialogo = await abrir(usuario);

    await usuario.selectOptions(within(dialogo).getByRole("combobox", { name: M.campoPeriodos }), "12");
    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmarImportar }));

    await vi.waitFor(() => expect(f.de(RUTA_IMPORTAR)).toHaveLength(1));
    expect(f.de(RUTA_IMPORTAR)[0]!.body).toEqual({ periodos: 12 });
  });

  it("«Cancelar» cierra el diálogo sin mandar nada", async () => {
    const f = instalarFetchAprendizaje({ importacion: null });
    const { usuario } = montar();
    const dialogo = await abrir(usuario);

    await usuario.click(within(dialogo).getByRole("button", { name: M.cancelar }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.de(RUTA_IMPORTAR)).toHaveLength(0);
  });
});

describe("<ImportarHistorial /> · permisos (CA-8)", () => {
  it("sin reglas.gestionar no hay botón «Importar historial», pero se ve el estado de la última importación", async () => {
    instalarFetchAprendizaje({ permisos: PERMISOS_SOLO_VER });
    montar();

    expect(await screen.findByText(M.resumen({ periodosLeidos: 5, candidatas: 14, sinCriterio: 3 }))).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.importar })).toBeNull();
  });
});

describe("<ImportarHistorial /> · estado de la última importación (CA-1, D-11)", () => {
  it("completada: resumen con los conteos y los periodos «sin datos»", async () => {
    instalarFetchAprendizaje();
    montar();

    expect(await screen.findByText(M.resumen({ periodosLeidos: 5, candidatas: 14, sinCriterio: 3 }))).toBeTruthy();
    expect(screen.getByText(M.sinDatos(["202605"]))).toBeTruthy();
  });

  it("sin periodos sin datos no se pinta la línea «Sin datos en»", async () => {
    instalarFetchAprendizaje({
      importacion: importacionDe({ resumen: { periodosLeidos: 6, periodosSinDatos: [], candidatas: 9, sinCriterio: 0 } }),
    });
    montar();

    expect(await screen.findByText(M.resumen({ periodosLeidos: 6, candidatas: 9, sinCriterio: 0 }))).toBeTruthy();
    expect(screen.queryByText(/Sin datos en/)).toBeNull();
  });

  it("en curso al abrir la pantalla: lo dice, sigue el trabajo y no deja importar otra", async () => {
    const f = instalarFetchAprendizaje({
      importacion: importacionDe({ estado: "en_curso", terminadaEn: null, resumen: null }),
    });
    montar();

    expect(await screen.findByText(M.enCurso)).toBeTruthy();
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    const boton = screen.getByRole("button", { name: M.importar }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(f.de(RUTA_IMPORTAR)).toHaveLength(0);
  });

  it("fallida: «La importación falló» y se puede volver a importar", async () => {
    instalarFetchAprendizaje({
      importacion: importacionDe({ estado: "fallida", resumen: null, motivo: "sunat_no_responde" }),
    });
    montar();

    expect(await screen.findByText(M.fallida)).toBeTruthy();
    expect((screen.getByRole("button", { name: M.importar }) as HTMLButtonElement).disabled).toBe(false);
    // Solo el motivo en español; nunca el código del trabajo.
    expect(document.body.textContent).not.toContain("sunat_no_responde");
  });

  it("el trabajo termina con error: se avisa de la falla sin esperar otra lectura", async () => {
    instalarFetchAprendizaje({
      importacion: importacionDe({ estado: "en_curso", terminadaEn: null, resumen: null }),
    });
    montar();
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    emitir("error", "credencial_invalida");

    expect(await screen.findByText(M.fallida)).toBeTruthy();
  });

  it("sin ninguna importación no hay resumen ni falla", async () => {
    instalarFetchAprendizaje({ importacion: null });
    montar();

    await screen.findByRole("button", { name: M.importar });
    await asentar();
    expect(screen.queryByText(/periodos leídos/)).toBeNull();
    expect(screen.queryByText(M.fallida)).toBeNull();
  });
});

describe("<ImportarHistorial /> · errores del servidor (CA-5)", () => {
  it.each([
    ["importacion_en_curso", M.errores.importacion_en_curso],
    ["credencial_no_configurada", M.errores.credencial_no_configurada],
    ["credencial_invalida", M.errores.credencial_invalida],
    ["cliente_archivado", M.errores.cliente_archivado],
  ])("409 %s: mensaje en español, sin el código y sin seguir ningún trabajo", async (codigo, texto) => {
    instalarFetchAprendizaje({
      importacion: null,
      extra: { [RUTA_IMPORTAR]: { status: 409, cuerpo: { codigo } } },
    });
    const { usuario } = montar();
    const dialogo = await abrir(usuario);

    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmarImportar }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(seguimiento.opciones).toBeNull();
  });

  it("403: el mensaje genérico de permiso", async () => {
    instalarFetchAprendizaje({
      importacion: null,
      extra: { [RUTA_IMPORTAR]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } },
    });
    const { usuario } = montar();
    const dialogo = await abrir(usuario);

    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmarImportar }));

    expect((await screen.findByRole("alert")).textContent).toContain(M.sinPermiso);
  });
});

describe("<ImportarHistorial /> · 390 px", () => {
  it("el diálogo y el estado no fijan anchos mayores a la pantalla ni esconden nada tras un scroll interior", async () => {
    instalarFetchAprendizaje();
    const { resultado, usuario } = montar();
    await screen.findByText(M.resumen({ periodosLeidos: 5, candidatas: 14, sinCriterio: 3 }));
    await abrir(usuario);

    expect(anchosFijosMayoresA390(resultado.container)).toEqual([]);
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

// Referencia para T13: el id de la importación que devuelve el 202 es el de la fila, no se inventa en el cliente.
describe("<ImportarHistorial /> · contrato de la respuesta", () => {
  it("usa el trabajoId de la respuesta 202 para seguir el trabajo", async () => {
    instalarFetchAprendizaje({
      importacion: null,
      extra: {
        [RUTA_IMPORTAR]: {
          status: 202,
          cuerpo: { importacion: importacionDe({ id: IMPORTACION_ID, estado: "en_curso", resumen: null }), trabajoId: TRABAJO_IMPORTACION_ID },
        },
      },
    });
    const { alCompletar, usuario } = montar();
    const dialogo = await abrir(usuario);
    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmarImportar }));
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    // Un evento de OTRO trabajo no completa la importación.
    seguimiento.opciones?.alEvento({
      ...trabajoN(2, TIPO_TRABAJO_IMPORTAR, "completado"),
    } as unknown as TrabajoVista);
    await asentar();
    expect(alCompletar).not.toHaveBeenCalled();

    emitir("completado");
    await vi.waitFor(() => expect(alCompletar).toHaveBeenCalledTimes(1));
  });
});

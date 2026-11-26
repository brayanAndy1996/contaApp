import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fechaHoraLima } from "../../../../lib/fechas";
import { reiniciarSesion } from "../../../../lib/sesion";
import { MENSAJES_ACCESO, asentar, celdas } from "../../../../pruebas/acceso";
import { anchosFijosMayoresA390, consultaDeLlamada } from "../../../../pruebas/aprendizaje";
import { TEXTO_HOSTIL, uuidDe } from "../../../../pruebas/compras";
import {
  DG_BOTA,
  DG_POLO,
  DG_ZAPATILLA,
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  RUTA_AGREGAR_GLOBAL,
  RUTA_DICCIONARIO,
  RUTA_HISTORIAL_GLOBAL,
  RUTA_PLATAFORMA_YO,
  diccionarioGlobalDe,
  historialGlobalDe,
  rutaEditarGlobal,
} from "../../../../pruebas/gastos";
import { crearRouterFalso, instalarFetchFalso, sesionDe, type Manejador } from "../../../../pruebas/soporte";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/diccionario",
  useSearchParams: () => new URLSearchParams(),
}));

import AdminDiccionario from "./page";

// Spec 027 · T7 (rojo; CA-8, R-6, D-2, D-3). Pantalla /admin/diccionario del super-admin (sin estudio activo: la sesión no trae X-Estudio).
// Contrato (T13), `app/(plataforma)/admin/diccionario/page.tsx` (export por omisión), como /admin/planes de 006:
//   - Al montar: GET /api/plataforma/yo. Con 403 muestra MENSAJES_ACCESO.sinPermiso y no pide nada más, ni formulario, ni botones.
//     Con 200: GET /api/plataforma/diccionario ({palabras}) y GET /api/plataforma/diccionario/historial ({items, siguiente}).
//   - Tabla M.tituloDiccionarioGlobal (role table con ese nombre; role row por palabra): una fila por palabra con la palabra, su categoría (ETIQUETA_CATEGORIA), sus
//     excepciones y el estado M.activa | M.inactiva; botones M.editarGlobal(p) y M.desactivarDiccionario(p) (activa) o
//     M.activarDiccionario(p) (inactiva). Sin palabras: M.sinGlobales.
//   - Formulario (siempre visible) con Palabra, Categoría (combobox, value = código) y Excepciones (coma). «Agregar palabra global»
//     (M.agregarGlobal) → POST /api/plataforma/diccionario {palabra, categoria, excepciones: string[]} con el CSRF de la sesión y
//     sin X-Estudio; 201 → role status M.globalAgregada y vuelve a leer la lista y el historial. Mismas validaciones del formulario
//     que en el estudio (M.palabraInvalida, M.excepcionesInvalidas, M.categoriaRequerida), sin petición. 409 palabra_existente →
//     role alert M.errores.palabra_existente, lo escrito se conserva.
//   - «Editar» carga la fila en el formulario (la palabra no se edita: campo de solo lectura o deshabilitado) y el botón pasa a
//     M.guardarCambios → PUT /api/plataforma/diccionario/:id {categoria, excepciones, activa, version} (reemplazo completo, con la
//     versión de la fila). 200 → M.globalGuardada y recarga. 409 version_cambiada → role alert M.errores.version_cambiada y recarga.
//     M.cancelar vuelve al modo de agregar.
//   - «Desactivar/Activar» → PUT con la fila completa y `activa` invertido, con su versión.
//   - Historial (role table con el nombre M.tituloHistorial): una fila por cambio con la acción (M.accion), la palabra, el autor (texto) y la fecha en
//     hora de Lima (`fechaHoraLima`), el más reciente primero; sin cambios M.sinHistorial. Con `siguiente` hay «Ver más» (M.verMas):
//     GET …/historial?antes=<siguiente> y se agregan las filas; sin `siguiente`, no hay botón.
//   - Textos del servidor (nombres) son texto, nunca HTML. Sin desborde a 390 px.

const sesion: Record<string, Manejador> = {
  "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-admin") },
};

function rutas(extra: Record<string, Manejador> = {}): Record<string, Manejador> {
  return {
    ...sesion,
    [RUTA_PLATAFORMA_YO]: { status: 200, cuerpo: { admin: true } },
    [RUTA_DICCIONARIO]: { status: 200, cuerpo: diccionarioGlobalDe() },
    [RUTA_HISTORIAL_GLOBAL]: { status: 200, cuerpo: historialGlobalDe() },
    ...extra,
  };
}

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fila de la tabla del diccionario (nombre M.tituloDiccionarioGlobal) con esa palabra; el historial tiene su propia tabla. */
const filaDic = (palabra: string): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const tabla = screen.getByRole("table", { name: M.tituloDiccionarioGlobal });
    const f = within(tabla).queryAllByRole("row").find((r) => r.textContent?.includes(palabra));
    if (!f) throw new Error(`sin fila de ${palabra}`);
    return f;
  });
const tablaHistorial = () => screen.findByRole("table", { name: M.tituloHistorial });
const boton = (f: HTMLElement, nombre: string) => within(f).queryByRole("button", { name: nombre });
const campoPalabra = () => screen.getByLabelText(M.campoPalabra) as HTMLInputElement;
const campoCategoria = () => screen.getByRole("combobox", { name: M.campoCategoria }) as HTMLSelectElement;
const campoExcepciones = () => screen.getByLabelText(M.campoExcepciones) as HTMLInputElement;

describe("/admin/diccionario · acceso", () => {
  it("403 en /plataforma/yo: solo el aviso, sin formulario, sin acciones y sin pedir el diccionario ni el historial", async () => {
    const f = instalarFetchFalso({
      ...sesion,
      [RUTA_PLATAFORMA_YO]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
    });
    render(<AdminDiccionario />);

    expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
    await asentar();
    expect(f.de(RUTA_DICCIONARIO)).toHaveLength(0);
    expect(f.de(RUTA_HISTORIAL_GLOBAL)).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(M.campoPalabra)).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });
});

describe("/admin/diccionario · lista (D-2)", () => {
  it("lista las palabras con categoría, excepciones y estado; cada fila ofrece Editar y Desactivar (activa) o Activar (inactiva)", async () => {
    instalarFetchFalso(rutas());
    render(<AdminDiccionario />);

    const zapatilla = await filaDic("zapatilla");
    expect(celdas(zapatilla).join(" | ")).toContain(ETIQUETA_CATEGORIA["calzado-ropa"]);
    expect(zapatilla.textContent).toContain("seguridad");
    expect(zapatilla.textContent).toContain("punta de acero");
    expect(within(zapatilla).getByText(M.activa)).toBeTruthy();
    expect(boton(zapatilla, M.editarGlobal("zapatilla"))).toBeTruthy();
    expect(boton(zapatilla, M.desactivarDiccionario("zapatilla"))).toBeTruthy();
    expect(boton(zapatilla, M.activarDiccionario("zapatilla"))).toBeNull();

    const bota = await filaDic("bota");
    expect(within(bota).getByText(M.inactiva)).toBeTruthy();
    expect(boton(bota, M.activarDiccionario("bota"))).toBeTruthy();
    expect(boton(bota, M.desactivarDiccionario("bota"))).toBeNull();
  });

  it("sin palabras globales: «Aún no hay palabras globales.»", async () => {
    instalarFetchFalso(rutas({ [RUTA_DICCIONARIO]: { status: 200, cuerpo: diccionarioGlobalDe([]) } }));
    render(<AdminDiccionario />);
    expect(await screen.findByText(M.sinGlobales)).toBeTruthy();
  });
});

describe("/admin/diccionario · agregar", () => {
  it("feliz: POST con el cuerpo completo, CSRF de la sesión y sin X-Estudio; 201 → «Palabra global agregada.» y recarga lista e historial", async () => {
    const f = instalarFetchFalso(
      rutas({ [RUTA_AGREGAR_GLOBAL]: { status: 201, cuerpo: { id: uuidDe(27, 40), version: 1 } } }),
    );
    render(<AdminDiccionario />);
    await filaDic("zapatilla");
    const usuario = userEvent.setup();

    await usuario.type(campoPalabra(), "lonchera");
    await usuario.selectOptions(campoCategoria(), "utiles-escolares");
    await usuario.type(campoExcepciones(), "termica, de campo");
    await usuario.click(screen.getByRole("button", { name: M.agregarGlobal }));

    expect(await screen.findByText(M.globalAgregada)).toBeTruthy();
    const [llamada] = f.de(RUTA_AGREGAR_GLOBAL);
    expect(llamada?.body).toEqual({ palabra: "lonchera", categoria: "utiles-escolares", excepciones: ["termica", "de campo"] });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    await vi.waitFor(() => expect(f.de(RUTA_DICCIONARIO)).toHaveLength(2));
    await vi.waitFor(() => expect(f.de(RUTA_HISTORIAL_GLOBAL)).toHaveLength(2));
  });

  it("sin excepciones manda el arreglo vacío", async () => {
    const f = instalarFetchFalso(rutas({ [RUTA_AGREGAR_GLOBAL]: { status: 201, cuerpo: { id: uuidDe(27, 40), version: 1 } } }));
    render(<AdminDiccionario />);
    await filaDic("zapatilla");
    const usuario = userEvent.setup();

    await usuario.type(campoPalabra(), "karaoke");
    await usuario.selectOptions(campoCategoria(), "entretenimiento");
    await usuario.click(screen.getByRole("button", { name: M.agregarGlobal }));

    await vi.waitFor(() => expect(f.de(RUTA_AGREGAR_GLOBAL)).toHaveLength(1));
    expect(f.de(RUTA_AGREGAR_GLOBAL)[0]!.body).toEqual({ palabra: "karaoke", categoria: "entretenimiento", excepciones: [] });
  });

  it.each([
    ["una palabra con espacios", "dos palabras", "juguetes", "", M.palabraInvalida],
    ["una palabra de menos de 3 letras", "ab", "juguetes", "", M.palabraInvalida],
    ["más de 5 excepciones", "mochila", "utiles-escolares", "a, b, c, d, e, f", M.excepcionesInvalidas],
    ["sin categoría", "mochila", "", "", M.categoriaRequerida],
  ])("rechaza %s en el formulario, sin petición", async (_caso, palabra, categoria, excepciones, mensaje) => {
    const f = instalarFetchFalso(rutas());
    render(<AdminDiccionario />);
    await filaDic("zapatilla");
    const usuario = userEvent.setup();

    await usuario.type(campoPalabra(), palabra);
    if (categoria !== "") await usuario.selectOptions(campoCategoria(), categoria);
    if (excepciones !== "") await usuario.type(campoExcepciones(), excepciones);
    await usuario.click(screen.getByRole("button", { name: M.agregarGlobal }));

    expect((await screen.findByRole("alert")).textContent).toBe(mensaje);
    expect(f.de(RUTA_AGREGAR_GLOBAL)).toHaveLength(0);
  });

  it("409 palabra_existente: mensaje en español (sin el código) y el formulario conserva lo escrito", async () => {
    instalarFetchFalso(rutas({ [RUTA_AGREGAR_GLOBAL]: { status: 409, cuerpo: { codigo: "palabra_existente" } } }));
    render(<AdminDiccionario />);
    await filaDic("zapatilla");
    const usuario = userEvent.setup();

    await usuario.type(campoPalabra(), "zapatilla");
    await usuario.selectOptions(campoCategoria(), "calzado-ropa");
    await usuario.click(screen.getByRole("button", { name: M.agregarGlobal }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(M.errores.palabra_existente);
    expect(alerta.textContent).not.toContain("palabra_existente");
    expect(campoPalabra().value).toBe("zapatilla");
  });
});

describe("/admin/diccionario · editar y activar (compare-and-set por versión)", () => {
  it("Editar carga la fila (palabra no editable); Guardar cambios manda el reemplazo completo con su versión", async () => {
    const f = instalarFetchFalso(rutas({ [rutaEditarGlobal(DG_POLO)]: { status: 200, cuerpo: { version: 3 } } }));
    render(<AdminDiccionario />);
    const usuario = userEvent.setup();

    await usuario.click(boton(await filaDic("polo"), M.editarGlobal("polo"))!);

    expect(campoPalabra().value).toBe("polo");
    expect(campoPalabra().disabled || campoPalabra().readOnly).toBe(true);
    expect(campoCategoria().value).toBe("calzado-ropa");
    expect(campoExcepciones().value).toBe("a tierra");
    expect(screen.queryByRole("button", { name: M.agregarGlobal })).toBeNull();

    await usuario.selectOptions(campoCategoria(), "juguetes");
    await usuario.clear(campoExcepciones());
    await usuario.type(campoExcepciones(), "a tierra, deportivo");
    await usuario.click(screen.getByRole("button", { name: M.guardarCambios }));

    expect(await screen.findByText(M.globalGuardada)).toBeTruthy();
    const [llamada] = f.de(rutaEditarGlobal(DG_POLO));
    expect(llamada?.body).toEqual({ categoria: "juguetes", excepciones: ["a tierra", "deportivo"], activa: true, version: 2 });
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-admin");
    expect(llamada?.headers["x-estudio"]).toBeUndefined();
    await vi.waitFor(() => expect(f.de(RUTA_DICCIONARIO)).toHaveLength(2));
    await vi.waitFor(() => expect(f.de(RUTA_HISTORIAL_GLOBAL)).toHaveLength(2));
  });

  it("Cancelar vuelve al modo de agregar con el formulario vacío", async () => {
    instalarFetchFalso(rutas());
    render(<AdminDiccionario />);
    const usuario = userEvent.setup();

    await usuario.click(boton(await filaDic("polo"), M.editarGlobal("polo"))!);
    await usuario.click(screen.getByRole("button", { name: M.cancelar }));

    expect(screen.getByRole("button", { name: M.agregarGlobal })).toBeTruthy();
    expect(campoPalabra().value).toBe("");
    expect(campoPalabra().disabled).toBe(false);
  });

  it("409 version_cambiada al guardar: mensaje en español y vuelve a leer la lista", async () => {
    const f = instalarFetchFalso(rutas({ [rutaEditarGlobal(DG_ZAPATILLA)]: { status: 409, cuerpo: { codigo: "version_cambiada" } } }));
    render(<AdminDiccionario />);
    const usuario = userEvent.setup();

    await usuario.click(boton(await filaDic("zapatilla"), M.editarGlobal("zapatilla"))!);
    await usuario.click(screen.getByRole("button", { name: M.guardarCambios }));

    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.version_cambiada);
    await vi.waitFor(() => expect(f.de(RUTA_DICCIONARIO)).toHaveLength(2));
  });

  it("Desactivar manda la fila completa con activa:false y su versión; Activar la inversa", async () => {
    const f = instalarFetchFalso(
      rutas({
        [rutaEditarGlobal(DG_ZAPATILLA)]: { status: 200, cuerpo: { version: 2 } },
        [rutaEditarGlobal(DG_BOTA)]: { status: 200, cuerpo: { version: 4 } },
      }),
    );
    render(<AdminDiccionario />);
    const usuario = userEvent.setup();

    await usuario.click(boton(await filaDic("zapatilla"), M.desactivarDiccionario("zapatilla"))!);
    await vi.waitFor(() => expect(f.de(rutaEditarGlobal(DG_ZAPATILLA))).toHaveLength(1));
    expect(f.de(rutaEditarGlobal(DG_ZAPATILLA))[0]!.body).toEqual({
      categoria: "calzado-ropa",
      excepciones: ["seguridad", "punta de acero"],
      activa: false,
      version: 1,
    });

    await usuario.click(boton(await filaDic("bota"), M.activarDiccionario("bota"))!);
    await vi.waitFor(() => expect(f.de(rutaEditarGlobal(DG_BOTA))).toHaveLength(1));
    expect(f.de(rutaEditarGlobal(DG_BOTA))[0]!.body).toEqual({
      categoria: "calzado-ropa",
      excepciones: ["seguridad", "jebe", "punta de acero"],
      activa: true,
      version: 3,
    });
  });
});

describe("/admin/diccionario · historial (D-2, D-4)", () => {
  it("lista los cambios, el más reciente primero, con acción, palabra, autor y fecha de Lima", async () => {
    instalarFetchFalso(rutas());
    render(<AdminDiccionario />);

    const historial = within(await tablaHistorial());
    const editada = await vi.waitFor(() => {
      const f = historial.queryAllByRole("row").find((r) => r.textContent?.includes(M.accion.editada));
      if (!f) throw new Error("sin fila editada");
      return f;
    });
    expect(editada.textContent).toContain("bota");
    expect(editada.textContent).toContain("Admin Plataforma");
    expect(editada.textContent).toContain(fechaHoraLima("2026-11-21T14:00:00.000Z"));
    const agregada = historial.getAllByRole("row").find((r) => r.textContent?.includes(M.accion.agregada))!;
    expect(agregada.textContent).toContain(fechaHoraLima("2026-11-20T14:00:00.000Z"));
    const filas = historial.getAllByRole("row");
    expect(filas.indexOf(editada)).toBeLessThan(filas.indexOf(agregada));
    expect(screen.queryByRole("button", { name: M.verMas })).toBeNull();
  });

  it("sin cambios: «Aún no hay cambios registrados.»", async () => {
    instalarFetchFalso(rutas({ [RUTA_HISTORIAL_GLOBAL]: { status: 200, cuerpo: historialGlobalDe([]) } }));
    render(<AdminDiccionario />);
    expect(await screen.findByText(M.sinHistorial)).toBeTruthy();
  });

  it("«Ver más» pide la página siguiente con `antes` y agrega las filas; al agotarse desaparece", async () => {
    const SIGUIENTE = "2026-11-20T14:00:00.000Z";
    const f = instalarFetchFalso(
      rutas({
        [RUTA_HISTORIAL_GLOBAL]: (llamada) =>
          consultaDeLlamada(llamada.url).get("antes") === SIGUIENTE
            ? {
                status: 200,
                cuerpo: historialGlobalDe([
                  {
                    id: uuidDe(27, 33),
                    palabraGlobalId: DG_ZAPATILLA,
                    palabra: "zapatilla",
                    accion: "agregada",
                    antes: null,
                    despues: { categoria: "calzado-ropa" },
                    autor: { id: uuidDe(5, 9), nombre: "Admin Plataforma", activo: true },
                    ocurridaEn: "2026-11-19T14:00:00.000Z",
                  },
                ]),
              }
            : { status: 200, cuerpo: historialGlobalDe(undefined, SIGUIENTE) },
      }),
    );
    render(<AdminDiccionario />);
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole("button", { name: M.verMas }));

    await vi.waitFor(() => expect(f.de(RUTA_HISTORIAL_GLOBAL)).toHaveLength(2));
    expect(consultaDeLlamada(f.de(RUTA_HISTORIAL_GLOBAL)[1]!.url).get("antes")).toBe(SIGUIENTE);
    await vi.waitFor(() => expect(screen.getAllByText(fechaHoraLima("2026-11-19T14:00:00.000Z"), { exact: false }).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: M.verMas })).toBeNull();
  });

  it("el nombre del autor con HTML se ve como texto, no como elemento", async () => {
    const base = historialGlobalDe();
    instalarFetchFalso(
      rutas({
        [RUTA_HISTORIAL_GLOBAL]: {
          status: 200,
          cuerpo: historialGlobalDe([{ ...base.items[0]!, autor: { id: uuidDe(5, 9), nombre: TEXTO_HOSTIL, activo: true } }]),
        },
      }),
    );
    const { container } = render(<AdminDiccionario />);

    const historial = within(await tablaHistorial());
    await vi.waitFor(() => expect(historial.getAllByRole("row").some((r) => r.textContent?.includes(TEXTO_HOSTIL))).toBe(true));
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("/admin/diccionario · 390 px", () => {
  it("la pantalla no fija anchos mayores a la pantalla ni esconde nada tras un scroll interior", async () => {
    instalarFetchFalso(rutas());
    const { container } = render(<AdminDiccionario />);
    await filaDic("zapatilla");

    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});

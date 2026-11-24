import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_ACCESO, asentar, rutaSesion, yoDe, type RolPrueba } from "../../pruebas/acceso";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import {
  CATEGORIAS,
  CLIENTE_ID,
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  RUTA_CATEGORIAS,
  RUTA_FIJAR_CATEGORIAS,
  categoriasDe,
  categoriasRestaurante,
  type CategoriasClientePrueba,
  type CategoriaPrueba,
} from "../../pruebas/gastos";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { CategoriasCliente } from "./categorias-cliente";

// Spec 027 · T7 (rojo; CA-1, CA-8, R-13, D-6). «Categorías permitidas» en las reglas del cliente.
// Contrato (T13), `components/gastos/categorias-cliente.tsx`: <CategoriasCliente clienteId="c-1" archivado?={boolean} />.
//   - Lee GET /api/clientes/:id/gastos/categorias (`CategoriasClienteVista`) y GET /api/acceso/yo.
//   - Muestra el giro (M.giroDe(ciiu, sección)) o M.sinCiiu si el cliente no tiene CIIU, y M.sinBase si su sección no permite nada.
//   - Una casilla por categoría (checkbox con el nombre de ETIQUETA_CATEGORIA), marcada si la categoría está en `efectivas` (la
//     base de su sección sale marcada). Marcar una desmarcada la agrega a `permitidas` (y la saca de `quitadas`); desmarcar una
//     de la base la agrega a `quitadas`; desmarcar una permitida por ajuste la saca de `permitidas`. Volver al valor original
//     de una casilla deshace su cambio.
//   - «Guardar categorías» (M.guardarCategorias) → PUT …/gastos/categorias {permitidas, quitadas, version} con los arreglos en el
//     orden de CATEGORIAS_GND; 200 {version} → role status M.categoriasGuardadas y vuelve a leer. 409 version_cambiada → role alert
//     y vuelve a leer; 409 cliente_archivado → role alert. Sin cambios el botón queda deshabilitado.
//   - Sin `reglas.gestionar` (Asistente, Lectura) o con `archivado`: las casillas deshabilitadas y sin botón; el motivo visible
//     (M.categoriasSoloLectura | M.errores.cliente_archivado). Sin desborde a 390 px.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GESTIONA = ["clientes.ver", "reglas.ver", "reglas.gestionar"];

function instalar(
  vista: CategoriasClientePrueba = categoriasDe(),
  o: { rol?: RolPrueba; permisos?: string[]; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(o.rol ?? "contador", o.permisos ?? GESTIONA) },
    [RUTA_CATEGORIAS]: { status: 200, cuerpo: vista },
    ...o.extra,
  });
}

const casilla = (categoria: CategoriaPrueba) =>
  screen.findByRole("checkbox", { name: ETIQUETA_CATEGORIA[categoria] }) as Promise<HTMLInputElement>;
const guardar = () => screen.findByRole("button", { name: M.guardarCategorias }) as Promise<HTMLButtonElement>;

describe("<CategoriasCliente /> · lo que se ve (R-13, D-6)", () => {
  it("ferretería (CIIU 4752, sección G): la base no permite ninguna categoría y las seis casillas están sin marcar", async () => {
    instalar();
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect(await screen.findByText(M.giroDe("4752", "G"))).toBeTruthy();
    expect(screen.getByText(M.sinBase)).toBeTruthy();
    for (const c of CATEGORIAS) expect((await casilla(c)).checked, c).toBe(false);
  });

  it("restaurante (CIIU 5611, sección I): «alimentos-personales» viene marcada por su base y las demás no", async () => {
    instalar(categoriasRestaurante());
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect(await screen.findByText(M.giroDe("5611", "I"))).toBeTruthy();
    expect(screen.queryByText(M.sinBase)).toBeNull();
    expect((await casilla("alimentos-personales")).checked).toBe(true);
    expect((await casilla("calzado-ropa")).checked).toBe(false);
  });

  it("las efectivas mandan: una permitida por ajuste se ve marcada y una base quitada, desmarcada", async () => {
    instalar(
      categoriasRestaurante({
        permitidas: ["calzado-ropa"],
        quitadas: ["alimentos-personales"],
        efectivas: ["calzado-ropa"],
        version: 5,
      }),
    );
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect((await casilla("calzado-ropa")).checked).toBe(true);
    expect((await casilla("alimentos-personales")).checked).toBe(false);
  });

  it("sin CIIU del cliente: lo dice (solo cuentan las categorías quitadas) y no muestra «sección»", async () => {
    instalar(categoriasDe({ ciiu: null, seccion: null }));
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect(await screen.findByText(M.sinCiiu)).toBeTruthy();
    expect(screen.queryByText(/sección/)).toBeNull();
  });

  it("error: un 404 de la vista muestra «no encontrado» y ninguna casilla", async () => {
    instalar(categoriasDe(), { extra: { [RUTA_CATEGORIAS]: { status: 404, cuerpo: { codigo: "no_encontrado" } } } });
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect((await screen.findByRole("alert")).textContent).toBe(MENSAJES_ACCESO.noEncontrado);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("<CategoriasCliente /> · permitir y quitar (CA-1)", () => {
  it("permitir «calzado-ropa» a la ferretería manda permitidas [calzado-ropa], quitadas [] y la versión; anuncia y vuelve a leer", async () => {
    const f = instalar(categoriasDe({ version: 3 }), {
      extra: { [RUTA_FIJAR_CATEGORIAS]: { status: 200, cuerpo: { version: 4 } } },
    });
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    const usuario = userEvent.setup();
    expect((await guardar()).disabled).toBe(true);

    await usuario.click(await casilla("calzado-ropa"));
    expect((await casilla("calzado-ropa")).checked).toBe(true);
    expect((await guardar()).disabled).toBe(false);
    await usuario.click(await guardar());

    await vi.waitFor(() => expect(f.de(RUTA_FIJAR_CATEGORIAS)).toHaveLength(1));
    expect(f.de(RUTA_FIJAR_CATEGORIAS)[0]!.body).toEqual({ permitidas: ["calzado-ropa"], quitadas: [], version: 3 });
    expect(f.de(RUTA_FIJAR_CATEGORIAS)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain(M.categoriasGuardadas);
    await vi.waitFor(() => expect(f.de(RUTA_CATEGORIAS).length).toBe(2));
  });

  it("quitar una categoría de la base la manda en quitadas; varias salen en el orden canónico", async () => {
    const f = instalar(
      categoriasRestaurante({ base: ["entretenimiento", "alimentos-personales"], efectivas: ["entretenimiento", "alimentos-personales"] }),
      { extra: { [RUTA_FIJAR_CATEGORIAS]: { status: 200, cuerpo: { version: 3 } } } },
    );
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    const usuario = userEvent.setup();

    // Se tocan en desorden: el cuerpo va en el orden de CATEGORIAS_GND.
    await usuario.click(await casilla("alimentos-personales"));
    await usuario.click(await casilla("entretenimiento"));
    await usuario.click(await casilla("juguetes"));
    await usuario.click(await guardar());

    await vi.waitFor(() => expect(f.de(RUTA_FIJAR_CATEGORIAS)).toHaveLength(1));
    expect(f.de(RUTA_FIJAR_CATEGORIAS)[0]!.body).toEqual({
      permitidas: ["juguetes"],
      quitadas: ["entretenimiento", "alimentos-personales"],
      version: 2,
    });
  });

  it("desmarcar una permitida por ajuste la saca de permitidas; marcarla y desmarcarla de nuevo deja el botón deshabilitado", async () => {
    const f = instalar(categoriasDe({ permitidas: ["calzado-ropa"], efectivas: ["calzado-ropa"], version: 1 }), {
      extra: { [RUTA_FIJAR_CATEGORIAS]: { status: 200, cuerpo: { version: 2 } } },
    });
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    const usuario = userEvent.setup();

    await usuario.click(await casilla("calzado-ropa"));
    await usuario.click(await casilla("calzado-ropa"));
    expect((await guardar()).disabled).toBe(true);
    await usuario.click(await casilla("calzado-ropa"));
    await usuario.click(await guardar());

    await vi.waitFor(() => expect(f.de(RUTA_FIJAR_CATEGORIAS)).toHaveLength(1));
    expect(f.de(RUTA_FIJAR_CATEGORIAS)[0]!.body).toEqual({ permitidas: [], quitadas: [], version: 1 });
  });

  it("volver a marcar una base quitada la saca de quitadas", async () => {
    const f = instalar(
      categoriasRestaurante({ quitadas: ["alimentos-personales"], efectivas: [], version: 4 }),
      { extra: { [RUTA_FIJAR_CATEGORIAS]: { status: 200, cuerpo: { version: 5 } } } },
    );
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    const usuario = userEvent.setup();

    expect((await casilla("alimentos-personales")).checked).toBe(false);
    await usuario.click(await casilla("alimentos-personales"));
    await usuario.click(await guardar());

    await vi.waitFor(() => expect(f.de(RUTA_FIJAR_CATEGORIAS)).toHaveLength(1));
    expect(f.de(RUTA_FIJAR_CATEGORIAS)[0]!.body).toEqual({ permitidas: [], quitadas: [], version: 4 });
  });

  it.each([
    ["version_cambiada", M.errores.version_cambiada],
    ["cliente_archivado", M.errores.cliente_archivado],
  ])("409 %s: mensaje en español (sin el código) y las casillas conservan lo elegido", async (codigo, mensaje) => {
    const f = instalar(categoriasDe(), { extra: { [RUTA_FIJAR_CATEGORIAS]: { status: 409, cuerpo: { codigo } } } });
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    const usuario = userEvent.setup();

    await usuario.click(await casilla("juguetes"));
    await usuario.click(await guardar());

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(mensaje);
    expect(alerta.textContent).not.toContain(codigo);
    if (codigo === "version_cambiada") await vi.waitFor(() => expect(f.de(RUTA_CATEGORIAS).length).toBe(2));
  });
});

describe("<CategoriasCliente /> · permisos y cliente archivado (CA-8)", () => {
  it.each([
    ["Asistente", "asistente", ["clientes.ver", "reglas.ver"]],
    ["Lectura", "lectura", ["clientes.ver", "reglas.ver"]],
  ] as const)("%s: ve las categorías con el motivo, casillas deshabilitadas y sin botón de guardar", async (_caso, rol, permisos) => {
    const f = instalar(categoriasRestaurante(), { rol, permisos: [...permisos] });
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect((await casilla("alimentos-personales")).checked).toBe(true);
    expect(screen.getByText(M.categoriasSoloLectura)).toBeTruthy();
    for (const c of CATEGORIAS) expect((await casilla(c)).disabled, c).toBe(true);
    expect(screen.queryByRole("button", { name: M.guardarCategorias })).toBeNull();
    await asentar();
    expect(f.llamadas.filter((l) => l.method !== "GET")).toHaveLength(0);
  });

  it("el Contador asignado con reglas.gestionar sí edita (alcance del cliente, no global)", async () => {
    instalar();
    render(<CategoriasCliente clienteId={CLIENTE_ID} />);

    expect((await casilla("juguetes")).disabled).toBe(false);
    expect(screen.queryByText(M.categoriasSoloLectura)).toBeNull();
  });

  it("cliente archivado: solo lectura con M.errores.cliente_archivado y sin llamadas de escritura", async () => {
    const f = instalar();
    render(<CategoriasCliente clienteId={CLIENTE_ID} archivado />);

    expect(await screen.findByText(M.errores.cliente_archivado)).toBeTruthy();
    for (const c of CATEGORIAS) expect((await casilla(c)).disabled, c).toBe(true);
    expect(screen.queryByRole("button", { name: M.guardarCategorias })).toBeNull();
    expect(f.llamadas.filter((l) => l.method !== "GET")).toHaveLength(0);
  });
});

describe("<CategoriasCliente /> · 390 px", () => {
  it("no fija anchos mayores a la pantalla ni esconde nada tras un scroll interior", async () => {
    instalar(categoriasRestaurante());
    const { container } = render(<CategoriasCliente clienteId={CLIENTE_ID} />);
    await casilla("juguetes");

    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});

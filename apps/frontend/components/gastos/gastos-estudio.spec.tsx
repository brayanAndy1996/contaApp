import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar, esperarFila, rutaSesion, yoDe, type RolPrueba } from "../../pruebas/acceso";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import { TEXTO_HOSTIL } from "../../pruebas/compras";
import {
  AUTOR_ROSA,
  ETIQUETA_CATEGORIA,
  G_POLO,
  G_ZAPATILLA,
  MENSAJES_GASTOS as M,
  P_AUDIFONOS,
  P_MOCHILA,
  P_PERFUME,
  RUTA_AGREGAR_PALABRA,
  RUTA_GASTOS,
  RUTA_UMBRAL,
  gastosEstudioDe,
  rutaGlobal,
  rutaPalabra,
  type GastosEstudioPrueba,
} from "../../pruebas/gastos";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { GastosEstudio } from "./gastos-estudio";

// Spec 027 · T7 (rojo; CA-8, CA-10, R-4, R-11, D-3). Sección «Gastos no deducibles» de «Reglas del motor».
// Contrato (T13), `components/gastos/gastos-estudio.tsx`: <GastosEstudio />, sin props (la página de `configuracion/reglas` la monta
// bajo <ReglasMotor />; los seis interruptores de 021 no cambian).
//   - Lee GET /api/estudio/reglas-motor/gastos (`GastosEstudioVista`) y GET /api/acceso/yo.
//   - Umbral: campo numérico M.campoUmbral con el valor del servidor y botón M.guardarUmbral. 0, 21 o un decimal se rechazan en el
//     formulario (role alert M.umbralInvalido, sin petición). Válido → PUT …/umbral {umbral, version: versionUmbral}; 200 {version}
//     → role status M.umbralGuardado y se vuelve a leer la vista. 409 version_cambiada → role alert M.errores.version_cambiada y
//     se vuelve a leer.
//   - Globales (table M.tituloGlobales): una fila por palabra con su categoría (texto de ETIQUETA_CATEGORIA) y excepciones; el botón
//     M.desactivarGlobal(p) → PUT …/globales/:id {activa:false}; la desactivada por el estudio muestra M.globalDesactivada y el botón
//     M.reactivarGlobal(p) → {activa:true}. Cada cambio anuncia M.globalCambiada en un role status y vuelve a leer la vista.
//   - Propias (table M.tituloPropias): una fila por palabra con categoría, excepciones, origen (M.origen), autor (M.autorDe) y la
//     inactiva con M.propiaInactiva; contador M.contador(activasPropias). «Desactivar/Reactivar» → PUT …/palabras/:id
//     {activa, version: la de la fila}. Sin palabras propias: M.sinPropias.
//   - «Agregar palabra» (M.agregarPalabra) abre un Dialog (role dialog, mismo nombre) con la Palabra, la Categoría (combobox con el
//     código como value; M.categoriaRequerida si se deja sin elegir), las Excepciones (coma) y M.guardarPalabra → POST …/palabras
//     {palabra, categoria, excepciones: string[]} (siempre el arreglo, vacío si no hay). 201 → cierra, role status M.palabraAgregada
//     y vuelve a leer. 409 palabra_existente | limite_palabras → role alert dentro del diálogo, que sigue abierto. Palabra con
//     espacios o de menos de 3 caracteres: M.palabraInvalida; más de 5 excepciones o de más de 3 palabras: M.excepcionesInvalidas.
//   - Buscar (textbox M.campoBuscar): filtra globales y propias por la palabra (sin tildes ni mayúsculas); sin coincidencias M.sinCoincidencias.
//   - Solo lectura (sin `reglas.gestionar` o sin alcance global: Contador asignado, Administrador sin permiso): se ven umbral, listas y
//     contador, con M.soloLectura; el campo del umbral queda deshabilitado y no hay botones de escritura (el servidor valida: esto solo oculta).
//   - Textos del servidor (nombres de autor) son texto, nunca HTML. Sin desborde a 390 px.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERMISOS = ["clientes.ver", "reglas.ver", "reglas.gestionar"];

function instalar(
  vista: GastosEstudioPrueba = gastosEstudioDe(),
  o: { rol?: RolPrueba; permisos?: string[]; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe(o.rol ?? "dueno", o.permisos ?? PERMISOS) },
    [RUTA_GASTOS]: { status: 200, cuerpo: vista },
    ...o.extra,
  });
}

const campoUmbral = () => screen.findByRole("spinbutton", { name: M.campoUmbral }) as Promise<HTMLInputElement>;
const boton = (nombre: string) => screen.findByRole("button", { name: nombre });
const lecturas = (f: ReturnType<typeof instalar>) => f.de(RUTA_GASTOS).length;

async function fijarUmbral(usuario: ReturnType<typeof userEvent.setup>, valor: string) {
  const campo = await campoUmbral();
  await usuario.clear(campo);
  await usuario.type(campo, valor);
  await usuario.click(await boton(M.guardarUmbral));
}

describe("<GastosEstudio /> · lo que se ve (R-4, R-11)", () => {
  it("feliz: umbral, globales con su estado, propias con origen y autor, y el contador «2 de 2.000»", async () => {
    instalar();
    render(<GastosEstudio />);

    expect((await campoUmbral()).value).toBe("3");
    const zapatilla = await esperarFila("zapatilla");
    expect(zapatilla.textContent).toContain(ETIQUETA_CATEGORIA["calzado-ropa"]);
    expect(zapatilla.textContent).toContain("seguridad");
    expect(zapatilla.textContent).toContain("punta de acero");
    const polo = await esperarFila("polo");
    expect(within(polo).getByText(M.globalDesactivada)).toBeTruthy();
    expect(within(polo).getByRole("button", { name: M.reactivarGlobal("polo") })).toBeTruthy();
    expect(within(zapatilla).getByRole("button", { name: M.desactivarGlobal("zapatilla") })).toBeTruthy();

    const audifonos = await esperarFila("audifonos");
    expect(audifonos.textContent).toContain(ETIQUETA_CATEGORIA.entretenimiento);
    expect(within(audifonos).getByText(M.origen.aprendida)).toBeTruthy();
    expect(audifonos.textContent).toContain(M.autorDe(AUTOR_ROSA.nombre));
    const mochila = await esperarFila("mochila");
    expect(within(mochila).getByText(M.origen.manual)).toBeTruthy();
    expect(mochila.textContent).toContain("fumigadora");
    expect(within(await esperarFila("perfume")).getByText(M.propiaInactiva)).toBeTruthy();
    expect(screen.getByText(M.contador(2))).toBeTruthy();
    expect(screen.queryByText(M.soloLectura)).toBeNull();
  });

  it("sin palabras propias: «El estudio aún no tiene palabras propias.» y «0 de 2.000»", async () => {
    instalar(gastosEstudioDe({ propias: [], activasPropias: 0 }));
    render(<GastosEstudio />);

    expect(await screen.findByText(M.sinPropias)).toBeTruthy();
    expect(screen.getByText(M.contador(0))).toBeTruthy();
  });

  it("el nombre del autor con HTML se ve como texto, no como elemento", async () => {
    const base = gastosEstudioDe();
    instalar(
      gastosEstudioDe({ propias: [{ ...base.propias[0]!, autor: { id: AUTOR_ROSA.id, nombre: TEXTO_HOSTIL, activo: true } }] }),
    );
    const { container } = render(<GastosEstudio />);

    expect((await esperarFila("audifonos")).textContent).toContain(TEXTO_HOSTIL);
    expect(container.querySelector("img")).toBeNull();
  });

  it("error: un 403 de la vista muestra el mensaje de permiso y nada más; otro error, el de carga", async () => {
    instalar(gastosEstudioDe(), { extra: { [RUTA_GASTOS]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } } });
    render(<GastosEstudio />);
    expect((await screen.findByRole("alert")).textContent).toBe(M.sinPermiso);
    expect(screen.queryByRole("spinbutton", { name: M.campoUmbral })).toBeNull();

    cleanup();
    instalar(gastosEstudioDe(), { extra: { [RUTA_GASTOS]: { status: 500, cuerpo: {} } } });
    render(<GastosEstudio />);
    expect((await screen.findByRole("alert")).textContent).toBe(M.errorCarga);
  });
});

describe("<GastosEstudio /> · umbral (R-11, CA-10)", () => {
  it("subir el umbral a 9 manda PUT {umbral, version}, anuncia «Umbral guardado.» y vuelve a leer", async () => {
    const f = instalar(gastosEstudioDe({ versionUmbral: 4 }), {
      extra: { [RUTA_UMBRAL]: { status: 200, cuerpo: { version: 5 } } },
    });
    render(<GastosEstudio />);
    const usuario = userEvent.setup();

    await fijarUmbral(usuario, "9");

    await vi.waitFor(() => expect(f.de(RUTA_UMBRAL)).toHaveLength(1));
    expect(f.de(RUTA_UMBRAL)[0]!.body).toEqual({ umbral: 9, version: 4 });
    expect(f.de(RUTA_UMBRAL)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain(M.umbralGuardado);
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });

  it.each(["1", "20"])("acepta el límite %s", async (valor) => {
    const f = instalar(gastosEstudioDe(), { extra: { [RUTA_UMBRAL]: { status: 200, cuerpo: { version: 1 } } } });
    render(<GastosEstudio />);

    await fijarUmbral(userEvent.setup(), valor);

    await vi.waitFor(() => expect(f.de(RUTA_UMBRAL)).toHaveLength(1));
    expect((f.de(RUTA_UMBRAL)[0]!.body as { umbral: number }).umbral).toBe(Number(valor));
  });

  it.each(["0", "21", "3.5", "-1"])("rechaza %s en el formulario: alerta en español y ninguna petición", async (valor) => {
    const f = instalar();
    render(<GastosEstudio />);

    await fijarUmbral(userEvent.setup(), valor);

    expect((await screen.findByRole("alert")).textContent).toBe(M.umbralInvalido);
    await asentar();
    expect(f.de(RUTA_UMBRAL)).toHaveLength(0);
  });

  it("el campo vacío tampoco se envía", async () => {
    const f = instalar();
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    await usuario.clear(await campoUmbral());
    await usuario.click(await boton(M.guardarUmbral));

    expect((await screen.findByRole("alert")).textContent).toBe(M.umbralInvalido);
    expect(f.de(RUTA_UMBRAL)).toHaveLength(0);
  });

  it("409 version_cambiada: mensaje en español (sin el código) y vuelve a leer la vista", async () => {
    const f = instalar(gastosEstudioDe(), {
      extra: { [RUTA_UMBRAL]: { status: 409, cuerpo: { codigo: "version_cambiada" } } },
    });
    render(<GastosEstudio />);

    await fijarUmbral(userEvent.setup(), "9");

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(M.errores.version_cambiada);
    expect(alerta.textContent).not.toContain("version_cambiada");
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });
});

describe("<GastosEstudio /> · palabras globales (R-8, D-3)", () => {
  it("desactivar «zapatilla» para el estudio manda PUT {activa:false}, lo anuncia y vuelve a leer", async () => {
    const f = instalar(gastosEstudioDe(), { extra: { [rutaGlobal(G_ZAPATILLA)]: { status: 200, cuerpo: {} } } });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.desactivarGlobal("zapatilla")));

    await vi.waitFor(() => expect(f.de(rutaGlobal(G_ZAPATILLA))).toHaveLength(1));
    expect(f.de(rutaGlobal(G_ZAPATILLA))[0]!.body).toEqual({ activa: false });
    expect(f.de(rutaGlobal(G_ZAPATILLA))[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain(M.globalCambiada("zapatilla", false));
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });

  it("reactivar «polo» manda PUT {activa:true}", async () => {
    const f = instalar(gastosEstudioDe(), { extra: { [rutaGlobal(G_POLO)]: { status: 200, cuerpo: {} } } });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.reactivarGlobal("polo")));

    await vi.waitFor(() => expect(f.de(rutaGlobal(G_POLO))).toHaveLength(1));
    expect(f.de(rutaGlobal(G_POLO))[0]!.body).toEqual({ activa: true });
    expect((await screen.findByRole("status")).textContent).toContain(M.globalCambiada("polo", true));
  });

  it("error: un 403 muestra el mensaje de permiso y la palabra conserva su estado", async () => {
    instalar(gastosEstudioDe(), {
      extra: { [rutaGlobal(G_ZAPATILLA)]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } },
    });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.desactivarGlobal("zapatilla")));

    expect((await screen.findByRole("alert")).textContent).toBe(M.sinPermiso);
    expect(within(await esperarFila("zapatilla")).queryByText(M.globalDesactivada)).toBeNull();
  });
});

describe("<GastosEstudio /> · palabras propias", () => {
  it("desactivar «audifonos» manda PUT {activa:false, version} con la versión de la fila", async () => {
    const f = instalar(gastosEstudioDe(), { extra: { [rutaPalabra(P_AUDIFONOS)]: { status: 200, cuerpo: { version: 2 } } } });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.desactivarPropia("audifonos")));

    await vi.waitFor(() => expect(f.de(rutaPalabra(P_AUDIFONOS))).toHaveLength(1));
    expect(f.de(rutaPalabra(P_AUDIFONOS))[0]!.body).toEqual({ activa: false, version: 1 });
    expect((await screen.findByRole("status")).textContent).toContain(M.propiaCambiada("audifonos", false));
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });

  it("reactivar «perfume» manda {activa:true, version:3}; 409 limite_palabras lo explica sin el código", async () => {
    const f = instalar(gastosEstudioDe(), {
      extra: { [rutaPalabra(P_PERFUME)]: { status: 409, cuerpo: { codigo: "limite_palabras" } } },
    });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.reactivarPropia("perfume")));

    await vi.waitFor(() => expect(f.de(rutaPalabra(P_PERFUME))).toHaveLength(1));
    expect(f.de(rutaPalabra(P_PERFUME))[0]!.body).toEqual({ activa: true, version: 3 });
    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.limite_palabras);
  });

  it("409 version_cambiada al desactivar: mensaje en español y vuelve a leer", async () => {
    const f = instalar(gastosEstudioDe(), {
      extra: { [rutaPalabra(P_MOCHILA)]: { status: 409, cuerpo: { codigo: "version_cambiada" } } },
    });
    render(<GastosEstudio />);

    await userEvent.setup().click(await boton(M.desactivarPropia("mochila")));

    expect((await screen.findByRole("alert")).textContent).toBe(M.errores.version_cambiada);
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });
});

describe("<GastosEstudio /> · agregar palabra con excepciones (R-4)", () => {
  async function abrir(usuario: ReturnType<typeof userEvent.setup>) {
    await usuario.click(await boton(M.agregarPalabra));
    return screen.findByRole("dialog", { name: M.agregarPalabra });
  }
  const palabra = () => screen.getByLabelText(M.campoPalabra) as HTMLInputElement;
  const excepciones = () => screen.getByLabelText(M.campoExcepciones) as HTMLInputElement;
  const categoria = () => screen.getByRole("combobox", { name: M.campoCategoria }) as HTMLSelectElement;

  it("feliz: «mochila» en útiles escolares con la excepción «fumigadora» manda el POST con el arreglo y vuelve a leer", async () => {
    const f = instalar(gastosEstudioDe(), {
      extra: { [RUTA_AGREGAR_PALABRA]: { status: 201, cuerpo: { id: P_MOCHILA, version: 1 } } },
    });
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);
    expect([...categoria().options].map((o) => o.value)).toEqual(
      expect.arrayContaining(["calzado-ropa", "juguetes", "entretenimiento", "alimentos-personales", "cuidado-personal", "utiles-escolares"]),
    );

    await usuario.type(palabra(), "mochila");
    await usuario.selectOptions(categoria(), "utiles-escolares");
    await usuario.type(excepciones(), "fumigadora, de campo");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));

    await vi.waitFor(() => expect(f.de(RUTA_AGREGAR_PALABRA)).toHaveLength(1));
    expect(f.de(RUTA_AGREGAR_PALABRA)[0]!.body).toEqual({
      palabra: "mochila",
      categoria: "utiles-escolares",
      excepciones: ["fumigadora", "de campo"],
    });
    expect(f.de(RUTA_AGREGAR_PALABRA)[0]!.headers["x-csrf-token"]).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toContain(M.palabraAgregada);
    await vi.waitFor(() => expect(lecturas(f)).toBe(2));
  });

  it("sin excepciones manda el arreglo vacío", async () => {
    const f = instalar(gastosEstudioDe(), {
      extra: { [RUTA_AGREGAR_PALABRA]: { status: 201, cuerpo: { id: P_MOCHILA, version: 1 } } },
    });
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);

    await usuario.type(palabra(), "karaoke");
    await usuario.selectOptions(categoria(), "entretenimiento");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));

    await vi.waitFor(() => expect(f.de(RUTA_AGREGAR_PALABRA)).toHaveLength(1));
    expect(f.de(RUTA_AGREGAR_PALABRA)[0]!.body).toEqual({ palabra: "karaoke", categoria: "entretenimiento", excepciones: [] });
  });

  it.each([
    ["con espacios", "dos palabras", M.palabraInvalida],
    ["de menos de 3 letras", "ab", M.palabraInvalida],
    ["de más de 40 caracteres", "a".repeat(41), M.palabraInvalida],
    ["con símbolos", "zapa-tilla", M.palabraInvalida],
  ])("rechaza una palabra %s en el formulario, sin petición", async (_caso, texto, mensaje) => {
    const f = instalar();
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);

    await usuario.type(palabra(), texto);
    await usuario.selectOptions(categoria(), "juguetes");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));

    expect((await within(dialogo).findByRole("alert")).textContent).toBe(mensaje);
    expect(f.de(RUTA_AGREGAR_PALABRA)).toHaveLength(0);
  });

  it("rechaza más de 5 excepciones o una de más de 3 palabras; sin categoría pide elegirla", async () => {
    const f = instalar();
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);
    await usuario.type(palabra(), "mochila");

    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));
    expect((await within(dialogo).findByRole("alert")).textContent).toBe(M.categoriaRequerida);

    await usuario.selectOptions(categoria(), "utiles-escolares");
    await usuario.type(excepciones(), "uno, dos, tres, cuatro, cinco, seis");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));
    await vi.waitFor(() => expect(within(dialogo).getByRole("alert").textContent).toBe(M.excepcionesInvalidas));

    await usuario.clear(excepciones());
    await usuario.type(excepciones(), "una frase de cuatro palabras");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));
    await vi.waitFor(() => expect(within(dialogo).getByRole("alert").textContent).toBe(M.excepcionesInvalidas));
    expect(f.de(RUTA_AGREGAR_PALABRA)).toHaveLength(0);
  });

  it.each([
    ["palabra_existente", M.errores.palabra_existente],
    ["limite_palabras", M.errores.limite_palabras],
  ])("409 %s: el mensaje va dentro del diálogo, que sigue abierto con lo escrito", async (codigo, mensaje) => {
    instalar(gastosEstudioDe(), { extra: { [RUTA_AGREGAR_PALABRA]: { status: 409, cuerpo: { codigo } } } });
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);

    await usuario.type(palabra(), "mochila");
    await usuario.selectOptions(categoria(), "utiles-escolares");
    await usuario.click(within(dialogo).getByRole("button", { name: M.guardarPalabra }));

    expect((await within(dialogo).findByRole("alert")).textContent).toBe(mensaje);
    expect(screen.getByRole("dialog", { name: M.agregarPalabra })).toBeTruthy();
    expect(palabra().value).toBe("mochila");
  });

  it("«Cancelar» cierra sin enviar nada", async () => {
    const f = instalar();
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    const dialogo = await abrir(usuario);

    await usuario.type(palabra(), "mochila");
    await usuario.click(within(dialogo).getByRole("button", { name: M.cancelar }));

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.de(RUTA_AGREGAR_PALABRA)).toHaveLength(0);
  });
});

describe("<GastosEstudio /> · búsqueda", () => {
  it("filtra globales y propias por la palabra, sin tildes ni mayúsculas; sin coincidencias lo dice", async () => {
    instalar();
    render(<GastosEstudio />);
    const usuario = userEvent.setup();
    await esperarFila("audifonos");
    const campo = screen.getByRole("textbox", { name: M.campoBuscar });

    await usuario.type(campo, "AUDÍF");
    await vi.waitFor(() => expect(screen.queryAllByRole("row").some((f) => f.textContent?.includes("zapatilla"))).toBe(false));
    expect(screen.queryAllByRole("row").some((f) => f.textContent?.includes("audifonos"))).toBe(true);

    await usuario.clear(campo);
    await usuario.type(campo, "zzzz");
    expect(await screen.findByText(M.sinCoincidencias)).toBeTruthy();
  });
});

describe("<GastosEstudio /> · solo lectura (CA-8, D-3)", () => {
  it.each([
    ["Contador asignado, aunque tenga reglas.gestionar", "contador", PERMISOS],
    ["Administrador sin reglas.gestionar", "admin", ["clientes.ver", "reglas.ver"]],
    ["Lectura", "lectura", ["clientes.ver", "reglas.ver"]],
  ] as const)("%s: ve todo con el motivo, el umbral deshabilitado y ningún botón de escritura", async (_caso, rol, permisos) => {
    const f = instalar(gastosEstudioDe(), { rol, permisos: [...permisos] });
    render(<GastosEstudio />);

    const campo = await campoUmbral();
    expect(campo.value).toBe("3");
    expect(campo.disabled || campo.readOnly).toBe(true);
    expect(screen.getByText(M.soloLectura)).toBeTruthy();
    expect(await esperarFila("zapatilla")).toBeTruthy();
    expect(screen.getByText(M.contador(2))).toBeTruthy();
    for (const nombre of [
      M.guardarUmbral,
      M.agregarPalabra,
      M.desactivarGlobal("zapatilla"),
      M.reactivarGlobal("polo"),
      M.desactivarPropia("audifonos"),
      M.reactivarPropia("perfume"),
    ]) {
      expect(screen.queryByRole("button", { name: nombre }), nombre).toBeNull();
    }
    await asentar();
    expect(f.llamadas.filter((l) => l.method !== "GET")).toHaveLength(0);
  });

  it("el Dueño con alcance global no ve el aviso de solo lectura", async () => {
    instalar();
    render(<GastosEstudio />);
    await campoUmbral();
    expect(screen.queryByText(M.soloLectura)).toBeNull();
    expect((await campoUmbral()).disabled).toBe(false);
  });
});

describe("<GastosEstudio /> · 390 px", () => {
  it("la sección y el diálogo no fijan anchos mayores a la pantalla ni esconden nada tras un scroll interior", async () => {
    instalar();
    const { container } = render(<GastosEstudio />);
    await esperarFila("audifonos");
    expect(anchosFijosMayoresA390(container)).toEqual([]);

    await userEvent.setup().click(await boton(M.agregarPalabra));
    await screen.findByRole("dialog", { name: M.agregarPalabra });
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

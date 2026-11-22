import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import {
  BASE,
  C_5070_ZAPATILLAS,
  MENSAJES_COMPRAS as MC,
  TEXTO_HOSTIL,
  accionDe,
  filaDe,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  PROPUESTA_CA9,
  rutaAprender,
  rutaPropuesta,
} from "../../pruebas/gastos";
import { ExcluirCompra } from "../compras/excluir-compra";
import { AprenderPalabras } from "./aprender-palabras";

// Spec 027 · T7 (rojo; CA-8, CA-9, R-7). «Aprender estas palabras» tras excluir una compra con XML.
// Contrato (T13), `components/gastos/aprender-palabras.tsx`: <AprenderPalabras contexto fila alCerrar />.
//   - Al montar pide GET …/periodos/:p/gastos/aprender/:compraId (`PropuestaAprenderVista {terminos}`). Con 1 a 10 términos abre un
//     Dialog (role dialog, nombre M.tituloAprender). Con 0 términos, un 409 (compra_no_excluida | compra_sin_xml) o cualquier otro
//     error NO muestra nada ni ninguna alerta y llama a `alCerrar()`: ofrecerlo nunca bloquea ni deshace la exclusión.
//   - Por cada término, en el orden recibido (i desde 1): casilla M.incluirTermino(i) (desmarcada), textbox M.campoTermino(i) con el
//     término (editable) y combobox M.campoCategoriaTermino(i) con la opción vacía M.elegirCategoria y las seis categorías (value =
//     código, texto = ETIQUETA_CATEGORIA).
//   - «Aprender palabras» (M.aprender): sin ninguna marcada → role alert M.ningunaMarcada; una marcada sin categoría →
//     M.categoriaObligatoria; un término corregido que no es una palabra de 3 a 40 letras o números → M.terminoInvalido. Ninguna
//     de las tres envía nada. Válido → POST …/aprender/:compraId {terminos: [{termino, categoria}]} solo con las marcadas y en el
//     orden de la lista; 200 {guardadas, omitidas} → role status con M.aprendidas(guardadas) y, si hay, M.omitidas(omitidas); el
//     diálogo sigue abierto con el botón M.cerrar, que llama a `alCerrar()`.
//   - «Ahora no» (M.ahoraNo) llama a `alCerrar()` sin enviar. Un 409 al guardar (limite_palabras, compra_no_excluida,
//     cliente_archivado…) se muestra como role alert DENTRO del diálogo, que sigue abierto.
//   - `ExcluirCompra` (015) lo ofrece tras excluir bien SOLO si `contexto.permisos.gestionarReglas` (Asistente y Lectura no lo ven y
//     ni siquiera lo piden): hace primero lo de siempre (recarga fila y resumen, aviso «compra excluida») y llama a `alTerminar()`
//     cuando el diálogo se cierra (o de inmediato si no hay nada que ofrecer). Sin desborde a 390 px.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILA = filaDe({ ...C_5070_ZAPATILLAS, version: 2, excluida: true });
const RUTA_PROPUESTA = rutaPropuesta(FILA.id);
const RUTA_APRENDER = rutaAprender(FILA.id);

function montar(
  o: {
    propuesta?: { status: number; cuerpo?: unknown };
    aprender?: { status: number; cuerpo?: unknown };
  } = {},
) {
  const f = instalarFetchCompras({
    extra: {
      [RUTA_PROPUESTA]: o.propuesta ?? { status: 200, cuerpo: PROPUESTA_CA9 },
      [RUTA_APRENDER]: o.aprender ?? { status: 200, cuerpo: { guardadas: ["audifonos"], omitidas: [] } },
    },
  });
  const alCerrar = vi.fn();
  const r = render(<AprenderPalabras contexto={contextoDe({ permisos: { gestionarReglas: true } })} fila={FILA} alCerrar={alCerrar} />);
  return { f, alCerrar, r, usuario: userEvent.setup() };
}

const dialogo = () => screen.findByRole("dialog", { name: M.tituloAprender });
const marcar = (usuario: ReturnType<typeof userEvent.setup>, i: number) =>
  usuario.click(screen.getByRole("checkbox", { name: M.incluirTermino(i) }));
const elegir = (usuario: ReturnType<typeof userEvent.setup>, i: number, categoria: string) =>
  usuario.selectOptions(screen.getByRole("combobox", { name: M.campoCategoriaTermino(i) }), categoria);
const enviar = (usuario: ReturnType<typeof userEvent.setup>) => usuario.click(screen.getByRole("button", { name: M.aprender }));

describe("<AprenderPalabras /> · propuesta (R-7, CA-9)", () => {
  it("feliz CA-9: ofrece «audifonos», «bluetooth» y «jbl» (no «x2», «und» ni «2.00»), sin marcar y con la categoría por elegir", async () => {
    const { f } = montar();
    const d = await dialogo();

    expect(f.de(RUTA_PROPUESTA)).toHaveLength(1);
    expect(within(d).getByText(M.introAprender)).toBeTruthy();
    PROPUESTA_CA9.terminos.forEach((t, i) => {
      expect((within(d).getByRole("textbox", { name: M.campoTermino(i + 1) }) as HTMLInputElement).value).toBe(t);
      expect((within(d).getByRole("checkbox", { name: M.incluirTermino(i + 1) }) as HTMLInputElement).checked).toBe(false);
      const combo = within(d).getByRole("combobox", { name: M.campoCategoriaTermino(i + 1) }) as HTMLSelectElement;
      expect(combo.value).toBe("");
      expect([...combo.options].map((o) => o.textContent)).toEqual([M.elegirCategoria, ...Object.values(ETIQUETA_CATEGORIA)]);
    });
    expect(within(d).queryByRole("textbox", { name: M.campoTermino(4) })).toBeNull();
    for (const ruido of ["x2", "und", "2.00"]) expect(d.textContent).not.toContain(ruido);
  });

  it("hasta 10 términos: los pinta todos en el orden recibido", async () => {
    const diez = ["alfombra", "bufanda", "cojin", "dado", "espejo", "florero", "guitarra", "hamaca", "iman", "jarron"];
    montar({ propuesta: { status: 200, cuerpo: { terminos: diez } } });
    const d = await dialogo();

    expect(within(d).getAllByRole("checkbox")).toHaveLength(10);
    diez.forEach((t, i) => expect((within(d).getByRole("textbox", { name: M.campoTermino(i + 1) }) as HTMLInputElement).value).toBe(t));
  });

  it("un término con HTML se ve como valor de texto, no como elemento", async () => {
    montar({ propuesta: { status: 200, cuerpo: { terminos: [TEXTO_HOSTIL] } } });
    const d = await dialogo();

    expect((within(d).getByRole("textbox", { name: M.campoTermino(1) }) as HTMLInputElement).value).toBe(TEXTO_HOSTIL);
    expect(document.querySelector("img")).toBeNull();
  });

  it.each([
    ["sin términos", { status: 200, cuerpo: { terminos: [] } }],
    ["409 compra_sin_xml", { status: 409, cuerpo: { codigo: "compra_sin_xml" } }],
    ["409 compra_no_excluida", { status: 409, cuerpo: { codigo: "compra_no_excluida" } }],
    ["403 permiso_denegado", { status: 403, cuerpo: { codigo: "permiso_denegado" } }],
    ["500", { status: 500, cuerpo: {} }],
  ])("%s: no muestra nada, ninguna alerta, y se cierra solo (nunca bloquea la exclusión)", async (_caso, propuesta) => {
    const { alCerrar } = montar({ propuesta });

    await vi.waitFor(() => expect(alCerrar).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("<AprenderPalabras /> · guardar (R-7, CA-9)", () => {
  it("feliz: elegir «audifonos» → entretenimiento y corregir «jbl» → «parlante» manda solo las marcadas, en orden, y avisa las guardadas", async () => {
    const { f, alCerrar, usuario } = montar({
      aprender: { status: 200, cuerpo: { guardadas: ["audifonos", "parlante"], omitidas: [] } },
    });
    await dialogo();

    await marcar(usuario, 1);
    await elegir(usuario, 1, "entretenimiento");
    await marcar(usuario, 3);
    const tercero = screen.getByRole("textbox", { name: M.campoTermino(3) });
    await usuario.clear(tercero);
    await usuario.type(tercero, "parlante");
    await elegir(usuario, 3, "entretenimiento");
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(RUTA_APRENDER)).toHaveLength(1));
    expect(f.de(RUTA_APRENDER)[0]!.body).toEqual({
      terminos: [
        { termino: "audifonos", categoria: "entretenimiento" },
        { termino: "parlante", categoria: "entretenimiento" },
      ],
    });
    expect(f.de(RUTA_APRENDER)[0]!.headers["x-csrf-token"]).toBeTruthy();
    const estado = await screen.findByRole("status");
    expect(estado.textContent).toContain(M.aprendidas(["audifonos", "parlante"]));
    expect(screen.getByRole("dialog", { name: M.tituloAprender })).toBeTruthy();
    expect(alCerrar).not.toHaveBeenCalled();

    await usuario.click(screen.getByRole("button", { name: M.cerrar }));
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("las omitidas (ya existían en el diccionario del estudio) se informan junto con las guardadas", async () => {
    const { usuario } = montar({ aprender: { status: 200, cuerpo: { guardadas: ["audifonos"], omitidas: ["jbl"] } } });
    await dialogo();

    await marcar(usuario, 1);
    await elegir(usuario, 1, "entretenimiento");
    await marcar(usuario, 3);
    await elegir(usuario, 3, "entretenimiento");
    await enviar(usuario);

    const estado = await screen.findByRole("status");
    expect(estado.textContent).toContain(M.aprendidas(["audifonos"]));
    expect(estado.textContent).toContain(M.omitidas(["jbl"]));
  });

  it("sin ninguna marcada: avisa y no envía", async () => {
    const { f, usuario } = montar();
    await dialogo();

    await enviar(usuario);

    expect((await screen.findByRole("alert")).textContent).toBe(M.ningunaMarcada);
    expect(f.de(RUTA_APRENDER)).toHaveLength(0);
  });

  it("una marcada sin categoría: la categoría es obligatoria, no envía", async () => {
    const { f, usuario } = montar();
    await dialogo();

    await marcar(usuario, 2);
    await enviar(usuario);

    expect((await screen.findByRole("alert")).textContent).toBe(M.categoriaObligatoria);
    expect(f.de(RUTA_APRENDER)).toHaveLength(0);
  });

  it.each([
    ["de menos de 3 letras", "ab"],
    ["con espacios", "dos palabras"],
    ["con símbolos", "bluetooth!"],
    ["de más de 40 caracteres", "a".repeat(41)],
    ["vacío", ""],
  ])("un término corregido %s se rechaza en el formulario, sin enviar", async (_caso, texto) => {
    const { f, usuario } = montar();
    await dialogo();

    await marcar(usuario, 2);
    await elegir(usuario, 2, "entretenimiento");
    const campo = screen.getByRole("textbox", { name: M.campoTermino(2) });
    await usuario.clear(campo);
    if (texto !== "") await usuario.type(campo, texto);
    await enviar(usuario);

    expect((await screen.findByRole("alert")).textContent).toBe(M.terminoInvalido);
    expect(f.de(RUTA_APRENDER)).toHaveLength(0);
  });

  it("un término sin marcar no se valida: puede quedar vacío o mal escrito si no se aprende", async () => {
    const { f, usuario } = montar();
    await dialogo();

    await marcar(usuario, 1);
    await elegir(usuario, 1, "entretenimiento");
    await usuario.clear(screen.getByRole("textbox", { name: M.campoTermino(3) }));
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(RUTA_APRENDER)).toHaveLength(1));
    expect(f.de(RUTA_APRENDER)[0]!.body).toEqual({ terminos: [{ termino: "audifonos", categoria: "entretenimiento" }] });
  });

  it.each([
    ["limite_palabras", M.errores.limite_palabras],
    ["compra_no_excluida", M.errores.compra_no_excluida],
    ["cliente_archivado", M.errores.cliente_archivado],
  ])("409 %s: el mensaje va dentro del diálogo (sin el código) y el diálogo sigue abierto con lo elegido", async (codigo, mensaje) => {
    const { alCerrar, usuario } = montar({ aprender: { status: 409, cuerpo: { codigo } } });
    const d = await dialogo();

    await marcar(usuario, 1);
    await elegir(usuario, 1, "juguetes");
    await enviar(usuario);

    const alerta = await within(d).findByRole("alert");
    expect(alerta.textContent).toBe(mensaje);
    expect(alerta.textContent).not.toContain(codigo);
    expect((screen.getByRole("combobox", { name: M.campoCategoriaTermino(1) }) as HTMLSelectElement).value).toBe("juguetes");
    expect(alCerrar).not.toHaveBeenCalled();
  });

  it("«Ahora no» cierra sin enviar nada", async () => {
    const { f, alCerrar, usuario } = montar();
    await dialogo();

    await marcar(usuario, 1);
    await usuario.click(screen.getByRole("button", { name: M.ahoraNo }));

    expect(alCerrar).toHaveBeenCalledTimes(1);
    await asentar();
    expect(f.de(RUTA_APRENDER)).toHaveLength(0);
  });
});

describe("<AprenderPalabras /> · 390 px", () => {
  it("el diálogo con diez términos no fija anchos mayores a la pantalla ni esconde nada tras un scroll interior", async () => {
    const diez = ["alfombra", "bufanda", "cojin", "dado", "espejo", "florero", "guitarra", "hamaca", "iman", "jarron"];
    montar({ propuesta: { status: 200, cuerpo: { terminos: diez } } });
    await dialogo();

    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

describe("<ExcluirCompra /> · ofrece aprender tras excluir (R-7, CA-8)", () => {
  const original = C_5070_ZAPATILLAS;
  const rutaExcluir = `POST ${BASE}/${original.id}/excluir`;
  const EXCLUIDA = accionDe(filaDe({ ...original, version: 2, excluida: true, motivo: "Gasto personal" }));

  function montarExcluir(
    permisos: { gestionarReglas?: boolean },
    propuesta: { status: number; cuerpo?: unknown } = { status: 200, cuerpo: PROPUESTA_CA9 },
  ) {
    const f = instalarFetchCompras({
      extra: {
        [rutaExcluir]: { status: 200, cuerpo: EXCLUIDA },
        [rutaPropuesta(original.id)]: propuesta,
      },
    });
    const contexto = contextoDe({ permisos });
    const alTerminar = vi.fn();
    const alAvisar = vi.fn();
    render(
      <ExcluirCompra contexto={contexto} fila={original} alTerminar={alTerminar} alCancelar={vi.fn()} alAvisar={alAvisar} />,
    );
    return { f, contexto, alTerminar, alAvisar, usuario: userEvent.setup() };
  }
  const excluir = (usuario: ReturnType<typeof userEvent.setup>) => usuario.click(screen.getByRole("button", { name: MC.excluir }));

  it("con reglas.gestionar: primero la exclusión de siempre; después el diálogo, y «alTerminar» recién al cerrarlo", async () => {
    const { f, contexto, alTerminar, alAvisar, usuario } = montarExcluir({ gestionarReglas: true });

    await excluir(usuario);

    await dialogo();
    expect(f.de(rutaExcluir)).toHaveLength(1);
    expect(contexto.recargarFila).toHaveBeenCalledWith(original.id);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alAvisar).toHaveBeenCalledWith(MC.compraExcluida, "ok");
    expect(f.de(rutaPropuesta(original.id))).toHaveLength(1);
    expect(alTerminar).not.toHaveBeenCalled();

    await usuario.click(screen.getByRole("button", { name: M.ahoraNo }));
    expect(alTerminar).toHaveBeenCalledTimes(1);
  });

  it("con reglas.gestionar pero la compra sin XML (409 compra_sin_xml): excluye, no hay diálogo ni alerta y termina de inmediato", async () => {
    const { alTerminar, alAvisar, usuario } = montarExcluir(
      { gestionarReglas: true },
      { status: 409, cuerpo: { codigo: "compra_sin_xml" } },
    );

    await excluir(usuario);

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(alAvisar).toHaveBeenCalledWith(MC.compraExcluida, "ok");
    expect(screen.queryByRole("dialog", { name: M.tituloAprender })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["Asistente o Lectura (gestionarReglas falso)", { gestionarReglas: false }],
    ["sin el permiso en el contexto", {}],
  ])("%s: excluye, termina de inmediato y nunca pide la propuesta ni muestra el diálogo", async (_caso, permisos) => {
    const { f, alTerminar, usuario } = montarExcluir(permisos);

    await excluir(usuario);

    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    await asentar();
    expect(f.de(rutaPropuesta(original.id))).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: M.tituloAprender })).toBeNull();
  });

  it("si la exclusión falla (409 periodo_generado) no se ofrece aprender", async () => {
    const f = instalarFetchCompras({
      extra: { [rutaExcluir]: { status: 409, cuerpo: { codigo: "periodo_generado" } } },
    });
    const alTerminar = vi.fn();
    render(
      <ExcluirCompra
        contexto={contextoDe({ permisos: { gestionarReglas: true } })}
        fila={original}
        alTerminar={alTerminar}
        alCancelar={vi.fn()}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: MC.excluir }));

    expect((await screen.findByRole("alert")).textContent).toBe(MC.errores.periodo_generado);
    expect(f.de(rutaPropuesta(original.id))).toHaveLength(0);
    expect(alTerminar).not.toHaveBeenCalled();
  });
});

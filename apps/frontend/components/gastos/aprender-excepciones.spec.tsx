import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { C_5070_ZAPATILLAS, filaDe, instalarFetchCompras } from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { MENSAJES_GASTOS as M, rutaAprender, rutaPropuesta } from "../../pruebas/gastos";
import { AprenderPalabras } from "./aprender-palabras";

// Spec 027 · T19 (rojo; H-027-2-3, decisión 2026-11-23). «Aprender estas palabras» muestra las frases de excepción que la propuesta trae para los
// términos cuyo singular o plural es otra palabra («medias» → «media pulgada») y las manda al guardar. CONTRATO que fija T19 (T20b lo implementa;
// el backend lo fija `apps/backend/src/modules/gastos/ronda2.correcciones.int.spec.ts`):
//   GET …/aprender/:compraId -> `{terminos: string[], excepciones?: {[termino]: string[]}}`: las frases de cada término van visibles dentro de
//     su fila (como texto, no editable en esta primera versión) y solo en la fila de ese término.
//   POST …/aprender/:compraId -> cada término marcado `{termino, categoria}` más `excepciones: string[]` SOLO si la propuesta trae para ese término
//     y la persona no cambió el texto del término (si lo corrige, las frases ya no aplican). Sin `excepciones` en la propuesta, el cuerpo es el de siempre.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILA = filaDe({ ...C_5070_ZAPATILLAS, version: 2, excluida: true });
const FRASES = ["media pulgada", "media presion"];
const PROPUESTA = { terminos: ["medias", "bluetooth"], excepciones: { medias: FRASES } };

function montar(propuesta: unknown = PROPUESTA) {
  const f = instalarFetchCompras({
    extra: {
      [rutaPropuesta(FILA.id)]: { status: 200, cuerpo: propuesta },
      [rutaAprender(FILA.id)]: { status: 200, cuerpo: { guardadas: ["medias", "bluetooth"], omitidas: [] } },
    },
  });
  const alCerrar = vi.fn();
  render(<AprenderPalabras contexto={contextoDe({ permisos: { gestionarReglas: true } })} fila={FILA} alCerrar={alCerrar} />);
  return { f, alCerrar, usuario: userEvent.setup() };
}
const dialogo = () => screen.findByRole("dialog", { name: M.tituloAprender });
type Usuario = ReturnType<typeof userEvent.setup>;
const marcar = (u: Usuario, i: number, categoria: string) =>
  u.click(screen.getByRole("checkbox", { name: M.incluirTermino(i) })).then(() => u.selectOptions(screen.getByRole("combobox", { name: M.campoCategoriaTermino(i) }), categoria));
const enviar = (u: Usuario) => u.click(screen.getByRole("button", { name: M.aprender }));

describe("<AprenderPalabras /> · frases de excepción propuestas (H-027-2-3)", () => {
  it("las muestra en la fila de «medias» y en ninguna otra, sin cerrar el diálogo por el campo nuevo", async () => {
    montar();
    const d = await dialogo();
    for (const frase of FRASES) expect(d.textContent).toContain(frase);
    expect(d.textContent!.split("media pulgada")).toHaveLength(2);
    expect((within(d).getByRole("textbox", { name: M.campoTermino(1) }) as HTMLInputElement).value).toBe("medias");
    expect((within(d).getByRole("textbox", { name: M.campoTermino(2) }) as HTMLInputElement).value).toBe("bluetooth");
  });

  it("al guardar manda las frases solo del término que las trae; «bluetooth» va como siempre", async () => {
    const { f, usuario } = montar();
    await dialogo();
    await marcar(usuario, 1, "calzado-ropa");
    await marcar(usuario, 2, "entretenimiento");
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(rutaAprender(FILA.id))).toHaveLength(1));
    expect(f.de(rutaAprender(FILA.id))[0]!.body).toEqual({
      terminos: [
        { termino: "medias", categoria: "calzado-ropa", excepciones: FRASES },
        { termino: "bluetooth", categoria: "entretenimiento" },
      ],
    });
  });

  it("si la persona corrige el término («medias» → «calcetines») las frases ya no aplican y no se mandan", async () => {
    const { f, usuario } = montar();
    await dialogo();
    const campo = screen.getByRole("textbox", { name: M.campoTermino(1) });
    await usuario.clear(campo);
    await usuario.type(campo, "calcetines");
    await marcar(usuario, 1, "calzado-ropa");
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(rutaAprender(FILA.id))).toHaveLength(1));
    expect(f.de(rutaAprender(FILA.id))[0]!.body).toEqual({ terminos: [{ termino: "calcetines", categoria: "calzado-ropa" }] });
  });

  it("si no marca «medias», sus frases no viajan", async () => {
    const { f, usuario } = montar();
    await dialogo();
    await marcar(usuario, 2, "entretenimiento");
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(rutaAprender(FILA.id))).toHaveLength(1));
    expect(f.de(rutaAprender(FILA.id))[0]!.body).toEqual({ terminos: [{ termino: "bluetooth", categoria: "entretenimiento" }] });
  });

  it("regresión: sin `excepciones` en la propuesta, el diálogo y el cuerpo son los de siempre", async () => {
    const { f, usuario } = montar({ terminos: ["medias", "bluetooth"] });
    await dialogo();
    await marcar(usuario, 1, "calzado-ropa");
    await enviar(usuario);

    await vi.waitFor(() => expect(f.de(rutaAprender(FILA.id))).toHaveLength(1));
    expect(f.de(rutaAprender(FILA.id))[0]!.body).toEqual({ terminos: [{ termino: "medias", categoria: "calzado-ropa" }] });
  });
});

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextoDe } from "../../pruebas/contexto-compras";
import { MENSAJES_GASTOS as M } from "../../pruebas/gastos";
import { AnfitrionAprender, useOfrecerAprender, type OfertaAprender } from "./anfitrion-aprender";

// Spec 027 · T19 (rojo; H-027-2-9, T13a). Contrato del anfitrión: cada `alCerrar` se llama UNA vez, también el de una oferta que otra reemplaza
// mientras aún pide su propuesta (la grilla sigue usable: se puede excluir otra fila). T18 fija el caso mínimo (`anfitrion-aprender.adv.spec.tsx`);
// aquí, tres ofertas, la respuesta tardía de la reemplazada y el uso normal.

type Respuesta = { ok: true; datos: { terminos: string[] } };
const pendientes: { resolver: (r: Respuesta) => void }[] = [];
vi.mock("../../lib/gastos", async (original) => ({
  ...(await original<typeof import("../../lib/gastos")>()),
  leerPropuestaAprender: vi.fn(() => new Promise((resolver) => pendientes.push({ resolver }))),
}));

afterEach(() => {
  cleanup();
  pendientes.length = 0;
});

let ofrecer: ((o: OfertaAprender) => void) | null = null;
function Captura() {
  const o = useOfrecerAprender();
  useEffect(() => {
    ofrecer = o;
  }, [o]);
  return null;
}

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const contexto = contextoDe({ permisos: { gestionarReglas: true } });
const montar = () =>
  render(
    <AnfitrionAprender>
      <Captura />
    </AnfitrionAprender>,
  );
const ofertar = (n: number, alCerrar: () => void) => act(async () => ofrecer!({ contexto, fila: { id: ID(n) }, alCerrar }));
const responder = (i: number, terminos: string[]) => act(async () => pendientes[i]!.resolver({ ok: true, datos: { terminos } }));

describe("T19 · AnfitrionAprender: cada oferta avisa una vez cuando termina (H-027-2-9)", () => {
  it("tres ofertas seguidas mientras cargan: la primera y la segunda avisan al ser reemplazadas, la tercera al cerrarse; ninguna dos veces", async () => {
    montar();
    const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
    await ofertar(1, a);
    await ofertar(2, b);
    await ofertar(3, c);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();

    await act(async () => {
      for (const p of pendientes) p.resolver({ ok: true, datos: { terminos: [] } });
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("la propuesta tardía de la oferta reemplazada no abre un diálogo: solo se ve el de la vigente y «Ahora no» avisa a la vigente, no a la reemplazada", async () => {
    montar();
    const [primera, segunda] = [vi.fn(), vi.fn()];
    await ofertar(1, primera);
    await ofertar(2, segunda);
    expect(primera).toHaveBeenCalledTimes(1);

    await responder(0, ["alfa"]);
    expect(screen.queryByRole("dialog"), "la reemplazada no abre diálogo").toBeNull();
    await responder(1, ["bravo", "charlie"]);
    const dialogos = await screen.findAllByRole("dialog", { name: M.tituloAprender });
    expect(dialogos).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: M.campoTermino(1) }) as HTMLInputElement).value).toBe("bravo");
    expect(screen.queryByDisplayValue("alfa")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: M.ahoraNo }));
    expect(segunda).toHaveBeenCalledTimes(1);
    expect(primera).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("regresión: una oferta sola con términos abre el diálogo, no avisa hasta cerrarlo y avisa una sola vez; la siguiente oferta ya cerrada funciona igual", async () => {
    montar();
    const [primera, segunda] = [vi.fn(), vi.fn()];
    await ofertar(1, primera);
    await responder(0, ["alfa"]);
    await screen.findByRole("dialog", { name: M.tituloAprender });
    expect(primera).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: M.ahoraNo }));
    expect(primera).toHaveBeenCalledTimes(1);

    await ofertar(2, segunda);
    await responder(1, []);
    expect(segunda).toHaveBeenCalledTimes(1);
    expect(primera).toHaveBeenCalledTimes(1);
  });
});

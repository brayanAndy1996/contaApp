import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextoDe } from "../../pruebas/contexto-compras";
import { AnfitrionAprender, useOfrecerAprender, type OfertaAprender } from "./anfitrion-aprender";

// Spec 027 · T18 (ronda adversarial 2, pantalla). Caja blanca de `anfitrion-aprender.tsx` (T13a): el anfitrión guarda UNA oferta y
// `ExcluirCompra` confía en que su `alTerminar` llega «solo al cerrar el diálogo, o de inmediato si no hay nada que ofrecer»
// (contrato de T13a). Mientras se pide la propuesta (sin diálogo modal todavía) la grilla sigue usable y se puede excluir otra fila.

const pendientes: { resolver: (r: unknown) => void }[] = [];
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

describe("T18 · AnfitrionAprender: dos exclusiones seguidas (T13a)", () => {
  it("H-027-2-9 · si llega otra oferta mientras la primera aún pide su propuesta, el `alCerrar` de la primera se llama (nadie queda esperando)", async () => {
    render(
      <AnfitrionAprender>
        <Captura />
      </AnfitrionAprender>,
    );
    const contexto = contextoDe({ permisos: { gestionarReglas: true } });
    const primera = vi.fn();
    const segunda = vi.fn();
    await act(async () => ofrecer!({ contexto, fila: { id: "11111111-1111-4111-8111-111111111111" }, alCerrar: primera }));
    // Antes de que responda la propuesta de la primera, el contador excluye otra fila (desde la grilla o la lupa).
    await act(async () => ofrecer!({ contexto, fila: { id: "22222222-2222-4222-8222-222222222222" }, alCerrar: segunda }));
    // Las dos propuestas responden «sin términos»: cada diálogo se cierra solo y avisa a quien lo pidió.
    await act(async () => {
      for (const p of pendientes) p.resolver({ ok: true, datos: { terminos: [] } });
    });
    expect(segunda).toHaveBeenCalledTimes(1);
    expect(primera).toHaveBeenCalledTimes(1);
  });
});

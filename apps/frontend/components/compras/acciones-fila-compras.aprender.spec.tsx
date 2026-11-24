import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  BASE,
  C_5070_ZAPATILLAS,
  MENSAJES_COMPRAS as M,
  accionDe,
  filaDe,
  instalarFetchCompras,
} from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { MENSAJES_GASTOS as MG, PROPUESTA_CA9, rutaPropuesta } from "../../pruebas/gastos";
import { AnfitrionAprender } from "../gastos/anfitrion-aprender";
import { AccionesFilaCompras } from "./acciones-fila-compras";

// Spec 027 · T13a (CA-9, R-7): al excluir desde el menú «Acciones» de una fila de la grilla, la compra sale de la vista
// «Con IGV» y su fila (con `AccionesFilaCompras`, `ExcluirCompra` y `AprenderPalabras` dentro) se desmonta; el diálogo
// «Aprender estas palabras» debe seguir apareciendo. Lo ofrece un anfitrión que sigue montado (la pantalla).

const FILA = C_5070_ZAPATILLAS;
const EXCLUIDA = filaDe({ ...FILA, version: 2, excluida: true });

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Imita la grilla: tras recargar la fila excluida, esta ya no está en la vista y su celda se desmonta.
function Pantalla({ conAnfitrion, gestionar }: { conAnfitrion: boolean; gestionar: boolean }) {
  const [visible, setVisible] = useState(true);
  const contexto = useMemo(
    () =>
      contextoDe({
        permisos: { gestionarReglas: gestionar },
        recargarFila: vi.fn(async () => setVisible(false)),
      }),
    [gestionar],
  );
  const lista = (
    <ul aria-label="Compras">
      {visible && (
        <li>
          <AccionesFilaCompras contexto={contexto} fila={FILA} />
        </li>
      )}
    </ul>
  );
  return conAnfitrion ? <AnfitrionAprender>{lista}</AnfitrionAprender> : lista;
}

async function excluirDesdeLaFila(usuario: ReturnType<typeof userEvent.setup>) {
  await usuario.click(await screen.findByRole("button", { name: `${M.columnas.acciones} F001-5070` }));
  await usuario.click(screen.getByRole("menuitem", { name: M.excluir }));
  const dialogo = await screen.findByRole("dialog", { name: `${M.excluir} F001-5070` });
  await usuario.click(dialogo.querySelector<HTMLButtonElement>('button[type="submit"]')!);
}

function instalar() {
  return instalarFetchCompras({
    extra: {
      [`POST ${BASE}/${FILA.id}/excluir`]: { status: 200, cuerpo: accionDe(EXCLUIDA) },
      [rutaPropuesta(FILA.id)]: { status: 200, cuerpo: PROPUESTA_CA9 },
    },
  });
}

describe("AccionesFilaCompras · aprender tras excluir con la fila desmontada (T13a)", () => {
  it("caso feliz: la fila desaparece al excluir y aun así aparece «Aprender estas palabras»", async () => {
    const f = instalar();
    const usuario = userEvent.setup();
    render(<Pantalla conAnfitrion gestionar />);

    await excluirDesdeLaFila(usuario);

    expect(await screen.findByRole("dialog", { name: MG.tituloAprender })).toBeTruthy();
    expect(screen.queryByRole("button", { name: `${M.columnas.acciones} F001-5070` })).toBeNull();
    expect(f.de(rutaPropuesta(FILA.id))).toHaveLength(1);

    await usuario.click(screen.getByRole("button", { name: MG.ahoraNo }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: MG.tituloAprender })).toBeNull());
  });

  it("sin `reglas.gestionar` no se ofrece ni se pide la propuesta, aunque la fila se desmonte", async () => {
    const f = instalar();
    const usuario = userEvent.setup();
    render(<Pantalla conAnfitrion gestionar={false} />);

    await excluirDesdeLaFila(usuario);

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.de(rutaPropuesta(FILA.id))).toHaveLength(0);
  });
});

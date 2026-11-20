import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_ACCESO } from "../../pruebas/acceso";
import {
  MENSAJES_BANDEJA as B,
  PERMISOS_ATENDER,
  RUTA_LOTE,
  filaBandeja,
  filasPendientes,
  rutasBase,
} from "../../pruebas/bandeja";
import { MENSAJES_BUZON as M } from "../../pruebas/buzon";
import { uuidDe } from "../../pruebas/compras";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { AtenderLote } from "./atender-lote";

// Spec 024 · T5 (rojo; D-6, D-7, U-3, CA-7, CA-11). Marcar como atendidos varios mensajes de la bandeja.
// Contrato (T9), `components/buzon/atender-lote.tsx`:
//   <AtenderLote seleccionados={FilaBandeja[]} alTerminar={(r: RespuestaLote) => void} />
//   - Sin seleccionados no pinta nada. Con ellos: barra con «N seleccionados» y el botón «Marcar como atendidos».
//   - El botón abre un `Dialog` con el cuadro «Comentario» (obligatorio si algún seleccionado es crítico: «Confirmar»
//     inactivo y el motivo a la vista) y «Confirmar» / «Cancelar». Más de 100 seleccionados: el botón queda inactivo y
//     dice el tope. Solo marca: no hay «Deshacer» en lote (U-3).
//   - Confirmar → POST /api/buzon/atencion con `{mensajes: [ids], comentario?}` (comentario recortado, omitido si vacío).
//     200 `{atendidos, omitidos}` → «N atendidos, M ya estaban atendidos» y `alTerminar(respuesta)`.
//     404 / 409 cliente_archivado / 400 comentario_requerido / 403 → aviso en español dentro del diálogo, sin `alTerminar`.
//   - Nada de `dangerouslySetInnerHTML`; solo components/ui y tokens.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMUNES = filasPendientes(3);
const CRITICA = filaBandeja({ id: uuidDe(24, 99), asunto: "Resolución coactiva" });
const ids = (filas: { id: string }[]) => filas.map((f) => f.id);

function montar(
  seleccionados = COMUNES,
  respuesta: Manejador = { status: 200, cuerpo: { atendidos: ids(COMUNES), omitidos: [] } },
) {
  const alTerminar = vi.fn();
  const f = instalarFetchFalso(rutasBase(PERMISOS_ATENDER, { [RUTA_LOTE]: respuesta }));
  render(<AtenderLote seleccionados={seleccionados} alTerminar={alTerminar} />);
  return { f, alTerminar, usuario: userEvent.setup() };
}

const abrir = async (usuario: ReturnType<typeof userEvent.setup>) => {
  await usuario.click(await screen.findByRole("button", { name: B.marcarLote }));
  return vi.waitFor(() => {
    const d = screen.getByRole("dialog");
    return d;
  });
};

describe("<AtenderLote /> · barra", () => {
  it("sin seleccionados no pinta nada", () => {
    montar([]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/seleccionad/)).toBeNull();
  });

  it("con seleccionados dice cuántos y ofrece «Marcar como atendidos»", async () => {
    montar();
    expect(await screen.findByText(B.seleccionados(3))).toBeTruthy();
    expect(screen.getByRole("button", { name: B.marcarLote })).toBeTruthy();
    expect(screen.queryByRole("button", { name: B.deshacer })).toBeNull(); // U-3: sin deshacer en lote
  });

  it("uno solo se dice en singular", async () => {
    montar([COMUNES[0]!]);
    expect(await screen.findByText(B.seleccionados(1))).toBeTruthy();
  });

  it("más de 100 seleccionados: el botón queda inactivo y dice el tope (CA-7)", async () => {
    montar(filasPendientes(101, 241));
    const boton = (await screen.findByRole("button", { name: B.marcarLote })) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(screen.getByText(B.maximoLote)).toBeTruthy();
  });

  it("exactamente 100 seleccionados sí se pueden marcar", async () => {
    montar(filasPendientes(100, 242));
    expect(((await screen.findByRole("button", { name: B.marcarLote })) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("<AtenderLote /> · diálogo y envío (D-6, D-7)", () => {
  it("sin críticos: confirma sin comentario y envía solo los ids", async () => {
    const { f, alTerminar, usuario } = montar();
    const dialogo = await abrir(usuario);
    const confirmar = within(dialogo).getByRole("button", { name: B.confirmar }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(false);
    await usuario.click(confirmar);
    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalledTimes(1));
    expect(f.de(RUTA_LOTE).map((l) => l.body)).toEqual([{ mensajes: ids(COMUNES) }]);
  });

  it("el comentario viaja recortado", async () => {
    const { f, alTerminar, usuario } = montar();
    const dialogo = await abrir(usuario);
    await usuario.type(within(dialogo).getByRole("textbox", { name: B.comentario }), "  Revisado en equipo ");
    await usuario.click(within(dialogo).getByRole("button", { name: B.confirmar }));
    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalled());
    expect(f.de(RUTA_LOTE).map((l) => l.body)).toEqual([{ mensajes: ids(COMUNES), comentario: "Revisado en equipo" }]);
  });

  it("con un crítico el comentario es obligatorio: «Confirmar» inactivo, con el motivo, hasta que haya texto", async () => {
    const { f, usuario } = montar([...COMUNES, CRITICA]);
    const dialogo = await abrir(usuario);
    const confirmar = within(dialogo).getByRole("button", { name: B.confirmar }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    expect(within(dialogo).getByText(B.comentarioObligatorio)).toBeTruthy();
    await usuario.type(within(dialogo).getByRole("textbox", { name: B.comentario }), "   ");
    expect(confirmar.disabled).toBe(true);
    await usuario.type(within(dialogo).getByRole("textbox", { name: B.comentario }), "Plan de pago acordado");
    expect(confirmar.disabled).toBe(false);
    await usuario.click(confirmar);
    await vi.waitFor(() => expect(f.de(RUTA_LOTE)).toHaveLength(1));
    expect(f.de(RUTA_LOTE)[0]!.body).toEqual({
      mensajes: ids([...COMUNES, CRITICA]),
      comentario: "Plan de pago acordado",
    });
  });

  it("el resultado dice cuántos se atendieron y cuántos ya estaban atendidos", async () => {
    const { alTerminar, usuario } = montar(COMUNES, {
      status: 200,
      cuerpo: { atendidos: ids(COMUNES.slice(0, 2)), omitidos: ids(COMUNES.slice(2)) },
    });
    const dialogo = await abrir(usuario);
    await usuario.click(within(dialogo).getByRole("button", { name: B.confirmar }));
    expect(await screen.findByText(/2 atendidos.*1 ya (estaba|estaban) atendid/)).toBeTruthy();
    expect(alTerminar).toHaveBeenCalledWith({ atendidos: ids(COMUNES.slice(0, 2)), omitidos: ids(COMUNES.slice(2)) });
  });

  it("Cancelar cierra el diálogo sin enviar nada", async () => {
    const { f, alTerminar, usuario } = montar();
    const dialogo = await abrir(usuario);
    await usuario.click(within(dialogo).getByRole("button", { name: B.cancelar }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.de(RUTA_LOTE)).toHaveLength(0);
    expect(alTerminar).not.toHaveBeenCalled();
  });

  it("un doble clic en «Confirmar» envía una sola vez", async () => {
    const { f, alTerminar, usuario } = montar();
    const dialogo = await abrir(usuario);
    await usuario.dblClick(within(dialogo).getByRole("button", { name: B.confirmar }));
    await vi.waitFor(() => expect(alTerminar).toHaveBeenCalled());
    expect(f.de(RUTA_LOTE)).toHaveLength(1);
  });
});

describe("<AtenderLote /> · errores (CA-7, U-1)", () => {
  it.each<[number, unknown, string | RegExp]>([
    [404, {}, MENSAJES_ACCESO.noEncontrado],
    [403, {}, MENSAJES_ACCESO.sinPermiso],
    [409, { codigo: "cliente_archivado" }, M.archivado],
    [400, { codigo: "comentario_requerido" }, B.comentarioObligatorio],
  ])("%i: avisa en español dentro del diálogo, sin el código y sin cerrar el lote", async (status, cuerpo, texto) => {
    const { alTerminar, usuario } = montar(COMUNES, { status, cuerpo });
    const dialogo = await abrir(usuario);
    await usuario.click(within(dialogo).getByRole("button", { name: B.confirmar }));
    const aviso = await within(dialogo).findByRole("alert");
    expect(aviso.textContent).toMatch(texto instanceof RegExp ? texto : new RegExp(texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(document.body.textContent).not.toMatch(/cliente_archivado|comentario_requerido/);
    expect(alTerminar).not.toHaveBeenCalled();
  });
});

describe("<AtenderLote /> · fuente", () => {
  it("el archivo no usa dangerouslySetInnerHTML ni innerHTML", () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(aqui, "atender-lote.tsx"), "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

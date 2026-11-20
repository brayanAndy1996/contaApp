import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fechaHoraLima } from "../../lib/fechas";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_ACCESO, asentar } from "../../pruebas/acceso";
import {
  CLIENTE_A,
  EN_ATENDIDO,
  MENSAJES_BANDEJA as B,
  PERMISOS_ATENDER,
  PERMISOS_VER,
  USUARIO_ANA,
  USUARIO_LUIS,
  detalleConAtencion,
  rutaAtencionDe,
  rutaDetalleDe,
  rutasBase,
} from "../../pruebas/bandeja";
import { MENSAJES_BUZON as M } from "../../pruebas/buzon";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { AtencionMensaje } from "./atencion-mensaje";
import { DetalleMensaje } from "./detalle-mensaje";

// Spec 024 · T5 (rojo; D-5 a D-8, U-1, U-2, CA-4, CA-5, CA-6, CA-11). Bloque de atención del detalle de un mensaje.
// Contrato (T9), `components/buzon/atencion-mensaje.tsx`:
//   <AtencionMensaje clienteId mensajeId critico atencion={AtencionDetalle} historial={EventoAtencion[]}
//                    archivado? alCambiar={() => void} />
//   Lee GET /api/acceso/yo (`usePuede("buzon.atender")`). `DetalleMensaje` lo pinta debajo del contenido con los datos de
//   `atencion` e `historial` del detalle y, tras un cambio o un 409, vuelve a leer el detalle (`alCambiar`).
//   - Estado visible con texto: «Pendiente», «Atendido por <nombre>» con la fecha en hora de Lima y el comentario vigente
//     (texto, `whitespace-pre-wrap`), o «Histórico». Historial: lista «Historial de atención», en orden, con quién y
//     «Marcó como atendido» / «Deshizo la atención», y el comentario de cada evento.
//   - Con `buzon.atender` y cliente no archivado: `Textarea` «Comentario» (contador «n/500», máximo 500) y el botón
//     «Marcar como atendido» (pendiente o histórico) o «Deshacer» (atendido). Sin permiso o con cliente archivado: ni
//     cuadro ni botones (el historial se sigue viendo); el archivado dice M.archivado (U-1).
//   - Marcar un crítico exige comentario: el botón queda inactivo y se dice por qué hasta que haya texto (no solo espacios).
//   - POST /api/clientes/:cid/buzon/mensajes/:mid/atencion con `{accion: "marcar" | "deshacer", comentario?}`; el
//     comentario va recortado y se omite si queda vacío. 200 `{atencion}` → `alCambiar()`.
//     409 atencion_cambiada → B.conflicto y `alCambiar()` (recarga el estado); 409 cliente_archivado → M.archivado;
//     400 comentario_requerido → aviso del comentario; 403 / 404 → mensajes de acceso. Un solo envío por clic.
//   - Nada de `dangerouslySetInnerHTML`; solo components/ui y tokens.

const MENSAJE = uuidDe(24, 50);
const RUTA = rutaAtencionDe(CLIENTE_A, MENSAJE);
const PENDIENTE = { estado: "pendiente", por: null, en: null, comentario: null } as const;
const ATENDIDO = { estado: "atendido", por: USUARIO_ANA, en: EN_ATENDIDO, comentario: "Se llamó al cliente." } as const;
const EVENTOS = [
  { accion: "atendido", comentario: "Se llamó al cliente.", usuario: USUARIO_ANA, en: "2026-11-18T15:30:00.000Z" },
  { accion: "deshecho", comentario: "Faltaba el cargo", usuario: USUARIO_LUIS, en: "2026-11-18T16:00:00.000Z" },
  { accion: "atendido", comentario: null, usuario: USUARIO_ANA, en: "2026-11-19T14:00:00.000Z" },
] as const;

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = Partial<Parameters<typeof AtencionMensaje>[0]>;

function montar(props: Props = {}, permisos: string[] = PERMISOS_ATENDER, extra: Record<string, Manejador> = {}) {
  const alCambiar = vi.fn();
  const f = instalarFetchFalso(rutasBase(permisos, { [RUTA]: { status: 200, cuerpo: { atencion: ATENDIDO } }, ...extra }));
  const r = render(
    <AtencionMensaje
      clienteId={CLIENTE_A}
      mensajeId={MENSAJE}
      critico={false}
      atencion={{ ...PENDIENTE }}
      historial={[]}
      alCambiar={alCambiar}
      {...props}
    />,
  );
  return { f, alCambiar, usuario: userEvent.setup(), ...r };
}

const cuerpoEnviado = (f: ReturnType<typeof instalarFetchFalso>) => f.de(RUTA).map((l) => l.body);
const caja = () => screen.findByRole("textbox", { name: B.comentario }) as Promise<HTMLTextAreaElement>;
const botonMarcar = () => screen.findByRole("button", { name: B.marcar }) as Promise<HTMLButtonElement>;

describe("<AtencionMensaje /> · permisos y estado (CA-6)", () => {
  it("con `buzon.atender`: cuadro «Comentario» con contador 0/500 y botón «Marcar como atendido»", async () => {
    montar();
    const area = await caja();
    expect(area.maxLength).toBe(500);
    expect(screen.getByText(B.contador(0))).toBeTruthy();
    expect(await botonMarcar()).toBeTruthy();
    expect(screen.getByText(B.estado.pendiente)).toBeTruthy();
  });

  it("sin `buzon.atender` (Lectura): ni cuadro ni botones, pero sí el estado y el historial", async () => {
    montar({ atencion: { ...ATENDIDO }, historial: [...EVENTOS] }, PERMISOS_VER);
    expect(await screen.findByText(B.atendidoPor(USUARIO_ANA.nombre), { exact: false })).toBeTruthy();
    await asentar(80); // deja que `acceso/yo` responda: sin el permiso, igual no aparece nada
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: B.marcar })).toBeNull();
    expect(screen.queryByRole("button", { name: B.deshacer })).toBeNull();
    expect(screen.getByRole("list", { name: B.historial })).toBeTruthy();
  });

  it("cliente archivado (U-1): sin botones ni cuadro, con el aviso de solo lectura y el historial a la vista", async () => {
    montar({ archivado: true, atencion: { ...ATENDIDO }, historial: [...EVENTOS] });
    expect(await screen.findByText(M.archivado)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: B.deshacer })).toBeNull();
    expect(screen.queryByRole("button", { name: B.marcar })).toBeNull();
    expect(within(screen.getByRole("list", { name: B.historial })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("atendido: dice quién, cuándo (hora de Lima) y el comentario vigente, y ofrece «Deshacer»", async () => {
    montar({ atencion: { ...ATENDIDO } });
    expect(await screen.findByRole("button", { name: B.deshacer })).toBeTruthy();
    expect(screen.queryByRole("button", { name: B.marcar })).toBeNull();
    const estado = screen.getByText(B.atendidoPor(USUARIO_ANA.nombre), { exact: false });
    expect(estado.textContent).toContain(fechaHoraLima(EN_ATENDIDO));
    expect(screen.getByText("Se llamó al cliente.")).toBeTruthy();
  });

  it("histórico (D-12): se dice «Histórico» y se puede marcar como atendido", async () => {
    montar({ atencion: { estado: "historico", por: null, en: null, comentario: null } });
    expect(await botonMarcar()).toBeTruthy();
    expect(screen.getByText(B.estado.historico)).toBeTruthy();
  });

  it("el historial sale en orden, con quién hizo cada cosa y su comentario", async () => {
    montar({ atencion: { ...ATENDIDO }, historial: [...EVENTOS] });
    const items = within(await screen.findByRole("list", { name: B.historial })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain(USUARIO_ANA.nombre);
    expect(items[0]!.textContent).toContain(B.accionAtendido);
    expect(items[0]!.textContent).toContain("Se llamó al cliente.");
    expect(items[1]!.textContent).toContain(USUARIO_LUIS.nombre);
    expect(items[1]!.textContent).toContain(B.accionDeshecho);
    expect(items[1]!.textContent).toContain("Faltaba el cargo");
    expect(items[2]!.textContent).toContain(B.accionAtendido);
    expect(items[2]!.textContent).not.toContain(B.accionDeshecho);
  });
});

describe("<AtencionMensaje /> · marcar y deshacer (CA-4, CA-5, D-7)", () => {
  it("un mensaje común se marca sin comentario: POST {accion:'marcar'} sin la clave comentario", async () => {
    const { f, alCambiar, usuario } = montar();
    await usuario.click(await botonMarcar());
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalledTimes(1));
    expect(cuerpoEnviado(f)).toEqual([{ accion: "marcar" }]);
  });

  it("el comentario viaja recortado y el contador cuenta lo escrito", async () => {
    const { f, alCambiar, usuario } = montar();
    await usuario.type(await caja(), "  Revisado con el cliente  ");
    expect(screen.getByText(B.contador("  Revisado con el cliente  ".length))).toBeTruthy();
    await usuario.click(await botonMarcar());
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(cuerpoEnviado(f)).toEqual([{ accion: "marcar", comentario: "Revisado con el cliente" }]);
  });

  it("un comentario de solo espacios se trata como vacío: no se envía", async () => {
    const { f, alCambiar, usuario } = montar();
    await usuario.type(await caja(), "    ");
    await usuario.click(await botonMarcar());
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(cuerpoEnviado(f)).toEqual([{ accion: "marcar" }]);
  });

  it("un crítico sin comentario: botón inactivo, con el motivo a la vista, y no se envía nada", async () => {
    const { f, usuario } = montar({ critico: true });
    const boton = await botonMarcar();
    expect(boton.disabled).toBe(true);
    expect(screen.getByText(B.comentarioObligatorio)).toBeTruthy();
    await usuario.click(boton);
    await usuario.type(await caja(), "   ");
    expect(boton.disabled).toBe(true);
    expect(f.de(RUTA)).toHaveLength(0);
  });

  it("un crítico con comentario habilita el botón y lo envía", async () => {
    const { f, alCambiar, usuario } = montar({ critico: true });
    await usuario.type(await caja(), "Se presentó el recurso");
    const boton = await botonMarcar();
    expect(boton.disabled).toBe(false);
    await usuario.click(boton);
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(cuerpoEnviado(f)).toEqual([{ accion: "marcar", comentario: "Se presentó el recurso" }]);
  });

  it("deshacer no exige comentario, aunque el mensaje sea crítico: POST {accion:'deshacer'}", async () => {
    const { f, alCambiar, usuario } = montar({ critico: true, atencion: { ...ATENDIDO } });
    const boton = (await screen.findByRole("button", { name: B.deshacer })) as HTMLButtonElement;
    expect(boton.disabled).toBe(false);
    await usuario.click(boton);
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(cuerpoEnviado(f)).toEqual([{ accion: "deshacer" }]);
  });

  it("deshacer admite un comentario opcional", async () => {
    const { f, alCambiar, usuario } = montar({ atencion: { ...ATENDIDO } });
    await usuario.type(await caja(), "Faltaba el cargo");
    await usuario.click(await screen.findByRole("button", { name: B.deshacer }));
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(cuerpoEnviado(f)).toEqual([{ accion: "deshacer", comentario: "Faltaba el cargo" }]);
  });

  it("un doble clic envía una sola vez (el botón se inactiva mientras se envía)", async () => {
    const { f, alCambiar, usuario } = montar();
    await usuario.dblClick(await botonMarcar());
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalled());
    expect(f.de(RUTA)).toHaveLength(1);
  });
});

describe("<AtencionMensaje /> · errores (D-6, U-1)", () => {
  it("409 atencion_cambiada: avisa «Otra persona ya cambió este mensaje.» y recarga el estado", async () => {
    const { alCambiar, usuario } = montar({}, PERMISOS_ATENDER, {
      [RUTA]: { status: 409, cuerpo: { codigo: "atencion_cambiada", atencion: ATENDIDO } },
    });
    await usuario.click(await botonMarcar());
    expect(await screen.findByText(B.conflicto)).toBeTruthy();
    expect(alCambiar).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("atencion_cambiada");
  });

  it("409 cliente_archivado: dice que el cliente es de solo lectura", async () => {
    const { usuario } = montar({}, PERMISOS_ATENDER, { [RUTA]: { status: 409, cuerpo: { codigo: "cliente_archivado" } } });
    await usuario.click(await botonMarcar());
    expect(await screen.findByText(M.archivado)).toBeTruthy();
  });

  it("400 comentario_requerido del servidor: lo explica en español, sin el código", async () => {
    const { usuario } = montar({}, PERMISOS_ATENDER, { [RUTA]: { status: 400, cuerpo: { codigo: "comentario_requerido" } } });
    await usuario.click(await botonMarcar());
    expect(await screen.findByText(B.comentarioObligatorio)).toBeTruthy();
    expect(document.body.textContent).not.toContain("comentario_requerido");
  });

  it.each([
    [403, MENSAJES_ACCESO.sinPermiso],
    [404, MENSAJES_ACCESO.noEncontrado],
  ])("%i: aviso genérico en español", async (status, texto) => {
    const { usuario } = montar({}, PERMISOS_ATENDER, { [RUTA]: { status, cuerpo: {} } });
    await usuario.click(await botonMarcar());
    expect((await screen.findByRole("alert")).textContent).toContain(texto);
  });
});

describe("<AtencionMensaje /> · texto hostil (CA-11)", () => {
  it("el comentario vigente y los del historial se ven como texto: ni imagen ni atributos on*", async () => {
    const { container } = montar({
      atencion: { ...ATENDIDO, comentario: TEXTO_HOSTIL },
      historial: [
        { accion: "atendido", comentario: TEXTO_HOSTIL, usuario: { id: USUARIO_ANA.id, nombre: TEXTO_HOSTIL }, en: EN_ATENDIDO },
      ],
    });
    await screen.findAllByText(TEXTO_HOSTIL, { exact: false });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect([...container.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name)))).toBe(false);
  });

  it("el archivo no usa dangerouslySetInnerHTML ni innerHTML", () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(aqui, "atencion-mensaje.tsx"), "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("<DetalleMensaje /> · con la atención integrada (024, P-9)", () => {
  it("pinta el bloque de atención del detalle y, tras marcar, vuelve a leer el detalle y muestra el estado nuevo", async () => {
    let lecturas = 0;
    const mensaje = { id: MENSAJE, critico: false, motivoCritico: null, categoria: "otro" as const };
    const f = instalarFetchFalso(
      rutasBase(PERMISOS_ATENDER, {
        [rutaDetalleDe(CLIENTE_A, MENSAJE)]: () => {
          lecturas += 1;
          return {
            status: 200,
            cuerpo:
              lecturas === 1
                ? detalleConAtencion(mensaje)
                : detalleConAtencion(mensaje, ATENDIDO, [EVENTOS[0]!]),
          };
        },
        [RUTA]: { status: 200, cuerpo: { atencion: ATENDIDO } },
      }),
    );
    render(<DetalleMensaje clienteId={CLIENTE_A} mensajeId={MENSAJE} />);
    const usuario = userEvent.setup();
    await usuario.click(await botonMarcar());
    expect(await screen.findByText(B.atendidoPor(USUARIO_ANA.nombre), { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: B.deshacer })).toBeTruthy();
    expect(f.de(rutaDetalleDe(CLIENTE_A, MENSAJE)).length).toBe(2);
    expect(f.de(RUTA)).toHaveLength(1);
  });

  it("el detalle de un crítico exige el comentario y no ofrece marcar sin él", async () => {
    instalarFetchFalso(
      rutasBase(PERMISOS_ATENDER, {
        [rutaDetalleDe(CLIENTE_A, MENSAJE)]: { status: 200, cuerpo: detalleConAtencion({ id: MENSAJE }) },
      }),
    );
    render(<DetalleMensaje clienteId={CLIENTE_A} mensajeId={MENSAJE} />);
    expect(((await botonMarcar()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(B.comentarioObligatorio)).toBeTruthy();
  });

  it("no pide nada de notificaciones al atender (CA-12)", async () => {
    const mensaje = { id: MENSAJE, critico: false, motivoCritico: null, categoria: "otro" as const };
    const f = instalarFetchFalso(
      rutasBase(PERMISOS_ATENDER, {
        [rutaDetalleDe(CLIENTE_A, MENSAJE)]: { status: 200, cuerpo: detalleConAtencion(mensaje) },
        [RUTA]: { status: 200, cuerpo: { atencion: ATENDIDO } },
      }),
    );
    render(<DetalleMensaje clienteId={CLIENTE_A} mensajeId={MENSAJE} />);
    await userEvent.setup().click(await botonMarcar());
    await vi.waitFor(() => expect(f.de(RUTA)).toHaveLength(1));
    expect(f.llamadas.filter((l) => l.ruta.startsWith("/api/notificaciones"))).toHaveLength(0);
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_ACCESO, yoDe } from "../../pruebas/acceso";
import {
  ADJUNTO_ID,
  CLIENTE_BUZON,
  ETIQUETA_CATEGORIA as C,
  MENSAJES_BUZON as M,
  MENSAJE_ID,
  adjuntoBuzon,
  detalleBuzon,
  hrefAdjunto,
  rutaAbrir,
  rutaDetalle,
} from "../../pruebas/buzon";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import { trabajoDe } from "../../pruebas/credenciales";
import { instalarFetchFalso, sesionDe, type Manejador } from "../../pruebas/soporte";
import { DetalleMensaje } from "./detalle-mensaje";

// Spec 023 · T7 (rojo; CA-4, CA-8, P-1, P-9, D-4). Vista mínima de un mensaje del buzón.
// Contrato (T14), `components/buzon/detalle-mensaje.tsx`: <DetalleMensaje clienteId="c-1" mensajeId={uuid} />.
//   - Lee GET /api/acceso/yo y GET /api/clientes/:id/buzon/mensajes/:mensajeId → {mensaje, contenido, adjuntos}.
//     404 (inexistente, ajeno o no asignado: mismo caso) → alerta MENSAJES_ACCESO.noEncontrado; 403 → sinPermiso.
//   - Cabecera: asunto, remitente, «Crítico · <categoría>» (Badge) si es crítico y la fecha.
//   - `contenido` (texto plano ya convertido por el servidor) se muestra como TEXTO con `whitespace-pre-wrap`:
//     un `<script>` o `<img onerror>` queda literal; no hay ningún nodo `script`/`img` ni atributo `on*` en el DOM y
//     el archivo no usa `dangerouslySetInnerHTML`.
//   - `contenido: null` → M.sinContenido (aún no se obtuvo). Nunca se llama al portal por solo mirar.
//   - Adjuntos: cada uno con `omitido: null` es un ENLACE (`<a href>`) a
//     /api/clientes/:id/buzon/mensajes/:mensajeId/adjuntos/:adjuntoId; uno omitido NO es enlace: muestra su nombre y
//     el motivo (M.omitido.mime | tamano | tope_mensaje). Nombres hostiles se ven como texto.
//   - «Abrir en SUNAT» (solo con el permiso `buzon.marcar_leido`, y solo si `contenido` es null): abre un diálogo
//     de confirmación (role alertdialog o dialog) que avisa que SUNAT puede marcar el mensaje como leído, con
//     «Confirmar» y «Cancelar». Sin confirmar no se llama a nada; «Cancelar» cierra sin llamar. Al confirmar →
//     POST …/mensajes/:id/abrir (una sola vez): 202 → M.aperturaEncolada con enlace M.enlacePanel a /trabajos;
//     200 {trabajo: null} → M.yaObtenido y se vuelve a leer el detalle; 409 credencial_* / cliente_archivado →
//     alerta en español (M.sinCredencial, M.credencialInvalida, M.archivado).
//   - Solo components/ui y tokens de color.

const PERMISOS_LECTURA = ["clientes.ver", "buzon.ver"];
const PERMISOS_ABRIR = ["clientes.ver", "buzon.ver", "buzon.marcar_leido"];
const CONTENIDO_HOSTIL =
  "Se le notifica la Resolución Coactiva.\n<script>alert(1)</script>\n" +
  '<img src=x onerror="alert(2)"> <a href="javascript:alert(3)" onclick="alert(4)">pague aquí</a>';

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function instalar(
  detalle: unknown,
  opciones: { permisos?: string[]; status?: number; extra?: Record<string, Manejador> } = {},
) {
  return instalarFetchFalso({
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }),
    },
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", opciones.permisos ?? PERMISOS_LECTURA),
    },
    [rutaDetalle()]: { status: opciones.status ?? 200, cuerpo: detalle },
    ...opciones.extra,
  });
}

const montar = () => {
  const r = render(<DetalleMensaje clienteId={CLIENTE_BUZON} mensajeId={MENSAJE_ID} />);
  return { ...r, usuario: userEvent.setup() };
};
const dialogo = (): HTMLElement | null =>
  screen.queryByRole("alertdialog") ?? screen.queryByRole("dialog");
const esperarDialogo = (): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const d = dialogo();
    if (!d) throw new Error("no hay diálogo de confirmación");
    return d;
  });

describe("<DetalleMensaje /> · cabecera y contenido (CA-8)", () => {
  it("muestra asunto, remitente y «Crítico · Coactiva»", async () => {
    instalar(detalleBuzon({ contenido: "Texto del mensaje." }));
    montar();
    expect(await screen.findByText("Resolución Coactiva N° 0150140012345")).toBeTruthy();
    expect(screen.getByText("SUNAT - Notificaciones")).toBeTruthy();
    expect(screen.getByText(`Crítico · ${C.coactiva}`)).toBeTruthy();
    expect(screen.getByText("Texto del mensaje.")).toBeTruthy();
  });

  it("contenido con <script> y onerror: todo queda como texto, sin nodos ni atributos ejecutables", async () => {
    instalar(detalleBuzon({ contenido: CONTENIDO_HOSTIL }));
    const { container } = montar();
    await screen.findByText(/Se le notifica la Resolución Coactiva/);

    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain('<img src=x onerror="alert(2)">');
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    const conOn = [...document.querySelectorAll("*")].some((el) =>
      [...el.attributes].some((a) => /^on/i.test(a.name)),
    );
    expect(conOn).toBe(false);
    // El «pague aquí» del contenido no es un enlace.
    expect(screen.queryByRole("link", { name: "pague aquí" })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("un asunto hostil también se ve como texto", async () => {
    instalar(detalleBuzon({ mensaje: { asunto: TEXTO_HOSTIL }, contenido: "x" }));
    montar();
    expect(await screen.findByText(TEXTO_HOSTIL)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("el archivo del componente no usa dangerouslySetInnerHTML", () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    const fuente = readFileSync(join(aqui, "detalle-mensaje.tsx"), "utf8");
    expect(fuente).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  it("sin contenido aún dice que no se obtuvo y no inventa texto", async () => {
    instalar(detalleBuzon({ contenido: null }));
    montar();
    expect(await screen.findByText(M.sinContenido)).toBeTruthy();
  });
});

describe("<DetalleMensaje /> · adjuntos", () => {
  it("un adjunto descargable es un enlace a la ruta de descarga y los omitidos no", async () => {
    const omitidoMime = adjuntoBuzon({ id: uuidDe(23, 21), nombre: "instalador.exe", mime: null, omitido: "mime" });
    const omitidoTamano = adjuntoBuzon({ id: uuidDe(23, 22), nombre: "enorme.zip", omitido: "tamano", tamano: 30_000_000 });
    const omitidoTope = adjuntoBuzon({ id: uuidDe(23, 23), nombre: "ultimo.pdf", omitido: "tope_mensaje" });
    instalar(detalleBuzon({ contenido: "Ver adjuntos.", adjuntos: [adjuntoBuzon(), omitidoMime, omitidoTamano, omitidoTope] }));
    montar();

    const enlace = await screen.findByRole("link", { name: /resolucion\.pdf/ });
    expect(enlace.getAttribute("href")).toBe(hrefAdjunto(ADJUNTO_ID));

    for (const [nombre, motivo] of [
      ["instalador.exe", M.omitido.mime],
      ["enorme.zip", M.omitido.tamano],
      ["ultimo.pdf", M.omitido.tope_mensaje],
    ] as const) {
      expect(screen.queryByRole("link", { name: new RegExp(nombre.replace(".", "\\.")) })).toBeNull();
      const item = screen.getByText(nombre).closest("li, tr, div")!;
      expect(item.textContent).toContain(motivo);
    }
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.includes("/adjuntos/"))).toHaveLength(1);
  });

  it("un nombre de adjunto hostil es texto; el enlace usa el id y nunca el nombre", async () => {
    const nombre = "../../etc/passwd<img src=x onerror=alert(1)>.pdf";
    instalar(detalleBuzon({ contenido: "x", adjuntos: [adjuntoBuzon({ nombre })] }));
    montar();
    const enlace = await screen.findByRole("link", { name: new RegExp("etc/passwd") });
    expect(enlace.textContent).toContain(nombre);
    expect(enlace.getAttribute("href")).toBe(hrefAdjunto(ADJUNTO_ID));
    expect(document.querySelector("img")).toBeNull();
  });

  it("sin adjuntos no hay lista de descargas", async () => {
    instalar(detalleBuzon({ contenido: "x", adjuntos: [] }));
    montar();
    await screen.findByText("x");
    expect(screen.queryAllByRole("link").filter((a) => a.getAttribute("href")?.includes("/adjuntos/"))).toHaveLength(0);
  });
});

describe("<DetalleMensaje /> · descarga del adjunto (CA-8)", () => {
  const crearUrl = vi.fn(() => "blob:adjunto-1");
  const revocarUrl = vi.fn();
  const clics: { descarga: string; href: string }[] = [];

  beforeEach(() => {
    clics.length = 0;
    crearUrl.mockClear();
    revocarUrl.mockClear();
    Object.assign(URL, { createObjectURL: crearUrl, revokeObjectURL: revocarUrl });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clics.push({ descarga: this.download, href: this.href });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const instalarConAdjunto = (descarga: Manejador) =>
    instalar(detalleBuzon({ contenido: "Ver adjunto.", adjuntos: [adjuntoBuzon()] }), {
      extra: { [`GET ${hrefAdjunto()}`]: descarga },
    });

  it("el clic pide el adjunto con X-Estudio y baja el archivo con el nombre del adjunto", async () => {
    const f = instalarConAdjunto({ status: 200, cuerpo: { pdf: true } });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("link", { name: /resolucion\.pdf/ }));

    await vi.waitFor(() => expect(clics).toHaveLength(1));
    const pedidos = f.de(`GET ${hrefAdjunto()}`);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.headers["x-estudio"]).toBe("e-a");
    expect(pedidos[0]!.credentials).toBe("same-origin");
    expect(clics[0]!.descarga).toBe("resolucion.pdf");
    expect(clics[0]!.href).toBe("blob:adjunto-1");
    expect(revocarUrl).toHaveBeenCalledWith("blob:adjunto-1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [404, MENSAJES_ACCESO.noEncontrado],
    [403, MENSAJES_ACCESO.sinPermiso],
    [500, MENSAJES_ACCESO.errorGeneral],
    [409, MENSAJES_ACCESO.errorGeneral],
  ])("el error %i se avisa en español, sin JSON, y no se baja nada", async (status, texto) => {
    instalarConAdjunto({ status, cuerpo: { codigo: "estudio_desfasado", detalle: "interno" } });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("link", { name: /resolucion\.pdf/ }));

    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toBe(texto);
    expect(aviso.textContent).not.toMatch(/[{}]|estudio_desfasado|interno/);
    expect(clics).toHaveLength(0);
    expect(crearUrl).not.toHaveBeenCalled();
  });

  it("el control tiene nombre, es alcanzable con teclado y mide 44 px en celular", async () => {
    instalarConAdjunto({ status: 200, cuerpo: {} });
    const { usuario } = montar();
    const control = await screen.findByRole("link", { name: /resolucion\.pdf/ });
    expect(control.className).toContain("max-lg:min-h-11");
    expect(control.className).toContain("focus-visible:outline");
    await usuario.tab();
    expect(document.activeElement).toBe(control);
  });
});

describe("<DetalleMensaje /> · errores de lectura", () => {
  it("404 → «no se encontró», igual para inexistente, ajeno o no asignado (CA-9)", async () => {
    instalar({ codigo: "no_encontrado" }, { status: 404 });
    montar();
    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES_ACCESO.noEncontrado);
    expect(screen.queryByRole("button", { name: M.abrirEnSunat })).toBeNull();
  });

  it("403 → sin permiso", async () => {
    instalar({ codigo: "sin_permiso" }, { status: 403 });
    montar();
    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES_ACCESO.sinPermiso);
  });
});

describe("<DetalleMensaje /> · «Abrir en SUNAT» (CA-4, P-1)", () => {
  it("sin buzon.marcar_leido (rol Lectura) no hay botón", async () => {
    instalar(detalleBuzon({ contenido: null }), { permisos: PERMISOS_LECTURA });
    montar();
    await screen.findByText(M.sinContenido);
    expect(screen.queryByRole("button", { name: M.abrirEnSunat })).toBeNull();
  });

  it("con el permiso y sin contenido el botón está; pedir el diálogo no llama a nada", async () => {
    const f = instalar(detalleBuzon({ contenido: null }), { permisos: PERMISOS_ABRIR });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));

    const d = await esperarDialogo();
    expect(d.textContent).toMatch(M.avisoAbrir);
    expect(within(d).getByRole("button", { name: M.confirmar })).toBeTruthy();
    expect(within(d).getByRole("button", { name: M.cancelar })).toBeTruthy();
    expect(f.de(rutaAbrir())).toHaveLength(0);
  });

  it("«Cancelar» cierra el diálogo sin llamar al servidor", async () => {
    const f = instalar(detalleBuzon({ contenido: null }), { permisos: PERMISOS_ABRIR });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.cancelar }));

    await vi.waitFor(() => expect(dialogo()).toBeNull());
    expect(f.de(rutaAbrir())).toHaveLength(0);
  });

  it("«Confirmar» → POST …/abrir una vez; 202 avisa y enlaza al panel de trabajos", async () => {
    const f = instalar(detalleBuzon({ contenido: null }), {
      permisos: PERMISOS_ABRIR,
      extra: {
        [rutaAbrir()]: { status: 202, cuerpo: { trabajo: trabajoDe({ tipo: "sol.buzon.abrir" }) } },
      },
    });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.confirmar }));

    expect(await screen.findByText(M.aperturaEncolada)).toBeTruthy();
    expect(screen.getByRole("link", { name: M.enlacePanel }).getAttribute("href")).toBe("/trabajos");
    const llamadas = f.de(rutaAbrir());
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(dialogo()).toBeNull();
  });

  it("200 {trabajo: null}: ya se obtuvo; lo dice y vuelve a leer el detalle", async () => {
    let lecturas = 0;
    const f = instalar(null, {
      permisos: PERMISOS_ABRIR,
      extra: {
        [rutaDetalle()]: () => {
          lecturas += 1;
          return {
            status: 200,
            cuerpo: detalleBuzon({ contenido: lecturas === 1 ? null : "Contenido ya obtenido por otro." }),
          };
        },
        [rutaAbrir()]: { status: 200, cuerpo: { trabajo: null } },
      },
    });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.confirmar }));

    expect(await screen.findByText(M.yaObtenido)).toBeTruthy();
    expect(await screen.findByText("Contenido ya obtenido por otro.")).toBeTruthy();
    expect(f.de(rutaAbrir())).toHaveLength(1);
    expect(f.de(rutaDetalle()).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["cliente_archivado", M.archivado],
    ["credencial_no_configurada", M.sinCredencial],
    ["credencial_invalida", M.credencialInvalida],
  ])("409 %s → alerta en español, sin el código", async (codigo, texto) => {
    instalar(detalleBuzon({ contenido: null }), {
      permisos: PERMISOS_ABRIR,
      extra: { [rutaAbrir()]: { status: 409, cuerpo: { codigo } } },
    });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.confirmar }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
  });

  it("403 al abrir → «sin permiso», sin mostrar contenido nuevo", async () => {
    instalar(detalleBuzon({ contenido: null }), {
      permisos: PERMISOS_ABRIR,
      extra: { [rutaAbrir()]: { status: 403, cuerpo: { codigo: "sin_permiso" } } },
    });
    const { usuario } = montar();
    await usuario.click(await screen.findByRole("button", { name: M.abrirEnSunat }));
    await usuario.click(within(await esperarDialogo()).getByRole("button", { name: M.confirmar }));
    expect((await screen.findByRole("alert")).textContent).toContain(MENSAJES_ACCESO.sinPermiso);
  });
});

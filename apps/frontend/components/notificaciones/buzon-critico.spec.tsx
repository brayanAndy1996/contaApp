import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinoDe, notificacionDeFila, type NotificacionVista } from "../../lib/notificaciones";
import { reiniciarSesion } from "../../lib/sesion";
import { ETIQUETA_CATEGORIA as C } from "../../pruebas/buzon";
import { TEXTO_HOSTIL } from "../../pruebas/compras";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Manejador,
} from "../../pruebas/soporte";
import { Campana } from "./campana";
import { textoNotificacion } from "./texto-notificacion";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Spec 023 · T7 (rojo; CA-6, D-10). La campana muestra la notificación `buzon_critico`.
// Contrato (T14), `components/notificaciones/texto-notificacion.tsx` y `lib/notificaciones.ts`:
//   - textoNotificacion({tipo: "buzon_critico", cliente, params: {categoria, mensajeId}}) =
//     «Mensaje crítico en el buzón SOL de <razón social>: <categoría>» (sin cliente: «…buzón SOL: <categoría>»),
//     con la categoría en español (ETIQUETA_CATEGORIA de pruebas/buzon.ts). Sin punto final. Nunca el código crudo
//     (`resolucion_multa`), ni el asunto (no viaja en `params`).
//   - destinoDe(n) = `/clientes/<clienteId>/buzon?mensaje=<mensajeId>` (la vista mínima del mensaje); si no hay
//     cliente, no cambia el comportamiento de 017.
//   - Al abrirla en el panel: POST /api/notificaciones/:id/leida y router.push al destino anterior.
//   - Una razón social hostil se ve como texto.
// Nota: `notificacionSchema` de `shared` acepta `buzon_critico` cuando T9 llena `CATEGORIAS_CRITICAS_BUZON`; las
// pruebas de texto y destino pasan el objeto directo para no depender de ello, y las de la campana sí lo usan.

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const CLIENTE = "00000000-0000-4000-8000-0000000000c1";
const MENSAJE = "00000000-0000-4000-8000-0000000000d1";
const NOTIF = "00000000-0000-4000-8000-0000000000a9";
const DESTINO = `/clientes/${CLIENTE}/buzon?mensaje=${MENSAJE}`;

const crudo = (
  categoria: string,
  cliente: { id: string; razonSocial: string } | null = { id: CLIENTE, razonSocial: "SAN JUAN SAC" },
) => ({
  id: NOTIF,
  tipo: "buzon_critico",
  creadaEn: "2026-11-17T08:00:00.000Z",
  leidaEn: null,
  cliente,
  trabajoId: null,
  params: { categoria, mensajeId: MENSAJE },
});
const vista = (...args: Parameters<typeof crudo>) => crudo(...args) as unknown as NotificacionVista;

describe("texto de buzon_critico (CA-6)", () => {
  it.each([
    ["coactiva", C.coactiva],
    ["resolucion_determinacion", C.resolucion_determinacion],
    ["resolucion_multa", C.resolucion_multa],
    ["requerimiento_fiscalizacion", C.requerimiento_fiscalizacion],
  ])("%s → «Mensaje crítico en el buzón SOL de SAN JUAN SAC: %s»", (categoria, etiqueta) => {
    const texto = textoNotificacion(vista(categoria));
    expect(texto).toBe(`Mensaje crítico en el buzón SOL de SAN JUAN SAC: ${etiqueta}`);
    expect(texto).not.toContain(categoria);
  });

  it("sin cliente, el texto sigue sin la parte «de …»", () => {
    expect(textoNotificacion(vista("coactiva", null))).toBe("Mensaje crítico en el buzón SOL: Coactiva");
  });

  it("una categoría que este cliente no conoce no se muestra cruda", () => {
    const texto = textoNotificacion(vista("categoria_del_futuro"));
    expect(texto).not.toContain("categoria_del_futuro");
    expect(texto).toContain("Mensaje crítico en el buzón SOL");
  });
});

describe("destino de buzon_critico", () => {
  it("lleva a la vista mínima del mensaje con ?mensaje=", () => {
    expect(destinoDe(vista("coactiva"))).toBe(DESTINO);
  });

  it("los otros tipos siguen llevando a la ficha o al panel de trabajos (017)", () => {
    const base = { id: NOTIF, creadaEn: "2026-11-17T08:00:00.000Z", leidaEn: null };
    expect(
      destinoDe({
        ...base,
        tipo: "credencial_invalida",
        cliente: { id: CLIENTE, razonSocial: "SAN JUAN SAC" },
        trabajoId: null,
        params: { credencial: "sol" },
      } as NotificacionVista),
    ).toBe(`/clientes/${CLIENTE}`);
  });
});

describe("campana con buzon_critico", () => {
  function rutas(extra: Record<string, Manejador> = {}): Record<string, Manejador> {
    return {
      "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
      "GET /api/notificaciones/no-leidas": { status: 200, cuerpo: { noLeidas: 1 } },
      "GET /api/notificaciones": {
        status: 200,
        cuerpo: { items: [crudo("resolucion_multa")], siguiente: null },
      },
      ...extra,
    };
  }

  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("el esquema de la notificación llega como buzon_critico, no como genérica", () => {
    expect(notificacionDeFila(crudo("coactiva"))?.tipo).toBe("buzon_critico");
  });

  it("el panel muestra el cliente y la categoría, y al abrirla marca leída y navega al mensaje", async () => {
    const f = instalarFetchFalso(rutas({ [`POST /api/notificaciones/${NOTIF}/leida`]: { status: 204 } }));
    render(<Campana />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: /Notificaciones, 1 sin leer/ }));
    const panel = await screen.findByRole("dialog", { name: "Panel de notificaciones" });
    const texto = await within(panel).findByText(
      `Mensaje crítico en el buzón SOL de SAN JUAN SAC: ${C.resolucion_multa}`,
    );
    expect(panel.textContent).not.toContain("Tienes una notificación nueva.");

    await usuario.click(texto);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(DESTINO));
    expect(f.de(`POST /api/notificaciones/${NOTIF}/leida`)).toHaveLength(1);
  });

  it("una razón social hostil se muestra como texto", async () => {
    instalarFetchFalso(
      rutas({
        "GET /api/notificaciones": {
          status: 200,
          cuerpo: { items: [crudo("coactiva", { id: CLIENTE, razonSocial: TEXTO_HOSTIL })], siguiente: null },
        },
      }),
    );
    render(<Campana />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: /Notificaciones/ }));
    const panel = await screen.findByRole("dialog", { name: "Panel de notificaciones" });
    await within(panel).findByText(/Mensaje crítico en el buzón SOL de/);
    expect(panel.textContent).toContain(TEXTO_HOSTIL);
    expect(panel.querySelector("img")).toBeNull();
  });
});

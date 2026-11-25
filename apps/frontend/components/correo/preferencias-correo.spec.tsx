import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import {
  FALLO_ISO,
  FALLO_TEXTO,
  GUARDAR_CORREO,
  LEER_CORREO,
  MENSAJES_CORREO as M,
  TEXTOS_CRUDOS_CORREO,
  VISTA_CONTADOR,
  VISTA_DUENO,
  VISTA_INICIAL,
  alcanza44px,
  cargarComponente,
  cuerpoDe,
  encendido,
  instalarServidorCorreo,
  type VistaCorreoPrueba,
} from "../../pruebas/correo";
import { crearRouterFalso } from "../../pruebas/soporte";

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
  usePathname: () => "/cuenta/correo",
  useSearchParams: () => new URLSearchParams(),
}));

// Spec 028 · T7 (rojo; R-9, R-13, R-15, D-3; CA-12, CA-13). «Mi cuenta → Correo».
// Contrato (T13):
//   - `components/correo/preferencias-correo.tsx` exporta `PreferenciasCorreo` (sin props) y
//     `app/(app)/cuenta/correo/page.tsx` la pinta bajo un `<h1>` «Correo» (M.titulo).
//   - Al montar: GET /api/cuenta/correo (una vez) → `PreferenciasCorreoVista`. Cuatro `role="switch"` con el nombre de
//     M.interruptores.* y su valor (`aria-checked`); «todos los clientes» (M.todos, también `switch`) SOLO si
//     `todosDisponible`; M.todosIgnorado (visible) si `todosIgnorado`; con `ultimoEnvioFallido` un aviso M.fallo(fecha),
//     la fecha en `fechaCorta` (hora de Lima), nunca el ISO; botón «Guardar» (44 px).
//   - «Guardar»: un PUT /api/cuenta/correo con EXACTAMENTE las cinco claves de `preferenciasCorreoSchema` (con X-CSRF-Token y
//     X-Estudio de la sesión); `todosClientes` viaja `false` si `todosDisponible` es false (no se reenvía una marca ignorada,
//     que daría 409). Botón deshabilitado mientras guarda (doble clic → un PUT). 200 → M.guardado y la pantalla queda con lo
//     devuelto; 403 → M.sinPermisoTodos; 409 → M.todosNoDisponible; cualquier otro fallo o error de red → M.errorGuardar;
//     un GET fallido → M.errorCarga y ningún interruptor. Nunca códigos crudos (TEXTOS_CRUDOS_CORREO).
//   - Mientras `invitacionResumen`, la pantalla incluye la invitación (ver invitacion-resumen.spec.tsx); al activarla el
//     interruptor del resumen queda encendido.
// El rol no se envía ni se lee en el cliente: el servidor decide `todosDisponible` y el 403.

const RUTA = "./preferencias-correo";
const RUTA_PAGINA = "../../app/(app)/cuenta/correo/page";
const cargar = () => cargarComponente(() => import(/* @vite-ignore */ RUTA), "PreferenciasCorreo");

async function pintar(inicial: VistaCorreoPrueba = VISTA_DUENO, opciones: Parameters<typeof instalarServidorCorreo>[1] = {}) {
  const Pantalla = await cargar();
  const srv = instalarServidorCorreo(inicial, opciones);
  const r = render(<Pantalla />);
  return { srv, ...r };
}

const interruptor = (nombre: string) => screen.getByRole("switch", { name: nombre });
const guardar = () => screen.getByRole("button", { name: M.guardar });

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("«Mi cuenta → Correo» · lectura (R-15, CA-13)", () => {
  it("lee una sola vez GET /api/cuenta/correo y muestra los cuatro interruptores con su texto y su valor", async () => {
    const { srv } = await pintar(VISTA_DUENO);
    for (const texto of Object.values(M.interruptores)) {
      expect(await screen.findByRole("switch", { name: texto })).toBeTruthy();
    }
    expect(srv.de(LEER_CORREO)).toHaveLength(1);
    expect(srv.de(LEER_CORREO)[0]?.credentials).toBe("same-origin");
    expect(encendido(interruptor(M.interruptores.buzonCritico))).toBe(true);
    expect(encendido(interruptor(M.interruptores.credencialInvalida))).toBe(true);
    expect(encendido(interruptor(M.interruptores.planLimite))).toBe(true);
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(false);
  });

  it("Contador o Asistente (límite del plan apagado): refleja los valores y no ofrece «todos los clientes»", async () => {
    await pintar(VISTA_CONTADOR);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    expect(encendido(interruptor(M.interruptores.planLimite))).toBe(false);
    expect(encendido(interruptor(M.interruptores.buzonCritico))).toBe(true);
    expect(screen.queryByRole("switch", { name: M.todos })).toBeNull();
    expect(screen.queryByText(M.todos)).toBeNull();
  });

  it("«todos los clientes» solo aparece con `todosDisponible`, y refleja su marca", async () => {
    const { unmount } = await pintar(VISTA_DUENO);
    const todos = await screen.findByRole("switch", { name: M.todos });
    expect(encendido(todos)).toBe(false);
    unmount();
    cleanup();
    await pintar({ ...VISTA_DUENO, todosClientes: true });
    expect(encendido(await screen.findByRole("switch", { name: M.todos }))).toBe(true);
  });

  it("`todosIgnorado`: avisa que la marca ya no aplica y no ofrece el interruptor; sin él, no hay aviso", async () => {
    const { unmount } = await pintar({ ...VISTA_DUENO, todosDisponible: false, todosClientes: true, todosIgnorado: true });
    expect(await screen.findByText(M.todosIgnorado)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: M.todos })).toBeNull();
    unmount();
    cleanup();
    await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.todos });
    expect(screen.queryByText(M.todosIgnorado)).toBeNull();
  });

  it("con el último envío fallido muestra «No pudimos enviarte el último correo (fecha)» con la fecha de Lima, nunca el ISO", async () => {
    const { container } = await pintar({ ...VISTA_DUENO, ultimoEnvioFallido: FALLO_ISO });
    expect(await screen.findByText(M.fallo(FALLO_TEXTO))).toBeTruthy();
    expect(container.textContent).not.toContain(FALLO_ISO);
    expect(container.textContent).not.toContain("T12:30");
  });

  it("sin envío fallido no hay alerta de fallo", async () => {
    await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    expect(screen.queryByText(/No pudimos enviarte el último correo/)).toBeNull();
  });

  it("un GET fallido (500 o red) muestra el error de carga en español y ningún interruptor", async () => {
    await pintar(VISTA_DUENO, { leer: { status: 500, cuerpo: { codigo: "error_interno" } } });
    expect(await screen.findByText(M.errorCarga)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("un GET con forma inválida no rompe la pantalla ni deja interruptores a medias", async () => {
    await pintar(VISTA_DUENO, { leer: { status: 200, cuerpo: { buzonCritico: "si" } } });
    expect(await screen.findByText(M.errorCarga)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("390 px: sin anchos fijos ni scroll interior, y «Guardar» con objetivo táctil de 44 px", async () => {
    const { container } = await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    expect(anchosFijosMayoresA390(container)).toEqual([]);
    expect(alcanza44px(guardar())).toBe(true);
  });

  it("no muestra códigos internos ni valores sin formato", async () => {
    const { container } = await pintar({ ...VISTA_DUENO, ultimoEnvioFallido: FALLO_ISO, invitacionResumen: true });
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    for (const crudo of TEXTOS_CRUDOS_CORREO) expect(container.textContent, crudo).not.toContain(crudo);
  });
});

describe("«Mi cuenta → Correo» · guardar (R-4, R-10, CA-12, CA-13)", () => {
  it("«Guardar» sin cambios envía un PUT con exactamente las cinco claves y los valores leídos, con CSRF y estudio", async () => {
    const { srv } = await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    await userEvent.setup().click(guardar());
    expect(await screen.findByText(M.guardado)).toBeTruthy();
    const puts = srv.de(GUARDAR_CORREO);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual(cuerpoDe(VISTA_DUENO));
    expect(Object.keys(puts[0]?.body as object).sort()).toEqual(
      ["buzonCritico", "credencialInvalida", "planLimite", "resumen", "todosClientes"].sort(),
    );
    expect(puts[0]?.url).toBe("/api/cuenta/correo");
    expect(puts[0]?.credentials).toBe("same-origin");
    expect(puts[0]?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    expect(puts[0]?.headers["x-estudio"]).toBe("e-a");
    expect(puts[0]?.headers["content-type"]).toBe("application/json");
  });

  it("cambiar un interruptor no llama a la API hasta pulsar «Guardar»; luego el PUT lleva el cambio", async () => {
    const { srv } = await pintar(VISTA_DUENO);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: M.interruptores.resumen }));
    await user.click(interruptor(M.interruptores.buzonCritico));
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(true);
    expect(encendido(interruptor(M.interruptores.buzonCritico))).toBe(false);
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(0);
    await user.click(guardar());
    await screen.findByText(M.guardado);
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(VISTA_DUENO, { resumen: true, buzonCritico: false }));
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(true);
  });

  it("un Dueño marca «todos los clientes» y el PUT lleva `todosClientes: true`", async () => {
    const { srv } = await pintar(VISTA_DUENO);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: M.todos }));
    await user.click(guardar());
    await screen.findByText(M.guardado);
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(VISTA_DUENO, { todosClientes: true }));
  });

  it("si la marca de «todos» se ignora, el PUT la envía en false (no reenvía una marca que daría 409)", async () => {
    const vista = { ...VISTA_DUENO, todosDisponible: false, todosClientes: true, todosIgnorado: true };
    const { srv } = await pintar(vista);
    await screen.findByText(M.todosIgnorado);
    await userEvent.setup().click(guardar());
    await screen.findByText(M.guardado);
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(vista, { todosClientes: false }));
  });

  it("el cuerpo del PUT nunca lleva usuario, estudio, rol ni los campos de solo lectura de la vista", async () => {
    const { srv } = await pintar({ ...VISTA_DUENO, ultimoEnvioFallido: FALLO_ISO });
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    await userEvent.setup().click(guardar());
    await screen.findByText(M.guardado);
    const cuerpo = JSON.stringify(srv.de(GUARDAR_CORREO)[0]?.body);
    for (const prohibido of ["usuarioId", "tenantId", "rol", "todosDisponible", "todosIgnorado", "invitacionResumen", "ultimoEnvioFallido"]) {
      expect(cuerpo, prohibido).not.toContain(prohibido);
    }
  });

  it("doble clic en «Guardar» → un solo PUT, y el botón queda deshabilitado mientras guarda", async () => {
    let liberar: (() => void) | undefined;
    const puerta = new Promise<void>((r) => {
      liberar = r;
    });
    const base = await pintar(VISTA_DUENO);
    const original = globalThis.fetch;
    const lento = vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") await puerta;
      return original(entrada, init);
    });
    vi.stubGlobal("fetch", lento);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    const user = userEvent.setup();
    await user.dblClick(guardar());
    expect((guardar() as HTMLButtonElement).disabled).toBe(true);
    liberar?.();
    await screen.findByText(M.guardado);
    expect(base.srv.de(GUARDAR_CORREO)).toHaveLength(1);
  });

  it("403 (rol sin permiso para «todos los clientes») → texto en español, sin confirmación ni código crudo", async () => {
    const { container, srv } = await pintar(VISTA_DUENO, {
      guardar: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: M.todos }));
    await user.click(guardar());
    expect(await screen.findByText(M.sinPermisoTodos)).toBeTruthy();
    expect(screen.queryByText(M.guardado)).toBeNull();
    expect(container.textContent).not.toContain("permiso_denegado");
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(1);
    // Lo que el usuario marcó se conserva para que lo corrija.
    expect(encendido(interruptor(M.todos))).toBe(true);
  });

  it("409 todos_clientes_no_disponible → texto en español, sin confirmación ni código crudo", async () => {
    const { container } = await pintar(VISTA_DUENO, {
      guardar: { status: 409, cuerpo: { codigo: "todos_clientes_no_disponible" } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: M.todos }));
    await user.click(guardar());
    expect(await screen.findByText(M.todosNoDisponible)).toBeTruthy();
    expect(screen.queryByText(M.guardado)).toBeNull();
    expect(container.textContent).not.toContain("todos_clientes_no_disponible");
  });

  it.each([
    ["400 solicitud_invalida", { status: 400, cuerpo: { codigo: "solicitud_invalida" } }],
    ["500", { status: 500, cuerpo: { codigo: "error_interno" } }],
    ["503", { status: 503, cuerpo: {} }],
  ])("%s → mensaje general de error al guardar, sin confirmación", async (_c, respuesta) => {
    const { container } = await pintar(VISTA_DUENO, { guardar: respuesta });
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    await userEvent.setup().click(guardar());
    expect(await screen.findByText(M.errorGuardar)).toBeTruthy();
    expect(screen.queryByText(M.guardado)).toBeNull();
    expect(container.textContent).not.toContain("solicitud_invalida");
  });

  it("tras un error, «Guardar» vuelve a estar disponible y el reintento (200) confirma y quita el error", async () => {
    const { srv } = await pintar(VISTA_DUENO, {
      guardar: (_l, vez) =>
        vez === 1 ? { status: 500, cuerpo: {} } : { status: 200, cuerpo: { ...VISTA_DUENO } },
    });
    const user = userEvent.setup();
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    await user.click(guardar());
    await screen.findByText(M.errorGuardar);
    expect((guardar() as HTMLButtonElement).disabled).toBe(false);
    await user.click(guardar());
    expect(await screen.findByText(M.guardado)).toBeTruthy();
    expect(screen.queryByText(M.errorGuardar)).toBeNull();
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(2);
  });

  it("un error de red al guardar muestra el mensaje general y no rompe la pantalla", async () => {
    await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "PUT") throw new TypeError("fallo de red");
        return original(entrada, init);
      }),
    );
    await userEvent.setup().click(guardar());
    expect(await screen.findByText(M.errorGuardar)).toBeTruthy();
    expect(screen.getAllByRole("switch").length).toBeGreaterThanOrEqual(4);
  });
});

describe("«Mi cuenta → Correo» · invitación dentro de la página (R-15)", () => {
  it("con `invitacionResumen` muestra la invitación; «Activar resumen» enciende el interruptor y la quita", async () => {
    const { srv } = await pintar(VISTA_INICIAL);
    const user = userEvent.setup();
    expect(await screen.findByText(M.invitacion)).toBeTruthy();
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(false);
    await user.click(screen.getByRole("button", { name: M.activarResumen }));
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    expect(srv.de(GUARDAR_CORREO)).toHaveLength(1);
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(VISTA_INICIAL, { resumen: true }));
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(true);
  });

  it("«Ahora no» guarda el resumen apagado, quita la invitación y deja el interruptor apagado", async () => {
    const { srv } = await pintar(VISTA_INICIAL);
    await userEvent.setup().click(await screen.findByRole("button", { name: M.ahoraNo }));
    await vi.waitFor(() => expect(screen.queryByText(M.invitacion)).toBeNull());
    expect(srv.de(GUARDAR_CORREO)[0]?.body).toEqual(cuerpoDe(VISTA_INICIAL, { resumen: false }));
    expect(encendido(interruptor(M.interruptores.resumen))).toBe(false);
  });

  it("sin `invitacionResumen` no hay invitación", async () => {
    await pintar(VISTA_DUENO);
    await screen.findByRole("switch", { name: M.interruptores.resumen });
    expect(screen.queryByText(M.invitacion)).toBeNull();
    expect(screen.queryByRole("button", { name: M.activarResumen })).toBeNull();
    expect(screen.queryByRole("button", { name: M.ahoraNo })).toBeNull();
  });
});

describe("página /cuenta/correo", () => {
  it("pinta el título «Correo» y las preferencias", async () => {
    const Pagina = await cargarComponente(() => import(/* @vite-ignore */ RUTA_PAGINA), "default");
    instalarServidorCorreo(VISTA_DUENO);
    render(<Pagina />);
    expect(await screen.findByRole("heading", { level: 1, name: M.titulo })).toBeTruthy();
    expect(await screen.findByRole("switch", { name: M.interruptores.resumen })).toBeTruthy();
  });
});

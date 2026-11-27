import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuPrincipal } from "../../../components/marco/menu-principal";
import {
  etiquetaDeRol,
  mensajeDeError,
  puedeOtorgarComoPropio,
  usePuede,
  type Yo,
} from "../../../lib/acceso";
import {
  mensajeDeErrorRol,
  MENSAJES_ROLES,
  requisitosDe,
} from "../../../lib/roles";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  ETIQUETA_ROL,
  MENSAJES_ACCESO,
  asentar,
  esperarFila,
  rutaSesion,
  yoDe,
} from "../../../pruebas/acceso";
import {
  AUDITOR,
  ID_AUDITOR,
  ID_PRACTICANTE,
  PRACTICANTE,
  casilla,
  filaDe,
  rutasRoles,
  yoPropio,
} from "../../../pruebas/roles";
import {
  crearRouterFalso,
  instalarFetchFalso,
  type Manejador,
} from "../../../pruebas/soporte";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const ruta = vi.hoisted(() => ({ actual: "/usuarios" as string | null }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => ruta.actual,
  useSearchParams: () => new URLSearchParams(),
}));

import Roles from "./roles/page";
import Usuarios from "./page";

// Cobertura de comportamiento público de las pantallas de roles (spec 030, T10): errores de carga, fallos de red,
// mensajes por código y el menú. Complementa las pruebas de T4 sin repetirlas.

const USUARIOS = [
  {
    usuarioId: "u-con",
    nombre: "Carlos Contador",
    correo: "carlos@estudio.test",
    rol: "contador",
    activo: true,
    esYo: false,
  },
];

function rutasUsuarios(
  extra: Record<string, Manejador> = {},
  yo: Record<string, unknown> = yoDe("dueno"),
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yo },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    "GET /api/invitaciones": { status: 200, cuerpo: [] },
    "GET /api/roles/asignables": { status: 500, cuerpo: {} },
    ...extra,
  };
}

describe("roles · cobertura de errores y menú (030)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    ruta.actual = "/usuarios";
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("/usuarios", () => {
    it("GET /acceso/yo falla: mensaje genérico", async () => {
      instalarFetchFalso(
        rutasUsuarios({ "GET /api/acceso/yo": { status: 500, cuerpo: {} } }),
      );
      render(<Usuarios />);
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    });

    it.each(["GET /api/usuarios", "GET /api/invitaciones"])(
      "%s falla: mensaje genérico en alerta",
      async (ruta) => {
        instalarFetchFalso(
          rutasUsuarios({ [ruta]: { status: 500, cuerpo: {} } }),
        );
        render(<Usuarios />);
        const alerta = await screen.findByRole("alert");
        expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
      },
    );

    it("un fallo de red al cargar muestra el mensaje genérico", async () => {
      const rutas = rutasUsuarios();
      delete rutas["GET /api/acceso/yo"];
      instalarFetchFalso(rutas);
      render(<Usuarios />);
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    });

    it("un fallo de red al cambiar de rol muestra el mensaje genérico", async () => {
      instalarFetchFalso(rutasUsuarios());
      render(<Usuarios />);
      const fila = await esperarFila("carlos@estudio.test");
      const user = userEvent.setup();
      await user.selectOptions(
        within(fila).getByRole("combobox", { name: "Cambiar rol" }),
        ETIQUETA_ROL.lectura,
      );
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    });

    it("un actor con rol propio sin asignables solo ve los roles de sistema que cabe en sus permisos", async () => {
      instalarFetchFalso(
        rutasUsuarios(
          {},
          yoPropio(
            [
              "usuarios.ver",
              "usuarios.gestionar",
              "clientes.ver",
              "buzon.ver",
              "reglas.ver",
              "prorrata.ver",
            ],
            "asignado",
            { id: ID_AUDITOR, nombre: "Auditor" },
          ),
        ),
      );
      render(<Usuarios />);
      await esperarFila("carlos@estudio.test");
      await asentar();
      const rol = screen.getByLabelText("Rol") as HTMLSelectElement;
      expect([...rol.options].map((o) => o.value)).toEqual(["lectura"]);
      // Sin asignables, un miembro de sistema no es tocable por un actor con rol propio.
      expect(
        screen.queryByRole("combobox", { name: "Cambiar rol" }),
      ).toBeNull();
    });
  });

  describe("/usuarios (selector)", () => {
    it("si el rol por omisión no es asignable, el selector y el cuerpo usan la primera opción", async () => {
      const f = instalarFetchFalso(
        rutasUsuarios({
          "GET /api/roles/asignables": {
            status: 200,
            cuerpo: { sistema: ["contador"], propios: [] },
          },
          "POST /api/invitaciones": { status: 201, cuerpo: {} },
        }),
      );
      render(<Usuarios />);
      await esperarFila("carlos@estudio.test");
      await vi.waitFor(() =>
        expect(
          [...(screen.getByLabelText("Rol") as HTMLSelectElement).options].map(
            (o) => o.value,
          ),
        ).toEqual(["contador"]),
      );
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
      await user.click(screen.getByRole("button", { name: "Invitar" }));
      await vi.waitFor(() =>
        expect(f.de("POST /api/invitaciones")).toHaveLength(1),
      );
      expect(f.de("POST /api/invitaciones")[0]?.body).toEqual({
        correo: "otra@estudio.test",
        rol: "contador",
      });
    });

    it("sin ningún rol asignable el selector queda vacío", async () => {
      instalarFetchFalso(
        rutasUsuarios({
          "GET /api/roles/asignables": {
            status: 200,
            cuerpo: { sistema: [], propios: [] },
          },
        }),
      );
      render(<Usuarios />);
      await esperarFila("carlos@estudio.test");
      await asentar();
      expect(
        (screen.getByLabelText("Rol") as HTMLSelectElement).options,
      ).toHaveLength(0);
    });

    it("un miembro con rol propio sin referencia no rompe la pantalla", async () => {
      instalarFetchFalso(
        rutasUsuarios({
          "GET /api/usuarios": {
            status: 200,
            cuerpo: [{ ...USUARIOS[0], rol: "propio", rolPropio: null }],
          },
        }),
      );
      render(<Usuarios />);
      const fila = await esperarFila("carlos@estudio.test");
      expect(fila.textContent).toContain("Rol propio");
    });

    it("al salir antes de que carguen los datos no actualiza nada", async () => {
      instalarFetchFalso(rutasUsuarios());
      const { unmount } = render(<Usuarios />);
      unmount();
      await asentar();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("/usuarios/roles", () => {
    it("al salir antes de que carguen los datos no actualiza nada", async () => {
      instalarFetchFalso(rutasRoles());
      const { unmount } = render(<Roles />);
      unmount();
      await asentar();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("GET /acceso/yo falla: mensaje genérico y sin tablas", async () => {
      instalarFetchFalso(
        rutasRoles({ "GET /api/acceso/yo": { status: 500, cuerpo: {} } }),
      );
      render(<Roles />);
      expect(screen.getByText(MENSAJES_ROLES.cargando)).toBeTruthy();
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("un fallo de red al cargar muestra el mensaje genérico", async () => {
      const rutas = rutasRoles();
      delete rutas["GET /api/acceso/yo"];
      instalarFetchFalso(rutas);
      render(<Roles />);
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    });

    it("un fallo de red al eliminar muestra el mensaje genérico", async () => {
      instalarFetchFalso(rutasRoles());
      render(<Roles />);
      await screen.findByRole("table", { name: "Roles propios" });
      const user = userEvent.setup();
      await user.click(
        within(filaDe("Roles propios", AUDITOR.nombre)).getByRole("button", {
          name: "Eliminar",
        }),
      );
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
    });

    it("un fallo de red al crear deja el formulario abierto con el mensaje genérico", async () => {
      instalarFetchFalso(rutasRoles());
      render(<Roles />);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Crear rol" }),
      );
      const form = await screen.findByRole("form", { name: "Datos del rol" });
      await user.type(
        within(form).getByRole("textbox", { name: "Nombre" }),
        "Pasante",
      );
      await user.click(casilla("clientes.ver"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
      expect(screen.getByRole("form", { name: "Datos del rol" })).toBeTruthy();
    });

    it("un fallo de red al pedir el impacto muestra el mensaje genérico y no guarda", async () => {
      const f = instalarFetchFalso(rutasRoles());
      render(<Roles />);
      await screen.findByRole("table", { name: "Roles propios" });
      const user = userEvent.setup();
      await user.click(
        within(filaDe("Roles propios", PRACTICANTE.nombre)).getByRole(
          "button",
          {
            name: "Editar",
          },
        ),
      );
      const form = await screen.findByRole("form", { name: "Datos del rol" });
      await user.click(casilla("sire.clasificar"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_ACCESO.errorGeneral);
      expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(0);
    });

    it("si el impacto no afecta a nadie guarda directamente", async () => {
      const f = instalarFetchFalso(
        rutasRoles({
          [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
            status: 200,
            cuerpo: {
              miembros: 0,
              clientesSinResponsable: 0,
              miembrosSinTotpExigidos: 0,
            },
          },
          [`PATCH /api/roles/${ID_PRACTICANTE}`]: {
            status: 200,
            cuerpo: PRACTICANTE,
          },
        }),
      );
      render(<Roles />);
      await screen.findByRole("table", { name: "Roles propios" });
      const user = userEvent.setup();
      await user.click(
        within(filaDe("Roles propios", PRACTICANTE.nombre)).getByRole(
          "button",
          {
            name: "Editar",
          },
        ),
      );
      const form = await screen.findByRole("form", { name: "Datos del rol" });
      await user.click(casilla("sire.clasificar"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      expect(await screen.findByText(MENSAJES_ROLES.rolGuardado)).toBeTruthy();
      expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(1);
    });

    it("cambiar el formulario descarta el aviso de impacto", async () => {
      instalarFetchFalso(
        rutasRoles({
          [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
            status: 200,
            cuerpo: {
              miembros: 2,
              clientesSinResponsable: 0,
              miembrosSinTotpExigidos: 0,
            },
          },
        }),
      );
      render(<Roles />);
      await screen.findByRole("table", { name: "Roles propios" });
      const user = userEvent.setup();
      await user.click(
        within(filaDe("Roles propios", PRACTICANTE.nombre)).getByRole(
          "button",
          {
            name: "Editar",
          },
        ),
      );
      const form = await screen.findByRole("form", { name: "Datos del rol" });
      await user.click(casilla("sire.clasificar"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      await screen.findByRole("region", { name: "Impacto del cambio" });
      await user.click(casilla("sire.descargar"));
      expect(
        screen.queryByRole("region", { name: "Impacto del cambio" }),
      ).toBeNull();
    });
  });

  describe("lib", () => {
    it.each([
      [403, { codigo: "otro" }, MENSAJES_ACCESO.sinPermiso],
      [409, { codigo: "otro" }, MENSAJES_ACCESO.errorGeneral],
      [409, { codigo: "rol_en_uso" }, MENSAJES_ROLES.enUso(0, 0)],
      [422, { codigo: "otro" }, MENSAJES_ACCESO.errorGeneral],
      [422, { codigo: "combinacion_invalida" }, MENSAJES_ACCESO.errorGeneral],
      [500, null, MENSAJES_ACCESO.errorGeneral],
    ])("mensajeDeErrorRol(%i, %j)", (status, datos, esperado) => {
      expect(mensajeDeErrorRol(status, datos)).toBe(esperado);
    });

    it("requisitosDe: lista lo que U3 exige y vacío si no exige nada", () => {
      expect(requisitosDe("usuarios.gestionar")).toEqual(["usuarios.ver"]);
      expect(requisitosDe("clientes.ver")).toEqual([]);
    });

    it("etiquetaDeRol: sistema, propio con nombre y propio sin referencia", () => {
      expect(etiquetaDeRol("admin")).toBe(ETIQUETA_ROL.admin);
      expect(
        etiquetaDeRol("propio", { id: ID_AUDITOR, nombre: "Auditor" }),
      ).toBe("Auditor");
      expect(etiquetaDeRol("propio")).toBe("Rol propio");
    });

    it("puedeOtorgarComoPropio: contención por permisos y alcance", () => {
      const yo: Yo = {
        rol: "propio",
        rolPropio: { id: ID_AUDITOR, nombre: "Auditor" },
        permisos: ["clientes.ver", "buzon.ver", "reglas.ver", "prorrata.ver"],
        alcance: "asignado",
      };
      expect(puedeOtorgarComoPropio(yo, "lectura")).toBe(true);
      expect(puedeOtorgarComoPropio(yo, "contador")).toBe(false);
      expect(
        puedeOtorgarComoPropio({ ...yo, alcance: "global" }, "admin"),
      ).toBe(false);
    });

    it("mensajeDeError: rol propio, 409 sin cuerpo y último Dueño", () => {
      expect(mensajeDeError(403, { codigo: "rol_propio" })).toBe(
        MENSAJES_ROLES.rolPropio,
      );
      expect(mensajeDeError(403, null)).toBe(MENSAJES_ACCESO.sinPermiso);
      expect(mensajeDeError(409, null)).toBe(MENSAJES_ACCESO.errorGeneral);
      expect(mensajeDeError(409, { codigo: "ultimo_dueno" })).toBe(
        MENSAJES_ACCESO.ultimoDueno,
      );
    });

    it.each([
      ["con permiso", yoDe("admin", ["roles.gestionar"])],
      ["sin respuesta", null],
    ])(
      "usePuede al desmontar antes de la respuesta (%s) no falla",
      async (_n, yo) => {
        instalarFetchFalso({
          ...rutaSesion(),
          ...(yo ? { "GET /api/acceso/yo": { status: 200, cuerpo: yo } } : {}),
        });
        const { unmount, result } = renderHook(() =>
          usePuede("roles.gestionar"),
        );
        expect(result.current).toBeUndefined();
        unmount();
        await asentar();
        expect(result.current).toBeUndefined();
      },
    );

    it("usePuede: si GET /acceso/yo falla no da permiso", async () => {
      instalarFetchFalso(rutaSesion());
      const { result } = renderHook(() => usePuede("roles.gestionar"));
      await vi.waitFor(() => expect(result.current).toBe(false));
    });
  });

  describe("menú", () => {
    it("sin ruta conocida ninguna entrada queda activa y «Reglas del motor» sale con reglas.ver", () => {
      ruta.actual = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      montarMenu(["usuarios.ver", "reglas.ver"]);
      expect(
        screen.getByRole("link", { name: "Reglas del motor" }),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: "Usuarios" })
          .getAttribute("aria-current"),
      ).toBeNull();
    });

    it("en /usuarios/roles solo «Roles» queda activa", () => {
      ruta.actual = "/usuarios/roles";
      montarMenu(["usuarios.ver", "roles.gestionar"]);
      expect(
        screen
          .getByRole("link", { name: "Roles" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(
        screen
          .getByRole("link", { name: "Usuarios" })
          .getAttribute("aria-current"),
      ).toBeNull();
    });

    function montarMenu(permisos: string[]) {
      return render(
        <MenuPrincipal
          estudioActivoId="e-a"
          estudios={[{ id: "e-a", nombre: "Estudio Alfa" }]}
          yo={{ rol: "admin", permisos, alcance: "global" }}
          campana={null}
          alCambiarEstudio={vi.fn()}
          alCerrarSesion={vi.fn()}
        />,
      );
    }

    it("«Más» se cierra con Escape y al elegir un enlace; «Roles» no deja «Usuarios» activo", async () => {
      montarMenu(["usuarios.ver", "roles.gestionar"]);
      const mas = screen.getByRole("button", { name: "Más" });
      fireEvent.click(mas);
      expect(mas.getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(document, { key: "a" });
      expect(mas.getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(mas.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(mas);
      fireEvent.click(screen.getByRole("link", { name: "Roles" }));
      expect(mas.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByRole("link", { name: "Usuarios" })).toBeTruthy();
    });
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import { MENSAJES_ACCESO, asentar, yoDe } from "../../../../pruebas/acceso";
import {
  AUDITOR,
  ID_AUDITOR,
  ID_PRACTICANTE,
  MENSAJES_ROLES,
  PERMISOS_ACTOR_TOTAL,
  PERMISOS_OFRECIDOS,
  PRACTICANTE,
  casilla,
  filaDe,
  rutasRoles,
} from "../../../../pruebas/roles";
import {
  crearRouterFalso,
  instalarFetchFalso,
  type FetchFalso,
  type Manejador,
} from "../../../../pruebas/soporte";

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
  usePathname: () => "/usuarios/roles",
  useSearchParams: () => new URLSearchParams(),
}));

import Roles from "./page";

// Contrato (plan 030, Contratos HTTP; spec U2, U3, U4, U6, U8, U9; CA-1, CA-2). Formulario de rol en
// /usuarios/roles (T10), abierto con "Crear rol" o con "Editar" de una fila propia:
// - Formulario (role=form, nombre "Datos del rol"): textbox "Nombre" (maxLength 40), select "Alcance"
//   (opciones `global` y `asignado`), select "Partir de" (opción vacía + roles de sistema y propios por
//   etiqueta/nombre) y una casilla por permiso ofrecido cuyo nombre accesible es el código del permiso
//   (23, sin `plan.gestionar`: CA-2). Botones "Guardar" y "Cancelar".
// - Partir de un rol de sistema o propio copia alcance y permisos en el formulario (editable). El cuerpo
//   de POST /api/roles lleva siempre `{nombre, alcance, permisos}`; `baseRolId` solo si la base es un
//   rol propio. Un rol de sistema no tiene id: nunca va como `baseRolId`.
// - U3 se valida antes de enviar: sin el `.ver` requerido no hay petición y se muestra, en role=alert,
//   MENSAJES_ROLES.falta(<permiso>). El formulario no completa casillas solo. El 422
//   `combinacion_invalida` (cuerpo `{codigo, permiso}`) muestra el mismo texto.
// - Nombre vacío: MENSAJES_ROLES.nombreObligatorio, sin petición.
// - U2/U4 (solo comodidad): casillas de permisos que el actor no tiene y la opción de alcance `global`
//   (si el actor es de alcance asignado) aparecen deshabilitadas.
// - Crear: POST /api/roles con X-CSRF-Token → 201: MENSAJES_ROLES.rolCreado, cierra el formulario y
//   recarga GET /api/roles. Errores: 409 nombre_duplicado, 409 limite_roles, 403 escalada, 422
//   permiso_invalido → su texto de MENSAJES_ROLES, sin mostrar el código; el formulario sigue abierto.
// - Editar (U6, U8): el formulario llega precargado. "Guardar" con el rol en uso (`miembros` > 0) pide
//   POST /api/roles/:id/impacto con el cuerpo de edición `{nombre, alcance, permisos}` y muestra la
//   región "Impacto del cambio" con una línea por cifra > 0 (impactoMiembros, impactoSinResponsable,
//   impactoTotp) y los botones "Confirmar" y "Cancelar"; solo "Confirmar" envía PATCH /api/roles/:id
//   (mismo cuerpo) → rolGuardado y recarga. Sin miembros: PATCH directo, sin pedir impacto ni avisar.
//   PATCH 404 → noEncontrado; 403 escalada / rol_propio → su texto.

const ALCANCE_ACTOR_GLOBAL = yoDe("dueno", PERMISOS_ACTOR_TOTAL);

function montar(
  extra: Record<string, Manejador> = {},
  yo: Record<string, unknown> = ALCANCE_ACTOR_GLOBAL,
): FetchFalso {
  const f = instalarFetchFalso(rutasRoles(extra, yo));
  render(<Roles />);
  return f;
}

async function abrirCrear(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Crear rol" }));
  return screen.findByRole("form", { name: "Datos del rol" });
}

async function abrirEditar(
  user: ReturnType<typeof userEvent.setup>,
  nombre: string,
) {
  await screen.findByRole("table", { name: "Roles propios" });
  await user.click(
    within(filaDe("Roles propios", nombre)).getByRole("button", {
      name: "Editar",
    }),
  );
  return screen.findByRole("form", { name: "Datos del rol" });
}

const marcadas = (): string[] =>
  PERMISOS_OFRECIDOS.filter((p) => casilla(p).checked).sort();

describe("/usuarios/roles · formulario", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("crear: ofrece 23 casillas (sin plan.gestionar), nombre de máximo 40 y alcance global/asignado", async () => {
    montar();
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    const casillas = within(form).getAllByRole("checkbox");
    expect(casillas).toHaveLength(23);
    expect(PERMISOS_OFRECIDOS).toHaveLength(23);
    for (const permiso of PERMISOS_OFRECIDOS)
      expect(casilla(permiso).checked, permiso).toBe(false);
    expect(
      within(form).queryByRole("checkbox", { name: "plan.gestionar" }),
    ).toBeNull();
    const nombre = within(form).getByRole("textbox", {
      name: "Nombre",
    }) as HTMLInputElement;
    expect(nombre.maxLength).toBe(40);
    const alcance = within(form).getByLabelText("Alcance") as HTMLSelectElement;
    expect([...alcance.options].map((o) => o.value).sort()).toEqual([
      "asignado",
      "global",
    ]);
  });

  it("crear: POST /api/roles {nombre, alcance, permisos} con X-CSRF-Token; mensaje, cierre y recarga", async () => {
    const f = montar({
      "POST /api/roles": {
        status: 201,
        cuerpo: { ...AUDITOR, id: "nuevo", nombre: "Pasante" },
      },
    });
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.type(
      within(form).getByRole("textbox", { name: "Nombre" }),
      "Pasante",
    );
    await user.selectOptions(
      within(form).getByLabelText("Alcance"),
      "asignado",
    );
    await user.click(casilla("clientes.ver"));
    await user.click(casilla("sire.descargar"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText(MENSAJES_ROLES.rolCreado)).toBeTruthy();
    const [llamada] = f.de("POST /api/roles");
    const cuerpo = llamada?.body as {
      nombre: string;
      alcance: string;
      permisos: string[];
    };
    expect(cuerpo.nombre).toBe("Pasante");
    expect(cuerpo.alcance).toBe("asignado");
    expect([...cuerpo.permisos].sort()).toEqual([
      "clientes.ver",
      "sire.descargar",
    ]);
    expect(Object.keys(cuerpo).sort()).toEqual([
      "alcance",
      "nombre",
      "permisos",
    ]);
    expect(llamada?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/roles")).toHaveLength(2));
    expect(screen.queryByRole("form", { name: "Datos del rol" })).toBeNull();
  });

  it("partir de un rol de sistema (Contador): copia alcance y permisos; el cuerpo no lleva baseRolId", async () => {
    const f = montar({
      "POST /api/roles": { status: 201, cuerpo: { ...AUDITOR, id: "n" } },
    });
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.selectOptions(
      within(form).getByLabelText("Partir de"),
      "Contador",
    );
    expect(marcadas()).toEqual(["clientes.ver", "credenciales.editar"]);
    expect(
      (within(form).getByLabelText("Alcance") as HTMLSelectElement).value,
    ).toBe("asignado");
    // La copia es editable.
    await user.click(casilla("sire.descargar"));
    await user.type(
      within(form).getByRole("textbox", { name: "Nombre" }),
      "Contador junior",
    );
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    await vi.waitFor(() => expect(f.de("POST /api/roles")).toHaveLength(1));
    const cuerpo = f.de("POST /api/roles")[0]?.body as Record<string, unknown>;
    expect(cuerpo).not.toHaveProperty("baseRolId");
    expect([...(cuerpo.permisos as string[])].sort()).toEqual([
      "clientes.ver",
      "credenciales.editar",
      "sire.descargar",
    ]);
  });

  it("partir de un rol propio (Practicante): copia sus permisos y envía baseRolId con su id", async () => {
    const f = montar({
      "POST /api/roles": { status: 201, cuerpo: { ...AUDITOR, id: "n" } },
    });
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.selectOptions(
      within(form).getByLabelText("Partir de"),
      "Practicante",
    );
    expect(marcadas()).toEqual([...PRACTICANTE.permisos].sort());
    await user.type(
      within(form).getByRole("textbox", { name: "Nombre" }),
      "Practicante senior",
    );
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    await vi.waitFor(() => expect(f.de("POST /api/roles")).toHaveLength(1));
    const cuerpo = f.de("POST /api/roles")[0]?.body as Record<string, unknown>;
    expect(cuerpo.baseRolId).toBe(ID_PRACTICANTE);
    expect(cuerpo.nombre).toBe("Practicante senior");
  });

  it("U3: usuarios.gestionar sin usuarios.ver no envía y nombra el permiso faltante; no completa casillas", async () => {
    const f = montar();
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.type(
      within(form).getByRole("textbox", { name: "Nombre" }),
      "Gestor",
    );
    await user.click(casilla("usuarios.gestionar"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.falta("usuarios.ver"));
    expect(casilla("usuarios.ver").checked).toBe(false);
    await asentar();
    expect(f.de("POST /api/roles")).toHaveLength(0);
  });

  it("U3: un permiso de cliente sin clientes.ver no envía y pide clientes.ver", async () => {
    const f = montar();
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.type(
      within(form).getByRole("textbox", { name: "Nombre" }),
      "Solo SIRE",
    );
    await user.click(casilla("sire.descargar"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.falta("clientes.ver"));
    await asentar();
    expect(f.de("POST /api/roles")).toHaveLength(0);
  });

  it("nombre vacío: mensaje y ninguna petición", async () => {
    const f = montar();
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.click(casilla("clientes.ver"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.nombreObligatorio);
    await asentar();
    expect(f.de("POST /api/roles")).toHaveLength(0);
  });

  it.each([
    [
      422,
      { codigo: "combinacion_invalida", permiso: "buzon.ver" },
      MENSAJES_ROLES.falta("buzon.ver"),
    ],
    [
      422,
      { codigo: "permiso_invalido", permiso: "plan.gestionar" },
      MENSAJES_ROLES.permisoInvalido,
    ],
    [409, { codigo: "nombre_duplicado" }, MENSAJES_ROLES.nombreDuplicado],
    [409, { codigo: "limite_roles" }, MENSAJES_ROLES.limiteRoles],
    [403, { codigo: "escalada" }, MENSAJES_ROLES.escalada],
    [500, { codigo: "boom_interno" }, MENSAJES_ACCESO.errorGeneral],
  ])(
    "crear: %i %j → su mensaje, sin código, y el formulario sigue abierto",
    async (status, cuerpo, mensaje) => {
      montar({ "POST /api/roles": { status, cuerpo } });
      const user = userEvent.setup();
      const form = await abrirCrear(user);
      await user.type(
        within(form).getByRole("textbox", { name: "Nombre" }),
        "Pasante",
      );
      await user.click(casilla("clientes.ver"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(mensaje);
      expect(alerta.textContent).not.toContain(cuerpo.codigo);
      expect(screen.getByRole("form", { name: "Datos del rol" })).toBeTruthy();
    },
  );

  it("cancelar cierra el formulario sin enviar nada", async () => {
    const f = montar();
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    await user.click(within(form).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("form", { name: "Datos del rol" })).toBeNull();
    expect(f.de("POST /api/roles")).toHaveLength(0);
  });

  it("U2: un actor sin ciertos permisos ve esas casillas deshabilitadas; el resto, habilitadas", async () => {
    montar(
      {},
      yoDe("admin", [
        "roles.gestionar",
        "usuarios.ver",
        "clientes.ver",
        "sire.descargar",
      ]),
    );
    const user = userEvent.setup();
    await abrirCrear(user);
    expect(casilla("clientes.ver").disabled).toBe(false);
    expect(casilla("sire.descargar").disabled).toBe(false);
    expect(casilla("usuarios.gestionar").disabled).toBe(true);
    expect(casilla("auditoria.ver").disabled).toBe(true);
    expect(casilla("prorrata.gestionar").disabled).toBe(true);
  });

  it("U4: un actor de alcance asignado no puede elegir alcance global", async () => {
    montar(
      {},
      yoDe("contador", ["roles.gestionar", "usuarios.ver", "clientes.ver"]),
    );
    const user = userEvent.setup();
    const form = await abrirCrear(user);
    const alcance = within(form).getByLabelText("Alcance") as HTMLSelectElement;
    const global = [...alcance.options].find((o) => o.value === "global");
    expect(global?.disabled).toBe(true);
    const asignado = [...alcance.options].find((o) => o.value === "asignado");
    expect(asignado?.disabled).toBe(false);
  });

  it("editar: el formulario llega precargado con nombre, alcance y permisos del rol", async () => {
    montar();
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    expect(
      (
        within(form).getByRole("textbox", {
          name: "Nombre",
        }) as HTMLInputElement
      ).value,
    ).toBe("Practicante");
    expect(
      (within(form).getByLabelText("Alcance") as HTMLSelectElement).value,
    ).toBe("asignado");
    expect(marcadas()).toEqual([...PRACTICANTE.permisos].sort());
  });

  it("editar un rol en uso: pide el impacto, lo muestra y solo Confirmar envía el PATCH", async () => {
    const f = montar({
      [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
        status: 200,
        cuerpo: {
          miembros: 2,
          clientesSinResponsable: 3,
          miembrosSinTotpExigidos: 2,
        },
      },
      [`PATCH /api/roles/${ID_PRACTICANTE}`]: {
        status: 200,
        cuerpo: PRACTICANTE,
      },
    });
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    await user.click(casilla("sire.clasificar")); // lo pierde (U6)
    await user.click(casilla("usuarios.ver"));
    await user.click(casilla("usuarios.gestionar")); // gana uno sensible (U8)
    await user.click(within(form).getByRole("button", { name: "Guardar" }));

    const region = await screen.findByRole("region", {
      name: "Impacto del cambio",
    });
    expect(region.textContent).toContain(MENSAJES_ROLES.impactoMiembros(2));
    expect(region.textContent).toContain(
      MENSAJES_ROLES.impactoSinResponsable(3),
    );
    expect(region.textContent).toContain(MENSAJES_ROLES.impactoTotp(2));
    expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(0);

    const [impacto] = f.de(`POST /api/roles/${ID_PRACTICANTE}/impacto`);
    expect(impacto?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    const cuerpo = impacto?.body as {
      nombre: string;
      alcance: string;
      permisos: string[];
    };
    expect(cuerpo.nombre).toBe("Practicante");
    expect(cuerpo.alcance).toBe("asignado");
    expect([...cuerpo.permisos].sort()).toEqual(
      [
        "clientes.ver",
        "sire.descargar",
        "usuarios.ver",
        "usuarios.gestionar",
      ].sort(),
    );

    await user.click(within(region).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText(MENSAJES_ROLES.rolGuardado)).toBeTruthy();
    const [parche] = f.de(`PATCH /api/roles/${ID_PRACTICANTE}`);
    expect(parche?.body).toEqual(cuerpo);
    expect(parche?.headers["x-csrf-token"]).toBe("csrf-acceso-1");
    await vi.waitFor(() => expect(f.de("GET /api/roles")).toHaveLength(2));
  });

  it("impacto: solo muestra las líneas con cifra mayor que cero", async () => {
    montar({
      [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
        status: 200,
        cuerpo: {
          miembros: 2,
          clientesSinResponsable: 0,
          miembrosSinTotpExigidos: 0,
        },
      },
    });
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    await user.click(casilla("sire.clasificar")); // quita un permiso para que haya cambio
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const region = await screen.findByRole("region", {
      name: "Impacto del cambio",
    });
    expect(region.textContent).toContain(MENSAJES_ROLES.impactoMiembros(2));
    expect(region.textContent).not.toContain("sin responsable");
    expect(region.textContent).not.toContain("(TOTP)");
  });

  it("impacto: Cancelar descarta el aviso y no envía el PATCH", async () => {
    const f = montar({
      [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
        status: 200,
        cuerpo: {
          miembros: 2,
          clientesSinResponsable: 3,
          miembrosSinTotpExigidos: 0,
        },
      },
    });
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    await user.click(casilla("sire.clasificar"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const region = await screen.findByRole("region", {
      name: "Impacto del cambio",
    });
    await user.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(
      screen.queryByRole("region", { name: "Impacto del cambio" }),
    ).toBeNull();
    await asentar();
    expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(0);
  });

  it("editar un rol sin miembros: PATCH directo, sin pedir impacto ni mostrar aviso", async () => {
    const f = montar({
      [`PATCH /api/roles/${ID_AUDITOR}`]: { status: 200, cuerpo: AUDITOR },
    });
    const user = userEvent.setup();
    const form = await abrirEditar(user, AUDITOR.nombre);
    await user.click(casilla("auditoria.ver"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText(MENSAJES_ROLES.rolGuardado)).toBeTruthy();
    expect(f.de(`POST /api/roles/${ID_AUDITOR}/impacto`)).toHaveLength(0);
    expect(
      screen.queryByRole("region", { name: "Impacto del cambio" }),
    ).toBeNull();
    const [parche] = f.de(`PATCH /api/roles/${ID_AUDITOR}`);
    expect(
      [...(parche?.body as { permisos: string[] }).permisos].sort(),
    ).toEqual(["clientes.ver", "usuarios.ver"]);
  });

  it("editar: la validación U3 también corre antes del impacto (sin peticiones)", async () => {
    const f = montar();
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    await user.click(casilla("clientes.ver")); // sire.* queda sin clientes.ver
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.falta("clientes.ver"));
    await asentar();
    expect(f.de(`POST /api/roles/${ID_PRACTICANTE}/impacto`)).toHaveLength(0);
    expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(0);
  });

  it.each([
    [404, { codigo: "no_encontrado" }, MENSAJES_ACCESO.noEncontrado],
    [403, { codigo: "escalada" }, MENSAJES_ROLES.escalada],
    [403, { codigo: "rol_propio" }, MENSAJES_ROLES.rolPropio],
    [409, { codigo: "nombre_duplicado" }, MENSAJES_ROLES.nombreDuplicado],
  ])(
    "editar: PATCH %i %j → su mensaje, sin código",
    async (status, cuerpo, mensaje) => {
      montar({
        [`PATCH /api/roles/${ID_AUDITOR}`]: { status, cuerpo },
      });
      const user = userEvent.setup();
      const form = await abrirEditar(user, AUDITOR.nombre);
      await user.click(casilla("auditoria.ver"));
      await user.click(within(form).getByRole("button", { name: "Guardar" }));
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(mensaje);
      expect(alerta.textContent).not.toContain(cuerpo.codigo);
    },
  );

  it("el impacto con error (403 escalada) muestra el mensaje y no deja pasar al PATCH", async () => {
    const f = montar({
      [`POST /api/roles/${ID_PRACTICANTE}/impacto`]: {
        status: 403,
        cuerpo: { codigo: "escalada" },
      },
    });
    const user = userEvent.setup();
    const form = await abrirEditar(user, PRACTICANTE.nombre);
    await user.click(casilla("sire.clasificar"));
    await user.click(within(form).getByRole("button", { name: "Guardar" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(MENSAJES_ROLES.escalada);
    expect(f.de(`PATCH /api/roles/${ID_PRACTICANTE}`)).toHaveLength(0);
    expect(
      screen.queryByRole("region", { name: "Impacto del cambio" }),
    ).toBeNull();
  });
});

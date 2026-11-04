import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  rutaSesion,
  yoDe,
} from "../../../../pruebas/acceso";
import { MENSAJES_CLIENTES, clienteDe } from "../../../../pruebas/clientes";
import {
  CANARIO_CLAVE_SOL,
  CANARIO_CLIENT_ID,
  CANARIO_CLIENT_SECRET,
  CANARIO_USUARIO_SOL,
  FECHA_VERIFICADA_TEXTO,
  MENSAJES_CREDENCIALES,
  MOTIVO_INVALIDA,
  estadoCredencialDe,
  superficieVisible,
  trabajoDe,
} from "../../../../pruebas/credenciales";
import { usoDe } from "../../../../pruebas/planes";
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
  usePathname: () => "/clientes/c-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Cliente from "./page";

// Contrato (plan 007b, HTTP; D3, D4, D5, D6; CA-4, CA-5, CA-6, CA-10). Detalle /clientes/c-1, además de
// lo de 005 y 007a. Al montar pide también GET /api/clientes/c-1/credenciales →
// [{tipo: "sol"|"sire_api", estado, fecha|null, motivo|null}] (nunca sobre ni secreto).
// - Región "Credenciales" con dos grupos (fieldset + legend): "Credencial SOL" y "Credencial SIRE".
//   Cada grupo muestra el estado con ETIQUETA_ESTADO; «Verificada» con la fecha dd/mm/aaaa (día con o sin
//   cero) y «Inválida» con el motivo tal como llega.
// - Con `credenciales.editar` y cliente activo, cada grupo es un formulario:
//   SOL: "Usuario SOL" (texto) y "Clave SOL" (type=password), botones "Guardar" y "Verificar".
//   SIRE: "Client ID" (texto) y "Client secret" (type=password), botones "Guardar" y "Verificar".
//   El grupo SIRE muestra siempre el aviso MENSAJES_CREDENCIALES.avisoClaveSol.
// - Guardar: PUT /api/clientes/c-1/credenciales/sol {usuario, clave} | /sire_api {clientId, clientSecret},
//   con X-CSRF-Token y X-Estudio; la clave se envía tal cual (sin trim). Campo vacío → no llama a la API y
//   muestra datosInvalidos. 200 {tipo, estado} → MENSAJES_CREDENCIALES.guardada, el estado del grupo pasa a
//   «Configurada» y TODOS los campos del grupo quedan vacíos. Error (400 → datosInvalidos; 403 →
//   MENSAJES_ACCESO.sinPermiso; 409 cliente_archivado → MENSAJES_CLIENTES.clienteArchivado; otro →
//   errorGeneral, en role=alert): los campos de clave quedan vacíos igualmente.
// - El secreto (ni usuario ni clave) no queda en el DOM, ni en valores de controles, ni en
//   localStorage/sessionStorage, ni en el texto de los errores.
// - Verificar: POST /api/clientes/c-1/credenciales/<tipo>/verificar con X-CSRF-Token y sin cuerpo.
//   202 TrabajoVista → MENSAJES_CREDENCIALES.verificacionEncolada y un enlace
//   MENSAJES_CREDENCIALES.enlacePanel con href /trabajos. 409 credencial_no_configurada → noConfigurada;
//   409 cliente_archivado → clienteArchivado.
// - Sin `credenciales.editar`, o con el cliente archivado (D3): la región muestra solo los estados, sin
//   campos ni botones.

const ACTIVO = clienteDe();
const ARCHIVADO = clienteDe({ archivado: true });
const EDITAR = ["clientes.ver", "credenciales.editar"];
const SOLO_VER = ["clientes.ver"];

const SIN_CONFIGURAR = [
  estadoCredencialDe("sol", "no_configurada"),
  estadoCredencialDe("sire_api", "no_configurada"),
];

function rutas(
  cliente: unknown,
  permisos: string[],
  credenciales: unknown[] = SIN_CONFIGURAR,
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    "GET /api/clientes/c-1": { status: 200, cuerpo: cliente },
    "GET /api/clientes/c-1/asignaciones": { status: 200, cuerpo: [] },
    "GET /api/usuarios": { status: 200, cuerpo: [] },
    "GET /api/plan/uso": {
      status: 200,
      cuerpo: usoDe({ rucs: { usados: 1, limite: 100, libres: 99, extra: 0 } }),
    },
    "GET /api/clientes/c-1/credenciales": { status: 200, cuerpo: credenciales },
    ...extra,
  };
}

const seccion = () => screen.findByRole("region", { name: "Credenciales" });
const grupo = (
  region: HTMLElement,
  nombre: "Credencial SOL" | "Credencial SIRE",
) => within(region).getByRole("group", { name: nombre });
const valor = (el: HTMLElement) => (el as HTMLInputElement).value;

async function montar(
  cliente: unknown,
  permisos: string[],
  credenciales?: unknown[],
  extra?: Record<string, Manejador>,
): Promise<{ f: FetchFalso; region: HTMLElement }> {
  const f = instalarFetchFalso(rutas(cliente, permisos, credenciales, extra));
  render(<Cliente />);
  const region = await seccion();
  await vi.waitFor(() =>
    expect(f.de("GET /api/clientes/c-1/credenciales")).toHaveLength(1),
  );
  return { f, region };
}

describe("/clientes/:id · credenciales (007b)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // Sin almacenamiento: nada que limpiar.
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("estado por tipo (D5)", () => {
    it("Verificada con fecha e Inválida con motivo, cada una en su grupo", async () => {
      const { region } = await montar(ACTIVO, EDITAR, [
        estadoCredencialDe("sol", "verificada"),
        estadoCredencialDe("sire_api", "invalida"),
      ]);
      await vi.waitFor(() =>
        expect(grupo(region, "Credencial SOL").textContent).toMatch(
          /Verificada/,
        ),
      );
      const sol = grupo(region, "Credencial SOL");
      expect(sol.textContent).toMatch(FECHA_VERIFICADA_TEXTO);
      const sire = grupo(region, "Credencial SIRE");
      expect(sire.textContent).toMatch(/Inválida/);
      expect(sire.textContent).toContain(MOTIVO_INVALIDA);
      expect(sire.textContent).not.toMatch(/Verificada/);
      expect(sol.textContent).not.toMatch(/Inválida/);
    });

    it("Configurada y No configurada", async () => {
      const { region } = await montar(ACTIVO, EDITAR, [
        estadoCredencialDe("sol", "configurada"),
        estadoCredencialDe("sire_api", "no_configurada"),
      ]);
      await vi.waitFor(() =>
        expect(grupo(region, "Credencial SOL").textContent).toMatch(
          /\bConfigurada\b/,
        ),
      );
      expect(grupo(region, "Credencial SIRE").textContent).toMatch(
        /No configurada/,
      );
    });

    it("los controles de clave existen pero están vacíos al cargar", async () => {
      const { region } = await montar(ACTIVO, EDITAR, [
        estadoCredencialDe("sol", "configurada"),
        estadoCredencialDe("sire_api", "no_configurada"),
      ]);
      await vi.waitFor(() =>
        expect(region.textContent).toMatch(/\bConfigurada\b/),
      );
      expect(valor(within(region).getByLabelText("Clave SOL"))).toBe("");
      expect(valor(within(region).getByLabelText("Client secret"))).toBe("");
    });
  });

  describe("guardar (D4, CA-4)", () => {
    it("SOL: PUT {usuario, clave} con CSRF; muestra Configurada, vacía el formulario y no deja el secreto", async () => {
      const { f, region } = await montar(ACTIVO, EDITAR, undefined, {
        "PUT /api/clientes/c-1/credenciales/sol": {
          status: 200,
          cuerpo: { tipo: "sol", estado: "configurada" },
        },
        "GET /api/clientes/c-1/credenciales": (_l, vez) => ({
          status: 200,
          cuerpo:
            vez === 1
              ? SIN_CONFIGURAR
              : [
                  estadoCredencialDe("sol", "configurada"),
                  estadoCredencialDe("sire_api", "no_configurada"),
                ],
        }),
      });
      const user = userEvent.setup();
      const sol = grupo(region, "Credencial SOL");
      const clave = within(sol).getByLabelText("Clave SOL");
      expect(clave.getAttribute("type")).toBe("password");
      await user.type(
        within(sol).getByLabelText("Usuario SOL"),
        CANARIO_USUARIO_SOL,
      );
      await user.type(clave, CANARIO_CLAVE_SOL);
      await user.click(within(sol).getByRole("button", { name: "Guardar" }));

      await vi.waitFor(() =>
        expect(f.de("PUT /api/clientes/c-1/credenciales/sol")).toHaveLength(1),
      );
      const llamada = f.de("PUT /api/clientes/c-1/credenciales/sol")[0]!;
      expect(llamada.body).toEqual({
        usuario: CANARIO_USUARIO_SOL,
        clave: CANARIO_CLAVE_SOL,
      });
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");

      expect(
        await within(region).findByText(MENSAJES_CREDENCIALES.guardada),
      ).toBeTruthy();
      await vi.waitFor(() =>
        expect(grupo(region, "Credencial SOL").textContent).toMatch(
          /\bConfigurada\b/,
        ),
      );
      expect(valor(within(sol).getByLabelText("Usuario SOL"))).toBe("");
      expect(valor(within(sol).getByLabelText("Clave SOL"))).toBe("");
      await asentar();
      const visible = superficieVisible();
      expect(visible).not.toContain(CANARIO_CLAVE_SOL);
      expect(visible).not.toContain(CANARIO_USUARIO_SOL);
    });

    it("SIRE: PUT {clientId, clientSecret}; vacía el formulario y no deja el secreto", async () => {
      const { f, region } = await montar(ACTIVO, EDITAR, undefined, {
        "PUT /api/clientes/c-1/credenciales/sire_api": {
          status: 200,
          cuerpo: { tipo: "sire_api", estado: "configurada" },
        },
      });
      const user = userEvent.setup();
      const sire = grupo(region, "Credencial SIRE");
      const secreto = within(sire).getByLabelText("Client secret");
      expect(secreto.getAttribute("type")).toBe("password");
      await user.type(
        within(sire).getByLabelText("Client ID"),
        CANARIO_CLIENT_ID,
      );
      await user.type(secreto, CANARIO_CLIENT_SECRET);
      await user.click(within(sire).getByRole("button", { name: "Guardar" }));

      await vi.waitFor(() =>
        expect(
          f.de("PUT /api/clientes/c-1/credenciales/sire_api"),
        ).toHaveLength(1),
      );
      const llamada = f.de("PUT /api/clientes/c-1/credenciales/sire_api")[0]!;
      expect(llamada.body).toEqual({
        clientId: CANARIO_CLIENT_ID,
        clientSecret: CANARIO_CLIENT_SECRET,
      });
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(
        await within(region).findByText(MENSAJES_CREDENCIALES.guardada),
      ).toBeTruthy();
      expect(valor(within(sire).getByLabelText("Client ID"))).toBe("");
      expect(valor(within(sire).getByLabelText("Client secret"))).toBe("");
      await asentar();
      const visible = superficieVisible();
      expect(visible).not.toContain(CANARIO_CLIENT_SECRET);
      expect(visible).not.toContain(CANARIO_CLIENT_ID);
    });

    it("la clave se envía sin trim (puede llevar espacios al borde)", async () => {
      const { f, region } = await montar(ACTIVO, EDITAR, undefined, {
        "PUT /api/clientes/c-1/credenciales/sol": {
          status: 200,
          cuerpo: { tipo: "sol", estado: "configurada" },
        },
      });
      const user = userEvent.setup();
      const sol = grupo(region, "Credencial SOL");
      await user.type(within(sol).getByLabelText("Usuario SOL"), "USUARIO");
      await user.type(
        within(sol).getByLabelText("Clave SOL"),
        "  con espacios  ",
      );
      await user.click(within(sol).getByRole("button", { name: "Guardar" }));
      await vi.waitFor(() =>
        expect(f.de("PUT /api/clientes/c-1/credenciales/sol")).toHaveLength(1),
      );
      expect(
        (
          f.de("PUT /api/clientes/c-1/credenciales/sol")[0]!.body as {
            clave: string;
          }
        ).clave,
      ).toBe("  con espacios  ");
    });

    it("con un campo vacío no llama a la API y avisa", async () => {
      const { f, region } = await montar(ACTIVO, EDITAR);
      const user = userEvent.setup();
      const sol = grupo(region, "Credencial SOL");
      await user.type(within(sol).getByLabelText("Usuario SOL"), "USUARIO");
      await user.click(within(sol).getByRole("button", { name: "Guardar" }));
      expect(
        await within(region).findByText(MENSAJES_CREDENCIALES.datosInvalidos),
      ).toBeTruthy();
      expect(f.de("PUT /api/clientes/c-1/credenciales/sol")).toHaveLength(0);
    });

    it.each([
      [400, { codigo: "datos_invalidos" }, MENSAJES_CREDENCIALES.datosInvalidos],
      [403, { codigo: "sin_permiso" }, MENSAJES_ACCESO.sinPermiso],
      [
        409,
        { codigo: "cliente_archivado" },
        MENSAJES_CLIENTES.clienteArchivado,
      ],
      [500, { codigo: "error_interno" }, MENSAJES_ACCESO.errorGeneral],
    ])(
      "error %i: muestra el mensaje, vacía las claves y no filtra el secreto",
      async (status, cuerpo, mensaje) => {
        const { region } = await montar(ACTIVO, EDITAR, undefined, {
          "PUT /api/clientes/c-1/credenciales/sol": { status, cuerpo },
        });
        const user = userEvent.setup();
        const sol = grupo(region, "Credencial SOL");
        await user.type(
          within(sol).getByLabelText("Usuario SOL"),
          CANARIO_USUARIO_SOL,
        );
        await user.type(
          within(sol).getByLabelText("Clave SOL"),
          CANARIO_CLAVE_SOL,
        );
        await user.click(within(sol).getByRole("button", { name: "Guardar" }));

        const alerta = await within(region).findByRole("alert");
        expect(alerta.textContent).toContain(mensaje);
        expect(valor(within(sol).getByLabelText("Clave SOL"))).toBe("");
        await asentar();
        expect(superficieVisible()).not.toContain(CANARIO_CLAVE_SOL);
        // Un guardado fallido no deja el estado en «Configurada».
        expect(grupo(region, "Credencial SOL").textContent).toMatch(
          /No configurada/,
        );
      },
    );

    it("tras un error de SIRE el client secret tampoco queda en el formulario", async () => {
      const { region } = await montar(ACTIVO, EDITAR, undefined, {
        "PUT /api/clientes/c-1/credenciales/sire_api": {
          status: 500,
          cuerpo: { codigo: "error_interno" },
        },
      });
      const user = userEvent.setup();
      const sire = grupo(region, "Credencial SIRE");
      await user.type(
        within(sire).getByLabelText("Client ID"),
        CANARIO_CLIENT_ID,
      );
      await user.type(
        within(sire).getByLabelText("Client secret"),
        CANARIO_CLIENT_SECRET,
      );
      await user.click(within(sire).getByRole("button", { name: "Guardar" }));
      await within(region).findByRole("alert");
      expect(valor(within(sire).getByLabelText("Client secret"))).toBe("");
      await asentar();
      expect(superficieVisible()).not.toContain(CANARIO_CLIENT_SECRET);
    });
  });

  describe("verificar (D6, CA-5)", () => {
    it.each([
      ["Credencial SOL", "sol"],
      ["Credencial SIRE", "sire_api"],
    ] as const)(
      "%s: POST …/%s/verificar con CSRF y sin cuerpo; muestra el trabajo y enlaza al panel",
      async (nombre, tipo) => {
        const ruta = `POST /api/clientes/c-1/credenciales/${tipo}/verificar`;
        const { f, region } = await montar(
          ACTIVO,
          EDITAR,
          [
            estadoCredencialDe("sol", "configurada"),
            estadoCredencialDe("sire_api", "configurada"),
          ],
          {
            [ruta]: {
              status: 202,
              cuerpo: trabajoDe({
                tipo:
                  tipo === "sol"
                    ? "credencial.verificar_sol"
                    : "credencial.verificar_sire",
              }),
            },
          },
        );
        const user = userEvent.setup();
        await user.click(
          within(grupo(region, nombre)).getByRole("button", {
            name: "Verificar",
          }),
        );
        await vi.waitFor(() => expect(f.de(ruta)).toHaveLength(1));
        const llamada = f.de(ruta)[0]!;
        expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
        expect(llamada.body).toBeUndefined();
        expect(
          await within(region).findByText(
            MENSAJES_CREDENCIALES.verificacionEncolada,
          ),
        ).toBeTruthy();
        const enlace = within(region).getByRole("link", {
          name: MENSAJES_CREDENCIALES.enlacePanel,
        });
        expect(enlace.getAttribute("href")).toBe("/trabajos");
      },
    );

    it("409 credencial_no_configurada → noConfigurada", async () => {
      const { region } = await montar(ACTIVO, EDITAR, undefined, {
        "POST /api/clientes/c-1/credenciales/sire_api/verificar": {
          status: 409,
          cuerpo: { codigo: "credencial_no_configurada" },
        },
      });
      const user = userEvent.setup();
      await user.click(
        within(grupo(region, "Credencial SIRE")).getByRole("button", {
          name: "Verificar",
        }),
      );
      const alerta = await within(region).findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_CREDENCIALES.noConfigurada);
    });

    it("409 cliente_archivado → clienteArchivado", async () => {
      const { region } = await montar(ACTIVO, EDITAR, undefined, {
        "POST /api/clientes/c-1/credenciales/sol/verificar": {
          status: 409,
          cuerpo: { codigo: "cliente_archivado" },
        },
      });
      const user = userEvent.setup();
      await user.click(
        within(grupo(region, "Credencial SOL")).getByRole("button", {
          name: "Verificar",
        }),
      );
      const alerta = await within(region).findByRole("alert");
      expect(alerta.textContent).toContain(MENSAJES_CLIENTES.clienteArchivado);
    });
  });

  describe("aviso de cambio de clave SOL (D6, CA-6)", () => {
    it("el grupo SIRE muestra el aviso, también tras guardar la clave SOL", async () => {
      const { region } = await montar(ACTIVO, EDITAR, undefined, {
        "PUT /api/clientes/c-1/credenciales/sol": {
          status: 200,
          cuerpo: { tipo: "sol", estado: "configurada" },
        },
      });
      expect(
        within(grupo(region, "Credencial SIRE")).getByText(
          MENSAJES_CREDENCIALES.avisoClaveSol,
        ),
      ).toBeTruthy();
      const user = userEvent.setup();
      const sol = grupo(region, "Credencial SOL");
      await user.type(within(sol).getByLabelText("Usuario SOL"), "USUARIO");
      await user.type(within(sol).getByLabelText("Clave SOL"), "CLAVE");
      await user.click(within(sol).getByRole("button", { name: "Guardar" }));
      await within(region).findByText(MENSAJES_CREDENCIALES.guardada);
      expect(
        within(grupo(region, "Credencial SIRE")).getByText(
          MENSAJES_CREDENCIALES.avisoClaveSol,
        ),
      ).toBeTruthy();
    });
  });

  describe("solo lectura (D3, CA-10)", () => {
    const CON_ESTADO = [
      estadoCredencialDe("sol", "verificada"),
      estadoCredencialDe("sire_api", "invalida"),
    ];

    it("cliente archivado: muestra los estados sin campos ni botones", async () => {
      const { region } = await montar(ARCHIVADO, EDITAR, CON_ESTADO);
      await vi.waitFor(() =>
        expect(grupo(region, "Credencial SOL").textContent).toMatch(
          /Verificada/,
        ),
      );
      expect(within(region).queryByLabelText("Clave SOL")).toBeNull();
      expect(within(region).queryByLabelText("Client secret")).toBeNull();
      expect(within(region).queryAllByRole("button")).toHaveLength(0);
      expect(within(region).queryAllByRole("textbox")).toHaveLength(0);
    });

    it("sin credenciales.editar: muestra los estados sin campos ni botones", async () => {
      const { region } = await montar(ACTIVO, SOLO_VER, CON_ESTADO);
      await vi.waitFor(() =>
        expect(grupo(region, "Credencial SIRE").textContent).toMatch(
          /Inválida/,
        ),
      );
      expect(within(region).queryByLabelText("Clave SOL")).toBeNull();
      expect(within(region).queryAllByRole("button")).toHaveLength(0);
      expect(within(region).queryAllByRole("textbox")).toHaveLength(0);
    });
  });
});

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
import { superficieVisible } from "../../../../pruebas/credenciales";
import {
  BYTES_XLSX,
  CANARIO_CLAVE_ARCHIVO,
  CSV_CON_CLAVE,
  MASCARA_CLAVE,
  MENSAJES_IMPORTACION as M,
  archivoDe,
  bytesDe,
  filaDe,
  informeDe,
  llamadasCrudas,
  vistaPreviaDe,
} from "../../../../pruebas/importacion";
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
  usePathname: () => "/clientes/importar",
  useSearchParams: () => new URLSearchParams(),
}));

import Importar from "./page";

// Contrato (plan 007b, HTTP; D7, D8, D9; CA-1, CA-2, CA-8). Pantalla /clientes/importar:
// - Al montar: GET /api/acceso/yo. Sin `clientes.crear` → MENSAJES_ACCESO.sinPermiso y ni selector de
//   archivo ni botones. Con permiso: <h1> M.titulo, enlace M.plantilla con href
//   /api/clientes/importacion/plantilla, selector de archivo con etiqueta "Archivo (.xlsx o .csv)"
//   (accept con .xlsx y .csv) y botón "Revisar archivo" (deshabilitado sin archivo).
// - Revisar: POST /api/clientes/importacion/vista-previa con el archivo como CUERPO CRUDO (Blob/File,
//   ArrayBuffer o vista; ni JSON ni multipart), con X-CSRF-Token y X-Estudio. 200 VistaPrevia → región
//   "Vista previa" con el resumen (M.validas, M.conError, M.cupoLibre, M.excedentes) y una tabla
//   (role=row por fila) con n, RUC, estado (M.estadoFila), los motivos (M.motivos; `duplicado` con
//   `archivado: true` → M.motivos.duplicadoArchivado) y las claves como "••••" (una por cada
//   `tieneSol`/`tieneSire`; sin clave, ninguna). El contenido del archivo nunca se muestra.
// - Cambiar el archivo elegido descarta la vista previa (no se confirma un archivo no revisado).
// - Confirmar: botón "Confirmar importación" en la vista previa (deshabilitado si validas = 0);
//   POST /api/clientes/importacion/confirmar con los mismos bytes crudos y CSRF. 200 Informe → región
//   "Resultado" con M.creadas, M.consultasEncoladas, M.consultasOmitidas y una tabla de «no importadas»
//   (n, RUC y el motivo de M.motivos; `duplicado` + `archivado` → duplicadoArchivado).
// - Errores (role=alert; sin vista previa ni botón de confirmar): 400 archivo_invalido →
//   M.archivoInvalido; 400 columnas_faltantes → columnasFaltantes; 400 demasiadas_filas →
//   demasiadasFilas; 413 → archivoGrande; 403 → MENSAJES_ACCESO.sinPermiso; otro → errorGeneral.

const URL_PREVIA = "/api/clientes/importacion/vista-previa";
const URL_CONFIRMAR = "/api/clientes/importacion/confirmar";
const PREVIA = `POST ${URL_PREVIA}`;
const CONFIRMAR = `POST ${URL_CONFIRMAR}`;

function rutas(
  permisos: string[],
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    ...extra,
  };
}
const CREAR = ["clientes.ver", "clientes.crear", "credenciales.editar"];

async function montar(
  extra: Record<string, Manejador> = {},
  permisos = CREAR,
): Promise<FetchFalso> {
  const f = instalarFetchFalso(rutas(permisos, extra));
  render(<Importar />);
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const selector = () => screen.findByLabelText("Archivo (.xlsx o .csv)");
async function elegir(archivo: File): Promise<void> {
  const user = userEvent.setup();
  await user.upload(await selector(), archivo);
}
async function revisar(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revisar archivo" }));
}
const vistaPrevia = () => screen.findByRole("region", { name: "Vista previa" });
const resultado = () => screen.findByRole("region", { name: "Resultado" });
function fila(region: HTMLElement, texto: string): HTMLElement {
  const f = within(region)
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}
const mascaras = (el: HTMLElement) =>
  (el.textContent?.match(new RegExp(MASCARA_CLAVE, "g")) ?? []).length;

const R1 = "20100000009";
const R2 = "20123456785";
const R3 = "20600000005";
const R4 = "20100000017";
const R5 = "20100000025";

const PREVIA_MIXTA = vistaPreviaDe(
  [
    filaDe(2, R1, { tieneSol: true, tieneSire: true }),
    filaDe(3, R2, { motivos: ["ruc_invalido"] }),
    filaDe(4, R3, { motivos: ["duplicado_en_archivo"], tieneSol: true }),
    filaDe(5, R4, { motivos: ["duplicado"], archivado: true }),
    filaDe(6, R5, {
      motivos: ["responsable_inexistente", "credencial_incompleta"],
    }),
  ],
  { cupoLibre: 3, excedentes: 2 },
);

describe("/clientes/importar · asistente de importación (007b)", () => {
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

  describe("estructura y permisos", () => {
    it("con clientes.crear: título, enlace a la plantilla, selector de archivo y Revisar deshabilitado", async () => {
      await montar();
      expect(
        await screen.findByRole("heading", { name: M.titulo, level: 1 }),
      ).toBeTruthy();
      const enlace = screen.getByRole("link", { name: M.plantilla });
      expect(enlace.getAttribute("href")).toBe(
        "/api/clientes/importacion/plantilla",
      );
      const entrada = await selector();
      expect(entrada.getAttribute("type")).toBe("file");
      expect(entrada.getAttribute("accept")).toMatch(/\.xlsx/);
      expect(entrada.getAttribute("accept")).toMatch(/\.csv/);
      expect(
        (
          screen.getByRole("button", {
            name: "Revisar archivo",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });

    it("sin clientes.crear: solo el mensaje de permiso", async () => {
      await montar({}, ["clientes.ver"]);
      expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
      expect(screen.queryByLabelText("Archivo (.xlsx o .csv)")).toBeNull();
      expect(screen.queryByRole("button", { name: "Revisar archivo" })).toBeNull();
    });
  });

  describe("vista previa (D7, CA-1)", () => {
    it("sube el archivo como cuerpo crudo (no JSON ni multipart) con CSRF y estudio", async () => {
      const f = await montar({
        [PREVIA]: { status: 200, cuerpo: vistaPreviaDe([filaDe(2, R1)]) },
      });
      await elegir(archivoDe("clientes.xlsx", BYTES_XLSX, "application/octet-stream"));
      await revisar();
      await vi.waitFor(() => expect(f.de(PREVIA)).toHaveLength(1));
      const llamada = f.de(PREVIA)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      expect(llamada.headers["content-type"] ?? "").not.toMatch(
        /json|multipart/i,
      );
      const cruda = llamadasCrudas("POST", URL_PREVIA)[0]!;
      expect(cruda.init.body).not.toBeInstanceOf(FormData);
      expect(typeof cruda.init.body).not.toBe("string");
      expect([...(await bytesDe(cruda.init.body))]).toEqual([...BYTES_XLSX]);
    });

    it("muestra errores por fila con sus motivos, el resumen con cupo y excedentes, y ninguna clave", async () => {
      await montar({ [PREVIA]: { status: 200, cuerpo: PREVIA_MIXTA } });
      await elegir(archivoDe("clientes.csv", CSV_CON_CLAVE));
      await revisar();
      const region = await vistaPrevia();

      expect(within(region).getByText(M.validas(1))).toBeTruthy();
      expect(within(region).getByText(M.conError(4))).toBeTruthy();
      expect(within(region).getByText(M.cupoLibre(3))).toBeTruthy();
      expect(within(region).getByText(M.excedentes(2))).toBeTruthy();

      const valida = fila(region, R1);
      expect(valida.textContent).toContain(M.estadoFila.valida);
      expect(mascaras(valida)).toBe(2);

      const invalida = fila(region, R2);
      expect(invalida.textContent).toContain(M.estadoFila.conError);
      expect(invalida.textContent).toContain(M.motivos.ruc_invalido);
      expect(mascaras(invalida)).toBe(0);

      const repetida = fila(region, R3);
      expect(repetida.textContent).toContain(M.motivos.duplicado_en_archivo);
      expect(mascaras(repetida)).toBe(1);

      const archivada = fila(region, R4);
      expect(archivada.textContent).toContain(M.motivos.duplicadoArchivado);

      const doble = fila(region, R5);
      expect(doble.textContent).toContain(M.motivos.responsable_inexistente);
      expect(doble.textContent).toContain(M.motivos.credencial_incompleta);

      await asentar();
      expect(superficieVisible()).not.toContain(CANARIO_CLAVE_ARCHIVO);
    });

    it("un duplicado activo no sugiere reactivar", async () => {
      await montar({
        [PREVIA]: {
          status: 200,
          cuerpo: vistaPreviaDe([filaDe(2, R4, { motivos: ["duplicado"] })]),
        },
      });
      await elegir(archivoDe("clientes.csv", CSV_CON_CLAVE));
      await revisar();
      const region = await vistaPrevia();
      const f = fila(region, R4);
      expect(f.textContent).toContain(M.motivos.duplicado);
      expect(f.textContent).not.toContain("Reactívalo");
    });

    it("cambiar el archivo descarta la vista previa y el botón de confirmar", async () => {
      await montar({ [PREVIA]: { status: 200, cuerpo: PREVIA_MIXTA } });
      await elegir(archivoDe("uno.csv", CSV_CON_CLAVE));
      await revisar();
      await vistaPrevia();
      expect(screen.getByRole("button", { name: "Confirmar importación" })).toBeTruthy();

      await elegir(archivoDe("dos.csv", CSV_CON_CLAVE));
      await vi.waitFor(() =>
        expect(screen.queryByRole("region", { name: "Vista previa" })).toBeNull(),
      );
      expect(screen.queryByRole("button", { name: "Confirmar importación" })).toBeNull();
    });

    it.each([
      [400, { codigo: "archivo_invalido" }, M.archivoInvalido],
      [400, { codigo: "columnas_faltantes" }, M.columnasFaltantes],
      [400, { codigo: "demasiadas_filas" }, M.demasiadasFilas],
      [413, {}, M.archivoGrande],
      [403, { codigo: "sin_permiso" }, MENSAJES_ACCESO.sinPermiso],
      [500, { codigo: "error_interno" }, MENSAJES_ACCESO.errorGeneral],
    ])(
      "error %i %j → mensaje, sin vista previa ni confirmar",
      async (status, cuerpo, mensaje) => {
        await montar({ [PREVIA]: { status, cuerpo } });
        await elegir(archivoDe("clientes.csv", CSV_CON_CLAVE));
        await revisar();
        const alerta = await screen.findByRole("alert");
        expect(alerta.textContent).toContain(mensaje);
        expect(screen.queryByRole("region", { name: "Vista previa" })).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Confirmar importación" }),
        ).toBeNull();
        await asentar();
        expect(superficieVisible()).not.toContain(CANARIO_CLAVE_ARCHIVO);
      },
    );
  });

  describe("confirmar (D8, D9, CA-3, CA-8)", () => {
    it("envía los mismos bytes crudos con CSRF y muestra el informe de no importadas", async () => {
      const informe = informeDe({
        creadas: 3,
        consultasEncoladas: 2,
        consultasOmitidas: 1,
        noImportadas: [
          { n: 5, ruc: R4, motivo: "duplicado", archivado: true },
          { n: 6, ruc: R5, motivo: "cupo_rucs" },
          { n: 7, ruc: R3, motivo: "duplicado" },
        ],
      });
      const f = await montar({
        [PREVIA]: { status: 200, cuerpo: PREVIA_MIXTA },
        [CONFIRMAR]: { status: 200, cuerpo: informe },
      });
      await elegir(archivoDe("clientes.xlsx", BYTES_XLSX, "application/octet-stream"));
      await revisar();
      await vistaPrevia();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Confirmar importación" }),
      );
      await vi.waitFor(() => expect(f.de(CONFIRMAR)).toHaveLength(1));
      const llamada = f.de(CONFIRMAR)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["content-type"] ?? "").not.toMatch(
        /json|multipart/i,
      );
      const cruda = llamadasCrudas("POST", URL_CONFIRMAR)[0]!;
      expect([...(await bytesDe(cruda.init.body))]).toEqual([...BYTES_XLSX]);

      const region = await resultado();
      expect(within(region).getByText(M.creadas(3))).toBeTruthy();
      expect(within(region).getByText(M.consultasEncoladas(2))).toBeTruthy();
      expect(within(region).getByText(M.consultasOmitidas(1))).toBeTruthy();

      expect(fila(region, R4).textContent).toContain(
        M.motivos.duplicadoArchivado,
      );
      expect(fila(region, R5).textContent).toContain(M.motivos.cupo_rucs);
      const activo = fila(region, R3);
      expect(activo.textContent).toContain(M.motivos.duplicado);
      expect(activo.textContent).not.toContain("Reactívalo");
      await asentar();
      expect(superficieVisible()).not.toContain(CANARIO_CLAVE_ARCHIVO);
    });

    it("sin filas válidas el botón de confirmar está deshabilitado", async () => {
      await montar({
        [PREVIA]: {
          status: 200,
          cuerpo: vistaPreviaDe([filaDe(2, R2, { motivos: ["ruc_invalido"] })]),
        },
      });
      await elegir(archivoDe("clientes.csv", CSV_CON_CLAVE));
      await revisar();
      await vistaPrevia();
      expect(
        (
          screen.getByRole("button", {
            name: "Confirmar importación",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });

    it.each([
      [400, { codigo: "archivo_invalido" }, M.archivoInvalido],
      [413, {}, M.archivoGrande],
      [403, { codigo: "sin_permiso" }, MENSAJES_ACCESO.sinPermiso],
      [500, { codigo: "error_interno" }, MENSAJES_ACCESO.errorGeneral],
    ])(
      "error %i al confirmar → mensaje y sin informe",
      async (status, cuerpo, mensaje) => {
        await montar({
          [PREVIA]: { status: 200, cuerpo: PREVIA_MIXTA },
          [CONFIRMAR]: { status, cuerpo },
        });
        await elegir(archivoDe("clientes.csv", CSV_CON_CLAVE));
        await revisar();
        await vistaPrevia();
        const user = userEvent.setup();
        await user.click(
          screen.getByRole("button", { name: "Confirmar importación" }),
        );
        const alerta = await screen.findByRole("alert");
        expect(alerta.textContent).toContain(mensaje);
        expect(screen.queryByRole("region", { name: "Resultado" })).toBeNull();
        await asentar();
        expect(superficieVisible()).not.toContain(CANARIO_CLAVE_ARCHIVO);
      },
    );
  });
});

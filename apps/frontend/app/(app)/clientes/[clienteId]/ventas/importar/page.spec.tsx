import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
} from "../../../../../../pruebas/acceso";
import { superficieVisible } from "../../../../../../pruebas/credenciales";
import {
  BYTES_XLSX,
  archivoDe,
  bytesDe,
  llamadasCrudas,
} from "../../../../../../pruebas/importacion";
import { crearRouterFalso } from "../../../../../../pruebas/soporte";
import {
  BASE,
  CANARIO_ARCHIVO_VENTAS,
  CLIENTE_ID,
  CSV_VENTAS,
  MENSAJES_VENTAS as M,
  PERIODO,
  PERMISOS,
  filaImportadaDe,
  instalarFetchVentas,
  propuestaDe,
  vistaPreviaVentasDe,
  type FetchVentas,
  type OpcionesVentas,
} from "../../../../../../pruebas/ventas";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/ventas/importar",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

// La página se importa en cada prueba para que, mientras no exista, cada una falle por su cuenta (rojo de T7).
const RUTA_PAGINA = "./page";
async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import(/* @vite-ignore */ RUTA_PAGINA)) as {
    default: () => ReactElement;
  };
  const Pagina = modulo.default;
  return <Pagina />;
}

// Contrato (plan 013, Rutas de importación; spec D6, D3, D10, D16; CA-10, CA-13). Pantalla
// /clientes/c-1/ventas/importar (asistente de 007b adaptado a ventas), con `useParams()` →
// `clienteId` y el periodo en `?periodo=` (campo editable «Periodo (AAAAMM)»):
// - Al montar: GET /api/acceso/yo. Sin `sire.descargar` → sinPermiso y ni selector ni botones.
//   Con permiso: <h1> M.tituloImportar, el periodo, selector de archivo con etiqueta M.archivo (accept con
//   .xlsx, .csv y .txt) y botón «Revisar archivo» (deshabilitado sin archivo o con periodo inválido).
// - Revisar: POST <BASE>/importar/vista-previa con el archivo como CUERPO CRUDO (ni JSON ni multipart), con
//   X-CSRF-Token y X-Estudio. 200 → región «Vista previa» con M.validas, M.conError y una tabla (role=row por
//   fila: primera celda = n, luego el estado de M.estadoFila y los motivos de M.motivos, un texto por código).
//   Con filas con error, «Confirmar importación» queda DESHABILITADO y se lee M.corregirFilas (todo o nada,
//   D3); sin errores y con válidas, queda habilitado. El contenido del archivo nunca se muestra.
// - Cambiar el archivo o el periodo descarta la vista previa (no se confirma lo no revisado).
// - Confirmar: POST <BASE>/importar/confirmar con los mismos bytes crudos y CSRF → 201 {propuesta}; región
//   «Resultado» con M.resumenDescarga(nuevas, distintas) y el enlace M.verVentas (href
//   /clientes/c-1/ventas?periodo=AAAAMM).
// - Errores (role=alert; sin vista previa ni botón de confirmar): 422 layout_no_oficial → M.layoutNoOficial;
//   422 propuesta_demasiado_grande → M.propuestaGrande; 413 → M.archivoGrande; 400 archivo_invalido →
//   M.archivoInvalido; 403 → MENSAJES_ACCESO.sinPermiso; otro → MENSAJES_ACCESO.errorGeneral.

const PREVIA = `POST ${BASE}/importar/vista-previa`;
const CONFIRMAR = `POST ${BASE}/importar/confirmar`;
const URL_PREVIA = `${BASE}/importar/vista-previa`;
const URL_CONFIRMAR = `${BASE}/importar/confirmar`;

const PREVIA_VALIDA = vistaPreviaVentasDe([
  filaImportadaDe(2),
  filaImportadaDe(3),
  filaImportadaDe(4),
]);
const PREVIA_CON_ERRORES = vistaPreviaVentasDe([
  filaImportadaDe(2),
  filaImportadaDe(3, ["fecha_invalida"]),
  filaImportadaDe(4, ["monto_invalido", "descuadre"]),
  filaImportadaDe(5, ["tipo_cambio_requerido"]),
  filaImportadaDe(6, ["celda_peligrosa"]),
]);
const PROPUESTA_IMPORTADA = propuestaDe(5, {
  fuente: "importacion",
  filasNuevas: 3,
  filasIguales: 0,
  filasDistintas: 0,
});

async function montar(
  o: Omit<OpcionesVentas, "estado"> & { periodo?: string | null } = {},
): Promise<FetchVentas> {
  const periodo = o.periodo === undefined ? PERIODO : o.periodo;
  busqueda.actual = new URLSearchParams(periodo ? `periodo=${periodo}` : "");
  const f = instalarFetchVentas({ permisos: o.permisos, extra: o.extra });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const selector = () => screen.findByLabelText(M.archivo);
async function elegir(archivo: File): Promise<void> {
  await userEvent.setup().upload(await selector(), archivo);
}
async function revisar(): Promise<void> {
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: M.revisarArchivo }));
}
const vistaPrevia = () => screen.findByRole("region", { name: "Vista previa" });
const resultado = () => screen.findByRole("region", { name: "Resultado" });
function filaN(region: HTMLElement, n: number): HTMLElement {
  const f = within(region)
    .queryAllByRole("row")
    .find((r) => (celdas(r)[0] ?? "").trim() === String(n));
  if (!f) throw new Error(`no hay fila ${n}`);
  return f;
}
const botonConfirmar = () =>
  screen.getByRole("button", {
    name: M.confirmarImportacion,
  }) as HTMLButtonElement;

describe("/clientes/:id/ventas/importar · asistente de importación (013)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    busqueda.actual = new URLSearchParams();
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
    it("con sire.descargar: título, periodo de la URL, selector de archivo y «Revisar archivo» deshabilitado", async () => {
      await montar();
      expect(
        await screen.findByRole("heading", { name: M.tituloImportar, level: 1 }),
      ).toBeTruthy();
      const periodo = (await screen.findByLabelText(
        M.etiquetaPeriodo,
      )) as HTMLInputElement;
      expect(periodo.value).toBe(PERIODO);
      const entrada = await selector();
      expect(entrada.getAttribute("type")).toBe("file");
      for (const ext of [".xlsx", ".csv", ".txt"]) {
        expect(entrada.getAttribute("accept")).toContain(ext);
      }
      expect(
        (screen.getByRole("button", { name: M.revisarArchivo }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    it("sin sire.descargar: solo el mensaje de permiso", async () => {
      await montar({ permisos: PERMISOS.lectura });
      expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
      expect(screen.queryByLabelText(M.archivo)).toBeNull();
      expect(screen.queryByRole("button", { name: M.revisarArchivo })).toBeNull();
    });

    it("sin periodo válido no se puede revisar: avisa y no llama a la API", async () => {
      const f = await montar({ periodo: null });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      const boton = screen.getByRole("button", {
        name: M.revisarArchivo,
      }) as HTMLButtonElement;
      expect(boton.disabled).toBe(true);
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(M.etiquetaPeriodo), "202613");
      expect(await screen.findByText(M.periodoInvalido)).toBeTruthy();
      expect(boton.disabled).toBe(true);
      await asentar();
      expect(f.de(PREVIA)).toHaveLength(0);
    });
  });

  describe("vista previa (D6, CA-10)", () => {
    it("sube el archivo como cuerpo crudo (no JSON ni multipart) con CSRF y estudio", async () => {
      const f = await montar({
        extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA } },
      });
      await elegir(archivoDe("ventas.xlsx", BYTES_XLSX, "application/octet-stream"));
      await revisar();
      await vi.waitFor(() => expect(f.de(PREVIA)).toHaveLength(1));
      const llamada = f.de(PREVIA)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      expect(llamada.headers["content-type"] ?? "").not.toMatch(/json|multipart/i);
      const cruda = llamadasCrudas("POST", URL_PREVIA)[0]!;
      expect(cruda.init.body).not.toBeInstanceOf(FormData);
      expect(typeof cruda.init.body).not.toBe("string");
      expect([...(await bytesDe(cruda.init.body))]).toEqual([...BYTES_XLSX]);
    });

    it("muestra los errores por fila con sus motivos y el resumen; no muestra el contenido del archivo", async () => {
      await montar({
        extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_CON_ERRORES } },
      });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      const region = await vistaPrevia();

      expect(within(region).getByText(M.validas(1))).toBeTruthy();
      expect(within(region).getByText(M.conError(4))).toBeTruthy();

      expect(filaN(region, 2).textContent).toContain(M.estadoFila.valida);
      const f3 = filaN(region, 3);
      expect(f3.textContent).toContain(M.estadoFila.conError);
      expect(f3.textContent).toContain(M.motivos.fecha_invalida);
      const f4 = filaN(region, 4);
      expect(f4.textContent).toContain(M.motivos.monto_invalido);
      expect(f4.textContent).toContain(M.motivos.descuadre);
      expect(filaN(region, 5).textContent).toContain(M.motivos.tipo_cambio_requerido);
      expect(filaN(region, 6).textContent).toContain(M.motivos.celda_peligrosa);

      await asentar();
      expect(superficieVisible()).not.toContain(CANARIO_ARCHIVO_VENTAS);
    });

    it("con errores «Confirmar importación» queda deshabilitado y se explica el todo o nada", async () => {
      const f = await montar({
        extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_CON_ERRORES } },
      });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      expect(botonConfirmar().disabled).toBe(true);
      expect(screen.getByText(M.corregirFilas)).toBeTruthy();
      await userEvent.setup().click(botonConfirmar());
      await asentar();
      expect(f.de(CONFIRMAR)).toHaveLength(0);
    });

    it("sin errores «Confirmar importación» está habilitado y no aparece el aviso de corregir", async () => {
      await montar({ extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA } } });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      expect(botonConfirmar().disabled).toBe(false);
      expect(screen.queryByText(M.corregirFilas)).toBeNull();
    });

    it("sin filas válidas tampoco se puede confirmar", async () => {
      await montar({
        extra: {
          [PREVIA]: { status: 200, cuerpo: vistaPreviaVentasDe([]) },
        },
      });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      expect(botonConfirmar().disabled).toBe(true);
    });

    it("cambiar el archivo descarta la vista previa y el botón de confirmar", async () => {
      await montar({ extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA } } });
      await elegir(archivoDe("uno.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      await elegir(archivoDe("otro.csv", CSV_VENTAS));
      expect(screen.queryByRole("region", { name: "Vista previa" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: M.confirmarImportacion }),
      ).toBeNull();
    });

    it("cambiar el periodo descarta la vista previa", async () => {
      await montar({ extra: { [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA } } });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      const user = userEvent.setup();
      const periodo = await screen.findByLabelText(M.etiquetaPeriodo);
      await user.clear(periodo);
      await user.type(periodo, "202609");
      expect(screen.queryByRole("region", { name: "Vista previa" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: M.confirmarImportacion }),
      ).toBeNull();
    });
  });

  describe("confirmar (D6, D16)", () => {
    it("envía los mismos bytes crudos con CSRF y muestra «N nuevos, M difieren» con el enlace a las ventas", async () => {
      const f = await montar({
        extra: {
          [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA },
          [CONFIRMAR]: { status: 201, cuerpo: { propuesta: PROPUESTA_IMPORTADA } },
        },
      });
      await elegir(archivoDe("ventas.xlsx", BYTES_XLSX, "application/octet-stream"));
      await revisar();
      await vistaPrevia();
      await userEvent.setup().click(botonConfirmar());
      await vi.waitFor(() => expect(f.de(CONFIRMAR)).toHaveLength(1));
      const llamada = f.de(CONFIRMAR)[0]!;
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      const cruda = llamadasCrudas("POST", URL_CONFIRMAR)[0]!;
      expect(cruda.init.body).not.toBeInstanceOf(FormData);
      expect([...(await bytesDe(cruda.init.body))]).toEqual([...BYTES_XLSX]);

      const res = await resultado();
      expect(within(res).getByText(M.resumenDescarga(3, 0))).toBeTruthy();
      const enlace = within(res).getByRole("link", { name: M.verVentas });
      expect(enlace.getAttribute("href")).toBe(
        `/clientes/${CLIENTE_ID}/ventas?periodo=${PERIODO}`,
      );
    });

    it.each([
      [422, { codigo: "layout_no_oficial" }, M.layoutNoOficial],
      [422, { codigo: "propuesta_demasiado_grande" }, M.propuestaGrande],
      [403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
      [500, {}, MENSAJES_ACCESO.errorGeneral],
    ])("el POST de confirmar responde %i (%j): mensaje en un alert y sin resultado", async (status, cuerpo, mensaje) => {
      await montar({
        extra: {
          [PREVIA]: { status: 200, cuerpo: PREVIA_VALIDA },
          [CONFIRMAR]: { status, cuerpo },
        },
      });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      await vistaPrevia();
      await userEvent.setup().click(botonConfirmar());
      expect((await screen.findByRole("alert")).textContent).toContain(mensaje);
      expect(screen.queryByRole("region", { name: "Resultado" })).toBeNull();
    });
  });

  describe("errores de la vista previa", () => {
    it.each([
      [422, { codigo: "layout_no_oficial" }, M.layoutNoOficial],
      [422, { codigo: "propuesta_demasiado_grande" }, M.propuestaGrande],
      [413, {}, M.archivoGrande],
      [400, { codigo: "archivo_invalido" }, M.archivoInvalido],
      [403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
      [500, {}, MENSAJES_ACCESO.errorGeneral],
    ])("%i %j: mensaje en un alert, sin vista previa ni confirmar", async (status, cuerpo, mensaje) => {
      await montar({ extra: { [PREVIA]: { status, cuerpo } } });
      await elegir(archivoDe("ventas.csv", CSV_VENTAS));
      await revisar();
      expect((await screen.findByRole("alert")).textContent).toContain(mensaje);
      expect(screen.queryByRole("region", { name: "Vista previa" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: M.confirmarImportacion }),
      ).toBeNull();
      await asentar();
      expect(superficieVisible()).not.toContain(CANARIO_ARCHIVO_VENTAS);
    });
  });
});

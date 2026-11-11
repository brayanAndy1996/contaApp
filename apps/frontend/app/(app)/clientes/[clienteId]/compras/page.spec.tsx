import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../../../../lib/sesion";
import type { OpcionesSeguimiento } from "../../../../../lib/trabajos";
import {
  BASE,
  C_3064_BOLSAS,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  PERIODO,
  PERMISOS,
  TEXTO_HOSTIL,
  accionDe,
  consultaDe,
  filaDe,
  generarFilas,
  instalarFetchCompras,
  montosDe,
  resumenDe,
  uuidDe,
  type EstadoCompras,
  type FetchCompras,
  type OpcionesCompras,
} from "../../../../../pruebas/compras";
import { idTrabajo } from "../../../../../pruebas/trabajos";
import {
  MENSAJES_VENTAS,
  propuestaDe,
  trabajoDescarga,
} from "../../../../../pruebas/ventas";

// Página de compras (spec 015, T3; D-1, D-12 a D-16; CA-3, CA-13, CA-14, CA-15 sin la parte de la grilla).
// El seguimiento de trabajos (SSE) se simula con un `seguirTrabajos` controlado por la prueba.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/compras",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

const seguimiento = vi.hoisted(() => ({
  opciones: null as OpcionesSeguimiento | null,
}));
vi.mock("../../../../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../../../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(async (o: OpcionesSeguimiento) => {
      seguimiento.opciones = o;
      await new Promise<void>((resolver) =>
        o.senal.addEventListener("abort", () => resolver(), { once: true }),
      );
    }),
  };
});

const RUTA_PAGINA = "./page";
async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import(/* @vite-ignore */ RUTA_PAGINA)) as {
    default: () => ReactElement;
  };
  const Pagina = modulo.default;
  return <Pagina />;
}

const P2 = propuestaDe(2);
const P3 = propuestaDe(3, {
  filasNuevas: 2,
  filasIguales: 1,
  filasDistintas: 1,
  creadaEn: "2026-11-04T11:00:00.000Z",
});
const DIFERENCIA = {
  clave: "01|F001|3064",
  tipo: "01",
  serie: "F001",
  numero: "3064",
  origenExistente: "sire",
  campos: ["total"],
  valoresSire: { total: "236.00" },
};
const POST_DESCARGAR = `POST ${BASE}/descargar`;
const POST_REABRIR = `POST ${BASE}/estado/reabrir`;
const USUARIO = "00000000-0000-4000-8000-0000000000a1";

function estadoBase(): Partial<EstadoCompras> {
  return {
    propuestas: [P2],
    diferencias: { [P2.id]: [DIFERENCIA], [P3.id]: [DIFERENCIA] },
  };
}

async function montar(
  o: OpcionesCompras & { periodo?: string | null; antes?: () => void } = {},
): Promise<FetchCompras> {
  const periodo = o.periodo === undefined ? PERIODO : o.periodo;
  busqueda.actual = new URLSearchParams(periodo ? `periodo=${periodo}` : "");
  const f = instalarFetchCompras({
    permisos: o.permisos,
    cliente: o.cliente,
    estado: { ...estadoBase(), ...o.estado },
    extra: o.extra,
  });
  o.antes?.();
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const lecturas = (f: FetchCompras, sufijo: string) => f.de(`GET ${BASE}${sufijo}`);
const boton = (nombre: string) => screen.queryByRole("button", { name: nombre });

describe("/clientes/:id/compras · página de compras (spec 015 T3)", () => {
  beforeEach(() => {
    seguimiento.opciones = null;
    busqueda.actual = new URLSearchParams();
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("estructura y permisos (D-1, CA-14)", () => {
    it("feliz: título, estado, descarga, resumen y diferencias del periodo, con enlace a Ventas", async () => {
      const f = await montar({
        estado: { resumen: resumenDe(FILAS_014, {}, "abierto") },
      });
      expect(await screen.findByRole("heading", { name: M.titulo })).toBeTruthy();
      expect(await screen.findByRole("region", { name: M.tituloResumen })).toBeTruthy();
      // Resumen cargado: aparece una cifra del servidor.
      const resumen = screen.getByRole("region", { name: M.tituloResumen });
      await vi.waitFor(() =>
        expect(within(resumen).getAllByRole("row").length).toBeGreaterThan(3),
      );
      expect(screen.getByRole("region", { name: "Estado del periodo" })).toBeTruthy();
      expect(screen.getByRole("region", { name: "Descarga" })).toBeTruthy();
      expect(
        await screen.findByRole("region", { name: M.tituloDiferencias }),
      ).toBeTruthy();
      expect(await screen.findByText(M.resumenDescarga(2, 1))).toBeTruthy();
      expect(
        screen.getByRole("link", { name: M.enlaceVentas }).getAttribute("href"),
      ).toBe(`/clientes/c-1/ventas?periodo=${PERIODO}`);
      // Con todos los permisos y el periodo abierto no hay aviso de solo lectura.
      expect(screen.queryByText(M.soloLectura.sinPermiso)).toBeNull();
      expect(lecturas(f, "/resumen")).toHaveLength(1);
      expect(lecturas(f, "/propuestas")).toHaveLength(1);
      expect(lecturas(f, `/propuestas/${P2.id}/diferencias`)).toHaveLength(1);
    });

    it("error: sin clientes.ver solo el mensaje y no se pide nada de compras", async () => {
      const f = await montar({ permisos: PERMISOS.sinVer });
      expect((await screen.findByRole("alert")).textContent).toBe(M.sinPermisoVer);
      expect(screen.queryByRole("heading", { name: M.titulo })).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(lecturas(f, "/resumen")).toHaveLength(0);
      expect(lecturas(f, "/propuestas")).toHaveLength(0);
    });

    it("sin periodo no pide nada y «Descargar» y «Exportar» están deshabilitados", async () => {
      const f = await montar({ periodo: null });
      await screen.findByRole("heading", { name: M.titulo });
      expect((boton(M.descargar) as HTMLButtonElement).disabled).toBe(true);
      expect((boton(M.exportar) as HTMLButtonElement).disabled).toBe(true);
      expect(lecturas(f, "/resumen")).toHaveLength(0);
    });

    it("periodo inválido avisa y no pide nada", async () => {
      const f = await montar({ periodo: "202613" });
      expect(await screen.findByText(M.periodoInvalido)).toBeTruthy();
      expect(lecturas(f, "/resumen")).toHaveLength(0);
    });

    it("escribir un periodo válido carga el resumen de ese periodo", async () => {
      const f = await montar({ periodo: null });
      const user = userEvent.setup();
      // Las lecturas de otro periodo no están simuladas: solo se comprueba que se pide el resumen.
      const campo = await screen.findByLabelText(M.etiquetaPeriodo);
      await user.type(campo, PERIODO);
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(1));
    });

    it.each([
      ["sin sire.descargar: sin «Descargar»", PERMISOS.lectura, "abierto", M.soloLectura.sinPermiso, false],
      ["solo descargar: puede descargar pero no modifica", PERMISOS.soloDescargar, "abierto", M.soloLectura.sinPermiso, true],
      ["revisado sin sire.aprobar_generar: solo lectura", PERMISOS.sinAprobar, "revisado", M.soloLectura.revisadoSinAprobar, true],
      ["generado: nadie edita", PERMISOS.todos, "generado", M.soloLectura.generado, true],
    ] as const)("%s (D-13, CA-14)", async (_nombre, permisos, estado, motivo, descarga) => {
      await montar({
        permisos,
        estado: { estado, resumen: resumenDe(FILAS_014, {}, estado) },
      });
      expect(await screen.findByText(motivo)).toBeTruthy();
      expect(!!boton(M.descargar)).toBe(descarga);
    });

    it("revisado con sire.aprobar_generar no es solo lectura y puede reabrir", async () => {
      await montar({
        estado: { estado: "revisado", resumen: resumenDe(FILAS_014, {}, "revisado") },
      });
      expect(await screen.findByText(M.estado.revisado)).toBeTruthy();
      expect(screen.queryByText(M.soloLectura.revisadoSinAprobar)).toBeNull();
      expect(boton(M.reabrir)).toBeTruthy();
      expect(boton(M.marcarRevisado)).toBeNull();
    });

    it("cliente archivado: solo lectura, sin descargar, sin marcar revisado", async () => {
      await montar({ cliente: { archivado: true } });
      expect(await screen.findByText(M.soloLectura.clienteArchivado)).toBeTruthy();
      expect(boton(M.descargar)).toBeNull();
      expect(boton(M.marcarRevisado)).toBeNull();
      // Exportar es lectura: sigue disponible.
      expect(boton(M.exportar)).toBeTruthy();
    });

    it("error: un 403 del servidor al pedir el resumen se muestra con su mensaje", async () => {
      await montar({
        extra: {
          [`GET ${BASE}/resumen`]: { status: 403, cuerpo: { codigo: "permiso_denegado" } },
        },
      });
      expect(await screen.findByText(M.errores.permiso_denegado!)).toBeTruthy();
    });
  });

  describe("descarga (D-14, CA-3)", () => {
    const manejador = (n: number) => (estado: EstadoCompras) => ({
      [POST_DESCARGAR]: () => {
        estado.trabajos = [trabajoDescarga(n, "en_cola", { posicion: 3 })];
        return { status: 202, cuerpo: { trabajoId: idTrabajo(n) } };
      },
    });
    const emitir = (t: ReturnType<typeof trabajoDescarga>) =>
      seguimiento.opciones?.alEvento(t as unknown as TrabajoVista);

    it("al completar refresca el resumen, las propuestas y las diferencias, y muestra «N nuevas, M distintas»", async () => {
      const f = await montar({ extra: manejador(1) });
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(1));
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: M.descargar }));
      await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
      emitir(trabajoDescarga(1, "en_cola", { posicion: 3 }));
      expect(await screen.findByText(M.enCola(3))).toBeTruthy();

      // El worker guardó 2 nuevas y una distinta.
      f.estado.propuestas = [P3, P2];
      f.estado.resumen = resumenDe(FILAS_014, {
        casilleros: {
          original: montosDe({ biDg: "10.00" }),
          vigente: montosDe({ biDg: "10.00" }),
          diferencia: montosDe(),
        },
      });
      emitir(trabajoDescarga(1, "completado"));

      expect(await screen.findByText(M.resumenDescarga(2, 1))).toBeTruthy();
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(2));
      await vi.waitFor(() => expect(lecturas(f, "/propuestas")).toHaveLength(2));
      await vi.waitFor(() =>
        expect(lecturas(f, `/propuestas/${P3.id}/diferencias`)).toHaveLength(1),
      );
    });

    it("error: un 409 credencial_no_configurada se muestra y no se recarga nada", async () => {
      const f = await montar({
        extra: {
          [POST_DESCARGAR]: { status: 409, cuerpo: { codigo: "credencial_no_configurada" } },
        },
      });
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(1));
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: M.descargar }));
      expect(
        await screen.findByText(M.errores.credencial_no_configurada!),
      ).toBeTruthy();
      expect(lecturas(f, "/resumen")).toHaveLength(1);
    });
  });

  describe("estado del periodo (D-13, CA-13)", () => {
    it("reabrir envía el estado visto y la página recarga el resumen con el estado nuevo", async () => {
      const f = await montar({
        estado: { estado: "revisado", resumen: resumenDe(FILAS_014, {}, "revisado") },
        extra: (estado) => ({
          [POST_REABRIR]: () => {
            estado.estado = "abierto";
            estado.resumen = resumenDe(FILAS_014, {}, "abierto");
            return {
              status: 200,
              cuerpo: { estado: "abierto", por: USUARIO, autor: { id: USUARIO, nombre: "Rosa Quispe", activo: true }, en: "2026-11-06T10:00:00.000Z" },
            };
          },
        }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: M.reabrir }));
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(
        within(dialogo).getByRole("button", { name: MENSAJES_VENTAS.confirmar }),
      );

      await vi.waitFor(() => expect(f.de(POST_REABRIR)).toHaveLength(1));
      expect(f.de(POST_REABRIR)[0]!.body).toEqual({ estadoVisto: "revisado" });
      expect(await screen.findByText(M.periodoReabierto)).toBeTruthy();
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(2));
      // El estado de la pantalla pasó a «Abierto»: ahora se ofrece marcar como revisado.
      expect(await screen.findByRole("button", { name: M.marcarRevisado })).toBeTruthy();
      expect(boton(M.reabrir)).toBeNull();
    });

    it("T18a P-1: el «Marcado el … por …» sale del resumen, también al recargar; sin marca no se muestra", async () => {
      await montar({
        estado: {
          estado: "revisado",
          resumen: resumenDe(
            FILAS_014,
            { por: USUARIO, autor: { id: USUARIO, nombre: "Rosa Quispe", activo: true }, en: "2026-11-06T10:00:00.000Z" },
            "revisado",
          ),
        },
      });
      const seccion = await screen.findByRole("region", { name: "Estado del periodo" });
      await vi.waitFor(() => expect(seccion.textContent).toMatch(/Marcado el .* por Rosa Quispe/));
      cleanup();
      vi.unstubAllGlobals();
      reiniciarSesion();

      await montar({ estado: { resumen: resumenDe(FILAS_014, {}, "abierto") } });
      const abierto = await screen.findByRole("region", { name: "Estado del periodo" });
      await vi.waitFor(() => expect(abierto.textContent).toContain(M.estado.abierto));
      expect(abierto.textContent).not.toContain("Marcado el");
    });

    it("error: 409 estado_invalido avisa y recarga el estado real del periodo", async () => {
      const f = await montar({
        estado: { estado: "revisado", resumen: resumenDe(FILAS_014, {}, "revisado") },
        extra: (estado) => ({
          [POST_REABRIR]: () => {
            // Otra persona ya lo había reabierto.
            estado.estado = "abierto";
            estado.resumen = resumenDe(FILAS_014, {}, "abierto");
            return { status: 409, cuerpo: { codigo: "estado_invalido" } };
          },
        }),
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: M.reabrir }));
      const dialogo = await screen.findByRole("alertdialog");
      await user.click(
        within(dialogo).getByRole("button", { name: MENSAJES_VENTAS.confirmar }),
      );
      expect(await screen.findByText(M.errores.estado_invalido!)).toBeTruthy();
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(2));
      expect(await screen.findByRole("button", { name: M.marcarRevisado })).toBeTruthy();
    });
  });

  describe("grilla conectada: carga, filtros y selección (T5; CA-1, CA-2, CA-12)", () => {
    beforeEach(() => {
      // jsdom no mide el diseño: el virtualizador lee `clientWidth`/`clientHeight` del contenedor.
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    });

    /** Retiene las llamadas de `fetch` que cumplen `coincide` hasta que se abra la compuerta. */
    function compuerta(coincide: (url: string) => boolean) {
      let abrir!: () => void;
      const abierta = new Promise<void>((resolver) => {
        abrir = resolver;
      });
      return {
        abrir,
        instalar: () => {
          const real = globalThis.fetch;
          vi.stubGlobal("fetch", async (entrada: RequestInfo | URL, init?: RequestInit) => {
            const url =
              typeof entrada === "string"
                ? entrada
                : entrada instanceof URL
                  ? entrada.pathname + entrada.search
                  : entrada.url;
            if (coincide(url)) await abierta;
            return real(entrada, init);
          });
        },
      };
    }

    const filasPintadas = () =>
      [...document.querySelectorAll<HTMLElement>("[data-fila]")].map(
        (f) => f.textContent ?? "",
      );
    const hayComprobante = (numero: string) =>
      filasPintadas().some((t) => t.includes(`F001-${numero}`));
    const esListado = (url: string) => url.startsWith(`${BASE}?`);

    it("feliz: lista las compras con IGV al abrir y pide al servidor cada filtro y la búsqueda (CA-1, CA-2, CA-12)", async () => {
      const f = await montar();
      expect(await screen.findByText(M.cargaCompleta(4))).toBeTruthy();
      const inicial = consultaDe(f.listados()[0]!.url);
      expect(inicial.get("vista")).toBe("con_igv");
      expect(inicial.get("limite")).toBe("1000");
      expect(inicial.has("alertas")).toBe(false);
      // F001-1040 no tiene IGV: va a «sin IGV», no a la lista principal.
      expect(hayComprobante("3064")).toBe(true);
      expect(hayComprobante("1040")).toBe(false);
      // El proveedor nuevo se ve con su etiqueta (CA-12).
      expect(filasPintadas().find((t) => t.includes("F001-3064"))).toContain(M.proveedorNuevo);

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: M.filtroAlertas }));
      await vi.waitFor(() => expect(f.listados()).toHaveLength(2));
      expect(consultaDe(f.listados()[1]!.url).get("alertas")).toBe("true");
      expect(await screen.findByText(M.cargaCompleta(3))).toBeTruthy();
      expect(hayComprobante("4062")).toBe(false);

      await user.click(screen.getByRole("checkbox", { name: M.filtroProveedorNuevo }));
      await vi.waitFor(() => expect(f.listados()).toHaveLength(3));
      expect(consultaDe(f.listados()[2]!.url).get("proveedorNuevo")).toBe("true");
      expect(await screen.findByText(M.cargaCompleta(1))).toBeTruthy();

      // La búsqueda espera un retardo corto y pide una sola vez con lo escrito.
      await user.type(screen.getByRole("searchbox", { name: M.buscar }), "20700000053");
      await vi.waitFor(() => expect(f.listados()).toHaveLength(4));
      expect(consultaDe(f.listados()[3]!.url).get("q")).toBe("20700000053");
      expect(consultaDe(f.listados()[3]!.url).get("alertas")).toBe("true");

      await user.click(screen.getByRole("radio", { name: M.vistas.excluidas }));
      await vi.waitFor(() => expect(f.listados()).toHaveLength(5));
      expect(consultaDe(f.listados()[4]!.url).get("vista")).toBe("excluidas");
      expect(await screen.findByText(M.sinResultados)).toBeTruthy();
    });

    it("una razón social con HTML se ve como texto y no crea elementos (CA-2)", async () => {
      await montar({
        estado: {
          filas: [
            filaDe({
              id: uuidDe(6, 1),
              numero: "7001",
              proveedor: { tipo: "6", numero: "20100070970", razonSocial: TEXTO_HOSTIL },
            }),
          ],
        },
      });
      expect(await screen.findByText(TEXTO_HOSTIL)).toBeTruthy();
      expect(document.querySelector("img")).toBeNull();
    });

    it("error: la respuesta vieja de un filtro anterior se descarta tras un cambio rápido de filtro", async () => {
      const lenta = compuerta((url) => esListado(url) && !url.includes("alertas"));
      const f = await montar({ antes: lenta.instalar });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: M.filtroAlertas }));
      // Responde el filtro nuevo (3 con alerta) mientras el listado completo sigue retenido.
      expect(await screen.findByText(M.cargaCompleta(3))).toBeTruthy();
      expect(hayComprobante("4062")).toBe(false);

      lenta.abrir();
      await new Promise((r) => setTimeout(r, 60));
      // Llegó tarde la respuesta sin filtrar (traía F001-4062) y no se pintó.
      expect(hayComprobante("4062")).toBe(false);
      expect(screen.queryByText(M.cargaCompleta(4))).toBeNull();
      expect(screen.getByText(M.cargaCompleta(3))).toBeTruthy();
      expect(f.listados().map((l) => consultaDe(l.url).get("alertas"))).toContain("true");
    });

    it("carga por cursor: usable desde el primer bloque y «las N del filtro» deshabilitado hasta terminar (CA-2)", async () => {
      const segundo = compuerta((url) => esListado(url) && url.includes("cursor="));
      const f = await montar({
        estado: { filas: generarFilas(2500) },
        antes: segundo.instalar,
      });
      // Primer bloque en pantalla (1.000 de las 2.475) con «Cargando…» y sin poder seleccionar todo.
      expect(await screen.findByText(M.cargandoMas(1000))).toBeTruthy();
      expect(filasPintadas().length).toBeGreaterThan(0);
      const todas = screen.getByRole("button", { name: M.seleccionarDelFiltro(1000) });
      expect((todas as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(M.seleccionarDelFiltroCargando)).toBeTruthy();

      segundo.abrir();
      expect(await screen.findByText(M.cargaCompleta(2475))).toBeTruthy();
      expect(f.listados()).toHaveLength(3);
      const lista = screen.getByRole("button", { name: M.seleccionarDelFiltro(2475) });
      expect((lista as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(lista);
      const primera = document.querySelector<HTMLElement>("[data-fila]")!;
      expect(primera.getAttribute("aria-selected")).toBe("true");
    });

    it("error: con más de 5.000 compras en el filtro pide filtrar y no deja seleccionarlas", async () => {
      await montar({ estado: { filas: generarFilas(5200) } });
      expect(await screen.findByText(M.cargaCompleta(5148), {}, { timeout: 15000 })).toBeTruthy();
      const todas = screen.getByRole("button", { name: M.seleccionarDelFiltro(5148) });
      expect((todas as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(M.seleccionarDemasiadas(5000))).toBeTruthy();
    }, 30000);

    it("error: si el listado falla se muestra el mensaje con «Reintentar» y reintenta", async () => {
      let falla = true;
      const f = await montar({
        extra: {
          [`GET ${BASE}`]: () =>
            falla
              ? { status: 403, cuerpo: { codigo: "permiso_denegado" } }
              : { status: 200, cuerpo: { filas: [C_3064_BOLSAS], siguiente: null } },
        },
      });
      expect(await screen.findByText(M.errores.permiso_denegado!)).toBeTruthy();
      falla = false;
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: M.reintentar }));
      expect(await screen.findByText(M.cargaCompleta(1))).toBeTruthy();
      expect(f.listados().length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("edición de una fila con teclado (T6; CA-4)", () => {
    const FILA = C_3064_BOLSAS;
    const EDITAR = `POST ${BASE}/${FILA.id}/editar`;
    const CALCULAR = `POST ${BASE}/${FILA.id}/calcular`;

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    });

    const celda = (columna: string) =>
      document.querySelector<HTMLElement>(`[data-fila="${FILA.id}"] [data-col="${columna}"]`)!;
    const campo = () => document.querySelector<HTMLInputElement>("input[data-edicion]");
    /** Foco en la celda de la BI de F001-3064 y Enter: abre la fila para editar. */
    async function abrirBi(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText(M.cargaCompleta(4));
      act(() => celda("biDg").focus());
      await user.keyboard("{Enter}");
      expect(campo()).not.toBeNull();
    }

    it("feliz: edita la BI, el total se recalcula, un solo editar, la fila y el resumen vienen del servidor", async () => {
      const guardada = {
        ...FILA,
        version: 2,
        montos: montosDe({ biDg: "150.00", igvDg: "18.00", icbper: "1.50" }),
      };
      const f = await montar({
        extra: (estado) => ({
          [CALCULAR]: {
            status: 200,
            cuerpo: { total: "169.50", cuadre: { cuadra: true, celdas: [] } },
          },
          [EDITAR]: () => {
            estado.filas = estado.filas.map((x) => (x.id === FILA.id ? guardada : x));
            return { status: 200, cuerpo: accionDe(guardada) };
          },
        }),
      });
      const user = userEvent.setup();
      await abrirBi(user);
      await user.keyboard("150.00");
      expect(celda("total").textContent).toContain("169.50");
      await vi.waitFor(() => expect(f.de(CALCULAR)).toHaveLength(1));
      expect(f.de(CALCULAR)[0]!.body).toEqual({ cambios: { biDg: "150.00" } });

      const resumenes = lecturas(f, "/resumen").length;
      await user.keyboard("{Enter}");
      await vi.waitFor(() => expect(f.de(EDITAR)).toHaveLength(1));
      expect(f.de(EDITAR)[0]!.body).toEqual({ versionBase: 1, cambios: { biDg: "150.00" } });
      expect(await screen.findByText(M.filaGuardada)).toBeTruthy();
      await vi.waitFor(() => expect(campo()).toBeNull());
      // La celda muestra lo que respondió el servidor, sin pedir otra vez la fila.
      expect(celda("biDg").textContent).toBe("150.00");
      expect(celda("total").textContent).toBe("169.50");
      await vi.waitFor(() => expect(lecturas(f, "/resumen")).toHaveLength(resumenes + 1));
      expect(lecturas(f, `/${FILA.id}`)).toHaveLength(0);
    });

    it("error: 409 version_obsoleta recarga la fila, descarta el borrador y avisa", async () => {
      const f = await montar({
        extra: (estado) => ({
          [CALCULAR]: {
            status: 200,
            cuerpo: { total: "169.50", cuadre: { cuadra: true, celdas: [] } },
          },
          [EDITAR]: () => {
            // Otra persona ya la había cambiado.
            estado.filas = estado.filas.map((x) =>
              x.id === FILA.id
                ? { ...x, version: 2, montos: montosDe({ biDg: "300.00", igvDg: "54.00" }) }
                : x,
            );
            return { status: 409, cuerpo: { codigo: "version_obsoleta", versionVigente: 2 } };
          },
        }),
      });
      const user = userEvent.setup();
      await abrirBi(user);
      await user.keyboard("150.00{Enter}");
      expect((await screen.findByRole("alert")).textContent).toBe(M.versionObsoleta);
      await vi.waitFor(() => expect(lecturas(f, `/${FILA.id}`)).toHaveLength(1));
      await vi.waitFor(() => expect(celda("biDg").textContent).toBe("300.00"));
      expect(campo()).toBeNull();
    });

    it("error: otro fallo del servidor se muestra y el borrador sigue abierto", async () => {
      const f = await montar({
        extra: {
          [CALCULAR]: { status: 500, cuerpo: {} },
          [EDITAR]: { status: 403, cuerpo: { codigo: "periodo_revisado" } },
        },
      });
      const user = userEvent.setup();
      await abrirBi(user);
      await user.keyboard("150.00");
      // `calcular` caído no impide seguir: total local y aviso.
      expect((await screen.findAllByText(new RegExp(M.cuadreNoVerificado))).length).toBeGreaterThan(0);
      await user.keyboard("{Enter}");
      expect(await screen.findByText(M.errores.periodo_revisado!)).toBeTruthy();
      expect(f.de(EDITAR)).toHaveLength(1);
      await vi.waitFor(() => expect(campo()?.value).toBe("150.00"));
    });

    it("solo lectura (periodo generado): no se abre la edición ni se pide nada", async () => {
      const f = await montar({
        estado: { estado: "generado", resumen: resumenDe(FILAS_014, {}, "generado") },
      });
      const user = userEvent.setup();
      await screen.findByText(M.cargaCompleta(4));
      act(() => celda("biDg").focus());
      await user.keyboard("{Enter}");
      expect(campo()).toBeNull();
      expect(f.de(EDITAR)).toHaveLength(0);
    });
  });
});

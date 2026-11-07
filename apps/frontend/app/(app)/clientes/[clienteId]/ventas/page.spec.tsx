import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shared from "@contapp/shared";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  MENSAJES_ACCESO,
  asentar,
  celdas,
} from "../../../../../pruebas/acceso";
import { MENSAJES_CLIENTES } from "../../../../../pruebas/clientes";
import { MENSAJES_CREDENCIALES } from "../../../../../pruebas/credenciales";
import { crearRouterFalso, type Manejador } from "../../../../../pruebas/soporte";
import { idTrabajo } from "../../../../../pruebas/trabajos";
import {
  BASE,
  CLIENTE_ID,
  COMENTARIO_JUSTIFICADO,
  CORRELATIVIDAD_BASE,
  CORRELATIVIDAD_CON_291,
  CORRELATIVIDAD_ENORME,
  CORRELATIVIDAD_JUSTIFICADA,
  CORRELATIVIDAD_PARCIAL,
  DIFERENCIA_290,
  MENSAJES_VENTAS as M,
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  RESUMEN_CON_USD_SIN_TC,
  RESUMEN_FLOTANTE,
  TEXTO_HOSTIL,
  V290,
  V292,
  V_HOSTIL,
  V_MANUAL,
  V_NC,
  V_USD_SIN_TC,
  consultaDe,
  instalarFetchVentas,
  paginaDe,
  propuestaDe,
  trabajoDescarga,
  uuidDe,
  ventaDe,
  type EstadoVentas,
  type FetchVentas,
  type OpcionesVentas,
} from "../../../../../pruebas/ventas";

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
  usePathname: () => "/clientes/c-1/ventas",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

// La página se importa en cada prueba (y no arriba) para que, mientras no exista, cada una falle por su
// cuenta con «no existe ./page» y se cuenten una a una (rojo de T7).
const RUTA_PAGINA = "./page";
async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import(/* @vite-ignore */ RUTA_PAGINA)) as {
    default: () => ReactElement;
  };
  const Pagina = modulo.default;
  return <Pagina />;
}

// Contrato (plan 013, Rutas; spec D14, D7 a D11, D16; CA-6 a CA-9, CA-13). Pantalla
// /clientes/c-1/ventas; el id sale de `useParams()` y el periodo, del campo «Periodo (AAAAMM)»
// (prellenado con `?periodo=` de la URL). Solo importa `@contapp/shared`:
// - Al montar pide GET /api/acceso/yo. Sin `clientes.ver` → sinPermiso y no se pide nada de ventas.
//   Con permiso: <h1> M.titulo y el campo de periodo. Con un periodo válido (AAAAMM, mes 01–12) pide, una
//   vez, GET <BASE> (`pagina=1&tamano=25`), /resumen, /correlatividad y /propuestas (y, si hay propuestas,
//   /propuestas/<la primera>/diferencias: la más reciente va primero). Periodo vacío o inválido →
//   M.periodoInvalido (el vacío, sin mensaje) y no pide nada; «Descargar» queda deshabilitado.
// - Permisos: «Descargar» y el enlace «Importar propuesta» (href /clientes/c-1/ventas/importar?periodo=…)
//   exigen `sire.descargar`; «Justificar», «Agregar venta» y «Agregar venta manual», `sire.clasificar`.
//   Sin ellos se OCULTAN (no se deshabilitan); la alerta y la grilla se ven igual.
// - Regiones (role=region): «Descarga», «Resumen», «Correlatividad», «Ventas del periodo» y
//   «Diferencias de la última descarga». Los montos son las cadenas del servidor, tal cual.
// - Grilla (RF-052): select «Filas por página» (valores 10, 25, 50, todas), «Anterior»/«Siguiente»,
//   filtros de texto «Buscar», «Tipo», «Serie», «Monto mínimo», «Monto máximo» y botón «Filtrar»
//   (query q, tipo, serie, min, max; cambia a pagina=1). Virtualizada: no pinta todas las filas.
// - Correlatividad: un grupo (role=group) por serie, nombrado M.nombreSerie(tipo, serie); cada faltante es un
//   listitem con «Falta B001-291» o «Faltan B003-402 a B003-404» y, según permiso, «Justificar» y
//   «Agregar venta». Serie completa → «Numeración completa». Contador M.porRevisar(n).
// - Justificar: formulario (role=form, «Justificar salto») con «Comentario» (1–500), «Guardar», «Cancelar».
//   POST <BASE>/saltos-justificados {tipo, serie, desde, hasta, comentario} (desde/hasta enteros) y recarga la
//   correlatividad.
// - Agregar venta: formulario (role=form, «Agregar venta») con los campos de M.campos, validado con
//   `ventaAgregarSchema` de shared; POST <BASE> con montos como cadenas; recarga grilla, resumen y
//   correlatividad. La pantalla NO suma ni compara montos: el servidor decide el cuadre.
// - «Diferencias de la última descarga» y el resumen se listan como filas (role=row).
// - Descargar: POST <BASE>/descargar sin cuerpo → 202 {trabajoId}; la región «Descarga» muestra la
//   posición (M.enCola), «Ejecutando», y al completar refresca todo y muestra M.resumenDescarga con los
//   contadores de la propuesta más reciente. Error → motivo + «Reintentar» (encola de nuevo).

const P2 = propuestaDe(2);
const P3 = propuestaDe(3, {
  filasNuevas: 2,
  filasIguales: 1,
  filasDistintas: 1,
  creadaEn: "2026-11-04T11:00:00.000Z",
});

function estadoBase(): Partial<EstadoVentas> {
  return {
    pagina: paginaDe([V290, V292]),
    resumen: RESUMEN_BASE,
    correlatividad: CORRELATIVIDAD_BASE,
    propuestas: [P2],
    diferencias: { [P2.id]: [DIFERENCIA_290], [P3.id]: [DIFERENCIA_290] },
  };
}

interface OpcionesMontaje extends Omit<OpcionesVentas, "estado"> {
  estado?: Partial<EstadoVentas>;
  /** `null` = sin periodo en la URL (la prueba lo escribe). Por defecto: PERIODO. */
  periodo?: string | null;
}

async function montar(o: OpcionesMontaje = {}): Promise<FetchVentas> {
  const periodo = o.periodo === undefined ? PERIODO : o.periodo;
  busqueda.actual = new URLSearchParams(periodo ? `periodo=${periodo}` : "");
  const f = instalarFetchVentas({
    permisos: o.permisos,
    estado: { ...estadoBase(), ...o.estado },
    extra: o.extra,
  });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const region = (nombre: string) =>
  screen.findByRole("region", { name: nombre });
function fila(contenedor: HTMLElement, texto: string): HTMLElement {
  const f = within(contenedor)
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}
function filaDeTipo(contenedor: HTMLElement, tipo: string): HTMLElement {
  const f = within(contenedor)
    .queryAllByRole("row")
    .find((r) => (celdas(r)[0] ?? "").trim() === tipo);
  if (!f) throw new Error(`no hay fila del tipo ${tipo}`);
  return f;
}
const grupoSerie = (contenedor: HTMLElement, tipo: string, serie: string) =>
  within(contenedor).getByRole("group", { name: M.nombreSerie(tipo, serie) });
function faltante(contenedor: HTMLElement, texto: string): HTMLElement {
  const el = within(contenedor).getByText(texto);
  const item = el.closest('li, [role="listitem"]');
  if (!item) throw new Error(`"${texto}" no está dentro de un listitem`);
  return item as HTMLElement;
}
const ventasEsperadas = async () => region(M.tablaVentas);

async function escribirPeriodo(valor: string): Promise<void> {
  const user = userEvent.setup();
  const campo = await screen.findByLabelText(M.etiquetaPeriodo);
  await user.clear(campo);
  await user.type(campo, valor);
}

const POST_DESCARGAR = `POST ${BASE}/descargar`;
const POST_JUSTIFICAR = `POST ${BASE}/saltos-justificados`;
const POST_AGREGAR = `POST ${BASE}`;

describe("/clientes/:id/ventas · pantalla de ventas (013)", () => {
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
    delete (window as unknown as Record<string, unknown>)["__xss"];
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("estructura, periodo y permisos (D14)", () => {
    it("sin periodo: título, campo vacío, «Descargar» deshabilitado y no se pide nada de ventas", async () => {
      const f = await montar({ periodo: null });
      expect(
        await screen.findByRole("heading", { name: M.titulo, level: 1 }),
      ).toBeTruthy();
      const campo = (await screen.findByLabelText(
        M.etiquetaPeriodo,
      )) as HTMLInputElement;
      expect(campo.value).toBe("");
      const boton = (await screen.findByRole("button", {
        name: M.descargar,
      })) as HTMLButtonElement;
      expect(boton.disabled).toBe(true);
      await asentar();
      expect(f.llamadas.filter((l) => l.ruta.startsWith(BASE))).toHaveLength(0);
    });

    it.each(["202613", "202600", "20261a"])(
      "periodo inválido %s: avisa, deshabilita «Descargar» y no pide nada",
      async (valor) => {
        const f = await montar({ periodo: null });
        await escribirPeriodo(valor);
        expect(await screen.findByText(M.periodoInvalido)).toBeTruthy();
        expect(
          (screen.getByRole("button", { name: M.descargar }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        await asentar();
        expect(f.llamadas.filter((l) => l.ruta.startsWith(BASE))).toHaveLength(0);
      },
    );

    it("al escribir un periodo válido carga la grilla, el resumen, la correlatividad y las propuestas, una vez cada uno", async () => {
      const f = await montar({ periodo: null });
      await escribirPeriodo(PERIODO);
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
      await vi.waitFor(() => expect(f.lecturas("/resumen")).toHaveLength(1));
      await vi.waitFor(() =>
        expect(f.lecturas("/correlatividad")).toHaveLength(1),
      );
      await vi.waitFor(() => expect(f.lecturas("/propuestas")).toHaveLength(1));
      await vi.waitFor(() =>
        expect(f.lecturas(`/propuestas/${P2.id}/diferencias`)).toHaveLength(1),
      );
      await asentar(60);
      expect(f.lecturas()).toHaveLength(1);
      expect(f.lecturas("/resumen")).toHaveLength(1);
      expect(f.lecturas("/correlatividad")).toHaveLength(1);
      const q = consultaDe(f.lecturas()[0]!.url);
      expect(q.get("pagina")).toBe("1");
      expect(q.get("tamano")).toBe("25");
      expect(f.lecturas()[0]!.headers["x-estudio"]).toBe("e-a");
    });

    it("el periodo de la URL (?periodo=) prellena el campo y carga sin escribir", async () => {
      const f = await montar({ periodo: PERIODO });
      const campo = (await screen.findByLabelText(
        M.etiquetaPeriodo,
      )) as HTMLInputElement;
      expect(campo.value).toBe(PERIODO);
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
    });

    it("sin clientes.ver: solo el mensaje de permiso y nada de ventas", async () => {
      const f = await montar({ permisos: [] });
      expect(await screen.findByText(MENSAJES_ACCESO.sinPermiso)).toBeTruthy();
      expect(screen.queryByLabelText(M.etiquetaPeriodo)).toBeNull();
      expect(screen.queryByRole("button", { name: M.descargar })).toBeNull();
      await asentar();
      expect(f.llamadas.filter((l) => l.ruta.startsWith(BASE))).toHaveLength(0);
    });

    it.each([
      ["lectura", PERMISOS.lectura, false, false],
      ["solo descargar", PERMISOS.soloDescargar, true, false],
      ["solo clasificar", PERMISOS.soloClasificar, false, true],
      ["todos", PERMISOS.todos, true, true],
    ] as const)(
      "permisos %s: las acciones se ocultan, la alerta y la grilla no",
      async (_nombre, permisos, descarga, clasifica) => {
        await montar({ permisos });
        const ventas = await ventasEsperadas();
        await vi.waitFor(() => fila(ventas, "B001-290"));
        const correlatividad = await region("Correlatividad");
        const item = await vi.waitFor(() =>
          faltante(correlatividad, M.faltaUno("B001-291")),
        );
        const hay = (nombre: string, donde: HTMLElement = document.body) =>
          within(donde).queryByRole("button", { name: nombre }) !== null;

        expect(hay(M.descargar)).toBe(descarga);
        expect(
          screen.queryByRole("link", { name: M.importar }) !== null,
        ).toBe(descarga);
        expect(hay(M.justificar, item)).toBe(clasifica);
        expect(hay(M.agregarVenta, item)).toBe(clasifica);
        expect(hay(M.agregarVentaManual)).toBe(clasifica);
      },
    );

    it("el enlace «Importar propuesta» lleva al asistente con el periodo", async () => {
      await montar();
      const enlace = await screen.findByRole("link", { name: M.importar });
      expect(enlace.getAttribute("href")).toBe(
        `/clientes/${CLIENTE_ID}/ventas/importar?periodo=${PERIODO}`,
      );
    });
  });

  describe("grilla (RF-052, D10)", () => {
    it("muestra las filas con sus montos tal como los entrega el servidor (cadenas, sin number)", async () => {
      await montar({
        estado: { pagina: paginaDe([V290, V292, V_USD_SIN_TC]) },
      });
      const ventas = await ventasEsperadas();
      const f290 = await vi.waitFor(() => fila(ventas, "B001-290"));
      expect(f290.textContent).toContain("118.00");
      expect(f290.textContent).toContain("100.00");
      const f292 = fila(ventas, "B001-292");
      for (const monto of ["0.10", "0.02", "0.12"]) {
        expect(f292.textContent).toContain(monto);
      }
      // `Number("1000.00")` daría «1000» y `toLocaleString`, «1,000.00»: ninguna cabe en «1000.00».
      const fusd = fila(ventas, "F001-5");
      expect(fusd.textContent).toContain("1000.00");
      expect(fusd.textContent).toContain("1180.00");
      expect(fusd.textContent).toContain("USD");
    });

    it("el texto del SIRE se escapa: se ve como texto y no crea elementos ni ejecuta nada", async () => {
      await montar({ estado: { pagina: paginaDe([V290, V_HOSTIL]) } });
      const ventas = await ventasEsperadas();
      const f = await vi.waitFor(() => fila(ventas, "B001-293"));
      expect(f.textContent).toContain(TEXTO_HOSTIL);
      await asentar();
      expect(document.querySelector("img")).toBeNull();
      expect((window as unknown as Record<string, unknown>)["__xss"]).toBeUndefined();
    });

    it("está virtualizada: con 2.000 filas no pinta todas", async () => {
      const filas = Array.from({ length: 2000 }, (_, i) =>
        ventaDe({ numero: String(1000 + i) }),
      );
      await montar({
        estado: { pagina: paginaDe(filas, { tamano: "todas" }) },
      });
      const ventas = await ventasEsperadas();
      await vi.waitFor(() =>
        expect(within(ventas).queryAllByRole("row").length).toBeGreaterThan(1),
      );
      expect(within(ventas).queryAllByRole("row").length).toBeLessThanOrEqual(300);
    });

    it("«Siguiente» y «Anterior» piden la página contigua con el mismo tamaño", async () => {
      const filas = [V290, V292];
      const f = await montar({
        extra: {
          [`GET ${BASE}`]: (l) => ({
            status: 200,
            cuerpo: paginaDe(filas, {
              total: 60,
              pagina: Number(consultaDe(l.url).get("pagina")),
              tamano: 25,
            }),
          }),
        },
      });
      const user = userEvent.setup();
      const anterior = (await screen.findByRole("button", {
        name: M.anterior,
      })) as HTMLButtonElement;
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
      expect(anterior.disabled).toBe(true);
      await user.click(screen.getByRole("button", { name: M.siguiente }));
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
      const q = consultaDe(f.lecturas()[1]!.url);
      expect(q.get("pagina")).toBe("2");
      expect(q.get("tamano")).toBe("25");
      await user.click(await screen.findByRole("button", { name: M.anterior }));
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(3));
      expect(consultaDe(f.lecturas()[2]!.url).get("pagina")).toBe("1");
    });

    it.each(["10", "50", "todas"])(
      "elegir %s filas por página pide tamano=%s desde la página 1",
      async (tamano) => {
        const f = await montar();
        const user = userEvent.setup();
        await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
        await user.selectOptions(
          await screen.findByLabelText(M.filasPorPagina),
          tamano,
        );
        await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
        const q = consultaDe(f.lecturas()[1]!.url);
        expect(q.get("tamano")).toBe(tamano);
        expect(q.get("pagina")).toBe("1");
      },
    );

    it("«todas» con más de 5.000 filas muestra el aviso con el total real", async () => {
      await montar({
        estado: {
          pagina: paginaDe([V290, V292], {
            total: 5001,
            tamano: "todas",
            avisos: ["todas_limitada"],
          }),
        },
      });
      expect(await screen.findByText(M.todasLimitada("5.001"))).toBeTruthy();
    });

    it("sin el aviso del servidor no muestra el aviso de «todas»", async () => {
      await montar();
      await vi.waitFor(() => fila(document.body, "B001-290"));
      await asentar();
      expect(screen.queryByText(/Se muestran las primeras/)).toBeNull();
    });

    it("los filtros se envían como cadenas, sin tocar (0.005, %, _ y comillas) y vuelven a la página 1", async () => {
      const f = await montar();
      const user = userEvent.setup();
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
      await user.type(await screen.findByLabelText(M.buscar), "100%_'");
      await user.type(screen.getByLabelText(M.filtroTipo), "03");
      await user.type(screen.getByLabelText(M.filtroSerie), "B001");
      await user.type(screen.getByLabelText(M.montoMinimo), "0.005");
      await user.type(screen.getByLabelText(M.montoMaximo), "999999999999.99");
      await user.click(screen.getByRole("button", { name: M.filtrar }));
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
      const q = consultaDe(f.lecturas()[1]!.url);
      expect(q.get("q")).toBe("100%_'");
      expect(q.get("tipo")).toBe("03");
      expect(q.get("serie")).toBe("B001");
      expect(q.get("min")).toBe("0.005");
      expect(q.get("max")).toBe("999999999999.99");
      expect(q.get("pagina")).toBe("1");
    });
  });

  describe("resumen (RF-056, D11)", () => {
    it("muestra por tipo la cantidad y las sumas en soles tal como las calcula el servidor, con la NC restando", async () => {
      await montar();
      const resumen = await region("Resumen");
      expect(within(resumen).getByText(M.importesEnSoles)).toBeTruthy();
      const boletas = await vi.waitFor(() => filaDeTipo(resumen, "03"));
      const c03 = celdas(boletas).map((c) => c.trim());
      for (const v of ["2", "100.10", "18.02", "118.12"]) {
        expect(c03).toContain(v);
      }
      const nc = filaDeTipo(resumen, "07");
      const c07 = celdas(nc).map((c) => c.trim());
      for (const v of ["1", "-50.00", "-9.00", "-59.00"]) {
        expect(c07).toContain(v);
      }
      const total = within(resumen)
        .queryAllByRole("row")
        .find((r) => /^total$/i.test((celdas(r)[0] ?? "").trim()));
      expect(total).toBeTruthy();
      const cT = celdas(total!).map((c) => c.trim());
      for (const v of ["3", "50.10", "9.02", "59.12"]) {
        expect(cT).toContain(v);
      }
    });

    it("no suma con number: el total es la cadena del servidor (0.10 + 0.20 = 0.30)", async () => {
      await montar({ estado: { resumen: RESUMEN_FLOTANTE } });
      const resumen = await region("Resumen");
      const total = await vi.waitFor(() => {
        const r = within(resumen)
          .queryAllByRole("row")
          .find((x) => /^total$/i.test((celdas(x)[0] ?? "").trim()));
        if (!r) throw new Error("sin fila de total");
        return r;
      });
      expect(celdas(total).map((c) => c.trim())).toContain("0.30");
      expect(resumen.textContent).not.toMatch(/0\.30000000000000004/);
    });

    it("una venta USD sin tipo de cambio: el aviso del servidor se muestra", async () => {
      await montar({ estado: { resumen: RESUMEN_CON_USD_SIN_TC } });
      expect(await screen.findByText(M.avisoUsdSinTipoCambio)).toBeTruthy();
    });

    it("sin el aviso del servidor no se muestra el de USD", async () => {
      await montar();
      await region("Resumen");
      await vi.waitFor(() => filaDeTipo(document.body, "03"));
      await asentar();
      expect(screen.queryByText(M.avisoUsdSinTipoCambio)).toBeNull();
    });
  });

  describe("correlatividad (RF-053, D7, CA-6)", () => {
    it("alerta «Falta B001-291» con Justificar y Agregar venta; serie completa, rango y no evaluable por separado", async () => {
      await montar();
      const region_ = await region("Correlatividad");
      const b001 = await vi.waitFor(() =>
        grupoSerie(region_, "03", "B001"),
      );
      const item = faltante(b001, M.faltaUno("B001-291"));
      expect(within(item).getByRole("button", { name: M.justificar })).toBeTruthy();
      expect(
        within(item).getByRole("button", { name: M.agregarVenta }),
      ).toBeTruthy();

      expect(
        within(grupoSerie(region_, "01", "F001")).getByText(
          M.numeracionCompleta,
        ),
      ).toBeTruthy();
      expect(
        within(grupoSerie(region_, "03", "B003")).getByText(
          M.faltaRango("B003-402", "B003-404"),
        ),
      ).toBeTruthy();
      expect(
        within(grupoSerie(region_, "01", "F002")).getByText(M.noEvaluable),
      ).toBeTruthy();
      expect(within(region_).getByText(M.porRevisar(2))).toBeTruthy();
    });

    it("un salto enorme se muestra como rango, sin expandir los números", async () => {
      await montar({ estado: { correlatividad: CORRELATIVIDAD_ENORME } });
      const region_ = await region("Correlatividad");
      const grupo = await vi.waitFor(() => grupoSerie(region_, "03", "B009"));
      expect(
        within(grupo).getByText(M.faltaRango("B009-2", "B009-99999998")),
      ).toBeTruthy();
      expect(within(grupo).queryAllByRole("listitem").length).toBeLessThan(10);
      expect(region_.textContent).not.toContain("B009-50000");
    });

    it("un salto justificado muestra «Justificado» con su comentario, ya no cuenta ni ofrece acciones", async () => {
      await montar({ estado: { correlatividad: CORRELATIVIDAD_JUSTIFICADA } });
      const region_ = await region("Correlatividad");
      const b001 = await vi.waitFor(() => grupoSerie(region_, "03", "B001"));
      expect(within(b001).getByText(M.justificado)).toBeTruthy();
      expect(within(b001).getByText(COMENTARIO_JUSTIFICADO)).toBeTruthy();
      expect(within(b001).queryByRole("button", { name: M.justificar })).toBeNull();
      expect(
        within(b001).queryByRole("button", { name: M.agregarVenta }),
      ).toBeNull();
      expect(within(region_).getByText(M.porRevisar(1))).toBeTruthy();
    });

    it("un salto justificado en parte sigue alertando y se puede justificar", async () => {
      await montar({ estado: { correlatividad: CORRELATIVIDAD_PARCIAL } });
      const region_ = await region("Correlatividad");
      const b001 = await vi.waitFor(() => grupoSerie(region_, "03", "B001"));
      expect(within(b001).getByText(M.justificadoEnParte)).toBeTruthy();
      expect(within(b001).getByRole("button", { name: M.justificar })).toBeTruthy();
      expect(within(region_).getByText(M.porRevisar(1))).toBeTruthy();
    });
  });

  describe("justificar (HU-12, D8, CA-7)", () => {
    const abrir = async () => {
      const user = userEvent.setup();
      const region_ = await region("Correlatividad");
      const item = await vi.waitFor(() =>
        faltante(grupoSerie(region_, "03", "B001"), M.faltaUno("B001-291")),
      );
      await user.click(within(item).getByRole("button", { name: M.justificar }));
      const form = await screen.findByRole("form", {
        name: M.formularioJustificar,
      });
      return { user, form, region_ };
    };

    it("pide comentario: sin él no llama a la API y avisa", async () => {
      const f = await montar();
      const { user, form } = await abrir();
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      expect((await screen.findByRole("alert")).textContent).toContain(
        M.comentarioRequerido,
      );
      await asentar();
      expect(f.de(POST_JUSTIFICAR)).toHaveLength(0);
    });

    it("el comentario admite hasta 500 caracteres: 501 no se envía y 500 sí", async () => {
      const f = await montar({
        extra: { [POST_JUSTIFICAR]: { status: 201, cuerpo: { id: uuidDe(30, 1) } } },
      });
      const { user, form } = await abrir();
      const comentario = within(form).getByLabelText(M.etiquetaComentario);
      fireEvent.change(comentario, { target: { value: "a".repeat(501) } });
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      await screen.findByRole("alert");
      await asentar();
      expect(f.de(POST_JUSTIFICAR)).toHaveLength(0);
      fireEvent.change(comentario, { target: { value: "a".repeat(500) } });
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      await vi.waitFor(() => expect(f.de(POST_JUSTIFICAR)).toHaveLength(1));
    });

    it("guarda el comentario, recarga la correlatividad y el salto queda «Justificado» sin contar", async () => {
      const f = await montar({
        extra: (estado) => ({
          [POST_JUSTIFICAR]: () => {
            estado.correlatividad = CORRELATIVIDAD_JUSTIFICADA;
            return { status: 201, cuerpo: { id: uuidDe(30, 1) } };
          },
        }),
      });
      const { user, form, region_ } = await abrir();
      await user.type(
        within(form).getByLabelText(M.etiquetaComentario),
        COMENTARIO_JUSTIFICADO,
      );
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      await vi.waitFor(() => expect(f.de(POST_JUSTIFICAR)).toHaveLength(1));
      const llamada = f.de(POST_JUSTIFICAR)[0]!;
      expect(llamada.body).toEqual({
        tipo: "03",
        serie: "B001",
        desde: 291,
        hasta: 291,
        comentario: COMENTARIO_JUSTIFICADO,
      });
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");

      await vi.waitFor(() =>
        expect(f.lecturas("/correlatividad")).toHaveLength(2),
      );
      const b001 = await vi.waitFor(() => {
        const g = grupoSerie(region_, "03", "B001");
        within(g).getByText(M.justificado);
        return g;
      });
      expect(within(b001).getByText(COMENTARIO_JUSTIFICADO)).toBeTruthy();
      expect(within(region_).getByText(M.porRevisar(1))).toBeTruthy();
      expect(
        screen.queryByRole("form", { name: M.formularioJustificar }),
      ).toBeNull();
    });

    it("un rango se justifica completo (B003-402 a B003-404)", async () => {
      const f = await montar({
        extra: { [POST_JUSTIFICAR]: { status: 201, cuerpo: { id: uuidDe(30, 2) } } },
      });
      const user = userEvent.setup();
      const region_ = await region("Correlatividad");
      const item = await vi.waitFor(() =>
        faltante(
          grupoSerie(region_, "03", "B003"),
          M.faltaRango("B003-402", "B003-404"),
        ),
      );
      await user.click(within(item).getByRole("button", { name: M.justificar }));
      const form = await screen.findByRole("form", {
        name: M.formularioJustificar,
      });
      await user.type(within(form).getByLabelText(M.etiquetaComentario), "Serie anulada");
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      await vi.waitFor(() => expect(f.de(POST_JUSTIFICAR)).toHaveLength(1));
      expect(f.de(POST_JUSTIFICAR)[0]!.body).toEqual({
        tipo: "03",
        serie: "B003",
        desde: 402,
        hasta: 404,
        comentario: "Serie anulada",
      });
    });

    it("«Cancelar» cierra el formulario sin llamar a la API", async () => {
      const f = await montar();
      const { user, form } = await abrir();
      await user.click(within(form).getByRole("button", { name: M.cancelar }));
      expect(
        screen.queryByRole("form", { name: M.formularioJustificar }),
      ).toBeNull();
      expect(f.de(POST_JUSTIFICAR)).toHaveLength(0);
    });

    it.each([
      [400, { codigo: "datos_invalidos" }, M.justificarInvalido],
      [403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
      [409, { codigo: "cliente_archivado" }, MENSAJES_CLIENTES.clienteArchivado],
      [500, {}, MENSAJES_ACCESO.errorGeneral],
    ])("error %i del servidor: mensaje en un alert y el formulario sigue abierto", async (status, cuerpo, mensaje) => {
      await montar({ extra: { [POST_JUSTIFICAR]: { status, cuerpo } } });
      const { user, form } = await abrir();
      await user.type(within(form).getByLabelText(M.etiquetaComentario), "Motivo");
      await user.click(within(form).getByRole("button", { name: M.guardar }));
      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toContain(mensaje);
      expect(
        screen.getByRole("form", { name: M.formularioJustificar }),
      ).toBeTruthy();
    });
  });

  describe("agregar venta (RF-055, D9, CA-8)", () => {
    const abrir = async () => {
      const user = userEvent.setup();
      const region_ = await region("Correlatividad");
      const item = await vi.waitFor(() =>
        faltante(grupoSerie(region_, "03", "B001"), M.faltaUno("B001-291")),
      );
      await user.click(within(item).getByRole("button", { name: M.agregarVenta }));
      const form = await screen.findByRole("form", { name: M.formularioAgregar });
      return { user, form };
    };
    const campo = (form: HTMLElement, etiqueta: string) =>
      within(form).getByLabelText(etiqueta) as HTMLInputElement;
    async function escribir(
      user: ReturnType<typeof userEvent.setup>,
      form: HTMLElement,
      etiqueta: string,
      valor: string,
    ) {
      const el = campo(form, etiqueta);
      await user.clear(el);
      if (valor !== "") await user.type(el, valor);
    }
    /** Una venta de la 291 que cuadra: 100.00 + 18.00 = 118.00. */
    async function llenarValida(
      user: ReturnType<typeof userEvent.setup>,
      form: HTMLElement,
    ) {
      fireEvent.change(campo(form, M.campos.fecha), {
        target: { value: "2026-10-05" },
      });
      await escribir(user, form, M.campos.baseGravada, "100.00");
      await escribir(user, form, M.campos.igv, "18.00");
      await escribir(user, form, M.campos.total, "118.00");
    }
    const enviar = (form: HTMLElement) =>
      userEvent
        .setup()
        .click(within(form).getByRole("button", { name: M.agregar }));

    it("se abre con tipo, serie y número del salto, y los montos en «0.00»", async () => {
      await montar();
      const { form } = await abrir();
      expect(campo(form, M.campos.tipo).value).toBe("03");
      expect(campo(form, M.campos.serie).value).toBe("B001");
      expect(campo(form, M.campos.numero).value).toBe("291");
      for (const e of [
        M.campos.baseGravada,
        M.campos.igv,
        M.campos.exonerada,
        M.campos.inafecta,
        M.campos.isc,
        M.campos.icbper,
        M.campos.otros,
        M.campos.total,
      ]) {
        expect(campo(form, e).value).toBe("0.00");
      }
      expect(campo(form, M.campos.documento).value).toBe("-");
      // PEN por defecto: no hay tipo de cambio que pedir.
      expect(within(form).queryByLabelText(M.campos.tipoCambio)).toBeNull();
    });

    it("envía la venta con los montos como cadenas, cumple el esquema de shared y recarga grilla, resumen y correlatividad", async () => {
      const f = await montar({
        extra: (estado) => ({
          [POST_AGREGAR]: () => {
            estado.correlatividad = CORRELATIVIDAD_CON_291;
            estado.pagina = paginaDe([V290, V_MANUAL, V292]);
            return { status: 201, cuerpo: V_MANUAL };
          },
        }),
      });
      const { user, form } = await abrir();
      await llenarValida(user, form);
      await enviar(form);
      await vi.waitFor(() => expect(f.de(POST_AGREGAR)).toHaveLength(1));
      const llamada = f.de(POST_AGREGAR)[0]!;
      expect(llamada.body).toMatchObject({
        tipo: "03",
        serie: "B001",
        numero: "291",
        fechaEmision: "2026-10-05",
        docContraparte: "-",
        moneda: "PEN",
        baseGravada: "100.00",
        igv: "18.00",
        exonerada: "0.00",
        inafecta: "0.00",
        isc: "0.00",
        icbper: "0.00",
        otros: "0.00",
        total: "118.00",
      });
      expect(llamada.body as object).not.toHaveProperty("tipoCambio");
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");
      // Contrato con T11: el esquema de agregar se llama `ventaAgregarSchema` (nombre fijado por las pruebas de T4;
      // T11 cambió aquí solo el nombre importado, que era `agregarVentaSchema`; ninguna aserción se tocó).
      const esquema = (
        shared as unknown as Record<
          string,
          { safeParse: (v: unknown) => { success: boolean } } | undefined
        >
      )["ventaAgregarSchema"];
      expect(esquema, "falta ventaAgregarSchema en @contapp/shared").toBeDefined();
      expect(esquema!.safeParse(llamada.body).success).toBe(true);

      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
      await vi.waitFor(() => expect(f.lecturas("/resumen")).toHaveLength(2));
      await vi.waitFor(() =>
        expect(f.lecturas("/correlatividad")).toHaveLength(2),
      );
      expect(await screen.findByText(M.ventaAgregada)).toBeTruthy();
      expect(
        screen.queryByRole("form", { name: M.formularioAgregar }),
      ).toBeNull();
      const ventas = await ventasEsperadas();
      await vi.waitFor(() => fila(ventas, "B001-291"));
      const region_ = await region("Correlatividad");
      await vi.waitFor(() =>
        expect(within(region_).queryByText(M.faltaUno("B001-291"))).toBeNull(),
      );
    });

    it.each([
      ["tipo de 1 dígito", M.campos.tipo, "3"],
      ["serie de 5 caracteres", M.campos.serie, "B0012"],
      ["número vacío", M.campos.numero, ""],
      ["fecha vacía", M.campos.fecha, ""],
      ["monto con 3 decimales", M.campos.baseGravada, "100.123"],
      ["monto que no es número", M.campos.igv, "abc"],
    ])("%s: no llama a la API y avisa", async (_nombre, etiqueta, valor) => {
      const f = await montar();
      const { user, form } = await abrir();
      await llenarValida(user, form);
      if (etiqueta === M.campos.fecha) {
        fireEvent.change(campo(form, etiqueta), { target: { value: valor } });
      } else {
        await escribir(user, form, etiqueta, valor);
      }
      await enviar(form);
      expect((await screen.findByRole("alert")).textContent).toContain(
        M.datosInvalidos,
      );
      await asentar();
      expect(f.de(POST_AGREGAR)).toHaveLength(0);
    });

    it("en USD pide el tipo de cambio y lo envía como cadena; sin él no llama", async () => {
      const f = await montar({
        extra: { [POST_AGREGAR]: { status: 201, cuerpo: V_MANUAL } },
      });
      const { user, form } = await abrir();
      await llenarValida(user, form);
      await user.selectOptions(campo(form, M.campos.moneda), "USD");
      expect(campo(form, M.campos.tipoCambio)).toBeTruthy();
      await enviar(form);
      await screen.findByRole("alert");
      await asentar();
      expect(f.de(POST_AGREGAR)).toHaveLength(0);

      await escribir(user, form, M.campos.tipoCambio, "3.756");
      await enviar(form);
      await vi.waitFor(() => expect(f.de(POST_AGREGAR)).toHaveLength(1));
      expect(f.de(POST_AGREGAR)[0]!.body).toMatchObject({
        moneda: "USD",
        tipoCambio: "3.756",
      });
    });

    it("no suma en pantalla: un total que no cuadra se envía y decide el servidor (400)", async () => {
      const f = await montar({
        extra: {
          [POST_AGREGAR]: { status: 400, cuerpo: { codigo: "descuadre" } },
        },
      });
      const { user, form } = await abrir();
      await llenarValida(user, form);
      await escribir(user, form, M.campos.total, "999.00");
      await enviar(form);
      await vi.waitFor(() => expect(f.de(POST_AGREGAR)).toHaveLength(1));
      expect(f.de(POST_AGREGAR)[0]!.body).toMatchObject({ total: "999.00" });
      expect((await screen.findByRole("alert")).textContent).toContain(
        M.datosInvalidos,
      );
      expect(screen.getByRole("form", { name: M.formularioAgregar })).toBeTruthy();
    });

    it.each([
      [409, { codigo: "duplicado" }, M.ventaDuplicada],
      [409, { codigo: "cliente_archivado" }, MENSAJES_CLIENTES.clienteArchivado],
      [403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
      [500, {}, MENSAJES_ACCESO.errorGeneral],
    ])("error %i del servidor (%j): mensaje en un alert", async (status, cuerpo, mensaje) => {
      await montar({ extra: { [POST_AGREGAR]: { status, cuerpo } } });
      const { user, form } = await abrir();
      await llenarValida(user, form);
      await enviar(form);
      expect((await screen.findByRole("alert")).textContent).toContain(mensaje);
    });

    it("el botón general «Agregar venta manual» abre el formulario sin datos del salto", async () => {
      await montar();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: M.agregarVentaManual }),
      );
      const form = await screen.findByRole("form", { name: M.formularioAgregar });
      expect(campo(form, M.campos.numero).value).toBe("");
    });
  });

  describe("descarga (RF-050, HU-11, D14, CA-1, CA-2)", () => {
    const manejadorDescarga =
      (n: number, posicion = 3) =>
      (estado: EstadoVentas): Record<string, Manejador> => ({
        [POST_DESCARGAR]: () => {
          estado.trabajos = [trabajoDescarga(n, "en_cola", { posicion })];
          return { status: 202, cuerpo: { trabajoId: idTrabajo(n) } };
        },
      });

    const descargar = async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: M.descargar }));
      return user;
    };

    it("«Descargar» encola (POST sin cuerpo, con CSRF) y muestra el trabajo con su posición y el enlace al panel", async () => {
      const f = await montar({ extra: manejadorDescarga(1) });
      await descargar();
      await vi.waitFor(() => expect(f.de(POST_DESCARGAR)).toHaveLength(1));
      const llamada = f.de(POST_DESCARGAR)[0]!;
      expect(llamada.body).toBeUndefined();
      expect(llamada.headers["x-csrf-token"]).toBe("csrf-acceso-1");
      expect(llamada.headers["x-estudio"]).toBe("e-a");

      const descarga = await region("Descarga");
      expect(await within(descarga).findByText(M.enCola(3))).toBeTruthy();
      const enlace = within(descarga).getByRole("link", {
        name: MENSAJES_CREDENCIALES.enlacePanel,
      });
      expect(enlace.getAttribute("href")).toBe("/trabajos");
    });

    it("al avanzar el trabajo cambia la posición y luego «Ejecutando»", async () => {
      const f = await montar({ extra: manejadorDescarga(1) });
      await descargar();
      const descarga = await region("Descarga");
      await within(descarga).findByText(M.enCola(3));
      f.emitir(trabajoDescarga(1, "en_cola", { posicion: 1 }));
      expect(await within(descarga).findByText(M.enCola(1))).toBeTruthy();
      f.emitir(trabajoDescarga(1, "ejecutando"));
      expect(await within(descarga).findByText(M.ejecutando)).toBeTruthy();
    });

    it("al completar refresca la grilla, el resumen, la correlatividad y las propuestas, y muestra «N nuevos, M difieren»", async () => {
      const f = await montar({ extra: manejadorDescarga(1) });
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(1));
      await descargar();
      const descarga = await region("Descarga");
      await within(descarga).findByText(M.enCola(3));

      // El worker guardó 2 nuevas (B001-293 y B001-294) y la 290 difiere.
      f.estado.pagina = paginaDe([
        V290,
        V292,
        ventaDe({ numero: "293" }),
        ventaDe({ numero: "294" }),
      ]);
      f.estado.propuestas = [P3, P2];
      f.emitir(trabajoDescarga(1, "completado"));

      expect(
        await within(descarga).findByText(M.resumenDescarga(2, 1)),
      ).toBeTruthy();
      await vi.waitFor(() => expect(f.lecturas()).toHaveLength(2));
      await vi.waitFor(() => expect(f.lecturas("/resumen")).toHaveLength(2));
      await vi.waitFor(() =>
        expect(f.lecturas("/correlatividad")).toHaveLength(2),
      );
      await vi.waitFor(() => expect(f.lecturas("/propuestas")).toHaveLength(2));
      await vi.waitFor(() =>
        expect(f.lecturas(`/propuestas/${P3.id}/diferencias`)).toHaveLength(1),
      );
      const ventas = await ventasEsperadas();
      await vi.waitFor(() => fila(ventas, "B001-294"));
    });

    it.each([
      ["sunat_no_responde", M.motivosTrabajo.sunat_no_responde],
      ["credencial_invalida", M.motivosTrabajo.credencial_invalida],
    ])("trabajo con error %s: muestra el motivo y «Reintentar» encola de nuevo", async (motivo, texto) => {
      let veces = 0;
      const f = await montar({
        extra: (estado) => ({
          [POST_DESCARGAR]: () => {
            veces += 1;
            estado.trabajos = [trabajoDescarga(veces, "en_cola", { posicion: 2 })];
            return { status: 202, cuerpo: { trabajoId: idTrabajo(veces) } };
          },
        }),
      });
      await descargar();
      const descarga = await region("Descarga");
      await within(descarga).findByText(M.enCola(2));
      f.emitir(trabajoDescarga(1, "error", { motivo }));

      expect((await within(descarga).findByText(new RegExp(texto))).textContent).toContain(
        texto,
      );
      const user = userEvent.setup();
      await user.click(
        await within(descarga).findByRole("button", { name: M.reintentar }),
      );
      await vi.waitFor(() => expect(f.de(POST_DESCARGAR)).toHaveLength(2));
      expect(await within(descarga).findByText(M.enCola(2))).toBeTruthy();
      expect(within(descarga).queryByText(new RegExp(texto))).toBeNull();
      expect(
        within(descarga).queryByRole("button", { name: M.reintentar }),
      ).toBeNull();
    });

    it.each([
      [409, { codigo: "credencial_no_configurada" }, MENSAJES_CREDENCIALES.noConfigurada],
      [409, { codigo: "cliente_archivado" }, MENSAJES_CLIENTES.clienteArchivado],
      [403, { codigo: "prohibido" }, MENSAJES_ACCESO.sinPermiso],
      [500, {}, MENSAJES_ACCESO.errorGeneral],
    ])("el POST de descargar responde %i (%j): mensaje en un alert y ningún trabajo", async (status, cuerpo, mensaje) => {
      await montar({ extra: { [POST_DESCARGAR]: { status, cuerpo } } });
      await descargar();
      expect((await screen.findByRole("alert")).textContent).toContain(mensaje);
      const descarga = await region("Descarga");
      expect(within(descarga).queryByText(/En cola/)).toBeNull();
    });
  });

  describe("diferencias de la última descarga (D16, CA-11)", () => {
    it("lista los comprobantes que el SIRE trajo distintos, con el campo y el valor del SIRE", async () => {
      await montar();
      const diferencias = await region(M.tituloDiferencias);
      const f290 = await vi.waitFor(() => fila(diferencias, "B001-290"));
      expect(f290.textContent).toMatch(/total/i);
      expect(f290.textContent).toContain("236.00");
    });

    it("sin descargas todavía lo dice y no pide diferencias", async () => {
      const f = await montar({ estado: { propuestas: [] } });
      expect(await screen.findByText(M.sinDescargas)).toBeTruthy();
      await asentar();
      expect(
        f.llamadas.filter((l) => l.ruta.endsWith("/diferencias")),
      ).toHaveLength(0);
    });

    it("el texto del SIRE de las diferencias también se escapa", async () => {
      await montar({
        estado: {
          diferencias: {
            [P2.id]: [
              {
                ...DIFERENCIA_290,
                campos: ["docContraparte"],
                valoresSire: { docContraparte: TEXTO_HOSTIL },
              },
            ],
          },
        },
      });
      const diferencias = await region(M.tituloDiferencias);
      const f = await vi.waitFor(() => fila(diferencias, "B001-290"));
      expect(f.textContent).toContain(TEXTO_HOSTIL);
      expect(document.querySelector("img")).toBeNull();
    });
  });

  it("las filas de otro tipo (nota de crédito) se muestran con su signo", async () => {
    await montar({ estado: { pagina: paginaDe([V290, V_NC]) } });
    const ventas = await ventasEsperadas();
    const nc = await vi.waitFor(() => fila(ventas, "FC01-1"));
    expect(nc.textContent).toContain("-59.00");
  });
});

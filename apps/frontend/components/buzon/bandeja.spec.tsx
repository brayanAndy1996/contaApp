import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { MENSAJES_ACCESO, celdas } from "../../pruebas/acceso";
import {
  CLIENTE_A,
  CLIENTE_B,
  FILA_CLIENTE,
  MENSAJES_BANDEJA as B,
  NOMBRE_A,
  NOMBRE_B,
  PERMISOS_ATENDER,
  PERMISOS_TODOS,
  PERMISOS_VER,
  RUTA_BANDEJA,
  RUTA_LOTE,
  atendidaPor,
  detalleConAtencion,
  filaBandeja,
  filasPendientes,
  paginaDeCliente,
  paginaGlobal,
  queryDe,
  rutaDetalleDe,
  rutaMensajesDe,
  rutasBase,
  simularPantalla,
} from "../../pruebas/bandeja";
import { MENSAJES_BUZON as M } from "../../pruebas/buzon";
import { uuidDe } from "../../pruebas/compras";
import { estadoCredencialDe } from "../../pruebas/credenciales";
import { instalarFetchFalso, type FetchFalso, type Manejador } from "../../pruebas/soporte";

vi.mock("next/navigation", async () => import("../../pruebas/navegacion"));

import { navegacion } from "../../pruebas/navegacion";
import { Bandeja } from "./bandeja";

// Spec 024 · T5 (rojo; D-2 a D-4, D-10, CA-1 a CA-3, CA-7, CA-11). Contenedor de la bandeja de buzones.
// Contrato (T9), `components/buzon/bandeja.tsx`: <Bandeja clienteFijo?={{id: string, archivado: boolean}} />.
//   Los filtros viven en la URL (`useSearchParams` + `router.push/replace`) con los mismos nombres que la API:
//   `atencion`, `categoria`, `leido`, `desde`, `hasta`, `responsable=yo`, `archivados=1` (y `mensaje=<id>`, que no es
//   un filtro y nunca se manda a la lista). Un parámetro desconocido o con valor inválido se ignora (la API daría 400).
//   - Global (`/buzon`): lee GET /api/buzon/mensajes → {mensajes, siguiente}. Fijada (`clienteFijo`, `/clientes/:id/buzon`):
//     lee GET /api/clientes/:id/buzon/mensajes → {estado, mensajes, siguiente}, sin `responsable` ni `archivados`, con
//     `RevisarBuzon` (023) arriba y sin la columna «Cliente».
//   - Abre en «Pendientes» (`atencion=pendientes` aunque la URL no diga nada); chips rápidos «Pendientes» y «Críticos
//     pendientes» (botones con `aria-pressed`; el segundo es `atencion=pendientes&categoria=criticos`); `FiltrosBandeja`;
//     `ListaMensajes`; «Cargar más» con `siguiente` (mismo filtro + `cursor`); cambiar un filtro vuelve a la primera página.
//   - Con `buzon.atender`: casillas por fila y `AtenderLote`; tras el lote, la lista se vuelve a leer y la selección se limpia.
//   - Elegir un cliente en el filtro navega a `/clientes/:id/buzon`; «Todos los clientes», a `/buzon`.
//   - `?mensaje=<id>` abre el detalle (`DetalleMensaje`) aunque el mensaje no esté en la página cargada. A 390 px el
//     detalle ocupa la pantalla con un «Volver» que quita `mensaje` de la URL; en escritorio, lista y detalle a la vez.
//   - Se vuelve a leer al volver a la pestaña (`visibilitychange` con la pestaña visible).
//   - Solo components/ui y tokens; nada de `dangerouslySetInnerHTML`.

const CRITICO = filaBandeja({ id: uuidDe(24, 20), asunto: "Resolución Coactiva N° 0150140012345" });
const COMUN = filaBandeja({
  id: uuidDe(24, 21),
  asunto: "Comunicado general",
  categoria: "otro",
  critico: false,
  motivoCritico: null,
  cliente: FILA_CLIENTE.B,
});
const ATENDIDO = filaBandeja({
  id: uuidDe(24, 22),
  asunto: "Ya gestionado",
  categoria: "otro",
  critico: false,
  motivoCritico: null,
  atencion: atendidaPor(),
});

beforeEach(() => {
  reiniciarSesion();
  navegacion.reiniciar("/buzon");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Opciones = {
  url?: string;
  permisos?: string[];
  pagina?: Manejador;
  fijada?: boolean;
  archivada?: boolean;
  extra?: Record<string, Manejador>;
};

function montar(o: Opciones = {}) {
  const fijada = o.fijada ?? false;
  const ruta = fijada ? rutaMensajesDe(CLIENTE_A) : RUTA_BANDEJA;
  const pagina: Manejador =
    o.pagina ?? { status: 200, cuerpo: fijada ? paginaDeCliente([CRITICO, COMUN, ATENDIDO]) : paginaGlobal([CRITICO, COMUN, ATENDIDO]) };
  navegacion.reiniciar(o.url ?? (fijada ? `/clientes/${CLIENTE_A}/buzon` : "/buzon"));
  const f = instalarFetchFalso(
    rutasBase(o.permisos ?? PERMISOS_ATENDER, {
      [ruta]: pagina,
      [`GET /api/clientes/${CLIENTE_A}/credenciales`]: {
        status: 200,
        cuerpo: [estadoCredencialDe("sol", "verificada"), estadoCredencialDe("sire_api", "no_configurada")],
      },
      ...o.extra,
    }),
  );
  render(<Bandeja clienteFijo={fijada ? { id: CLIENTE_A, archivado: o.archivada ?? false } : undefined} />);
  return { f, ruta, usuario: userEvent.setup() };
}

const consultas = (f: FetchFalso, ruta: string) => f.de(ruta).map((l) => queryDe(l.url));
const ultima = (f: FetchFalso, ruta: string) => consultas(f, ruta).at(-1);
const filaDe = (texto: string): HTMLElement => {
  const fila = screen.getAllByRole("row").find((r) => r.textContent?.includes(texto));
  if (!fila) throw new Error(`no hay fila con "${texto}"`);
  return fila;
};
const cargada = () => screen.findByText(CRITICO.asunto);

describe("<Bandeja /> · vista global (CA-1, CA-2)", () => {
  it("abre en «Pendientes»: pide atencion=pendientes aunque la URL no diga nada", async () => {
    const { f, ruta } = montar();
    await cargada();
    expect(consultas(f, ruta)[0]).toMatchObject({ atencion: "pendientes" });
    expect(screen.getByRole("button", { name: B.chipPendientes }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: B.chipCriticosPendientes }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: B.tituloGlobal })).toBeTruthy();
  });

  it("cada fila trae el cliente, el asunto y la atención; el crítico dice «Crítico · Coactiva»", async () => {
    montar();
    await cargada();
    expect(celdas(filaDe(CRITICO.asunto)).join("|")).toContain(NOMBRE_A);
    expect(celdas(filaDe(COMUN.asunto)).join("|")).toContain(NOMBRE_B);
    expect(within(filaDe(CRITICO.asunto)).getByText("Crítico · Coactiva")).toBeTruthy();
    expect(within(filaDe(ATENDIDO.asunto)).getByText(B.estado.atendido)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: B.columnaCliente })).toBeTruthy();
  });

  it("«Críticos pendientes» filtra en un toque y lo deja en la URL", async () => {
    const { f, ruta, usuario } = montar();
    await cargada();
    await usuario.click(screen.getByRole("button", { name: B.chipCriticosPendientes }));
    await vi.waitFor(() => expect(ultima(f, ruta)).toMatchObject({ atencion: "pendientes", categoria: "criticos" }));
    expect(navegacion.parametros()).toMatchObject({ atencion: "pendientes", categoria: "criticos" });
    expect(screen.getByRole("button", { name: B.chipCriticosPendientes }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: B.chipPendientes }).getAttribute("aria-pressed")).toBe("false");
    // y «Pendientes» quita la categoría
    await usuario.click(screen.getByRole("button", { name: B.chipPendientes }));
    await vi.waitFor(() => expect(ultima(f, ruta)?.categoria).toBeUndefined());
    expect(ultima(f, ruta)).toMatchObject({ atencion: "pendientes" });
  });

  it("los filtros de la URL se mandan a la API y se ven en los controles", async () => {
    const { f, ruta } = montar({
      url: "/buzon?atencion=atendidos&categoria=coactiva&leido=no&desde=2026-11-01&hasta=2026-11-15&responsable=yo&archivados=1",
    });
    await vi.waitFor(() => expect(f.de(ruta).length).toBeGreaterThan(0));
    expect(consultas(f, ruta)[0]).toMatchObject({
      atencion: "atendidos",
      categoria: "coactiva",
      leido: "no",
      desde: "2026-11-01",
      hasta: "2026-11-15",
      responsable: "yo",
      archivados: "1",
    });
    expect((screen.getByLabelText(B.filtroAtencion) as HTMLSelectElement).value).toBe("atendidos");
    expect((screen.getByRole("checkbox", { name: B.filtroResponsable }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: B.filtroArchivados }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: B.chipPendientes }).getAttribute("aria-pressed")).toBe("false");
  });

  it("cambiar un filtro actualiza la URL y vuelve a pedir la primera página", async () => {
    const { f, ruta, usuario } = montar();
    await cargada();
    await usuario.selectOptions(screen.getByLabelText(B.filtroAtencion), "todos");
    await vi.waitFor(() => expect(ultima(f, ruta)).toMatchObject({ atencion: "todos" }));
    expect(navegacion.parametros().atencion).toBe("todos");
    expect(ultima(f, ruta)?.cursor).toBeUndefined();
    await usuario.click(screen.getByRole("checkbox", { name: B.filtroArchivados }));
    await vi.waitFor(() => expect(ultima(f, ruta)).toMatchObject({ atencion: "todos", archivados: "1" }));
    await usuario.click(screen.getByRole("checkbox", { name: B.filtroResponsable }));
    await vi.waitFor(() => expect(ultima(f, ruta)).toMatchObject({ responsable: "yo" }));
  });

  it("ignora lo que no es un filtro válido: parámetros desconocidos, valores inválidos y `mensaje`", async () => {
    const { f, ruta } = montar({ url: "/buzon?foo=1&atencion=cualquiera&categoria=inventada&leido=quizas&desde=ayer&mensaje=x&cursor=zzz" });
    await vi.waitFor(() => expect(f.de(ruta).length).toBeGreaterThan(0));
    const q = consultas(f, ruta)[0]!;
    expect(q.atencion).toBe("pendientes");
    for (const clave of ["foo", "categoria", "leido", "desde", "mensaje", "cursor"]) expect(q).not.toHaveProperty(clave);
  });

  it("«Cargar más» pide la página siguiente con el mismo filtro y suma las filas; sin `siguiente` no hay botón", async () => {
    const extra = filaBandeja({ id: uuidDe(24, 30), asunto: "De la segunda página", categoria: "otro", critico: false, motivoCritico: null });
    const { f, ruta, usuario } = montar({
      url: "/buzon?categoria=criticos",
      pagina: (l) =>
        queryDe(l.url).cursor === "cur-1"
          ? { status: 200, cuerpo: paginaGlobal([extra], null) }
          : { status: 200, cuerpo: paginaGlobal([CRITICO], "cur-1") },
    });
    await cargada();
    await usuario.click(screen.getByRole("button", { name: M.cargarMas }));
    expect(await screen.findByText("De la segunda página")).toBeTruthy();
    expect(screen.getByText(CRITICO.asunto)).toBeTruthy();
    expect(ultima(f, ruta)).toMatchObject({ cursor: "cur-1", atencion: "pendientes", categoria: "criticos" });
    expect(screen.queryByRole("button", { name: M.cargarMas })).toBeNull();
  });

  it("elegir un cliente en el filtro navega a su bandeja fijada", async () => {
    const { usuario } = montar();
    await cargada();
    const select = await screen.findByLabelText(B.filtroCliente);
    await vi.waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    await usuario.selectOptions(select, CLIENTE_B);
    expect(navegacion.destinos().at(-1)).toMatch(new RegExp(`^/clientes/${CLIENTE_B}/buzon(\\?|$)`));
  });

  it("no pinta «Revisar buzón ahora»: eso es de la bandeja de un cliente", async () => {
    montar();
    await cargada();
    expect(screen.queryByRole("button", { name: M.revisar })).toBeNull();
  });

  it("sin mensajes dice que no hay y no pinta filas de datos", async () => {
    montar({ pagina: { status: 200, cuerpo: paginaGlobal([]) } });
    expect(await screen.findByText(M.listaVacia)).toBeTruthy();
    expect(screen.queryAllByRole("row").filter((r) => r.querySelector("td"))).toHaveLength(0);
  });

  it.each([
    [500, M.errorCarga],
    [403, MENSAJES_ACCESO.sinPermiso],
  ])("%i al leer: aviso en español, sin lista", async (status, texto) => {
    montar({ pagina: { status, cuerpo: {} } });
    expect((await screen.findByRole("alert")).textContent).toContain(texto);
    expect(screen.queryByText(CRITICO.asunto)).toBeNull();
  });

  it("400 (filtro rechazado por la API) también avisa en español, sin el código", async () => {
    montar({ pagina: { status: 400, cuerpo: { codigo: "parametros_invalidos" } } });
    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).not.toContain("parametros_invalidos");
  });

  it("al volver a la pestaña (visible) se vuelve a leer; con la pestaña oculta, no", async () => {
    const { f, ruta } = montar();
    await cargada();
    const antes = f.de(ruta).length;
    let visible = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 50));
    expect(f.de(ruta).length).toBe(antes);
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(f.de(ruta).length).toBe(antes + 1));
    Reflect.deleteProperty(document, "visibilityState");
  });
});

describe("<Bandeja /> · atención en lote desde la lista (CA-6, CA-7)", () => {
  const TRES = filasPendientes(3, 243);

  it("con `buzon.atender`: una casilla por fila; sin él (Lectura), ninguna", async () => {
    montar({ pagina: { status: 200, cuerpo: paginaGlobal(TRES) } });
    await screen.findByText(TRES[0]!.asunto);
    await vi.waitFor(() => expect(screen.getAllByRole("checkbox", { name: /^Seleccionar / })).toHaveLength(3));
    cleanup();
    montar({ permisos: PERMISOS_VER, pagina: { status: 200, cuerpo: paginaGlobal(TRES) } });
    await screen.findByText(TRES[0]!.asunto);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("checkbox", { name: /^Seleccionar / })).toBeNull();
    expect(screen.queryByRole("button", { name: B.marcarLote })).toBeNull();
  });

  it("seleccionar dos y marcarlas: POST del lote con sus ids, la lista se vuelve a leer y la selección se limpia", async () => {
    let atendidos = false;
    const { f, ruta, usuario } = montar({
      pagina: () => ({ status: 200, cuerpo: paginaGlobal(atendidos ? [TRES[2]!] : TRES) }),
      extra: {
        [RUTA_LOTE]: () => {
          atendidos = true;
          return { status: 200, cuerpo: { atendidos: [TRES[0]!.id, TRES[1]!.id], omitidos: [] } };
        },
      },
    });
    await screen.findByText(TRES[0]!.asunto);
    await usuario.click(await screen.findByRole("checkbox", { name: B.seleccionar(TRES[0]!.asunto) }));
    await usuario.click(screen.getByRole("checkbox", { name: B.seleccionar(TRES[1]!.asunto) }));
    expect(await screen.findByText(B.seleccionados(2))).toBeTruthy();
    await usuario.click(screen.getByRole("button", { name: B.marcarLote }));
    await usuario.click(within(await screen.findByRole("dialog")).getByRole("button", { name: B.confirmar }));
    await vi.waitFor(() => expect(f.de(RUTA_LOTE)).toHaveLength(1));
    expect(f.de(RUTA_LOTE)[0]!.body).toEqual({ mensajes: [TRES[0]!.id, TRES[1]!.id] });
    await vi.waitFor(() => expect(f.de(ruta).length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(screen.queryByText(TRES[0]!.asunto)).toBeNull());
    expect(screen.getByText(TRES[2]!.asunto)).toBeTruthy();
    expect(screen.queryByText(B.seleccionados(2))).toBeNull();
  });

  it("cambiar de filtro limpia la selección", async () => {
    const { usuario } = montar({ pagina: { status: 200, cuerpo: paginaGlobal(TRES) } });
    await usuario.click(await screen.findByRole("checkbox", { name: B.seleccionar(TRES[0]!.asunto) }));
    expect(await screen.findByText(B.seleccionados(1))).toBeTruthy();
    await usuario.selectOptions(screen.getByLabelText(B.filtroAtencion), "todos");
    await vi.waitFor(() => expect(screen.queryByText(B.seleccionados(1))).toBeNull());
  });
});

describe("<Bandeja /> · bandeja fijada en un cliente (D-10, CA-2)", () => {
  it("lee la ruta del cliente, sin responsable ni archivados, y abre en «Pendientes»", async () => {
    const { f, ruta } = montar({ fijada: true, url: `/clientes/${CLIENTE_A}/buzon?responsable=yo&archivados=1&categoria=criticos` });
    await cargada();
    expect(f.de(RUTA_BANDEJA)).toHaveLength(0);
    const q = consultas(f, ruta)[0]!;
    expect(q).toMatchObject({ atencion: "pendientes", categoria: "criticos" });
    expect(q).not.toHaveProperty("responsable");
    expect(q).not.toHaveProperty("archivados");
  });

  it("muestra «Revisar buzón ahora» arriba, el cliente elegido en el filtro y no la columna «Cliente»", async () => {
    montar({ fijada: true });
    await cargada();
    expect(await screen.findByRole("button", { name: M.revisar })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: B.columnaCliente })).toBeNull();
    const select = screen.getByLabelText(B.filtroCliente) as HTMLSelectElement;
    expect(select.value).toBe(CLIENTE_A);
    expect(screen.queryByRole("checkbox", { name: B.filtroArchivados })).toBeNull();
  });

  it("«Todos los clientes» vuelve a la bandeja global", async () => {
    const { usuario } = montar({ fijada: true });
    await cargada();
    const select = await screen.findByLabelText(B.filtroCliente);
    await vi.waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    await usuario.selectOptions(select, "");
    expect(navegacion.destinos().at(-1)).toMatch(/^\/buzon(\?|$)/);
  });

  it("`?mensaje=<id>` abre el detalle aunque el mensaje no esté en la página cargada", async () => {
    const lejano = uuidDe(24, 77);
    const { f } = montar({
      fijada: true,
      url: `/clientes/${CLIENTE_A}/buzon?mensaje=${lejano}`,
      extra: {
        [rutaDetalleDe(CLIENTE_A, lejano)]: {
          status: 200,
          cuerpo: detalleConAtencion({ id: lejano, asunto: "Mensaje de la campana", categoria: "resolucion_multa" }),
        },
      },
      permisos: PERMISOS_TODOS,
    });
    expect(await screen.findByText("Mensaje de la campana")).toBeTruthy();
    expect(f.de(rutaDetalleDe(CLIENTE_A, lejano)).length).toBeGreaterThanOrEqual(1);
    // la lista sigue visible al costado en escritorio y no depende de ese mensaje
    expect(await screen.findByText(CRITICO.asunto)).toBeTruthy();
    expect(queryDe(f.de(rutaMensajesDe(CLIENTE_A))[0]!.url)).not.toHaveProperty("mensaje");
  });

  it("un cliente archivado: se lee la bandeja pero sus filas no se pueden seleccionar (U-1)", async () => {
    const filas = filasPendientes(2, 244).map((fila) => ({ ...fila, cliente: { ...fila.cliente, archivado: true } }));
    montar({ fijada: true, archivada: true, pagina: { status: 200, cuerpo: paginaDeCliente(filas) } });
    await screen.findByText(filas[0]!.asunto);
    await vi.waitFor(() => expect(screen.getAllByRole("checkbox", { name: /^Seleccionar / })).toHaveLength(2));
    for (const casilla of screen.getAllByRole("checkbox", { name: /^Seleccionar / })) {
      expect((casilla as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getAllByText(M.archivado).length).toBeGreaterThan(0);
  });
});

describe("<Bandeja /> · 390 px (D-10, CA-11)", () => {
  it("los filtros pasan a un Dialog («Filtros» → «Aplicar») y los chips rápidos siguen a la vista", async () => {
    simularPantalla("movil");
    const { f, ruta, usuario } = montar();
    await cargada();
    expect(screen.queryByLabelText(B.filtroAtencion)).toBeNull();
    expect(screen.getByRole("button", { name: B.chipCriticosPendientes })).toBeTruthy();
    await usuario.click(screen.getByRole("button", { name: B.abrirFiltros }));
    const dialogo = await screen.findByRole("dialog");
    await usuario.selectOptions(within(dialogo).getByLabelText(B.filtroCategoria), "coactiva");
    expect(ultima(f, ruta)?.categoria).toBeUndefined();
    await usuario.click(within(dialogo).getByRole("button", { name: B.aplicar }));
    await vi.waitFor(() => expect(ultima(f, ruta)).toMatchObject({ categoria: "coactiva" }));
    expect(navegacion.parametros().categoria).toBe("coactiva");
  });

  it("el detalle ocupa la pantalla con «Volver», que quita `mensaje` de la URL", async () => {
    simularPantalla("movil");
    const { usuario } = montar({
      fijada: true,
      url: `/clientes/${CLIENTE_A}/buzon?mensaje=${CRITICO.id}`,
      permisos: PERMISOS_TODOS,
      extra: {
        [rutaDetalleDe(CLIENTE_A, CRITICO.id)]: { status: 200, cuerpo: detalleConAtencion({ id: CRITICO.id }) },
      },
    });
    expect(await screen.findByText("Texto del mensaje.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await usuario.click(screen.getAllByText(new RegExp(`^${B.volver}`))[0]!);
    expect(navegacion.destinos().at(-1)).toBe(`/clientes/${CLIENTE_A}/buzon`);
  });

  it("en escritorio no hay botón «Filtros» y la lista y el detalle conviven", async () => {
    simularPantalla("escritorio");
    montar({
      fijada: true,
      url: `/clientes/${CLIENTE_A}/buzon?mensaje=${CRITICO.id}`,
      permisos: PERMISOS_TODOS,
      extra: {
        [rutaDetalleDe(CLIENTE_A, CRITICO.id)]: { status: 200, cuerpo: detalleConAtencion({ id: CRITICO.id }) },
      },
    });
    expect(await screen.findByText("Texto del mensaje.")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByRole("button", { name: B.abrirFiltros })).toBeNull();
  });
});

describe("<Bandeja /> · fuente", () => {
  it("el archivo no usa dangerouslySetInnerHTML ni innerHTML", () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(aqui, "bandeja.tsx"), "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

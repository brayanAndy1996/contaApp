import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../../../../lib/sesion";
import type { OpcionesSeguimiento } from "../../../../../lib/trabajos";
import {
  BASE,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  PERIODO,
  PERMISOS,
  instalarFetchCompras,
  montosDe,
  resumenDe,
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
  o: OpcionesCompras & { periodo?: string | null } = {},
): Promise<FetchCompras> {
  const periodo = o.periodo === undefined ? PERIODO : o.periodo;
  busqueda.actual = new URLSearchParams(periodo ? `periodo=${periodo}` : "");
  const f = instalarFetchCompras({
    permisos: o.permisos,
    cliente: o.cliente,
    estado: { ...estadoBase(), ...o.estado },
    extra: o.extra,
  });
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
              cuerpo: { estado: "abierto", por: USUARIO, en: "2026-11-06T10:00:00.000Z" },
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
});

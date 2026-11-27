import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../lib/sesion";
import { asentar, yoDe } from "../../../../pruebas/acceso";
import {
  crearRouterFalso,
  instalarFetchFalso,
  sesionDe,
  type Llamada,
  type Manejador,
  type RespuestaSimulada,
} from "../../../../pruebas/soporte";

// La URL es la fuente de los filtros: `useSearchParams` es reactivo y `router.replace`/`push` la actualizan.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const nav = vi.hoisted(() => {
  const oyentes = new Set<() => void>();
  const estado = { query: "" };
  return {
    estado,
    oyentes,
    ir(url: string) {
      const i = url.indexOf("?");
      estado.query = i === -1 ? "" : url.slice(i + 1);
      oyentes.forEach((o) => o());
    },
  };
});
vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    useRouter: () => router,
    usePathname: () => "/configuracion/auditoria",
    useSearchParams: () => {
      const q = React.useSyncExternalStore(
        (o) => {
          nav.oyentes.add(o);
          return () => nav.oyentes.delete(o);
        },
        () => nav.estado.query,
        () => nav.estado.query,
      );
      return React.useMemo(() => new URLSearchParams(q), [q]);
    },
  };
});

import PaginaAuditoria from "./page";

// Spec 031 T4 (CA-10; P-1 a P-3; nivel B): filtros de la auditoría en la URL con los mismos nombres de la API
// (`usuarioId`, `clienteId`, `accion` repetida, `desde`, `hasta`) más `todo=1`. Contrato de pantalla que fija T8:
// - Etiquetas: select «Usuario»; campo «Cliente» (búsqueda en `GET /api/auditoria/opciones?q=`, resultados con
//   role=option); grupo «Acciones» con un checkbox por acción (texto en español del catálogo); inputs «Desde» y
//   «Hasta» (type=date) y checkbox «Todo el historial».
// - Sin `desde`/`hasta` ni `todo=1`: últimos 30 días en hora de Lima (hoy − 29 → hoy). `todo=1` quita ambos.
// - Cambiar un filtro actualiza la URL y descarta el cursor; «Cargar más» lo envía sin tocar la URL.

const ESTUDIO = { id: "e-a", nombre: "Estudio Alfa" };
const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const U3 = "00000000-0000-4000-8000-0000000000a3";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";

const OPCIONES = {
  miembros: [
    { id: U1, nombre: "Rosa Quispe", activo: true },
    { id: U2, nombre: "Beto Contador", activo: true },
    { id: U3, nombre: "Olga Baja", activo: false },
  ],
  clientes: [
    { id: C1, ruc: "20100000001", razonSocial: "Distribuidora Andina SAC", archivado: false },
    { id: C2, ruc: "20100000002", razonSocial: "Textiles Alfa SAC", archivado: true },
  ],
};

const fila = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  ocurridaEn: `2026-11-1${n}T15:00:00.000Z`,
  accion: "cliente.creado",
  actor: { tipo: "usuario", autor: { id: U1, nombre: "Rosa Quispe", activo: true }, trabajoId: null },
  cliente: { id: C1, ruc: "20100000001", razonSocial: "Distribuidora Andina SAC" },
  entidad: "cliente",
  entidadId: C1,
  datos: { origen: "manual" },
  objetivo: null,
  ...extra,
});

const PERMISOS_AUDITOR = ["auditoria.ver", "clientes.ver"];

function rutas(
  auditoria: Manejador,
  extra: Record<string, Manejador> = {},
  permisos: string[] = PERMISOS_AUDITOR,
): Record<string, Manejador> {
  return {
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    "GET /api/auditoria": auditoria,
    "GET /api/auditoria/opciones": { status: 200, cuerpo: OPCIONES },
    ...extra,
  };
}

const ok = (items: unknown[] = [fila(1)], siguiente: string | null = null): RespuestaSimulada => ({
  status: 200,
  cuerpo: { items, siguiente },
});

const params = (l: Llamada | undefined): URLSearchParams => new URL(l?.url ?? "/", "http://x").searchParams;
const urlActual = (): URLSearchParams => new URLSearchParams(nav.estado.query);

describe("configuracion/auditoria · filtros (spec 031)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    router.replace.mockImplementation(nav.ir);
    router.push.mockImplementation(nav.ir);
    nav.estado.query = "";
    reiniciarSesion();
    // 2026-11-28 03:00 UTC = 27-nov 22:00 en Lima: «hoy» es el 27, no el 28.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T03:00:00.000Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("P-2: sin filtros pide los últimos 30 días (hoy Lima − 29 → hoy) y los muestra en Desde/Hasta", async () => {
    const f = instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });

    const q = params(f.de("GET /api/auditoria")[0]);
    expect(q.get("desde")).toBe("2026-10-29");
    expect(q.get("hasta")).toBe("2026-11-27");
    expect(q.has("usuarioId")).toBe(false);
    expect(q.has("clienteId")).toBe(false);
    expect(q.has("accion")).toBe(false);
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("2026-10-29");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("2026-11-27");
    expect((screen.getByLabelText("Todo el historial") as HTMLInputElement).checked).toBe(false);
  });

  it("P-2: «todo=1» pide todo el historial, sin desde ni hasta, y marca la casilla", async () => {
    nav.estado.query = "todo=1";
    const f = instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });

    const q = params(f.de("GET /api/auditoria")[0]);
    expect(q.has("desde")).toBe(false);
    expect(q.has("hasta")).toBe(false);
    expect((screen.getByLabelText("Todo el historial") as HTMLInputElement).checked).toBe(true);
  });

  it("marcar «Todo el historial» pone todo=1 en la URL y vuelve a pedir sin fechas; desmarcar restituye los 30 días", async () => {
    const f = instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("Todo el historial"));
    await waitFor(() => expect(f.de("GET /api/auditoria")).toHaveLength(2));
    expect(urlActual().get("todo")).toBe("1");
    expect(params(f.de("GET /api/auditoria")[1]).has("desde")).toBe(false);

    await user.click(screen.getByLabelText("Todo el historial"));
    await waitFor(() => expect(f.de("GET /api/auditoria")).toHaveLength(3));
    expect(urlActual().has("todo")).toBe(false);
    expect(params(f.de("GET /api/auditoria")[2]).get("desde")).toBe("2026-10-29");
  });

  it("CA-10: los filtros de la URL sobreviven al recargar (usuario, cliente, acciones, fechas) y se pintan", async () => {
    nav.estado.query =
      `usuarioId=${U1}&clienteId=${C1}&accion=cliente.editado&accion=cliente.creado&desde=2026-11-01&hasta=2026-11-15`;
    const f = instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });

    const q = params(f.de("GET /api/auditoria")[0]);
    expect(q.get("usuarioId")).toBe(U1);
    expect(q.get("clienteId")).toBe(C1);
    expect(q.getAll("accion").sort()).toEqual(["cliente.creado", "cliente.editado"]);
    expect(q.get("desde")).toBe("2026-11-01");
    expect(q.get("hasta")).toBe("2026-11-15");
    expect(q.has("todo")).toBe(false);

    // Para pintar el cliente al recargar se pide con `clienteId` (D-6).
    await waitFor(() => expect(f.de("GET /api/auditoria/opciones").length).toBeGreaterThan(0));
    expect(f.de("GET /api/auditoria/opciones").some((l) => params(l).get("clienteId") === C1)).toBe(true);
    await waitFor(() =>
      expect((screen.getByLabelText("Cliente") as HTMLInputElement).value).toContain("Distribuidora Andina SAC"),
    );
    await waitFor(() => expect((screen.getByLabelText("Usuario") as HTMLSelectElement).value).toBe(U1));
    const acciones = screen.getByRole("group", { name: "Acciones" });
    expect((within(acciones).getByRole("checkbox", { name: "Editó un cliente" }) as HTMLInputElement).checked).toBe(true);
    expect((within(acciones).getByRole("checkbox", { name: "Creó un cliente" }) as HTMLInputElement).checked).toBe(true);
    expect((within(acciones).getByRole("checkbox", { name: "Archivó un cliente" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("2026-11-01");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("2026-11-15");
  });

  it("cambiar un filtro actualiza la URL, descarta el cursor y la selección sobrevive a un remonte", async () => {
    let vez = 0;
    const f = instalarFetchFalso(
      rutas(() => {
        vez += 1;
        return vez === 1 ? ok([fila(1)], "cur-1") : vez === 2 ? ok([fila(2)], "cur-2") : ok([fila(3)]);
      }),
    );
    render(<PaginaAuditoria />);
    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Cargar más" }));
    await waitFor(() => expect(f.de("GET /api/auditoria")).toHaveLength(2));
    expect(params(f.de("GET /api/auditoria")[1]).get("cursor")).toBe("cur-1");
    expect(urlActual().has("cursor")).toBe(false);

    await waitFor(() => expect((screen.getByLabelText("Usuario") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    await user.selectOptions(screen.getByLabelText("Usuario"), U2);
    await waitFor(() => expect(f.de("GET /api/auditoria")).toHaveLength(3));
    const q = params(f.de("GET /api/auditoria")[2]);
    expect(q.get("usuarioId")).toBe(U2);
    expect(q.has("cursor")).toBe(false);
    expect(urlActual().get("usuarioId")).toBe(U2);
    expect(urlActual().has("cursor")).toBe(false);
    // La página nueva reemplaza las filas acumuladas.
    await waitFor(() => expect(within(tabla).getAllByRole("row")).toHaveLength(2));

    cleanup();
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(params(f.de("GET /api/auditoria")[3]).get("usuarioId")).toBe(U2);
    await waitFor(() => expect((screen.getByLabelText("Usuario") as HTMLSelectElement).value).toBe(U2));
  });

  it("marcar acciones y fechas se refleja en la URL y en la petición (`accion` repetida)", async () => {
    const f = instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    const user = userEvent.setup();

    const acciones = screen.getByRole("group", { name: "Acciones" });
    await user.click(within(acciones).getByRole("checkbox", { name: "Creó un cliente" }));
    await user.click(within(acciones).getByRole("checkbox", { name: "Descifró una credencial" }));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-11-15" } });

    await waitFor(() => {
      const ultima = params(f.de("GET /api/auditoria").at(-1));
      expect(ultima.getAll("accion").sort()).toEqual(["cliente.creado", "credencial.descifrada"]);
      expect(ultima.get("desde")).toBe("2026-11-01");
      expect(ultima.get("hasta")).toBe("2026-11-15");
    });
    expect(urlActual().getAll("accion").sort()).toEqual(["cliente.creado", "credencial.descifrada"]);
    expect(urlActual().get("desde")).toBe("2026-11-01");
    expect(urlActual().get("hasta")).toBe("2026-11-15");
  });

  it("el cliente se busca en /opciones (q) y al elegirlo queda en la URL; el archivado va marcado", async () => {
    const f = instalarFetchFalso(
      rutas(ok(), {
        "GET /api/auditoria/opciones": (l) => ({
          status: 200,
          cuerpo: params(l).get("q") ? { miembros: OPCIONES.miembros, clientes: OPCIONES.clientes } : { miembros: OPCIONES.miembros, clientes: [] },
        }),
      }),
    );
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Cliente"), "alfa");
    await waitFor(() => expect(f.de("GET /api/auditoria/opciones").some((l) => params(l).get("q") === "alfa")).toBe(true));
    const archivado = await screen.findByRole("option", { name: /Textiles Alfa SAC.*archivado/i });
    expect(await screen.findByRole("option", { name: /Distribuidora Andina SAC/ })).toBeTruthy();

    await user.click(archivado);
    await waitFor(() => expect(urlActual().get("clienteId")).toBe(C2));
    await waitFor(() => expect(params(f.de("GET /api/auditoria").at(-1)).get("clienteId")).toBe(C2));
  });

  it("el usuario inactivo del selector se marca «(inactivo)» y el activo no", async () => {
    instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    const select = screen.getByLabelText("Usuario") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    const textos = [...select.options].map((o) => o.textContent);
    expect(textos).toContain("Olga Baja (inactivo)");
    expect(textos).toContain("Rosa Quispe");
    expect(textos).not.toContain("Rosa Quispe (inactivo)");
  });

  it("con filtro de usuario avisa que los descifrados no registran autor; sin él no hay aviso", async () => {
    nav.estado.query = `usuarioId=${U1}`;
    instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(await screen.findByText(/descifrados.*no registran autor/i)).toBeTruthy();
    cleanup();

    nav.estado.query = "";
    instalarFetchFalso(rutas(ok()));
    render(<PaginaAuditoria />);
    await screen.findByRole("table", { name: "Registros de auditoría" });
    await asentar();
    expect(screen.queryByText(/no registran autor/i)).toBeNull();
  });

  it("vacío: con filtros dice que no hay registros para ellos; sin filtros (todo=1) usa el vacío de siempre", async () => {
    nav.estado.query = `usuarioId=${U1}`;
    instalarFetchFalso(rutas(ok([])));
    render(<PaginaAuditoria />);
    expect(await screen.findByText(/No hay registros para los filtros elegidos/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();

    nav.estado.query = "todo=1";
    instalarFetchFalso(rutas(ok([])));
    render(<PaginaAuditoria />);
    expect(await screen.findByText("Todavía no hay registros de auditoría.")).toBeTruthy();
  });

  it("404 del cliente (no visible o inexistente): mensaje en español, sin tabla ni código crudo", async () => {
    nav.estado.query = `clienteId=${C1}`;
    instalarFetchFalso(rutas({ status: 404, cuerpo: { codigo: "no_encontrado" } }));
    const { container } = render(<PaginaAuditoria />);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(/no se encontró el cliente/i);
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.textContent).not.toContain("no_encontrado");
  });

  it("400 por filtros inválidos en la URL: mensaje en español sin código crudo", async () => {
    nav.estado.query = "usuarioId=no-es-uuid";
    instalarFetchFalso(rutas({ status: 400, cuerpo: { codigo: "solicitud_invalida" } }));
    const { container } = render(<PaginaAuditoria />);
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toMatch(/filtros no son válidos/i);
    expect(container.textContent).not.toContain("solicitud_invalida");
  });

  it("error 500 con filtros: avisa y «Reintentar» repite la misma consulta", async () => {
    nav.estado.query = `clienteId=${C1}&accion=cliente.editado`;
    const f = instalarFetchFalso(rutas((_l, vez) => (vez === 1 ? { status: 500, cuerpo: {} } : ok())));
    render(<PaginaAuditoria />);
    expect((await screen.findByRole("alert")).textContent).toContain("No se pudo cargar la auditoría");
    await userEvent.setup().click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("table", { name: "Registros de auditoría" });
    const [primera, segunda] = f.de("GET /api/auditoria");
    expect(params(segunda).toString()).toBe(params(primera).toString());
    expect(params(segunda).get("clienteId")).toBe(C1);
    expect(params(segunda).getAll("accion")).toEqual(["cliente.editado"]);
  });

  it("P-3: «compra.operacion» enlaza al Historial del periodo solo con `compras.ver`", async () => {
    const compra = fila(1, {
      accion: "compra.operacion",
      entidad: "compra",
      datos: { tipo: "excluir", filas: 3, periodo: "202610" },
    });
    const f = instalarFetchFalso(rutas(ok([compra]), {}, [...PERMISOS_AUDITOR, "compras.ver"]));
    render(<PaginaAuditoria />);
    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(within(tabla).getByText("Operación: Exclusión")).toBeTruthy();
    expect(within(tabla).getByText("Filas: 3")).toBeTruthy();
    const enlace = await within(tabla).findByRole("link", { name: /historial/i });
    expect(enlace.getAttribute("href")).toBe(`/clientes/${C1}/compras?periodo=202610`);
    expect(f.de("GET /api/acceso/yo").length).toBeGreaterThan(0);
    cleanup();

    instalarFetchFalso(rutas(ok([compra]), {}, PERMISOS_AUDITOR));
    render(<PaginaAuditoria />);
    const tabla2 = await screen.findByRole("table", { name: "Registros de auditoría" });
    expect(within(tabla2).getByText("Operación: Exclusión")).toBeTruthy();
    await asentar(60);
    expect(within(tabla2).queryByRole("link")).toBeNull();
  });

  it("P-3: sin cliente o sin periodo en los datos, la fila de compras no lleva enlace", async () => {
    const sinPeriodo = fila(1, { accion: "compra.operacion", entidad: "compra", datos: { tipo: "excluir", filas: 3 } });
    const sinCliente = fila(2, { accion: "compra.operacion", entidad: "compra", cliente: null, datos: { tipo: "excluir", periodo: "202610" } });
    instalarFetchFalso(rutas(ok([sinPeriodo, sinCliente]), {}, [...PERMISOS_AUDITOR, "compras.ver"]));
    render(<PaginaAuditoria />);
    const tabla = await screen.findByRole("table", { name: "Registros de auditoría" });
    await asentar(60);
    expect(within(tabla).queryByRole("link")).toBeNull();
  });
});

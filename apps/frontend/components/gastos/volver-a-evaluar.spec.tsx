import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { MENSAJES as MENSAJES_ACCESO_LIB } from "../../lib/acceso";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import { asentar, rutaSesion } from "../../pruebas/acceso";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import { contextoDe } from "../../pruebas/contexto-compras";
import {
  MENSAJES_GASTOS as M,
  RUTA_REEVALUAR,
  TIPO_TRABAJO_REEVALUAR,
  TRABAJO_REEVALUAR_ID,
} from "../../pruebas/gastos";
import { instalarFetchFalso, type Manejador } from "../../pruebas/soporte";
import { trabajoN } from "../../pruebas/trabajos";
import { VolverAEvaluar } from "./volver-a-evaluar";

// Spec 027 · T7 (rojo; CA-12, R-8, R-12, D-3). «Volver a evaluar» el periodo de compras.
// Contrato (T13), `components/gastos/volver-a-evaluar.tsx`: <VolverAEvaluar contexto={ContextoCompras} alTerminar?={() => void} />.
//   - Solo se ofrece (botón M.volverAEvaluar) con el periodo `abierto` y `contexto.permisos.clasificar` (`sire.clasificar`, como las
//     acciones de la grilla; el Asistente puede). En `revisado` o `generado`, o sin ese permiso, no hay botón.
//   - Pulsarlo → POST /api/clientes/:id/periodos/:p/gastos/reevaluar con el CSRF; 202 {trabajoId} → role status M.reevaluando, el
//     botón queda deshabilitado (un solo pedido) y se sigue ESE trabajo con `seguirTrabajos` de 008 (los eventos de otros trabajos
//     se ignoran). Al completarse: role status M.reevaluada, `contexto.recargarResumen()` y `alTerminar?.()` (la página vuelve a
//     leer el listado) y el botón se habilita otra vez. Trabajo con error o cancelado → role alert M.reevaluarFallida, sin el motivo técnico.
//   - 409 periodo_no_abierto | cliente_archivado y 403 → role alert en español (M.errores.* | M.sinPermiso), sin el código.
//   - Ninguna respuesta crea versiones: el componente no llama a ninguna otra ruta de escritura. Sin desborde a 390 px.

const seguimiento = vi.hoisted(() => ({ opciones: null as OpcionesSeguimiento | null }));
vi.mock("../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(async (o: OpcionesSeguimiento) => {
      seguimiento.opciones = o;
      await new Promise<void>((resolver) => o.senal.addEventListener("abort", () => resolver(), { once: true }));
    }),
  };
});

const emitir = (estado: "ejecutando" | "completado" | "error" | "cancelado", motivo: string | null = null, id = TRABAJO_REEVALUAR_ID) =>
  seguimiento.opciones?.alEvento({ ...trabajoN(1, TIPO_TRABAJO_REEVALUAR, estado, motivo), id } as unknown as TrabajoVista);

beforeEach(() => {
  seguimiento.opciones = null;
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ACEPTADA = { status: 202, cuerpo: { trabajoId: TRABAJO_REEVALUAR_ID } };

function montar(
  o: { reevaluar?: Manejador; estado?: "abierto" | "revisado" | "generado"; clasificar?: boolean } = {},
) {
  const f = instalarFetchFalso({ ...rutaSesion(), [RUTA_REEVALUAR]: o.reevaluar ?? ACEPTADA });
  const contexto = contextoDe({ estado: o.estado ?? "abierto", permisos: { clasificar: o.clasificar ?? true } });
  const alTerminar = vi.fn();
  const r = render(<VolverAEvaluar contexto={contexto} alTerminar={alTerminar} />);
  return { f, contexto, alTerminar, r, usuario: userEvent.setup() };
}
const boton = () => screen.findByRole("button", { name: M.volverAEvaluar }) as Promise<HTMLButtonElement>;

describe("<VolverAEvaluar /> · cuándo se ofrece (R-12, D-3)", () => {
  it("periodo abierto y permiso de clasificar: hay botón habilitado", async () => {
    montar();
    expect((await boton()).disabled).toBe(false);
  });

  it.each(["revisado", "generado"] as const)("periodo %s: no hay botón", async (estado) => {
    montar({ estado });
    await asentar();
    expect(screen.queryByRole("button", { name: M.volverAEvaluar })).toBeNull();
  });

  it("sin sire.clasificar (Lectura): no hay botón", async () => {
    montar({ clasificar: false });
    await asentar();
    expect(screen.queryByRole("button", { name: M.volverAEvaluar })).toBeNull();
  });
});

describe("<VolverAEvaluar /> · encolar y seguir el trabajo (CA-12)", () => {
  it("feliz: POST, estado «Volviendo a evaluar…», un solo pedido, y al completarse recarga el resumen y el listado", async () => {
    const { f, contexto, alTerminar, usuario } = montar();
    await usuario.click(await boton());

    await vi.waitFor(() => expect(f.de(RUTA_REEVALUAR)).toHaveLength(1));
    expect(f.de(RUTA_REEVALUAR)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain(M.reevaluando);
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    expect((await boton()).disabled).toBe(true);
    await usuario.click(await boton());
    expect(f.de(RUTA_REEVALUAR)).toHaveLength(1);

    emitir("ejecutando");
    expect(screen.getByRole("status").textContent).toContain(M.reevaluando);
    expect(alTerminar).not.toHaveBeenCalled();
    emitir("completado");

    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain(M.reevaluada));
    expect(screen.getByRole("status").textContent).not.toContain(M.reevaluando);
    expect(contexto.recargarResumen).toHaveBeenCalledTimes(1);
    expect(alTerminar).toHaveBeenCalledTimes(1);
    expect((await boton()).disabled).toBe(false);
  });

  it("un evento de OTRO trabajo no completa nada", async () => {
    const { contexto, alTerminar, usuario } = montar();
    await usuario.click(await boton());
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    emitir("completado", null, "00000000-0000-4000-8000-0000000000aa");
    await asentar();

    expect(screen.getByRole("status").textContent).toContain(M.reevaluando);
    expect(contexto.recargarResumen).not.toHaveBeenCalled();
    expect(alTerminar).not.toHaveBeenCalled();
  });

  it.each(["error", "cancelado"] as const)(
    "el trabajo termina en «%s»: alerta en español, sin el motivo técnico, y no recarga",
    async (estado) => {
      const { contexto, alTerminar, usuario } = montar();
      await usuario.click(await boton());
      await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

      emitir(estado, estado === "error" ? "sunat_no_responde" : null);

      const alerta = await screen.findByRole("alert");
      expect(alerta.textContent).toBe(M.reevaluarFallida);
      expect(alerta.textContent).not.toContain("sunat_no_responde");
      expect(contexto.recargarResumen).not.toHaveBeenCalled();
      expect(alTerminar).not.toHaveBeenCalled();
      expect((await boton()).disabled).toBe(false);
    },
  );

  it.each([
    ["409 periodo_no_abierto", { status: 409, cuerpo: { codigo: "periodo_no_abierto" } }, M.errores.periodo_no_abierto],
    ["409 cliente_archivado", { status: 409, cuerpo: { codigo: "cliente_archivado" } }, M.errores.cliente_archivado],
    ["403", { status: 403, cuerpo: { codigo: "permiso_denegado" } }, MENSAJES_ACCESO_LIB.sinPermiso],
  ])("%s: alerta en español sin el código y ningún seguimiento", async (_caso, respuesta, mensaje) => {
    const { alTerminar, usuario } = montar({ reevaluar: respuesta });
    await usuario.click(await boton());

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(mensaje);
    expect(alerta.textContent).not.toMatch(/periodo_no_abierto|cliente_archivado|permiso_denegado/);
    expect(seguimiento.opciones).toBeNull();
    expect(alTerminar).not.toHaveBeenCalled();
  });

  it("solo llama a la ruta de reevaluar: ninguna otra escritura (no crea versiones)", async () => {
    const { f, usuario } = montar();
    await usuario.click(await boton());
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    emitir("completado");
    await asentar();

    expect(f.llamadas.filter((l) => l.method !== "GET").map((l) => `${l.method} ${l.ruta}`)).toEqual([RUTA_REEVALUAR]);
  });
});

describe("<VolverAEvaluar /> · 390 px", () => {
  it("no fija anchos mayores a la pantalla ni esconde nada tras un scroll interior", async () => {
    const { r } = montar();
    await boton();
    expect(anchosFijosMayoresA390(r.container)).toEqual([]);
  });
});

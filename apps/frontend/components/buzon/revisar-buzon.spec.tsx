import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { yoDe } from "../../pruebas/acceso";
import {
  CLIENTE_BUZON,
  MENSAJES_BUZON as M,
  RUTA_MENSAJES,
  RUTA_REVISAR,
  paginaBuzon,
} from "../../pruebas/buzon";
import {
  estadoCredencialDe,
  trabajoDe,
} from "../../pruebas/credenciales";
import { instalarFetchFalso, sesionDe, type Manejador } from "../../pruebas/soporte";
import { RevisarBuzon } from "./revisar-buzon";

// Spec 023 · T7 (rojo; CA-2, P-6). Botón «Revisar buzón ahora» de la ficha del cliente.
// Contrato (T14), `components/buzon/revisar-buzon.tsx`: <RevisarBuzon clienteId="c-1" archivado={boolean} />.
//   - Lee GET /api/clientes/:id/credenciales (estado de la credencial `sol`): `no_configurada` e `invalida`
//     dejan el botón deshabilitado con el motivo visible (M.sinCredencial / M.credencialInvalida);
//     `configurada` y `verificada` lo habilitan. `archivado` lo deshabilita con M.archivado.
//   - Botón «Revisar buzón ahora» → POST /api/clientes/:id/buzon/revisar (sin cuerpo).
//     202 → M.encolada y enlace M.enlacePanel a /trabajos. 200 (ya hay una viva) → M.enCurso y el mismo enlace.
//   - 429 `captura_reciente` (el cuerpo es solo `{codigo}`, sin minutos): lee GET …/buzon/mensajes?limite=1 y de
//     `estado.revisarDesde` saca N = minutos enteros hacia arriba (mínimo 1) → M.recienteEn(N).
//   - 409 cliente_archivado / credencial_no_configurada / credencial_invalida → el mismo texto de arriba en una
//     alerta (role=alert), en español y sin mostrar el código.
//   - Usa `Button`/`Alert` de components/ui y solo tokens de color.

const AHORA = "2026-11-17T12:00:00.000Z";
const SIN_PRISA: Manejador = { status: 200, cuerpo: paginaBuzon() };

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function instalar(
  opciones: {
    credencial?: "no_configurada" | "configurada" | "verificada" | "invalida";
    extra?: Record<string, Manejador>;
  } = {},
) {
  return instalarFetchFalso({
    "GET /api/auth/sesion": {
      status: 200,
      cuerpo: sesionDe({ id: "e-a", nombre: "Estudio Alfa" }),
    },
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", ["clientes.ver", "buzon.ver"]),
    },
    [`GET /api/clientes/${CLIENTE_BUZON}/credenciales`]: {
      status: 200,
      cuerpo: [
        estadoCredencialDe("sol", opciones.credencial ?? "verificada"),
        estadoCredencialDe("sire_api", "no_configurada"),
      ],
    },
    [RUTA_MENSAJES]: SIN_PRISA,
    ...opciones.extra,
  });
}

const montar = (archivado = false) => {
  render(<RevisarBuzon clienteId={CLIENTE_BUZON} archivado={archivado} />);
  return userEvent.setup();
};
const boton = () =>
  screen.findByRole("button", { name: M.revisar }) as Promise<HTMLButtonElement>;

describe("<RevisarBuzon /> · pedir la revisión (CA-2)", () => {
  it("202: encola, avisa y enlaza al panel de trabajos", async () => {
    const f = instalar({
      extra: {
        [RUTA_REVISAR]: { status: 202, cuerpo: { trabajo: trabajoDe({ tipo: "sol.buzon.revisar" }) } },
      },
    });
    const usuario = montar();
    const b = await boton();
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    await usuario.click(b);

    expect(await screen.findByText(M.encolada)).toBeTruthy();
    const enlace = screen.getByRole("link", { name: M.enlacePanel });
    expect(enlace.getAttribute("href")).toBe("/trabajos");
    const llamadas = f.de(RUTA_REVISAR);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(llamadas[0]!.body).toBeUndefined();
  });

  it("200: ya había una revisión viva; lo dice y enlaza al panel", async () => {
    instalar({
      extra: {
        [RUTA_REVISAR]: { status: 200, cuerpo: { trabajo: trabajoDe({ tipo: "sol.buzon.revisar", estado: "ejecutando" }) } },
      },
    });
    const usuario = montar();
    await usuario.click(await boton());
    expect(await screen.findByText(M.enCurso)).toBeTruthy();
    expect(screen.getByRole("link", { name: M.enlacePanel }).getAttribute("href")).toBe("/trabajos");
    expect(screen.queryByText(M.encolada)).toBeNull();
  });
});

describe("<RevisarBuzon /> · 429 con minutos", () => {
  it.each([
    ["2026-11-17T12:07:30.000Z", 8],
    ["2026-11-17T12:10:00.000Z", 10],
    ["2026-11-17T12:00:20.000Z", 1],
    ["2026-11-17T11:59:00.000Z", 1], // ya pasó: nunca «0 min»
    [null, 1],
  ])("revisarDesde %j → %i min", async (revisarDesde, minutos) => {
    // Solo se simula `Date`: los temporizadores de `waitFor` siguen siendo reales.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AHORA));
    const f = instalar({
      extra: {
        [RUTA_REVISAR]: { status: 429, cuerpo: { codigo: "captura_reciente" } },
        [RUTA_MENSAJES]: { status: 200, cuerpo: paginaBuzon({ revisarDesde }) },
      },
    });
    const usuario = userEvent.setup();
    render(<RevisarBuzon clienteId={CLIENTE_BUZON} archivado={false} />);
    const b = await boton();
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    await usuario.click(b);

    expect(await screen.findByText(M.recienteEn(minutos))).toBeTruthy();
    expect(f.de(RUTA_REVISAR)).toHaveLength(1);
    expect(screen.queryByText(/captura_reciente/)).toBeNull();
  });
});

describe("<RevisarBuzon /> · deshabilitado con motivo", () => {
  it("cliente archivado: botón deshabilitado y el motivo a la vista, sin pedir nada", async () => {
    const f = instalar();
    const usuario = montar(true);
    const b = await boton();
    expect(b.disabled).toBe(true);
    expect(screen.getByText(M.archivado)).toBeTruthy();
    await usuario.click(b);
    expect(f.de(RUTA_REVISAR)).toHaveLength(0);
  });

  it("credencial SOL sin configurar: deshabilitado con el motivo", async () => {
    const f = instalar({ credencial: "no_configurada" });
    const usuario = montar();
    const b = await boton();
    expect(await screen.findByText(M.sinCredencial)).toBeTruthy();
    expect(b.disabled).toBe(true);
    await usuario.click(b);
    expect(f.de(RUTA_REVISAR)).toHaveLength(0);
  });

  it("credencial SOL inválida: deshabilitado con el motivo", async () => {
    const f = instalar({ credencial: "invalida" });
    const usuario = montar();
    const b = await boton();
    expect(await screen.findByText(M.credencialInvalida)).toBeTruthy();
    expect(b.disabled).toBe(true);
    await usuario.click(b);
    expect(f.de(RUTA_REVISAR)).toHaveLength(0);
  });

  it.each(["configurada", "verificada"] as const)(
    "credencial %s: habilitado y sin motivo",
    async (credencial) => {
      instalar({ credencial });
      montar();
      const b = await boton();
      await vi.waitFor(() => expect(b.disabled).toBe(false));
      expect(screen.queryByText(M.sinCredencial)).toBeNull();
      expect(screen.queryByText(M.credencialInvalida)).toBeNull();
      expect(screen.queryByText(M.archivado)).toBeNull();
    },
  );
});

describe("<RevisarBuzon /> · 409 del servidor", () => {
  it.each([
    ["cliente_archivado", M.archivado],
    ["credencial_no_configurada", M.sinCredencial],
    ["credencial_invalida", M.credencialInvalida],
  ])("%s → alerta en español, sin el código", async (codigo, texto) => {
    instalar({ extra: { [RUTA_REVISAR]: { status: 409, cuerpo: { codigo } } } });
    const usuario = montar();
    const b = await boton();
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    await usuario.click(b);

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(screen.queryByText(M.encolada)).toBeNull();
  });
});

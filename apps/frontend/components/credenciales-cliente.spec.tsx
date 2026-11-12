import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../lib/sesion";
import { rutaSesion } from "../pruebas/acceso";
import { estadoCredencialDe, trabajoDe } from "../pruebas/credenciales";
import { instalarFetchFalso, type Manejador } from "../pruebas/soporte";
import { CredencialesCliente } from "./credenciales-cliente";
import {
  MOTIVO_CREDENCIAL_GENERICO,
  MOTIVOS_CREDENCIAL,
} from "../lib/credenciales";

// Contrato (spec 020, D-5, DT-3, CA-5). Tras «Verificar» (202) el grupo pasa a «Verificando…» y la ficha vuelve a
// leer GET /api/clientes/c-1/credenciales con espera creciente (1 s, 2 s, 4 s… hasta 10 s) hasta que el estado
// final cambia: «Verificada» o «Inválida» sin recargar. «Inválida» muestra el motivo en español y nunca el
// código crudo (`credencial_invalida`); un motivo desconocido, un texto genérico. Al desmontar no hay más lecturas.

const RUTA = "GET /api/clientes/c-1/credenciales";

function rutas(listado: Manejador): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    [RUTA]: listado,
    "POST /api/clientes/c-1/credenciales/sol/verificar": {
      status: 202,
      cuerpo: trabajoDe(),
    },
  };
}

const lecturas = (f: ReturnType<typeof instalarFetchFalso>) =>
  f.de(RUTA).length;

const grupoSol = () => screen.getByRole("group", { name: "Credencial SOL" });

async function avanzar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Monta la ficha, espera la primera lectura y pulsa «Verificar» de SOL. */
async function montarYVerificar(listado: Manejador) {
  const f = instalarFetchFalso(rutas(listado));
  const vista = render(<CredencialesCliente clienteId="c-1" editable />);
  await avanzar(0);
  const boton = within(grupoSol()).getByRole("button", { name: "Verificar" });
  await act(async () => {
    boton.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  return { f, vista };
}

describe("<CredencialesCliente /> refresco tras verificar (D-5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("«Verificando…» pasa a «Verificada» sin recargar y deja de leer", async () => {
    let listado: unknown[] = [estadoCredencialDe("sol", "configurada")];
    const { f } = await montarYVerificar(() => ({
      status: 200,
      cuerpo: listado,
    }));
    expect(grupoSol().textContent).toContain("Verificando…");
    const antes = lecturas(f);

    await avanzar(1_000); // primera lectura de sondeo: sigue «Configurada»
    expect(lecturas(f)).toBe(antes + 1);
    expect(grupoSol().textContent).toContain("Verificando…");

    listado = [estadoCredencialDe("sol", "verificada")]; // el worker terminó
    await avanzar(2_000);
    expect(grupoSol().textContent).toMatch(/Estado: Verificada/);
    expect(grupoSol().textContent).not.toContain("Verificando");

    const alTerminar = lecturas(f);
    await avanzar(60_000);
    expect(lecturas(f)).toBe(alTerminar);
  });

  it("«Verificando…» pasa a «Inválida» con el motivo en español, sin el código crudo", async () => {
    const codigoCrudo = "credencial_invalida";
    let listado: unknown[] = [estadoCredencialDe("sol", "configurada")];
    await montarYVerificar(() => ({ status: 200, cuerpo: listado }));
    expect(grupoSol().textContent).toContain("Verificando…");

    listado = [
      estadoCredencialDe("sol", "invalida", {
        motivo: codigoCrudo,
        fecha: "2026-11-03T10:00:00.000Z",
      }),
    ];
    await avanzar(1_000);
    const texto = grupoSol().textContent ?? "";
    expect(texto).toMatch(/Inválida/);
    expect(texto).toContain(MOTIVOS_CREDENCIAL[codigoCrudo]);
    expect(texto).not.toContain(codigoCrudo);
    expect(document.body.textContent).not.toContain(codigoCrudo);
  });

  it("un motivo desconocido muestra el texto genérico, nunca el código", async () => {
    instalarFetchFalso(
      rutas({
        status: 200,
        cuerpo: [
          estadoCredencialDe("sol", "invalida", { motivo: "codigo_nuevo_x" }),
        ],
      }),
    );
    render(<CredencialesCliente clienteId="c-1" editable={false} />);
    await avanzar(0);
    const texto = grupoSol().textContent ?? "";
    expect(texto).toContain(MOTIVO_CREDENCIAL_GENERICO);
    expect(texto).not.toContain("codigo_nuevo_x");
  });

  it("al desmontar no vuelve a leer", async () => {
    const { f, vista } = await montarYVerificar(() => ({
      status: 200,
      cuerpo: [estadoCredencialDe("sol", "configurada")],
    }));
    await avanzar(1_000);
    const antes = lecturas(f);
    expect(antes).toBeGreaterThan(1);
    vista.unmount();
    await avanzar(120_000);
    expect(lecturas(f)).toBe(antes);
  });
});

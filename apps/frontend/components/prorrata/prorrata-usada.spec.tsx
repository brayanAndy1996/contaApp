import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import {
  MENSAJES_PRORRATA as M,
  anchosFijosMayoresA390,
  coeficienteDe,
  instalarFetchProrrata,
  rutaUsada,
} from "../../pruebas/prorrata";
import { ProrrataUsada } from "./prorrata-usada";

// Spec 026 · T7 (rojo; CA-6, CA-9, R-8, U-9, U-10, D-8). Prorrata usada en la declaración y alerta de diferencia.
// Contrato (T13), `components/prorrata/prorrata-usada.tsx`:
//   <ProrrataUsada clienteId="c-1" periodo="202610" usada={{valor, origen} | null} versionUsada={n}
//     diferencia={{diferencia, alerta} | null} coeficiente={CoeficienteVista} puedeGestionar={boolean} archivado?={boolean}
//     alGuardar={() => void} />
//   - Título M.tituloUsada. Con `usada`: el valor con coma («83,34 %») y su origen M.origenUsada[origen]. Sin `usada`: M.sinUsada.
//   - Alerta de diferencia (R-8): solo con `diferencia.alerta` y coeficiente `calculado`: el texto M.alertaDiferencia(calculada,
//     usada, origen, diferencia) con ambos valores, la diferencia en puntos y el origen de la usada. Sin alerta, ni rastro.
//   - Ingreso (solo con `puedeGestionar`, sin `archivado` y cuando el PDT no la trae, es decir `usada` null o «ingresada»):
//     campo M.campoUsada y botón M.guardarUsada → PUT /api/clientes/:id/prorrata/usada/:periodo con {porcentaje, version:
//     versionUsada}; el campo es de texto (type="text", inputMode decimal); porcentaje «NN.NN», 0 a 100 con hasta 2 decimales (si no, M.porcentajeInvalido sin llamar a la API).
//     Con una ya ingresada el campo parte con su valor y aparece M.quitarUsada → PUT con {porcentaje: null, version}.
//     Éxito → `alGuardar()`. Si el PDT la trae («declarada») no hay campo ni botones.
//   - 409 prorrata_declarada | mes_cambiado | cliente_archivado y 403 → role alert en español, nunca el código.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERIODO = "202610";
const OK = { status: 200, cuerpo: { version: 1 } };

interface Props {
  usada?: { valor: string; origen: "declarada" | "ingresada" } | null;
  versionUsada?: number;
  diferencia?: { diferencia: string; alerta: boolean } | null;
  coeficiente?: Record<string, unknown>;
  puedeGestionar?: boolean;
  archivado?: boolean;
}

function montar(p: Props = {}, extra: Parameters<typeof instalarFetchProrrata>[0] = {}) {
  const f = instalarFetchProrrata(extra);
  const alGuardar = vi.fn();
  const r = render(
    <ProrrataUsada
      clienteId="c-1"
      periodo={PERIODO}
      usada={p.usada ?? null}
      versionUsada={p.versionUsada ?? 0}
      diferencia={p.diferencia ?? null}
      coeficiente={p.coeficiente ?? coeficienteDe()}
      puedeGestionar={p.puedeGestionar ?? true}
      archivado={p.archivado}
      alGuardar={alGuardar}
    />,
  );
  return { f, alGuardar, r, usuario: userEvent.setup() };
}

describe("<ProrrataUsada /> · origen y alerta (CA-6, R-8)", () => {
  it("declarada en el PDT: valor con coma, su origen y alerta con ambos valores cuando difiere en 0,01", () => {
    montar({ usada: { valor: "83.34", origen: "declarada" }, diferencia: { diferencia: "0.01", alerta: true } });
    expect(screen.getByRole("heading", { name: M.tituloUsada })).toBeTruthy();
    expect(screen.getByText("83,34 %")).toBeTruthy();
    expect(screen.getByText(M.origenUsada.declarada)).toBeTruthy();
    expect(screen.getByText(M.alertaDiferencia("83.33", "83.34", "declarada", "0.01"))).toBeTruthy();
  });

  it("igual a la calculada: sin alerta", () => {
    montar({ usada: { valor: "83.33", origen: "declarada" }, diferencia: { diferencia: "0.00", alerta: false } });
    expect(screen.getByText("83,33 %")).toBeTruthy();
    expect(document.body.textContent).not.toContain("no coincide");
  });

  it("ingresada a mano: alerta igual y marca su origen", () => {
    montar({ usada: { valor: "70.00", origen: "ingresada" }, versionUsada: 1, diferencia: { diferencia: "13.33", alerta: true } });
    expect(screen.getByText(M.origenUsada.ingresada)).toBeTruthy();
    expect(screen.getByText(M.alertaDiferencia("83.33", "70.00", "ingresada", "13.33"))).toBeTruthy();
  });

  it("sin prorrata usada: M.sinUsada y ninguna alerta", () => {
    montar({ usada: null, diferencia: null });
    expect(screen.getByText(M.sinUsada)).toBeTruthy();
    expect(document.body.textContent).not.toContain("no coincide");
  });

  it("coeficiente no calculado: sin alerta aunque venga marcada (no hay valor calculado que mostrar)", () => {
    montar({
      usada: { valor: "83.34", origen: "declarada" },
      diferencia: { diferencia: "0.01", alerta: true },
      coeficiente: { estado: "faltan_meses", faltantes: ["202511"] },
    });
    expect(document.body.textContent).not.toContain("no coincide");
  });
});

describe("<ProrrataUsada /> · ingresarla cuando el PDT no la trae (CA-6, U-9)", () => {
  it("sin usada y con permiso: manda {porcentaje, version 0} y avisa al guardar", async () => {
    const { f, alGuardar, usuario } = montar({}, { extra: { [rutaUsada(PERIODO)]: OK } });
    await usuario.type(screen.getByLabelText(M.campoUsada), "83.34");
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));

    await vi.waitFor(() => expect(f.de(rutaUsada(PERIODO))).toHaveLength(1));
    expect(f.de(rutaUsada(PERIODO))[0]!.body).toEqual({ porcentaje: "83.34", version: 0 });
    expect(f.de(rutaUsada(PERIODO))[0]!.headers["x-csrf-token"]).toBeTruthy();
    await vi.waitFor(() => expect(alGuardar).toHaveBeenCalledTimes(1));
  });

  it.each(["0", "0.00", "100", "100.00", "5.5", " 87.34 "])("acepta %j", async (valor) => {
    const { f, usuario } = montar({}, { extra: { [rutaUsada(PERIODO)]: OK } });
    await usuario.type(screen.getByLabelText(M.campoUsada), valor);
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));
    await vi.waitFor(() => expect(f.de(rutaUsada(PERIODO))).toHaveLength(1));
    expect((f.de(rutaUsada(PERIODO))[0]!.body as { porcentaje: string }).porcentaje).toBe(valor.trim());
  });

  it.each(["100.01", "87.345", "-1", "abc", "1e2", ""])("rechaza %j sin llamar a la API", async (malo) => {
    const { f, alGuardar, usuario } = montar({}, { extra: { [rutaUsada(PERIODO)]: OK } });
    if (malo) await usuario.type(screen.getByLabelText(M.campoUsada), malo);
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));
    expect(await screen.findByText(M.porcentajeInvalido)).toBeTruthy();
    await asentar();
    expect(f.de(rutaUsada(PERIODO))).toHaveLength(0);
    expect(alGuardar).not.toHaveBeenCalled();
  });

  it("ya ingresada: el campo parte con su valor, edita con su versión y se puede quitar", async () => {
    const { f, alGuardar, usuario } = montar(
      { usada: { valor: "70.00", origen: "ingresada" }, versionUsada: 3 },
      { extra: { [rutaUsada(PERIODO)]: OK } },
    );
    expect((screen.getByLabelText(M.campoUsada) as HTMLInputElement).value).toBe("70.00");

    await usuario.click(screen.getByRole("button", { name: M.quitarUsada }));
    await vi.waitFor(() => expect(f.de(rutaUsada(PERIODO))).toHaveLength(1));
    expect(f.de(rutaUsada(PERIODO))[0]!.body).toEqual({ porcentaje: null, version: 3 });
    await vi.waitFor(() => expect(alGuardar).toHaveBeenCalledTimes(1));
  });

  it("ya ingresada: corregirla manda el nuevo valor con la versión vigente", async () => {
    const { f, usuario } = montar(
      { usada: { valor: "70.00", origen: "ingresada" }, versionUsada: 3 },
      { extra: { [rutaUsada(PERIODO)]: OK } },
    );
    const c = screen.getByLabelText(M.campoUsada);
    await usuario.clear(c);
    await usuario.type(c, "83.34");
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));
    await vi.waitFor(() => expect(f.de(rutaUsada(PERIODO))).toHaveLength(1));
    expect(f.de(rutaUsada(PERIODO))[0]!.body).toEqual({ porcentaje: "83.34", version: 3 });
  });

  it("si el PDT la trae no hay campo ni botones", () => {
    montar({ usada: { valor: "83.34", origen: "declarada" } });
    expect(screen.queryByLabelText(M.campoUsada)).toBeNull();
    expect(screen.queryByRole("button", { name: M.guardarUsada })).toBeNull();
    expect(screen.queryByRole("button", { name: M.quitarUsada })).toBeNull();
  });
});

describe("<ProrrataUsada /> · permisos y cliente archivado (CA-9)", () => {
  it("sin permiso de gestión se ve el valor pero no hay campo ni botones", () => {
    montar({ usada: { valor: "70.00", origen: "ingresada" }, versionUsada: 1, puedeGestionar: false });
    expect(screen.getByText("70,00 %")).toBeTruthy();
    expect(screen.queryByLabelText(M.campoUsada)).toBeNull();
    expect(screen.queryByRole("button", { name: M.guardarUsada })).toBeNull();
    expect(screen.queryByRole("button", { name: M.quitarUsada })).toBeNull();
  });

  it("sin permiso y sin usada: solo M.sinUsada", () => {
    montar({ puedeGestionar: false });
    expect(screen.getByText(M.sinUsada)).toBeTruthy();
    expect(screen.queryByLabelText(M.campoUsada)).toBeNull();
  });

  it("cliente archivado: se ve, pero no se puede ingresar", () => {
    montar({ usada: { valor: "70.00", origen: "ingresada" }, versionUsada: 1, archivado: true });
    expect(screen.getByText("70,00 %")).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.guardarUsada })).toBeNull();
  });
});

describe("<ProrrataUsada /> · errores del servidor (CA-6, CA-9)", () => {
  it.each([
    ["prorrata_declarada", M.errores.prorrata_declarada],
    ["mes_cambiado", M.usadaCambiada],
    ["cliente_archivado", M.errores.cliente_archivado],
  ])("409 %s: alerta en español, sin el código", async (codigo, texto) => {
    const { alGuardar, usuario } = montar({}, { extra: { [rutaUsada(PERIODO)]: { status: 409, cuerpo: { codigo } } } });
    await usuario.type(screen.getByLabelText(M.campoUsada), "83.34");
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(alGuardar).not.toHaveBeenCalled();
  });

  it("403: el mensaje genérico de permiso", async () => {
    const { usuario } = montar({}, { extra: { [rutaUsada(PERIODO)]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } } });
    await usuario.type(screen.getByLabelText(M.campoUsada), "83.34");
    await usuario.click(screen.getByRole("button", { name: M.guardarUsada }));
    expect((await screen.findByRole("alert")).textContent).toContain(M.sinPermiso);
  });
});

describe("<ProrrataUsada /> · 390 px", () => {
  it("sin anchos fijos mayores a la pantalla", () => {
    const { r } = montar({ usada: { valor: "83.34", origen: "declarada" }, diferencia: { diferencia: "0.01", alerta: true } });
    expect(anchosFijosMayoresA390(r.container)).toEqual([]);
  });
});

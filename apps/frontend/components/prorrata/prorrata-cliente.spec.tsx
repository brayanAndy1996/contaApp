import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrabajoVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import type { OpcionesSeguimiento } from "../../lib/trabajos";
import { asentar, fila } from "../../pruebas/acceso";
import {
  CLIENTE_PRORRATA,
  MENSAJES_PRORRATA as M,
  OBTENIDA_EN,
  PERIODO_M,
  PERMISOS_SOLO_VER,
  RUTA_OBTENER,
  RUTA_VISTA,
  TIPO_TRABAJO_DECLARACIONES,
  TRABAJO_DECLARACIONES_ID,
  anchosFijosMayoresA390,
  coeficienteDe,
  consultaDeLlamada,
  conMes,
  igvDe,
  instalarFetchProrrata,
  mesFaltaDe,
  rutaHistorial,
  rutaMes,
  valorDe,
  ventanaMixta,
  vistaDe,
  type ProrrataVistaPrueba,
} from "../../pruebas/prorrata";
import { trabajoN } from "../../pruebas/trabajos";
import { ProrrataCliente } from "./prorrata-cliente";

// Spec 026 · T7 (rojo; CA-1, CA-3 a CA-6, CA-9, D-5, D-8). Pantalla de prorrata del cliente (integra tabla, gráfico, coeficiente,
// IGV, manual, historial y prorrata usada).
// Contrato (T13), `components/prorrata/prorrata-cliente.tsx`: <ProrrataCliente clienteId="c-1" archivado?={boolean} />.
//   - Lee GET /api/acceso/yo (permisos) y GET /api/clientes/:id/prorrata?periodo=AAAAMM. Encabezado M.tituloPagina no se exige.
//   - Selector de mes (combobox M.campoPeriodo): M.mesesOfrecidos opciones, del mes en curso (hora de Lima, reloj `Date`) hacia
//     atrás, con valor «AAAAMM» y texto «AAAA-MM»; por omisión el mes ANTERIOR al en curso. Cambiarlo vuelve a leer con ese periodo.
//   - «Obtener declaraciones» (M.obtener; solo con `prorrata.gestionar`) → POST …/prorrata/declaraciones {periodo} (periodo elegido).
//     202 {trabajoId} → role status M.obteniendo y seguimiento con `seguirTrabajos` de 008 (solo el trabajo con ese id); al
//     completarse se vuelve a leer la vista. Trabajo con error → M.obtencionFallida (role alert, sin el motivo técnico).
//     409 cliente_archivado | credencial_no_configurada | credencial_invalida, 400 periodo_futuro y 403 → role alert (sin el código).
//     `archivado` → botón deshabilitado con M.errores.cliente_archivado visible, sin llamar.
//   - Muestra la última obtención (M.ultimaObtencion(iso) o M.sinObtencion) y los periodos sin declaración (M.sinDeclaracion).
//   - Integra <TablaMeses>, <GraficoProrrata>, <Coeficiente>, <IgvEstimado> y <ProrrataUsada> con la vista; «Ingresar a mano AAAA-MM»
//     abre <MesManual> y «Historial AAAA-MM», <HistorialMes>; al guardar un mes (o la prorrata usada) se vuelve a leer la vista.
//   - Asistente y Lectura (solo `prorrata.ver`): ven todo, sin «Obtener declaraciones», «Ingresar a mano» ni ingreso de prorrata usada.
//   - 404 de la vista → M.noEncontrado y nada más; 403 → M.sinPermiso; otro error → M.errorCarga.

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

const emitir = (estado: "ejecutando" | "completado" | "error", motivo: string | null = null, id = TRABAJO_DECLARACIONES_ID) =>
  seguimiento.opciones?.alEvento({
    ...trabajoN(1, TIPO_TRABAJO_DECLARACIONES, estado, motivo),
    id,
  } as unknown as TrabajoVista);

// 22/11/2026 10:00 en Lima: el mes anterior es 2026-10.
const AHORA = OBTENIDA_EN;

beforeEach(() => {
  seguimiento.opciones = null;
  reiniciarSesion();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AHORA));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ACEPTADA = { status: 202, cuerpo: { trabajoId: TRABAJO_DECLARACIONES_ID } };

function montar(o: Parameters<typeof instalarFetchProrrata>[0] = {}, archivado = false) {
  const f = instalarFetchProrrata(o);
  const r = render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={archivado} />);
  return { f, r, usuario: userEvent.setup() };
}
const selector = () => screen.findByRole("combobox", { name: M.campoPeriodo }) as Promise<HTMLSelectElement>;
const botonObtener = () => screen.findByRole("button", { name: M.obtener }) as Promise<HTMLButtonElement>;

describe("<ProrrataCliente /> · mes de cálculo (R-1)", () => {
  it("por omisión el mes anterior al en curso (Lima), con 24 opciones desde el mes en curso, y lee con ese periodo", async () => {
    const { f } = montar();
    const s = await selector();
    expect(s.value).toBe("202610");
    const opciones = [...s.options];
    expect(opciones).toHaveLength(M.mesesOfrecidos);
    expect(opciones[0]!.value).toBe("202611");
    expect(opciones[0]!.textContent).toBe("2026-11");
    expect(opciones[23]!.value).toBe("202412");
    await vi.waitFor(() => expect(f.de(RUTA_VISTA)).toHaveLength(1));
    expect(consultaDeLlamada(f.de(RUTA_VISTA)[0]!.url).get("periodo")).toBe("202610");
  });

  it("a las 22:00 del 31/10 en Lima (03:00 UTC del 1/11) el mes en curso sigue siendo octubre: por omisión 2026-09", async () => {
    vi.setSystemTime(new Date("2026-11-01T03:00:00.000Z"));
    const { f } = montar();
    const s = await selector();
    expect(s.value).toBe("202609");
    expect(s.options[0]!.value).toBe("202610");
    await vi.waitFor(() => expect(consultaDeLlamada(f.de(RUTA_VISTA)[0]!.url).get("periodo")).toBe("202609"));
  });

  it("en enero el mes anterior es diciembre del año previo", async () => {
    vi.setSystemTime(new Date("2027-01-15T17:00:00.000Z"));
    montar();
    expect((await selector()).value).toBe("202612");
  });

  it("cambiar el mes vuelve a leer con ese periodo y muestra su ventana", async () => {
    const { f, usuario } = montar({ vista: (p) => vistaDe({ periodo: p ?? PERIODO_M }) });
    const s = await selector();
    await screen.findByRole("table", { name: M.tablaMeses });
    expect(document.getElementById("mes-202511")).not.toBeNull();
    expect(document.getElementById("mes-202610")).not.toBeNull();
    await usuario.selectOptions(s, "202609");

    await vi.waitFor(() => expect(f.de(RUTA_VISTA).map((l) => consultaDeLlamada(l.url).get("periodo"))).toContain("202609"));
    await vi.waitFor(() => expect(document.getElementById("mes-202510")).not.toBeNull());
    expect(document.getElementById("mes-202610")).toBeNull();
    expect(document.getElementById("mes-202511")).not.toBeNull();
  });
});

describe("<ProrrataCliente /> · lo que se ve (CA-1, CA-3, CA-5, D-8)", () => {
  it("la vista completa: tabla de 12 meses, gráfico, coeficiente 83,33 % e IGV a pagar", async () => {
    montar();
    expect(await screen.findByRole("table", { name: M.tablaMeses })).toBeTruthy();
    expect(screen.getByRole("img", { name: M.tituloGrafico })).toBeTruthy();
    expect(screen.getByText("83,33 %")).toBeTruthy();
    expect(valorDe(M.situacion.a_pagar)).toBe("6,000.00");
    expect(screen.getByText(M.notaEstimado)).toBeTruthy();
  });

  it("origen por mes y coeficiente «provisional» con meses manual, SIRE y faltante (CA-3)", async () => {
    montar({
      vista: vistaDe({
        ventana: ventanaMixta(),
        coeficiente: coeficienteDe({ provisional: true, avisos: ["exportaciones_en_sire"] }),
      }),
    });
    await screen.findByRole("table", { name: M.tablaMeses });
    expect(fila("2025-11").textContent).toContain(M.origen.falta);
    expect(fila("2025-12").textContent).toContain(M.origen.manual);
    expect(fila("2026-01").textContent).toContain(M.origen.sire);
    expect(fila("2026-02").textContent).toContain(M.origen.rectificatoria);
    expect(screen.getByText(M.provisional)).toBeTruthy();
    expect(screen.getByText(M.avisosCoeficiente.exportaciones_en_sire)).toBeTruthy();
  });

  it("con un mes faltante no hay coeficiente ni IGV: se lista el mes con enlace a su fila (CA-4)", async () => {
    montar({
      vista: vistaDe({
        ventana: ventanaMixta(),
        coeficiente: { estado: "faltan_meses", faltantes: ["202511"] },
        igvEstimado: { estado: "no_estimable", motivo: "coeficiente" },
      }),
    });
    const enlace = await screen.findByRole("link", { name: M.ingresarFaltante("202511") });
    expect(enlace.getAttribute("href")).toBe("#mes-202511");
    expect(document.getElementById("mes-202511")).not.toBeNull();
    expect(screen.getByText(M.noEstimable.coeficiente)).toBeTruthy();
  });

  it("IGV no estimable porque falta el periodo de compras: lo dice", async () => {
    montar({ vista: vistaDe({ igvEstimado: { estado: "no_estimable", motivo: "sin_compras" } }) });
    expect(await screen.findByText(M.noEstimable.sin_compras)).toBeTruthy();
  });

  it("última obtención y periodos sin declaración", async () => {
    montar({ vista: vistaDe({ ultimaObtencion: { obtenidaEn: OBTENIDA_EN, periodosSinDeclaracion: ["202511", "202603"] } }) });
    expect(await screen.findByText(M.ultimaObtencion(OBTENIDA_EN))).toBeTruthy();
    expect(screen.getByText(M.sinDeclaracion(["202511", "202603"]))).toBeTruthy();
  });

  it("sin ninguna obtención lo dice y no pinta la línea de periodos sin declaración", async () => {
    montar({ vista: vistaDe({ ultimaObtencion: null }) });
    expect(await screen.findByText(M.sinObtencion)).toBeTruthy();
    expect(screen.queryByText(/Sin declaración en/)).toBeNull();
  });

  it("alerta de prorrata usada distinta (CA-6): con ambos valores y su origen", async () => {
    montar({
      vista: vistaDe({
        prorrataUsada: { valor: "83.34", origen: "declarada" },
        diferencia: { diferencia: "0.01", alerta: true },
      }),
    });
    expect(await screen.findByText(M.alertaDiferencia("83.33", "83.34", "declarada", "0.01"))).toBeTruthy();
  });

  it("con permiso, un mes sin prorrata usada ofrece ingresarla", async () => {
    montar();
    expect(await screen.findByLabelText(M.campoUsada)).toBeTruthy();
    expect(screen.getByText(M.sinUsada)).toBeTruthy();
  });
});

describe("<ProrrataCliente /> · obtener declaraciones (CA-1, D-3)", () => {
  it("202: manda {periodo} del mes elegido, muestra el seguimiento y al completar vuelve a leer la vista", async () => {
    let lecturas = 0;
    const f = instalarFetchProrrata({
      vista: () => {
        lecturas += 1;
        return vistaDe(
          lecturas === 1
            ? { ultimaObtencion: null }
            : { ultimaObtencion: { obtenidaEn: OBTENIDA_EN, periodosSinDeclaracion: ["202511"] } },
        );
      },
      extra: { [RUTA_OBTENER]: ACEPTADA },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    const b = await botonObtener();
    await screen.findByText(M.sinObtencion);
    await usuario.click(b);

    await vi.waitFor(() => expect(f.de(RUTA_OBTENER)).toHaveLength(1));
    expect(f.de(RUTA_OBTENER)[0]!.body).toEqual({ periodo: "202610" });
    expect(f.de(RUTA_OBTENER)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(await screen.findByText(M.obteniendo)).toBeTruthy();
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    const antes = f.de(RUTA_VISTA).length;

    emitir("ejecutando");
    expect(screen.getByText(M.obteniendo)).toBeTruthy();
    emitir("completado");

    await vi.waitFor(() => expect(f.de(RUTA_VISTA).length).toBeGreaterThan(antes));
    expect(await screen.findByText(M.ultimaObtencion(OBTENIDA_EN))).toBeTruthy();
    expect(screen.getByText(M.sinDeclaracion(["202511"]))).toBeTruthy();
    expect(screen.queryByText(M.obteniendo)).toBeNull();
  });

  it("un evento de OTRO trabajo no completa la obtención", async () => {
    const { f, usuario } = montar({ extra: { [RUTA_OBTENER]: ACEPTADA } });
    await usuario.click(await botonObtener());
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    const antes = f.de(RUTA_VISTA).length;

    emitir("completado", null, "00000000-0000-4000-8000-0000000000aa");
    await asentar();

    expect(screen.getByText(M.obteniendo)).toBeTruthy();
    expect(f.de(RUTA_VISTA)).toHaveLength(antes);
  });

  it("el trabajo termina con error: alerta en español, sin el motivo técnico", async () => {
    const { usuario } = montar({ extra: { [RUTA_OBTENER]: ACEPTADA } });
    await usuario.click(await botonObtener());
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());

    emitir("error", "credencial_invalida");

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(M.obtencionFallida);
    expect(alerta.textContent).not.toContain("credencial_invalida");
    expect(screen.queryByText(M.obteniendo)).toBeNull();
  });

  it("mientras se obtiene no se puede pedir otra vez", async () => {
    const { f, usuario } = montar({ extra: { [RUTA_OBTENER]: ACEPTADA } });
    const b = await botonObtener();
    await usuario.click(b);
    await screen.findByText(M.obteniendo);
    expect(b.disabled).toBe(true);
    await usuario.click(b);
    expect(f.de(RUTA_OBTENER)).toHaveLength(1);
  });

  it("el periodo elegido es el que se manda", async () => {
    const { f, usuario } = montar({ extra: { [RUTA_OBTENER]: ACEPTADA }, vista: (p) => vistaDe({ periodo: p ?? PERIODO_M }) });
    await usuario.selectOptions(await selector(), "202607");
    await vi.waitFor(() => expect(f.de(RUTA_VISTA).map((l) => consultaDeLlamada(l.url).get("periodo"))).toContain("202607"));
    await usuario.click(await botonObtener());
    await vi.waitFor(() => expect(f.de(RUTA_OBTENER)).toHaveLength(1));
    expect(f.de(RUTA_OBTENER)[0]!.body).toEqual({ periodo: "202607" });
  });

  it.each([
    [409, "cliente_archivado", M.errores.cliente_archivado],
    [409, "credencial_no_configurada", M.errores.credencial_no_configurada],
    [409, "credencial_invalida", M.errores.credencial_invalida],
    [400, "periodo_futuro", M.errores.periodo_futuro],
    [403, "permiso_denegado", M.sinPermiso],
  ])("%i %s: alerta en español, sin el código y sin seguir ningún trabajo", async (status, codigo, texto) => {
    const { usuario } = montar({ extra: { [RUTA_OBTENER]: { status, cuerpo: { codigo } } } });
    await usuario.click(await botonObtener());

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain(texto);
    expect(alerta.textContent).not.toContain(codigo);
    expect(seguimiento.opciones).toBeNull();
  });

  it("cliente archivado: botón deshabilitado con el motivo a la vista, sin llamar", async () => {
    const { f, usuario } = montar({ extra: { [RUTA_OBTENER]: ACEPTADA } }, true);
    const b = await botonObtener();
    expect(b.disabled).toBe(true);
    expect(screen.getByText(M.errores.cliente_archivado)).toBeTruthy();
    await usuario.click(b);
    expect(f.de(RUTA_OBTENER)).toHaveLength(0);
  });
});

describe("<ProrrataCliente /> · mes manual e historial desde la pantalla (CA-4)", () => {
  const vistaConFalta = (): ProrrataVistaPrueba =>
    vistaDe({
      ventana: ventanaMixta(),
      coeficiente: { estado: "faltan_meses", faltantes: ["202511"] },
      igvEstimado: { estado: "no_estimable", motivo: "coeficiente" },
    });

  it("«Ingresar a mano» abre el diálogo; al guardar se vuelve a leer la vista y el diálogo se cierra", async () => {
    let lecturas = 0;
    const f = instalarFetchProrrata({
      vista: () => {
        lecturas += 1;
        return lecturas === 1 ? vistaConFalta() : conMes(vistaDe({ ventana: ventanaMixta() }), mesFaltaDe("202511", { origen: "manual" }));
      },
      extra: { [rutaMes("202511")]: { status: 200, cuerpo: { version: 1 } } },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.ingresarAMano("202511") }));
    const d = await screen.findByRole("dialog", { name: M.tituloManual("202511") });

    await usuario.type(within(d).getByLabelText(M.campos.gravadas), "0");
    await usuario.type(within(d).getByLabelText(M.campos.exportaciones), "0");
    await usuario.type(within(d).getByLabelText(M.campos.noGravadas), "0");
    await usuario.type(within(d).getByLabelText(M.campos.motivo), "Antes del inicio de actividades");
    const antes = f.de(RUTA_VISTA).length;
    await usuario.click(within(d).getByRole("button", { name: M.guardar }));

    await vi.waitFor(() => expect(f.de(rutaMes("202511"))).toHaveLength(1));
    expect((f.de(rutaMes("202511"))[0]!.body as Record<string, unknown>).version).toBe(0);
    await vi.waitFor(() => expect(f.de(RUTA_VISTA).length).toBeGreaterThan(antes));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("el enlace del mes faltante lleva a su fila (el ancla existe en la tabla)", async () => {
    montar({ vista: vistaConFalta() });
    const enlace = await screen.findByRole("link", { name: M.ingresarFaltante("202511") });
    const destino = document.getElementById(enlace.getAttribute("href")!.slice(1));
    expect(destino).not.toBeNull();
    expect(destino!.textContent).toContain("2025-11");
  });

  it("«Historial» abre el historial del mes", async () => {
    const f = instalarFetchProrrata({
      extra: { [rutaHistorial("202602")]: { status: 200, cuerpo: { declaraciones: [], manual: [] } } },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole("button", { name: M.historial("202602") }));
    expect(await screen.findByRole("dialog", { name: M.tituloHistorial("202602") })).toBeTruthy();
    await vi.waitFor(() => expect(f.de(rutaHistorial("202602"))).toHaveLength(1));
  });
});

describe("<ProrrataCliente /> · permisos (CA-9)", () => {
  it("Asistente y Lectura ven todo pero sin «Obtener declaraciones», «Ingresar a mano» ni ingreso de la prorrata usada", async () => {
    montar({ permisos: PERMISOS_SOLO_VER, vista: vistaDe({ ventana: ventanaMixta() }) });
    await screen.findByRole("table", { name: M.tablaMeses });
    await asentar();
    expect(screen.queryByRole("button", { name: M.obtener })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Ingresar a mano / })).toHaveLength(0);
    expect(screen.queryByLabelText(M.campoUsada)).toBeNull();
    expect(screen.queryByRole("button", { name: M.guardarUsada })).toBeNull();
    // Sí ve el historial y los resultados.
    expect(screen.getAllByRole("button", { name: /^Historial / })).toHaveLength(12);
    expect(screen.getByRole("img", { name: M.tituloGrafico })).toBeTruthy();
  });

  it("con prorrata.gestionar hay botones en los meses sin declaración (manual, SIRE y falta)", async () => {
    montar({ vista: vistaDe({ ventana: ventanaMixta() }) });
    await screen.findByRole("table", { name: M.tablaMeses });
    await botonObtener();
    expect(screen.getAllByRole("button", { name: /^Ingresar a mano / })).toHaveLength(3);
  });
});

describe("<ProrrataCliente /> · errores de lectura", () => {
  it("404: «no se encontró» y nada más (ni botones ni tabla)", async () => {
    montar({ vista: undefined, extra: { [RUTA_VISTA]: { status: 404, cuerpo: { codigo: "no_encontrado" } } } });
    expect((await screen.findByRole("alert")).textContent).toContain(M.noEncontrado);
    await asentar();
    expect(screen.queryByRole("button", { name: M.obtener })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("403: mensaje de permiso", async () => {
    montar({ extra: { [RUTA_VISTA]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } } });
    expect((await screen.findByRole("alert")).textContent).toContain(M.sinPermiso);
  });

  it("500: mensaje de error de carga", async () => {
    montar({ extra: { [RUTA_VISTA]: { status: 500, cuerpo: {} } } });
    expect((await screen.findByRole("alert")).textContent).toContain(M.errorCarga);
  });

  it("IGV distinto en la lectura siguiente (DG → DGNG): la pantalla muestra lo nuevo sin recargar a mano", async () => {
    let n = 0;
    const f = instalarFetchProrrata({
      vista: () => {
        n += 1;
        return vistaDe({ igvEstimado: n === 1 ? igvDe() : igvDe({ resultado: "9000.00", creditoDg: "6000.00", igvDgng: "6600.00", creditoDgng: "5500.00" }) });
      },
      extra: { [RUTA_OBTENER]: ACEPTADA },
    });
    render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
    const usuario = userEvent.setup();
    await screen.findByText(M.componentes.igvVentas);
    expect(valorDe(M.situacion.a_pagar)).toBe("6,000.00");
    await usuario.click(await botonObtener());
    await vi.waitFor(() => expect(seguimiento.opciones).not.toBeNull());
    emitir("completado");
    await vi.waitFor(() => expect(valorDe(M.situacion.a_pagar)).toBe("9,000.00"));
    expect(f.de(RUTA_VISTA).length).toBeGreaterThanOrEqual(2);
  });
});

describe("<ProrrataCliente /> · 390 px", () => {
  it("la pantalla y los diálogos no fijan anchos mayores a la pantalla ni esconden nada tras un scroll horizontal", async () => {
    const { r, usuario } = montar({ vista: vistaDe({ ventana: ventanaMixta() }) });
    await screen.findByRole("table", { name: M.tablaMeses });
    expect(anchosFijosMayoresA390(r.container)).toEqual([]);
    await usuario.click(await screen.findByRole("button", { name: M.ingresarAMano("202511") }));
    await screen.findByRole("dialog", { name: M.tituloManual("202511") });
    expect(anchosFijosMayoresA390(document.body)).toEqual([]);
  });
});

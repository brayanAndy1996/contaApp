import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import { asentar } from "../../pruebas/acceso";
import { TEXTO_HOSTIL, uuidDe } from "../../pruebas/compras";
import {
  CAND_A,
  CAND_ACTIVADA,
  CAND_B,
  CAND_DESCARTADA,
  CAND_DISTINTO,
  CAND_SIN,
  CAND_YA,
  IMPORTACION_ID,
  MENSAJES_APRENDIZAJE as M,
  PERMISOS_SOLO_VER,
  RUTA_ACTIVAR,
  RUTA_CANDIDATAS,
  RUTA_DESCARTAR,
  RUTA_ULTIMA,
  anchosFijosMayoresA390,
  candidataDe,
  consultaDeLlamada,
  conteosSinCriterio,
  frecuencia,
  instalarFetchAprendizaje,
  rutaGrilla,
  rutaReemplazar,
} from "../../pruebas/aprendizaje";
import { CandidatasImportadas } from "./candidatas-importadas";

// Spec 025 · T7 (rojo; CA-3, CA-4, CA-8, CA-12, D-5, D-6, U-6, U-8). Revisar las candidatas de la importación.
// Contrato (T13), `components/reglas/candidatas-importadas.tsx`: <CandidatasImportadas clienteId="c-1" />, sin más props.
//   - Lee GET …/reglas/importaciones/ultima ({importacion}), GET /api/acceso/yo y GET …/reglas/candidatas?grupo=&cursor=&limite=
//     ({candidatas, siguiente}); sin importación muestra `sinImportacion` y nada más.
//   - Pestañas (role tab, el nombre empieza por el texto; puede llevar un conteo): «Propuestas» (la inicial, grupo=propuestas),
//     «Sin criterio claro», «Con conflicto» y «Resueltas». Cada candidata es un elemento `[data-candidata=<id>]` (fila o tarjeta).
//   - Propuestas: casilla «Seleccionar candidata de <RUC>», combobox «Destino de <RUC>» (DG, DGNG, DNG; el propuesto de
//     inicio) y la frecuencia «11 de 12 comprobantes en DNG · en 5 de 6 periodos» (los mixtos aparte: «· 1 mixto»).
//     «Activar seleccionadas» → POST …/candidatas/activar {items: [{id, destino?}]} con `destino` solo si se cambió;
//     «Descartar seleccionadas» → POST …/candidatas/descartar {ids}. Ambos deshabilitados sin selección.
//   - Sin criterio claro (U-8): sin casillas; combobox «Destino de <RUC>» con la opción vacía «Elige un destino»; el botón
//     «Activar candidata de <RUC>» queda deshabilitado hasta elegir y manda {items: [{id, destino}]}.
//   - Con conflicto (D-6): «Regla vigente: <destino>»; si es `distinto`, «Reemplazar regla de <RUC>» → POST
//     …/candidatas/:id/reemplazar {versionRegla: regla.version} (más `destino` si se cambió); si es `ya_aprendida` solo el aviso
//     «Ya aprendida…», sin casilla ni botón. 409 regla_cambiada → role alert con el texto de 021 y se vuelve a leer la lista.
//   - Resueltas: estado en texto («Activada», «Descartada»…) sin acciones.
//   - Tras activar o descartar: anuncio en role status («2 reglas activadas.»), lista vuelta a leer; tras activar, aviso de U-6
//     («Las reglas rigen desde la próxima descarga…») con el enlace «Ver compras del periodo» a la grilla filtrada por el proveedor.
//   - «Activar todas» en Propuestas (con `reglas.gestionar`): confirma y manda {todas: true, importacionId} (ver activar-candidatas).
//   - Sin `reglas.gestionar`: se ve todo, sin casillas ni botones de acción. La razón social se ve siempre como texto.
// Los datos son de ejemplo; ningún RUC ni razón social sale en errores ni en el anuncio de estado (CA-12).

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const montar = () => {
  const resultado = render(<CandidatasImportadas clienteId="c-1" />);
  return { resultado, usuario: userEvent.setup() };
};

const filaDe = async (id: string): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-candidata="${id}"]`);
    if (!el) throw new Error(`no hay candidata ${id}`);
    return el;
  });
const hay = (id: string) => document.querySelector(`[data-candidata="${id}"]`) !== null;
const pestana = (nombre: string) => screen.findByRole("tab", { name: new RegExp(`^${nombre}`) });
const gruposPedidos = (f: ReturnType<typeof instalarFetchAprendizaje>) =>
  f.de(RUTA_CANDIDATAS).map((l) => consultaDeLlamada(l.url).get("grupo"));

describe("<CandidatasImportadas /> · Propuestas (CA-3)", () => {
  it("feliz: pide el grupo «propuestas» y lista proveedor, destino propuesto y frecuencia en texto", async () => {
    const f = instalarFetchAprendizaje();
    montar();

    const a = await filaDe(CAND_A.id);
    expect(within(a).getByText(/20100070970/)).toBeTruthy();
    expect(within(a).getByText(/PROVEEDOR PRUEBA S\.A\.C\./)).toBeTruthy();
    expect(within(a).getByText(frecuencia(CAND_A), { exact: false })).toBeTruthy();
    expect((within(a).getByRole("combobox", { name: M.campoDestino("20100070970") }) as HTMLSelectElement).value).toBe("DNG");

    const b = await filaDe(CAND_B.id);
    expect(within(b).getByText(frecuencia(CAND_B), { exact: false })).toBeTruthy();
    expect((within(b).getByRole("combobox", { name: M.campoDestino("20700000011") }) as HTMLSelectElement).value).toBe("DG");

    // Solo las propuestas: ni las sin criterio, ni las de conflicto, ni las resueltas.
    for (const otra of [CAND_SIN, CAND_DISTINTO, CAND_YA, CAND_ACTIVADA, CAND_DESCARTADA]) expect(hay(otra.id)).toBe(false);
    expect(gruposPedidos(f)).toEqual(["propuestas"]);
    for (const nombre of Object.values(M.pestanas)) expect(await pestana(nombre)).toBeTruthy();
  });

  it("la razón social del SIRE se ve como texto, sin interpretarse (CA-12)", async () => {
    instalarFetchAprendizaje({
      candidatas: [candidataDe({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: TEXTO_HOSTIL } })],
    });
    montar();

    expect(await screen.findByText(TEXTO_HOSTIL, { exact: false })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });

  it("sin importación: avisa que aún no se importó y no pide candidatas", async () => {
    const f = instalarFetchAprendizaje({ importacion: null });
    montar();

    expect(await screen.findByText(M.sinImportacion)).toBeTruthy();
    await asentar();
    expect(f.de(RUTA_CANDIDATAS)).toHaveLength(0);
  });

  it("error 403 al leer: mensaje genérico de permiso", async () => {
    instalarFetchAprendizaje({
      extra: { [RUTA_CANDIDATAS]: { status: 403, cuerpo: { codigo: "permiso_denegado" } } },
    });
    montar();

    expect((await screen.findByRole("alert")).textContent).toContain(M.sinPermiso);
  });

  it("con más de una página: «Cargar más» pide el cursor que dio el servidor y agrega sin repetir", async () => {
    const muchas = Array.from({ length: 5 }, (_, i) =>
      candidataDe({
        id: uuidDe(27, i + 1),
        proveedor: { tipo: "6", numero: `2070000${String(i + 1).padStart(4, "0")}`, razonSocial: `PROVEEDOR ${i + 1}` },
      }),
    );
    const f = instalarFetchAprendizaje({
      candidatas: muchas,
      extra: {
        [RUTA_CANDIDATAS]: (llamada) => {
          const consulta = consultaDeLlamada(llamada.url);
          const desde = Number(consulta.get("cursor") ?? "0");
          const trozo = muchas.slice(desde, desde + 3);
          return {
            status: 200,
            cuerpo: { candidatas: trozo, siguiente: desde + 3 < muchas.length ? String(desde + 3) : null },
          };
        },
      },
    });
    const { usuario } = montar();
    await filaDe(muchas[2]!.id);
    expect(hay(muchas[3]!.id)).toBe(false);

    await usuario.click(screen.getByRole("button", { name: M.cargarMas }));

    await filaDe(muchas[4]!.id);
    expect(document.querySelectorAll("[data-candidata]")).toHaveLength(5);
    expect(consultaDeLlamada(f.de(RUTA_CANDIDATAS)[1]!.url).get("cursor")).toBe("3");
    expect(screen.queryByRole("button", { name: M.cargarMas })).toBeNull();
  });
});

describe("<CandidatasImportadas /> · activar y descartar (CA-3, D-5)", () => {
  it("activar dos seleccionadas con el destino de una cambiado: manda destino solo en la cambiada, anuncia y avisa de U-6", async () => {
    const f = instalarFetchAprendizaje({
      extra: {
        [RUTA_ACTIVAR]: { status: 200, cuerpo: { activadas: [CAND_A.id, CAND_B.id], omitidas: [] } },
      },
    });
    const { usuario } = montar();
    const a = await filaDe(CAND_A.id);
    const b = await filaDe(CAND_B.id);
    const activar = screen.getByRole("button", { name: M.activarSeleccionadas }) as HTMLButtonElement;
    expect(activar.disabled).toBe(true);

    await usuario.click(within(a).getByRole("checkbox", { name: M.seleccionar("20100070970") }));
    await usuario.click(within(b).getByRole("checkbox", { name: M.seleccionar("20700000011") }));
    await usuario.selectOptions(within(b).getByRole("combobox", { name: M.campoDestino("20700000011") }), "DGNG");
    expect(activar.disabled).toBe(false);
    await usuario.click(activar);

    await vi.waitFor(() => expect(f.de(RUTA_ACTIVAR)).toHaveLength(1));
    expect(f.de(RUTA_ACTIVAR)[0]!.body).toEqual({ items: [{ id: CAND_A.id }, { id: CAND_B.id, destino: "DGNG" }] });
    expect(f.de(RUTA_ACTIVAR)[0]!.headers["x-csrf-token"]).toBeTruthy();
    expect(await screen.findByText(M.reglasActivadas(2))).toBeTruthy();
    // La lista se vuelve a leer del servidor (la fuente de verdad), no se edita a mano.
    await vi.waitFor(() => expect(f.de(RUTA_CANDIDATAS).length).toBeGreaterThanOrEqual(2));
    // U-6: aviso y enlace a la grilla filtrada por proveedor.
    expect(screen.getByText(M.avisoPeriodoCargado)).toBeTruthy();
    const enlace = screen.getAllByRole("link", { name: M.irAGrilla })[0] as HTMLAnchorElement;
    expect(enlace.getAttribute("href")).toMatch(/^\/clientes\/c-1\/compras\?periodo=\d{6}&q=(20100070970|20700000011)$/);
  });

  it("activar una sola con su destino propuesto: el enlace de U-6 filtra por ese proveedor", async () => {
    instalarFetchAprendizaje({
      candidatas: [CAND_A],
      extra: { [RUTA_ACTIVAR]: { status: 200, cuerpo: { activadas: [CAND_A.id], omitidas: [] } } },
    });
    const { usuario } = montar();
    const a = await filaDe(CAND_A.id);

    await usuario.click(within(a).getByRole("checkbox", { name: M.seleccionar("20100070970") }));
    await usuario.click(screen.getByRole("button", { name: M.activarSeleccionadas }));

    expect(await screen.findByText(M.reglasActivadas(1))).toBeTruthy();
    const enlace = screen.getByRole("link", { name: M.irAGrilla }) as HTMLAnchorElement;
    expect(enlace.getAttribute("href")).toMatch(/^\/clientes\/c-1\/compras\?periodo=\d{6}&q=20100070970$/);
    expect(rutaGrilla("202611", "20100070970")).toContain("q=20100070970");
  });

  it("descartar la seleccionada manda {ids}, anuncia y no crea reglas", async () => {
    const f = instalarFetchAprendizaje({
      extra: { [RUTA_DESCARTAR]: { status: 200, cuerpo: { descartadas: [CAND_B.id], omitidas: [] } } },
    });
    const { usuario } = montar();
    const b = await filaDe(CAND_B.id);
    const descartar = screen.getByRole("button", { name: M.descartarSeleccionadas }) as HTMLButtonElement;
    expect(descartar.disabled).toBe(true);

    await usuario.click(within(b).getByRole("checkbox", { name: M.seleccionar("20700000011") }));
    await usuario.click(descartar);

    await vi.waitFor(() => expect(f.de(RUTA_DESCARTAR)).toHaveLength(1));
    expect(f.de(RUTA_DESCARTAR)[0]!.body).toEqual({ ids: [CAND_B.id] });
    expect(await screen.findByText(M.candidatasDescartadas(1))).toBeTruthy();
    expect(f.de(RUTA_ACTIVAR)).toHaveLength(0);
    expect(screen.queryByText(M.avisoPeriodoCargado)).toBeNull();
  });

  it("409 cliente_archivado al activar: el mensaje de solo lectura y sin anuncio de éxito", async () => {
    instalarFetchAprendizaje({
      extra: { [RUTA_ACTIVAR]: { status: 409, cuerpo: { codigo: "cliente_archivado" } } },
    });
    const { usuario } = montar();
    const a = await filaDe(CAND_A.id);

    await usuario.click(within(a).getByRole("checkbox", { name: M.seleccionar("20100070970") }));
    await usuario.click(screen.getByRole("button", { name: M.activarSeleccionadas }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(M.errores.cliente_archivado);
    expect(alerta.textContent).not.toContain("cliente_archivado");
    expect(screen.queryByText(M.reglasActivadas(1))).toBeNull();
  });

  it("«Activar todas» confirma y manda {todas: true, importacionId}", async () => {
    const f = instalarFetchAprendizaje({
      extra: { [RUTA_ACTIVAR]: { status: 200, cuerpo: { activadas: [CAND_A.id, CAND_B.id], omitidas: [] } } },
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(await screen.findByRole("button", { name: M.activarTodas }));
    const dialogo = await screen.findByRole("dialog");
    expect(f.de(RUTA_ACTIVAR)).toHaveLength(0);
    await usuario.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await vi.waitFor(() => expect(f.de(RUTA_ACTIVAR)).toHaveLength(1));
    expect(f.de(RUTA_ACTIVAR)[0]!.body).toEqual({ todas: true, importacionId: IMPORTACION_ID });
  });
});

describe("<CandidatasImportadas /> · sin criterio claro (U-8)", () => {
  it("se listan aparte con sus conteos y sin casillas: solo se activan de una en una eligiendo el destino", async () => {
    const f = instalarFetchAprendizaje({
      extra: { [RUTA_ACTIVAR]: { status: 200, cuerpo: { activadas: [CAND_SIN.id], omitidas: [] } } },
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(await pestana(M.pestanas.sin_criterio));

    const fila = await filaDe(CAND_SIN.id);
    expect(gruposPedidos(f)).toContain("sin_criterio");
    expect(within(fila).getByText(conteosSinCriterio(CAND_SIN), { exact: false })).toBeTruthy();
    expect(within(fila).queryByRole("checkbox")).toBeNull();
    const destino = within(fila).getByRole("combobox", { name: M.campoDestino("20700000045") }) as HTMLSelectElement;
    expect(destino.value).toBe("");
    expect(within(destino).getByRole("option", { name: M.elegirDestino })).toBeTruthy();
    const activar = within(fila).getByRole("button", { name: M.activarUna("20700000045") }) as HTMLButtonElement;
    expect(activar.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: M.activarTodas })).toBeNull();

    await usuario.selectOptions(destino, "DNG");
    expect(activar.disabled).toBe(false);
    await usuario.click(activar);

    await vi.waitFor(() => expect(f.de(RUTA_ACTIVAR)).toHaveLength(1));
    expect(f.de(RUTA_ACTIVAR)[0]!.body).toEqual({ items: [{ id: CAND_SIN.id, destino: "DNG" }] });
    expect(await screen.findByText(M.reglasActivadas(1))).toBeTruthy();
  });
});

describe("<CandidatasImportadas /> · con conflicto (CA-4, D-6)", () => {
  it("muestra la regla vigente; «Reemplazar» manda la versión de esa regla y nunca sobrescribe sola", async () => {
    const f = instalarFetchAprendizaje({
      extra: {
        [rutaReemplazar(CAND_DISTINTO.id)]: {
          status: 200,
          cuerpo: { regla: { id: CAND_DISTINTO.regla!.id, destino: "DNG", version: 4 } },
        },
      },
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(await pestana(M.pestanas.conflicto));

    const distinta = await filaDe(CAND_DISTINTO.id);
    expect(within(distinta).getByText(M.reglaVigente("DG"), { exact: false })).toBeTruthy();
    expect(within(distinta).queryByRole("checkbox")).toBeNull();
    const ya = await filaDe(CAND_YA.id);
    expect(within(ya).getByText(M.yaAprendida, { exact: false })).toBeTruthy();
    expect(within(ya).queryByRole("button", { name: M.reemplazar("20700000061") })).toBeNull();
    expect(within(ya).queryByRole("checkbox")).toBeNull();
    // Nada se manda hasta que el contador pulsa «Reemplazar».
    expect(f.llamadas.filter((l) => l.method === "POST")).toHaveLength(0);

    await usuario.click(within(distinta).getByRole("button", { name: M.reemplazar("20700000053") }));

    await vi.waitFor(() => expect(f.de(rutaReemplazar(CAND_DISTINTO.id))).toHaveLength(1));
    expect(f.de(rutaReemplazar(CAND_DISTINTO.id))[0]!.body).toEqual({ versionRegla: 3 });
    expect(await screen.findByText(M.reglaReemplazada)).toBeTruthy();
  });

  it("409 regla_cambiada al reemplazar: el mensaje de 021, sin el código, y la lista se vuelve a leer", async () => {
    const f = instalarFetchAprendizaje({
      extra: {
        [rutaReemplazar(CAND_DISTINTO.id)]: { status: 409, cuerpo: { codigo: "regla_cambiada" } },
      },
    });
    const { usuario } = montar();
    await filaDe(CAND_A.id);
    await usuario.click(await pestana(M.pestanas.conflicto));
    const distinta = await filaDe(CAND_DISTINTO.id);
    const lecturas = f.de(RUTA_CANDIDATAS).length;

    await usuario.click(within(distinta).getByRole("button", { name: M.reemplazar("20700000053") }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toBe(M.reglaCambiada);
    expect(alerta.textContent).not.toContain("regla_cambiada");
    await vi.waitFor(() => expect(f.de(RUTA_CANDIDATAS).length).toBeGreaterThan(lecturas));
  });

  it("«Activar todas» no existe en esta pestaña (omite los conflictos)", async () => {
    instalarFetchAprendizaje();
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(await pestana(M.pestanas.conflicto));
    await filaDe(CAND_DISTINTO.id);

    expect(screen.queryByRole("button", { name: M.activarTodas })).toBeNull();
  });
});

describe("<CandidatasImportadas /> · resueltas", () => {
  it("se ve su estado en texto y no tienen acciones", async () => {
    instalarFetchAprendizaje();
    const { usuario } = montar();
    await filaDe(CAND_A.id);

    await usuario.click(await pestana(M.pestanas.resueltas));

    const activada = await filaDe(CAND_ACTIVADA.id);
    expect(within(activada).getByText(M.estados.activada)).toBeTruthy();
    const descartada = await filaDe(CAND_DESCARTADA.id);
    expect(within(descartada).getByText(M.estados.descartada)).toBeTruthy();
    expect(within(activada).queryByRole("button")).toBeNull();
    expect(within(activada).queryByRole("checkbox")).toBeNull();
    expect(within(descartada).queryByRole("button")).toBeNull();
  });
});

describe("<CandidatasImportadas /> · permisos (CA-8)", () => {
  it("sin reglas.gestionar se ven las candidatas pero no hay casillas, activar, descartar, reemplazar ni «Activar todas»", async () => {
    instalarFetchAprendizaje({ permisos: PERMISOS_SOLO_VER });
    const { usuario } = montar();

    const a = await filaDe(CAND_A.id);
    expect(within(a).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: M.activarSeleccionadas })).toBeNull();
    expect(screen.queryByRole("button", { name: M.descartarSeleccionadas })).toBeNull();
    expect(screen.queryByRole("button", { name: M.activarTodas })).toBeNull();

    await usuario.click(await pestana(M.pestanas.sin_criterio));
    const sin = await filaDe(CAND_SIN.id);
    expect(within(sin).queryByRole("button", { name: M.activarUna("20700000045") })).toBeNull();

    await usuario.click(await pestana(M.pestanas.conflicto));
    const distinta = await filaDe(CAND_DISTINTO.id);
    expect(within(distinta).queryByRole("button", { name: M.reemplazar("20700000053") })).toBeNull();
  });
});

describe("<CandidatasImportadas /> · 390 px", () => {
  it("las candidatas no fijan anchos mayores a la pantalla ni esconden nada tras un scroll interior", async () => {
    instalarFetchAprendizaje();
    const { resultado } = montar();
    await filaDe(CAND_A.id);

    expect(anchosFijosMayoresA390(resultado.container)).toEqual([]);
    expect(document.querySelector("[data-candidata]")).not.toBeNull();
  });
});

// La última importación solo se lee una vez al abrir; el id de la importación sale de ella, no de la lista.
describe("<CandidatasImportadas /> · lecturas", () => {
  it("lee la última importación una vez y no manda ninguna escritura al abrir", async () => {
    const f = instalarFetchAprendizaje();
    montar();
    await filaDe(CAND_A.id);

    expect(f.de(RUTA_ULTIMA)).toHaveLength(1);
    expect(f.llamadas.filter((l) => l.method !== "GET")).toHaveLength(0);
  });
});

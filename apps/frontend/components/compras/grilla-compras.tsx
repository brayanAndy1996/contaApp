"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTable, type Column, type Row } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ColumnaMontoCompra, FilaCompraVista } from "@contapp/shared";
import { MENSAJES_COMPRAS as M } from "../../lib/compras";
import { conMiles, destinoDe } from "../../lib/montos-compras";
import {
  COLUMNAS_COMPRAS,
  ENCABEZADOS,
  FEATURES_COMPRAS,
  FIJAS_COMPRAS,
  GRUPO_DE_COLUMNA,
  ORDEN_SECCIONES,
  TEXTOS_GRILLA as T,
  TITULO_SECCION,
  esMonto,
  seccionDe,
  type SeccionCompras,
} from "./columnas-compras";

// Grilla de compras del periodo (spec 015, T4; D-5, D-16; P-5, P-8; RF-061). Solo lectura aquí: la edición
// de las celdas es de T6. TanStack Table 9 da el modelo de columnas y filas (con las columnas fijas y los
// anchos) y TanStack Virtual la ventana de filas y de columnas: con miles de filas solo hay en el DOM las
// visibles más un margen. El marcado, el teclado y la accesibilidad (`role="grid"`) son propios.
//
// Los montos son cadenas del servidor: aquí solo se les da formato (`conMiles`); nada se calcula. La razón
// social, el motivo y la explicación vienen del SIRE y son texto no confiable: React los escapa.

const ALTO_FILA = 52;
const ALTO_SECCION = 30;
const ALTO_GRUPO = 28;
const ALTO_ENCABEZADO = 36;
const ALTO_CABECERA = ALTO_GRUPO + ALTO_ENCABEZADO;
const SALTO_PAGINA = 10;
const MARGEN_FILAS = 6;
const MARGEN_COLUMNAS = 2;

export interface PropsGrillaCompras {
  filas: readonly FilaCompraVista[];
  cargando: boolean;
  seleccion: ReadonlySet<string>;
  alCambiarSeleccion: (seleccion: Set<string>) => void;
  /** Filas a resaltar (afectadas por deshacer o por «Ver filas»). */
  resaltadas?: ReadonlySet<string>;
  /** Motivo legible de solo lectura (`ContextoCompras.soloLectura`) o `null`. La edición es de T6. */
  soloLectura?: string | null;
  /** Guardado de una fila editada (T6): `versionBase` y solo las celdas cambiadas. */
  alGuardarFila?: (
    id: string,
    versionBase: number,
    cambios: Partial<Record<ColumnaMontoCompra, string>>,
  ) => Promise<void> | void;
  renderAcciones: (fila: FilaCompraVista) => ReactNode;
  alAbrirHistorial: (id: string) => void;
}

type Item =
  | { tipo: "seccion"; clave: string; seccion: SeccionCompras; n: number }
  | { tipo: "fila"; clave: string; fila: Row<typeof FEATURES_COMPRAS, FilaCompraVista>; r: number };

type ColumnaGrilla = Column<typeof FEATURES_COMPRAS, FilaCompraVista, unknown>;

interface Activa {
  r: number;
  c: number;
}

/** Agrupa tramos consecutivos de columnas del centro con el mismo grupo de encabezado. */
function tramosDeGrupo(centro: readonly ColumnaGrilla[]): { titulo: string; ancho: number }[] {
  const tramos: { titulo: string; ancho: number }[] = [];
  for (const columna of centro) {
    const titulo = GRUPO_DE_COLUMNA[columna.id] ?? "";
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && ultimo.titulo === titulo) ultimo.ancho += columna.getSize();
    else tramos.push({ titulo, ancho: columna.getSize() });
  }
  return tramos;
}

/** Rango por defecto más los índices que deben seguir en el DOM (la celda activa conserva el foco). */
function conIndices(range: Range, extra: readonly number[]): number[] {
  const base = defaultRangeExtractor(range);
  const lista = new Set(base);
  for (const i of extra) if (i >= 0 && i < range.count) lista.add(i);
  return [...lista].sort((a, b) => a - b);
}

const limitar = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const CELDA =
  "flex h-full shrink-0 flex-col justify-center overflow-hidden border-b border-gray-200 px-2 text-sm bg-inherit focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-700";
const CELDA_MONTO = `${CELDA} items-end text-right tabular-nums`;

export function GrillaCompras({
  filas,
  cargando,
  seleccion,
  alCambiarSeleccion,
  resaltadas,
  renderAcciones,
  alAbrirHistorial,
}: PropsGrillaCompras) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enfocarRef = useRef(false);
  const [activaPedida, setActiva] = useState<Activa>({ r: 0, c: 0 });

  // Secciones «con IGV» / «sin IGV» / «excluidas»: orden estable dentro de cada una.
  const { datos, cuenta } = useMemo(() => {
    const porSeccion: Record<SeccionCompras, FilaCompraVista[]> = {
      con_igv: [],
      sin_igv: [],
      excluidas: [],
    };
    for (const f of filas) porSeccion[seccionDe(f)].push(f);
    return {
      datos: ORDEN_SECCIONES.flatMap((s) => porSeccion[s]),
      cuenta: {
        con_igv: porSeccion.con_igv.length,
        sin_igv: porSeccion.sin_igv.length,
        excluidas: porSeccion.excluidas.length,
      } as Record<SeccionCompras, number>,
    };
  }, [filas]);

  const table = useTable({
    features: FEATURES_COMPRAS,
    columns: COLUMNAS_COMPRAS,
    data: datos,
    getRowId: (f) => f.id,
    initialState: { columnPinning: { start: [...FIJAS_COMPRAS.start], end: [...FIJAS_COMPRAS.end] } },
  });

  const filasTabla = table.getRowModel().rows;
  const inicio = table.getStartLeafColumns();
  const centro = table.getCenterLeafColumns();
  const fin = table.getEndLeafColumns();
  const todas = useMemo(() => [...inicio, ...centro, ...fin], [inicio, centro, fin]);
  const anchoInicio = table.getStartTotalSize();
  const anchoCentro = table.getCenterTotalSize();
  const anchoFin = table.getEndTotalSize();
  const anchoTotal = anchoInicio + anchoCentro + anchoFin;

  // Elementos del tramo vertical: separadores de sección y filas. `filaAItem[r]` es el índice de la fila r.
  const { items, filaAItem } = useMemo(() => {
    const lista: Item[] = [];
    const indices: number[] = [];
    let actual: SeccionCompras | null = null;
    filasTabla.forEach((row, r) => {
      const seccion = seccionDe(row.original);
      if (seccion !== actual) {
        actual = seccion;
        lista.push({ tipo: "seccion", clave: `seccion-${seccion}`, seccion, n: cuenta[seccion] });
      }
      indices.push(lista.length);
      lista.push({ tipo: "fila", clave: row.id, fila: row, r });
    });
    return { items: lista, filaAItem: indices };
  }, [filasTabla, cuenta]);

  const nFilas = filaAItem.length;
  const nColumnas = todas.length;
  const activa: Activa = {
    r: limitar(activaPedida.r, 0, Math.max(0, nFilas - 1)),
    c: limitar(activaPedida.c, 0, Math.max(0, nColumnas - 1)),
  };
  const itemActivo = nFilas > 0 ? filaAItem[activa.r] : undefined;
  const centroActivo = activa.c - inicio.length;

  const filasVirtuales = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.tipo === "seccion" ? ALTO_SECCION : ALTO_FILA),
    getItemKey: (i) => items[i]?.clave ?? i,
    overscan: MARGEN_FILAS,
    scrollPaddingStart: ALTO_CABECERA,
    rangeExtractor: (range) => conIndices(range, itemActivo === undefined ? [] : [itemActivo]),
  });

  const columnasVirtuales = useVirtualizer({
    horizontal: true,
    count: centro.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => centro[i]?.getSize() ?? 100,
    getItemKey: (i) => centro[i]?.id ?? i,
    overscan: MARGEN_COLUMNAS,
    scrollMargin: anchoInicio,
    scrollPaddingStart: anchoInicio,
    scrollPaddingEnd: anchoFin,
    rangeExtractor: (range) => conIndices(range, centroActivo >= 0 ? [centroActivo] : []),
  });

  // El foco se pone tras renderizar: la celda activa siempre está en el DOM (la conservan los extractores).
  useEffect(() => {
    if (!enfocarRef.current) return;
    const celda = scrollRef.current?.querySelector<HTMLElement>(
      `[data-r="${activa.r}"][data-c="${activa.c}"]`,
    );
    if (celda) {
      enfocarRef.current = false;
      celda.focus({ preventScroll: true });
    }
  });

  function irA(r: number, c: number) {
    if (nFilas === 0) return;
    const rr = limitar(r, 0, nFilas - 1);
    const cc = limitar(c, 0, nColumnas - 1);
    setActiva({ r: rr, c: cc });
    enfocarRef.current = true;
    const item = filaAItem[rr];
    if (item !== undefined) filasVirtuales.scrollToIndex(item, { align: "auto" });
    const enCentro = cc - inicio.length;
    if (enCentro >= 0 && enCentro < centro.length) {
      columnasVirtuales.scrollToIndex(enCentro, { align: "auto" });
    }
  }

  function alternarSeleccion(id: string) {
    const siguiente = new Set(seleccion);
    if (siguiente.has(id)) siguiente.delete(id);
    else siguiente.add(id);
    alCambiarSeleccion(siguiente);
  }

  function alTeclear(e: KeyboardEvent<HTMLDivElement>) {
    const destino = e.target as HTMLElement;
    const esCelda = destino.getAttribute("role") === "gridcell" && destino.dataset.r !== undefined;
    if (!esCelda) {
      // Dentro de un control de la celda, Esc devuelve el foco a la celda.
      if (e.key === "Escape") {
        destino.closest<HTMLElement>('[role="gridcell"]')?.focus();
      }
      return;
    }
    if (e.altKey || e.metaKey) return;
    const { r, c } = activa;
    const ultimaCol = nColumnas - 1;
    const ultimaFila = nFilas - 1;
    switch (e.key) {
      case "ArrowRight":
        irA(r, c + 1);
        break;
      case "ArrowLeft":
        irA(r, c - 1);
        break;
      case "ArrowDown":
        irA(r + 1, c);
        break;
      case "ArrowUp":
        irA(r - 1, c);
        break;
      case "PageDown":
        irA(r + SALTO_PAGINA, c);
        break;
      case "PageUp":
        irA(r - SALTO_PAGINA, c);
        break;
      case "Home":
        if (e.ctrlKey) irA(0, 0);
        else irA(r, 0);
        break;
      case "End":
        if (e.ctrlKey) irA(ultimaFila, ultimaCol);
        else irA(r, ultimaCol);
        break;
      case "Tab": {
        // Tab recorre las celdas de la fila y sigue en la siguiente; en los extremos sale de la grilla.
        if (e.shiftKey) {
          if (c > 0) irA(r, c - 1);
          else if (r > 0) irA(r - 1, ultimaCol);
          else return;
        } else if (c < ultimaCol) irA(r, c + 1);
        else if (r < ultimaFila) irA(r + 1, 0);
        else return;
        break;
      }
      case " ":
      case "Spacebar": {
        const fila = filasTabla[r];
        if (!fila) return;
        alternarSeleccion(fila.id);
        break;
      }
      case "Enter":
      case "F2": {
        // Una celda con controles (casilla, acciones): Enter entra en el primero; Esc vuelve a la celda.
        const control = destino.querySelector<HTMLElement>("button, input, a[href], [tabindex='0']");
        if (!control) return;
        control.focus();
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  const itemsVirtuales = filasVirtuales.getVirtualItems();
  const columnasVisibles = columnasVirtuales.getVirtualItems();
  const margenIzq = columnasVisibles.length
    ? (columnasVisibles[0]?.start ?? anchoInicio) - anchoInicio
    : 0;
  const finVisible = columnasVisibles.length
    ? (columnasVisibles[columnasVisibles.length - 1]?.end ?? anchoInicio) - anchoInicio
    : 0;
  const margenDer = Math.max(0, anchoCentro - finVisible);

  // Posición fija de una columna de los extremos (sticky) dentro de su fila.
  function estiloFija(columna: ColumnaGrilla, region: "start" | "end"): CSSProperties {
    return {
      width: columna.getSize(),
      position: "sticky",
      zIndex: 10,
      ...(region === "start"
        ? { left: columna.getStart("start") }
        : { right: columna.getAfter("end") }),
    };
  }

  function celda(
    columna: ColumnaGrilla,
    fila: Row<typeof FEATURES_COMPRAS, FilaCompraVista>,
    r: number,
    c: number,
    estilo: CSSProperties,
  ) {
    const f = fila.original;
    const esActiva = activa.r === r && activa.c === c;
    const comprobante = `${f.serie}-${f.numero}`;
    const comun = {
      role: "gridcell" as const,
      "aria-colindex": c + 1,
      "data-r": r,
      "data-c": c,
      "data-col": columna.id,
      tabIndex: esActiva ? 0 : -1,
      style: estilo,
      onFocus: () => {
        if (activa.r !== r || activa.c !== c) setActiva({ r, c });
      },
    };
    const id = columna.id;

    if (id === "seleccionar") {
      return (
        <div key={id} {...comun} className={`${CELDA} items-center`}>
          <input
            type="checkbox"
            checked={seleccion.has(f.id)}
            onChange={() => alternarSeleccion(f.id)}
            tabIndex={esActiva ? 0 : -1}
            aria-label={M.seleccionarFila(comprobante)}
          />
        </div>
      );
    }
    if (id === "tipo") {
      return (
        <div key={id} {...comun} className={CELDA}>
          {f.tipo}
        </div>
      );
    }
    if (id === "comprobante") {
      const reglas = f.hallazgos.map((h) => h.regla).join(", ");
      const resaltada = resaltadas?.has(f.id) === true;
      return (
        <div key={id} {...comun} className={CELDA}>
          <span className="truncate font-medium">{comprobante}</span>
          <span className="flex flex-wrap items-center gap-x-1 text-xs">
            {f.hallazgos.length > 0 && (
              <span className="font-medium text-amber-900" title={f.hallazgos.map((h) => h.explicacion).join(" · ")}>
                <span aria-hidden="true">⚠ </span>
                {T.alertaDe(reglas)}
              </span>
            )}
            {f.origen === "agregada" && <span className="rounded border px-1">{M.agregada}</span>}
            {f.excluida && <span className="rounded border px-1">{M.excluida}</span>}
            {resaltada && <span className="rounded border border-blue-700 px-1 text-blue-900">{T.actualizada}</span>}
          </span>
        </div>
      );
    }
    if (id === "proveedor") {
      const razon = f.proveedor.razonSocial;
      return (
        <div key={id} {...comun} className={CELDA}>
          <span className="truncate" title={razon ?? undefined}>
            {razon ?? T.sinRazonSocial}
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-700">
            <span>
              {f.proveedor.tipo} {f.proveedor.numero}
            </span>
            {f.proveedorNuevo && (
              <span className="rounded border border-blue-700 px-1 font-medium text-blue-900">
                {M.proveedorNuevo}
              </span>
            )}
          </span>
        </div>
      );
    }
    if (id === "fecha") {
      return (
        <div key={id} {...comun} className={CELDA}>
          {f.fecha}
        </div>
      );
    }
    if (id === "moneda") {
      return (
        <div key={id} {...comun} className={CELDA}>
          <span>{f.moneda}</span>
          {f.tipoCambio !== null && (
            <span className="text-xs text-gray-700" title={M.columnas.tipoCambio}>
              TC {f.tipoCambio}
            </span>
          )}
        </div>
      );
    }
    if (id === "destino") {
      const destino = destinoDe(f.montos);
      return (
        <div key={id} {...comun} className={CELDA}>
          <span title={M.destinoAyuda}>{M.destinos[destino]}</span>
          <span className="text-xs text-gray-700">{f.clasificada ? M.clasificada : M.porClasificar}</span>
        </div>
      );
    }
    if (id === "alertas") {
      const texto = f.hallazgos.map((h) => `${h.regla}: ${h.explicacion}`).join(" · ");
      return (
        <div key={id} {...comun} className={CELDA}>
          {texto && (
            <span className="line-clamp-2 text-xs" title={texto}>
              {texto}
            </span>
          )}
        </div>
      );
    }
    if (id === "lupa") {
      return (
        <div key={id} {...comun} className={`${CELDA} items-center`}>
          <button
            type="button"
            disabled
            title={M.lupaDeshabilitada}
            aria-label={`${M.columnas.lupa}: ${M.lupaDeshabilitada}`}
            className="rounded border px-1 text-gray-500"
          >
            <span aria-hidden="true">🔍</span>
          </button>
        </div>
      );
    }
    if (id === "acciones") {
      return (
        <div key={id} {...comun} className={`${CELDA} flex-row items-center gap-1`}>
          {renderAcciones(f)}
          <button
            type="button"
            onClick={() => alAbrirHistorial(f.id)}
            tabIndex={esActiva ? 0 : -1}
            aria-label={T.abrirHistorial(comprobante)}
            className="rounded border px-2 py-0.5 text-xs"
          >
            {T.historial}
          </button>
        </div>
      );
    }
    if (esMonto(id)) {
      return (
        <div key={id} {...comun} className={id === "total" ? `${CELDA_MONTO} font-medium` : CELDA_MONTO}>
          {conMiles(String(fila.getAllCellsByColumnId()[id]?.getValue() ?? ""))}
        </div>
      );
    }
    return <div key={id} {...comun} className={CELDA} />;
  }

  function filaCuerpo(item: Extract<Item, { tipo: "fila" }>, start: number, indiceItem: number) {
    const f = item.fila.original;
    const seleccionada = seleccion.has(f.id);
    const resaltada = resaltadas?.has(f.id) === true;
    const color = seleccionada
      ? "bg-blue-50"
      : resaltada
        ? "bg-sky-100"
        : f.hallazgos.length > 0
          ? "bg-amber-50"
          : f.excluida
            ? "bg-gray-100 text-gray-600"
            : "bg-white";
    const borde = f.hallazgos.length > 0 ? "border-l-4 border-l-amber-600" : "border-l-4 border-l-transparent";
    return (
      <div
        key={item.clave}
        role="row"
        aria-rowindex={indiceItem + 3}
        aria-selected={seleccionada}
        data-fila={f.id}
        data-seccion={seccionDe(f)}
        className={`absolute left-0 top-0 flex text-black ${color} ${borde}`}
        style={{ width: anchoTotal, height: ALTO_FILA, transform: `translateY(${start}px)` }}
      >
        {inicio.map((col, i) => celda(col, item.fila, item.r, i, estiloFija(col, "start")))}
        <div aria-hidden="true" style={{ width: margenIzq, flexShrink: 0 }} />
        {columnasVisibles.map((v) => {
          const col = centro[v.index];
          if (!col) return null;
          return celda(col, item.fila, item.r, inicio.length + v.index, { width: col.getSize() });
        })}
        <div aria-hidden="true" style={{ width: margenDer, flexShrink: 0 }} />
        {fin.map((col, i) =>
          celda(col, item.fila, item.r, inicio.length + centro.length + i, estiloFija(col, "end")),
        )}
      </div>
    );
  }

  const tramos = tramosDeGrupo(centro);
  const vacio = items.length === 0;

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={M.tablaCompras}
      aria-rowcount={items.length + 2}
      aria-colcount={nColumnas}
      aria-multiselectable="true"
      aria-busy={cargando}
      onKeyDown={alTeclear}
      className="relative h-[65vh] min-h-[360px] overflow-auto rounded border bg-white text-black"
    >
      <div style={{ width: anchoTotal, minWidth: "100%" }}>
        <div role="rowgroup" className="sticky top-0 z-30 bg-gray-50 text-black" style={{ width: anchoTotal }}>
          <div role="row" aria-rowindex={1} className="flex" style={{ height: ALTO_GRUPO, width: anchoTotal }}>
            <div
              role="columnheader"
              aria-colspan={inicio.length}
              className="sticky left-0 z-20 shrink-0 truncate border-b bg-gray-100 px-2 text-xs font-semibold leading-7"
              style={{ width: anchoInicio }}
            >
              {T.grupoIdentidad}
            </div>
            {tramos.map((t, i) => (
              <div
                key={`${t.titulo}-${i}`}
                role="columnheader"
                className="shrink-0 truncate border-b border-l bg-gray-100 px-2 text-xs font-semibold leading-7"
                style={{ width: t.ancho }}
              >
                {t.titulo}
              </div>
            ))}
            <div
              role="columnheader"
              aria-colspan={fin.length}
              className="sticky right-0 z-20 shrink-0 truncate border-b border-l bg-gray-100 px-2 text-xs font-semibold leading-7"
              style={{ width: anchoFin }}
            >
              {T.grupoFin}
            </div>
          </div>
          <div role="row" aria-rowindex={2} className="flex" style={{ height: ALTO_ENCABEZADO, width: anchoTotal }}>
            {todas.map((col, c) => {
              const region = c < inicio.length ? "start" : c >= inicio.length + centro.length ? "end" : null;
              const enc = ENCABEZADOS[col.id];
              return (
                <div
                  key={col.id}
                  role="columnheader"
                  aria-colindex={c + 1}
                  aria-label={enc?.completo}
                  title={enc?.completo}
                  className={`shrink-0 truncate border-b px-2 text-xs font-semibold leading-9 ${
                    region ? "bg-gray-100" : "bg-gray-50"
                  } ${esMonto(col.id) ? "text-right" : ""}`}
                  style={region ? estiloFija(col, region) : { width: col.getSize() }}
                >
                  {col.id === "seleccionar" ? <span className="sr-only">{enc?.completo}</span> : enc?.corto}
                </div>
              );
            })}
          </div>
        </div>

        <div
          role="rowgroup"
          className="relative"
          style={{ height: Math.max(filasVirtuales.getTotalSize(), vacio ? ALTO_FILA : 0), width: anchoTotal }}
        >
          {vacio && (
            <p role="status" className="sticky left-0 px-3 py-3 text-sm" style={{ width: "min(100%, 480px)" }}>
              {cargando ? M.cargando : M.sinCompras}
            </p>
          )}
          {itemsVirtuales.map((v) => {
            const item = items[v.index];
            if (!item) return null;
            if (item.tipo === "seccion") {
              return (
                <div
                  key={item.clave}
                  role="row"
                  aria-rowindex={v.index + 3}
                  data-seccion-titulo={item.seccion}
                  className="absolute left-0 top-0 bg-gray-200 text-black"
                  style={{ width: anchoTotal, height: ALTO_SECCION, transform: `translateY(${v.start}px)` }}
                >
                  <div
                    role="gridcell"
                    aria-colspan={nColumnas}
                    className="sticky left-0 px-3 text-sm font-semibold leading-[30px]"
                    style={{ width: "min(100%, 480px)" }}
                  >
                    {T.seccion(TITULO_SECCION[item.seccion], item.n)}
                  </div>
                </div>
              );
            }
            return filaCuerpo(item, v.start, v.index);
          })}
        </div>
      </div>
    </div>
  );
}

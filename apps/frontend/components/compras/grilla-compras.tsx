"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTable, type Column, type Row } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { CalcularRespuesta, ColumnaMontoCompra, FilaCompraVista } from "@contapp/shared";
import { MENSAJES_COMPRAS as M, type ResultadoCompras } from "../../lib/compras";
import {
  aplicarCuadre,
  cambiarCelda,
  cambiosParaEnviar,
  errorDeCelda,
  esColumnaEditable,
  explicaciones,
  hayCambios,
  iniciarEdicion,
  marcarCuadreNoVerificado,
  sinCuadre,
  textoDe,
  totalLocal,
  type CambiosFila,
  type EstadoEdicion,
} from "../../lib/edicion-compras";
import { conMiles, destinoDe, validarMonto } from "../../lib/montos-compras";
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

// Grilla de compras del periodo (spec 015, T4 y T6; D-5, D-6, D-16; P-3, P-5, P-8, P-9; RF-061, RF-064).
// TanStack Table 9 da el modelo de columnas y filas (con las columnas fijas y los anchos) y TanStack Virtual
// la ventana de filas y de columnas: con miles de filas solo hay en el DOM las visibles más un margen. El
// marcado, el teclado y la accesibilidad (`role="grid"`) son propios.
//
// Edición por fila (P-3): Enter, F2 o doble clic en una celda de monto abren la fila; Tab y Shift+Tab pasan
// entre las celdas de monto sin guardar; al salir de la fila (Enter, flecha vertical o foco en otra fila) se
// pide UN solo `editar` con las celdas cambiadas; Esc descarta. El estado del borrador es puro
// (`lib/edicion-compras.ts`); a los 300 ms sin teclear se pide el cuadre a `calcular`.
//
// Los montos son cadenas del servidor: aquí solo se les da formato (`conMiles`); el único cálculo es el total
// que se muestra mientras se teclea (suma exacta con decimal.js, vía `edicion-compras`). La razón social, el
// motivo y la explicación vienen del SIRE y son texto no confiable: React los escapa.

const ALTO_FILA = 52;
const ALTO_SECCION = 30;
const ALTO_GRUPO = 28;
const ALTO_ENCABEZADO = 36;
const ALTO_CABECERA = ALTO_GRUPO + ALTO_ENCABEZADO;
const SALTO_PAGINA = 10;
const MARGEN_FILAS = 6;
const MARGEN_COLUMNAS = 2;
/** Espera sin teclear antes de pedir el cuadre a `calcular` (D-6). */
export const RETARDO_CALCULAR_MS = 300;

export type ResultadoGuardado = "cerrar" | "mantener";

export interface PropsGrillaCompras {
  filas: readonly FilaCompraVista[];
  cargando: boolean;
  seleccion: ReadonlySet<string>;
  alCambiarSeleccion: (seleccion: Set<string>) => void;
  /** Filas a resaltar (afectadas por deshacer o por «Ver filas»). */
  resaltadas?: ReadonlySet<string>;
  /** Motivo legible de solo lectura (`ContextoCompras.soloLectura`) o `null`: con motivo no se edita. */
  soloLectura?: string | null;
  /**
   * Guarda la fila editada: `versionBase` y solo las celdas cambiadas, en UN `editar`. Sin esta función la grilla
   * no se edita. Devuelve `"mantener"` si el guardado falló y el borrador debe seguir abierto; con cualquier otra
   * cosa la edición se cierra (la fila ya se actualizó o se recargó).
   */
  alGuardarFila?: (
    id: string,
    versionBase: number,
    cambios: CambiosFila,
  ) => Promise<ResultadoGuardado | void> | ResultadoGuardado | void;
  /** Vista previa del total y del cuadre (`POST …/calcular`, no escribe nada). Sin ella no hay cuadre en vivo. */
  alCalcular?: (id: string, cambios: CambiosFila) => Promise<ResultadoCompras<CalcularRespuesta>>;
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

/** Fila abierta para editar: su borrador, la celda con el cursor y si está guardando. */
interface EdicionFila {
  estado: EstadoEdicion;
  columna: ColumnaMontoCompra;
  guardando: boolean;
  /** Aviso propio de la edición (pegar varias celdas). */
  aviso: string | null;
}

/** Forma canónica de un texto ya validado (con 2 decimales); si no es válido se devuelve tal cual. */
function validarValor(texto: string): string {
  const r = validarMonto(texto);
  return r.ok ? r.valor : texto;
}

const idExplicacion = (columna: ColumnaMontoCompra) => `explicacion-edicion-${columna}`;
const ID_PANEL_EDICION = "panel-edicion-compras";

const CELDA =
  "flex h-full shrink-0 flex-col justify-center overflow-hidden border-b border-gray-200 px-2 text-sm bg-inherit focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-700";
const CELDA_MONTO = `${CELDA} items-end text-right tabular-nums`;

export function GrillaCompras({
  filas,
  cargando,
  seleccion,
  alCambiarSeleccion,
  resaltadas,
  soloLectura,
  alGuardarFila,
  alCalcular,
  renderAcciones,
  alAbrirHistorial,
}: PropsGrillaCompras) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enfocarRef = useRef(false);
  const [activaPedida, setActiva] = useState<Activa>({ r: 0, c: 0 });
  const [edicion, setEdicion] = useState<EdicionFila | null>(null);
  const [anuncio, setAnuncio] = useState("");
  // Lo último que dieron el padre y el estado: las continuaciones asíncronas (guardar, calcular) no deben usar
  // valores de un render viejo.
  const edicionRef = useRef<EdicionFila | null>(null);
  const guardarRef = useRef(alGuardarFila);
  const calcularRef = useRef(alCalcular);
  const irARef = useRef<(r: number, c: number) => void>(() => undefined);
  /** Turno de `calcular`: una respuesta tardía (o de una fila ya cerrada) no pisa el estado actual. */
  const turnoCalcular = useRef(0);
  useEffect(() => {
    edicionRef.current = edicion;
    guardarRef.current = alGuardarFila;
    calcularRef.current = alCalcular;
  });

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
      // La celda en edición enfoca su campo con el texto seleccionado: teclear reemplaza el monto.
      const campo = celda.querySelector<HTMLInputElement>("input[data-edicion]");
      if (campo) {
        campo.focus({ preventScroll: true });
        campo.select();
      } else {
        celda.focus({ preventScroll: true });
      }
    }
  });

  // La fila editada ya no está (se descartó o salió del filtro): se cierra la edición sin enviar nada.
  useEffect(() => {
    if (edicion && !filasTabla.some((row) => row.id === edicion.estado.filaId)) {
      turnoCalcular.current += 1;
      setEdicion(null);
    }
  }, [edicion, filasTabla]);

  // Cuadre en vivo (D-6): a los 300 ms sin teclear, `calcular` con las celdas cambiadas y válidas.
  const filaEditada = edicion?.estado.filaId ?? null;
  const cambiosEnVivo = edicion ? JSON.stringify(cambiosParaEnviar(edicion.estado).cambios) : null;
  useEffect(() => {
    if (filaEditada === null || cambiosEnVivo === null) return;
    const turno = ++turnoCalcular.current;
    const cambios = JSON.parse(cambiosEnVivo) as CambiosFila;
    const actualizar = (cambiar: (e: EstadoEdicion) => EstadoEdicion) =>
      setEdicion((e) => (e && e.estado.filaId === filaEditada ? { ...e, estado: cambiar(e.estado) } : e));
    if (Object.keys(cambios).length === 0) {
      actualizar(sinCuadre);
      return;
    }
    const calcular = calcularRef.current;
    if (!calcular) return;
    const temporizador = setTimeout(() => {
      calcular(filaEditada, cambios)
        .then((r) => (r.ok ? r.datos.cuadre : null))
        .catch(() => null)
        .then((cuadre) => {
          if (turno !== turnoCalcular.current) return;
          actualizar((e) => (cuadre ? aplicarCuadre(e, cuadre) : marcarCuadreNoVerificado(e)));
        });
    }, RETARDO_CALCULAR_MS);
    return () => clearTimeout(temporizador);
  }, [filaEditada, cambiosEnVivo]);

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

  irARef.current = irA;

  const puedeEditar = (fila: FilaCompraVista): boolean =>
    !soloLectura && alGuardarFila !== undefined && !fila.excluida;

  /** Posición (fila, columna) de la celda con el cursor de edición. */
  function posicionDeEdicion(ed: EdicionFila): Activa {
    const r = filasTabla.findIndex((row) => row.id === ed.estado.filaId);
    const c = todas.findIndex((col) => col.id === ed.columna);
    return { r: Math.max(0, r), c: Math.max(0, c) };
  }

  /** Vuelve el foco a la celda que se está editando (la salida de la fila se bloqueó). */
  function volverAEdicion(ed: EdicionFila) {
    const { r, c } = posicionDeEdicion(ed);
    setActiva({ r, c });
    enfocarRef.current = true;
  }

  function empezarEdicion(r: number, c: number): boolean {
    const row = filasTabla[r];
    const columna = todas[c]?.id;
    if (!row || columna === undefined || !esColumnaEditable(columna) || !puedeEditar(row.original)) {
      return false;
    }
    setActiva({ r, c });
    enfocarRef.current = true;
    setAnuncio("");
    setEdicion((e) =>
      e && e.estado.filaId === row.id
        ? { ...e, columna }
        : { estado: iniciarEdicion(row.original), columna, guardando: false, aviso: null },
    );
    return true;
  }

  function cancelarEdicion() {
    const ed = edicionRef.current;
    if (!ed || ed.guardando) return;
    turnoCalcular.current += 1;
    setEdicion(null);
    setAnuncio(M.edicionCancelada);
    enfocarRef.current = true;
  }

  /** Cambia la celda en edición a la siguiente (o anterior) columna de monto de la misma fila, sin guardar. */
  function moverEdicion(sentido: 1 | -1) {
    const ed = edicionRef.current;
    if (!ed || ed.guardando) return;
    const { r, c } = posicionDeEdicion(ed);
    for (let i = c + sentido; i >= 0 && i < nColumnas; i += sentido) {
      const columna = todas[i]?.id;
      if (columna !== undefined && esColumnaEditable(columna)) {
        setEdicion({ ...ed, columna });
        irA(r, i);
        return;
      }
    }
  }

  /**
   * Sale de la fila en edición (P-3): un solo `editar` con las celdas cambiadas. Con un monto inválido no se envía
   * nada y el cursor vuelve a esa celda; si el guardado falla el borrador sigue abierto. Devuelve si la fila se cerró.
   */
  async function salirDeFila(destino: Activa | null): Promise<boolean> {
    const ed = edicionRef.current;
    if (!ed || ed.guardando) return false;
    const { cambios, invalidas } = cambiosParaEnviar(ed.estado);
    const cerrar = () => {
      turnoCalcular.current += 1;
      setEdicion(null);
      if (destino) irARef.current(destino.r, destino.c);
      else enfocarRef.current = true;
    };
    if (invalidas.length > 0) {
      const siguiente = { ...ed, columna: invalidas[0]! };
      setEdicion(siguiente);
      volverAEdicion(siguiente);
      return false;
    }
    if (Object.keys(cambios).length === 0) {
      cerrar();
      return true;
    }
    turnoCalcular.current += 1;
    setEdicion({ ...ed, guardando: true });
    let resultado: ResultadoGuardado | void = "mantener";
    try {
      resultado = await guardarRef.current?.(ed.estado.filaId, ed.estado.versionBase, cambios);
    } catch {
      resultado = "mantener";
    }
    if (resultado === "mantener") {
      const abierta = { ...ed, guardando: false };
      setEdicion((e) => (e && e.estado.filaId === ed.estado.filaId ? abierta : e));
      volverAEdicion(abierta);
      return false;
    }
    cerrar();
    return true;
  }

  function alTeclearCampo(e: KeyboardEvent<HTMLInputElement>) {
    // Las teclas del campo son del campo: la grilla no las ve (flechas laterales y Ctrl+Z editan el texto).
    e.stopPropagation();
    const ed = edicionRef.current;
    if (!ed || e.nativeEvent.isComposing) return;
    if (ed.guardando) {
      e.preventDefault();
      return;
    }
    const { r, c } = posicionDeEdicion(ed);
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        void salirDeFila({ r: r + 1, c });
        break;
      case "ArrowDown":
        e.preventDefault();
        void salirDeFila({ r: r + 1, c });
        break;
      case "ArrowUp":
        e.preventDefault();
        void salirDeFila({ r: r - 1, c });
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        // Las flechas laterales pasan a la celda vecina solo si no hay nada que mover dentro del texto: con el
        // texto entero seleccionado (recién abierta) o con el cursor en el borde que corresponde.
        const campo = e.currentTarget;
        const { selectionStart: desde, selectionEnd: hasta, value } = campo;
        const todoSeleccionado = desde === 0 && hasta === value.length;
        const alBorde =
          desde === hasta && (e.key === "ArrowRight" ? hasta === value.length : desde === 0);
        if (todoSeleccionado || alBorde) {
          e.preventDefault();
          moverEdicion(e.key === "ArrowRight" ? 1 : -1);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        cancelarEdicion();
        break;
      case "Tab":
        e.preventDefault();
        moverEdicion(e.shiftKey ? -1 : 1);
        break;
      case "F2":
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  /** Solo se pega un valor en la celda (P-9): varias celdas (tabulaciones o saltos) se rechazan y se explica. */
  function alPegarEnCampo(e: ClipboardEvent<HTMLInputElement>) {
    const pegado = e.clipboardData.getData("text");
    if (!/[\t\r\n]/.test(pegado.trim())) return;
    e.preventDefault();
    setEdicion((ed) => (ed ? { ...ed, aviso: M.pegarRango } : ed));
  }

  function alEscribirEnCampo(columna: ColumnaMontoCompra, texto: string) {
    setEdicion((ed) =>
      ed ? { ...ed, estado: cambiarCelda(ed.estado, columna, texto), aviso: null } : ed,
    );
  }

  /** El foco llegó a otra fila mientras se editaba: se guarda la fila editada (o se vuelve a ella si no se puede). */
  async function alEnfocarOtraFila(r: number, c: number) {
    const ed = edicionRef.current;
    if (!ed) return;
    await salirDeFila({ r, c });
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
    if (e.key === "Escape" && edicionRef.current) {
      // Esc descarta la fila abierta aunque el foco esté en otra celda o botón de la misma fila.
      e.preventDefault();
      cancelarEdicion();
      return;
    }
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
        // Una celda de monto editable abre la fila; las demás, si tienen controles, entran en el primero.
        if (empezarEdicion(r, c)) break;
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

  // Filas resaltadas (deshacer, «Ver filas», ubicar una compra existente): la primera se lleva a la vista sin mover
  // el foco. Con miles de filas, resaltar fuera de la ventana no serviría de nada (T10).
  useEffect(() => {
    if (!resaltadas || resaltadas.size === 0) return;
    const i = items.findIndex((x) => x.tipo === "fila" && resaltadas.has(x.fila.original.id));
    if (i >= 0) filasVirtuales.scrollToIndex(i, { align: "center" });
    // Al cambiar lo resaltado o la cantidad de filas (la compra ubicada puede llegar con una carga nueva); el
    // virtualizador y `items` se leen del último pintado.
  }, [resaltadas, items.length]);
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
        const ed = edicionRef.current;
        if (ed && ed.estado.filaId !== f.id) {
          // Clic o foco en otra fila: la fila abierta se guarda (P-3) antes de pasar a esta.
          void alEnfocarOtraFila(r, c);
          return;
        }
        if (activa.r !== r || activa.c !== c) setActiva({ r, c });
        // Otra celda de monto de la misma fila abierta: el campo pasa a ella.
        if (ed && esColumnaEditable(columna.id) && ed.columna !== columna.id && !ed.guardando) {
          setEdicion({ ...ed, columna: columna.id });
          enfocarRef.current = true;
        }
      },
      onDoubleClick: () => {
        if (esColumnaEditable(columna.id)) empezarEdicion(r, c);
      },
    };
    const id = columna.id;
    const enEdicion = edicion && edicion.estado.filaId === f.id ? edicion : null;

    /** Celda de monto de la fila abierta: el campo en la que tiene el cursor y el borrador en las demás. */
    function celdaMontoEnEdicion(id: ColumnaMontoCompra, ed: EdicionFila) {
      const explicacion = explicaciones(ed.estado).find((x) => x.columna === id);
      const invalida = explicacion !== undefined;
      const texto = textoDe(ed.estado, id);
      const tocada = ed.estado.borrador[id] !== undefined;
      const valido = errorDeCelda(ed.estado, id) === null;
      const color = invalida
        ? "bg-red-50 text-red-800 ring-2 ring-inset ring-red-600"
        : tocada
          ? "bg-yellow-50 font-semibold"
          : "";
      const nombre = M.celdaDe(M.casilleros[id], comprobante);
      const descripcion = invalida ? idExplicacion(id) : undefined;
      return (
        <div
          key={id}
          {...comun}
          aria-invalid={invalida || undefined}
          aria-describedby={descripcion}
          className={`${CELDA_MONTO} ${color}`}
        >
          {ed.columna === id ? (
            <input
              data-edicion=""
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={texto}
              readOnly={ed.guardando}
              aria-label={nombre}
              aria-invalid={invalida || undefined}
              aria-describedby={descripcion}
              aria-busy={ed.guardando}
              onChange={(e) => alEscribirEnCampo(id, e.target.value)}
              onKeyDown={alTeclearCampo}
              onPaste={alPegarEnCampo}
              className="w-full rounded border border-blue-700 bg-white px-1 py-0.5 text-right tabular-nums text-black"
            />
          ) : (
            <span>{tocada && valido ? conMiles(validarValor(texto)) : texto}</span>
          )}
        </div>
      );
    }


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
    if (enEdicion && esMonto(id)) {
      if (id === "total") {
        return (
          <div key={id} {...comun} className={`${CELDA_MONTO} font-medium`}>
            <span>{conMiles(totalLocal(enEdicion.estado))}</span>
            {enEdicion.estado.cuadreNoVerificado && (
              <span className="text-xs font-normal text-amber-900">{M.cuadreNoVerificado}</span>
            )}
          </div>
        );
      }
      return celdaMontoEnEdicion(id, enEdicion);
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

  const filaAbierta = edicion
    ? filasTabla.find((row) => row.id === edicion.estado.filaId)?.original
    : undefined;

  return (
    <>
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
    {edicion && filaAbierta && (
      <PanelEdicion edicion={edicion} comprobante={`${filaAbierta.serie}-${filaAbierta.numero}`} />
    )}
    <p aria-live="polite" className="sr-only">
      {anuncio}
    </p>
    </>
  );
}

/**
 * Lo que la fila abierta tiene que decir y no cabe en una celda: total en vivo, cada monto que no se puede enviar
 * o que no cuadra con su explicación (visible, no solo color) y las teclas. Cada celda marcada apunta aquí con
 * `aria-describedby`. Queda pegado al borde inferior para verse mientras se edita.
 */
function PanelEdicion({ edicion, comprobante }: { edicion: EdicionFila; comprobante: string }) {
  const lista = explicaciones(edicion.estado);
  return (
    <section
      id={ID_PANEL_EDICION}
      aria-label={M.editandoFila(comprobante)}
      aria-live="polite"
      className="sticky bottom-0 z-40 flex flex-col gap-1 rounded border border-blue-700 bg-white p-2 text-sm text-black"
    >
      <p className="font-medium">
        {M.editandoFila(comprobante)} · {M.totalLocal} {conMiles(totalLocal(edicion.estado))}
        {edicion.guardando && ` · ${M.guardando}`}
        {!edicion.guardando && hayCambios(edicion.estado) && ` · ${M.cambiosSinGuardar}`}
        {edicion.estado.cuadreNoVerificado && ` · ${M.cuadreNoVerificado}`}
      </p>
      {lista.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {lista.map((x) => (
            <li
              key={x.columna}
              id={idExplicacion(x.columna)}
              className="font-medium text-red-800"
            >
              <span aria-hidden="true">⚠ </span>
              {M.explicacionCelda(M.casilleros[x.columna], x.texto)}
              {x.tipo === "cuadre" && ` (${M.descuadre})`}
            </li>
          ))}
        </ul>
      )}
      {edicion.aviso && (
        <p role="alert" className="font-medium text-red-800">
          {edicion.aviso}
        </p>
      )}
      <p className="text-xs text-gray-700">{M.ayudaEdicion}</p>
    </section>
  );
}


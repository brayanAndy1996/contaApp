import { useCallback, useEffect, useRef, useState } from "react";
import type { FilaCompraVista } from "@contapp/shared";
import {
  MENSAJES_COMPRAS as M,
  cargarPeriodo,
  obtenerDetalleCompra,
  type FiltrosCompras,
} from "./compras";
import { useSecuencia } from "./secuencia";

// Filas de la grilla de compras (spec 015, T5; D-4): carga por cursor con los filtros del servidor, selección y
// recarga de filas con la respuesta del servidor (sin actualización optimista de montos). Vive aparte de la página
// para probar la carga y la recarga sin montar la pantalla.

/** Filas que se recargan una a una; con más, se vuelve a pedir el listado entero en vez de miles de GET. */
export const UMBRAL_RECARGA_INDIVIDUAL = 100;
const LOTE_RECARGA = 8;

export type EstadoCarga = "cargando" | "completa" | "error";

/** Mezcla un bloque en la lista: la fila ya cargada se reemplaza en su lugar y las nuevas se agregan al final. */
export function fusionar(
  actuales: FilaCompraVista[],
  bloque: readonly FilaCompraVista[],
): FilaCompraVista[] {
  const lugar = new Map(actuales.map((f, i) => [f.id, i] as const));
  const resultado = actuales.slice();
  for (const f of bloque) {
    const i = lugar.get(f.id);
    if (i === undefined) {
      lugar.set(f.id, resultado.length);
      resultado.push(f);
    } else {
      resultado[i] = f;
    }
  }
  return resultado;
}

export interface OpcionesFilasCompras {
  clienteId: string;
  periodo: string;
  /** Solo se carga con permiso para ver y un periodo válido. */
  activo: boolean;
  filtros: FiltrosCompras;
  /** Error de una recarga de fila o del listado silencioso (la carga principal lo informa en `errorCarga`). */
  alFallar: (status: number, mensaje: string) => void;
}

export function useFilasCompras({
  clienteId,
  periodo,
  activo,
  filtros,
  alFallar,
}: OpcionesFilasCompras) {
  const [filas, setFilas] = useState<FilaCompraVista[]>([]);
  const [carga, setCarga] = useState<EstadoCarga>("cargando");
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [seleccion, setSeleccion] = useState<Set<string>>(() => new Set());

  const sFilas = useSecuencia();
  // Vigencia de lo que depende de la carga actual (fila recargada, listado silencioso): al cambiar el periodo o
  // los filtros sube y todo lo que estaba en vuelo se descarta. Una orden por fila evita que una recarga vieja
  // de la misma fila pise a una más nueva.
  const generacion = useRef(0);
  const porFila = useRef(new Map<string, number>());
  const filasActuales = useRef<FilaCompraVista[]>([]);
  const filtrosActuales = useRef(filtros);
  const cargaActual = useRef<EstadoCarga>("cargando");
  const aviso = useRef(alFallar);
  useEffect(() => {
    filasActuales.current = filas;
    filtrosActuales.current = filtros;
    cargaActual.current = carga;
    aviso.current = alFallar;
  });

  // Carga por cursor: bloques de 1.000 hasta que `siguiente` sea `null`; la grilla se usa desde el primer bloque.
  // Cambiar de filtro, de periodo o de cliente cancela la carga anterior y descarta sus respuestas.
  useEffect(() => {
    if (!activo) return;
    const control = new AbortController();
    const id = sFilas.nueva();
    generacion.current += 1;
    porFila.current.clear();
    setFilas([]);
    setSeleccion(new Set());
    setErrorCarga(null);
    setCarga("cargando");
    cargarPeriodo(clienteId, periodo, filtros, {
      senal: control.signal,
      alBloque: (bloque, info) => {
        if (!sFilas.vigente(id)) return;
        setFilas((previas) => fusionar(info.primero ? [] : previas, bloque));
      },
    })
      .then((r) => {
        if (!sFilas.vigente(id) || r.estado === "cancelada") return;
        if (r.estado === "completa") {
          setCarga("completa");
          return;
        }
        setCarga("error");
        if (r.error.status !== 401) setErrorCarga(r.error.mensaje);
      })
      .catch(() => {
        if (!sFilas.vigente(id)) return;
        setCarga("error");
        setErrorCarga(M.errorCarga);
      });
    return () => {
      control.abort();
      sFilas.invalidar();
      generacion.current += 1;
    };
    // `sFilas` es estable (solo envuelve un ref).
  }, [activo, clienteId, periodo, filtros, reintento]);

  const quitarFila = useCallback((id: string) => {
    setFilas((previas) => previas.filter((f) => f.id !== id));
    setSeleccion((previa) => {
      if (!previa.has(id)) return previa;
      const siguiente = new Set(previa);
      siguiente.delete(id);
      return siguiente;
    });
  }, []);

  /**
   * Actualiza una fila con la respuesta del servidor. Si el id no está cargado la inserta (así aparece una compra
   * recién agregada, aunque el filtro vigente no la incluiría); si el servidor ya no la tiene (404), la quita.
   */
  const recargarFila = useCallback(
    async (id: string) => {
      const mia = generacion.current;
      const orden = (porFila.current.get(id) ?? 0) + 1;
      porFila.current.set(id, orden);
      try {
        const r = await obtenerDetalleCompra(clienteId, periodo, id);
        if (generacion.current !== mia || porFila.current.get(id) !== orden) return;
        if (!r.ok) {
          if (r.status === 404) quitarFila(id);
          else aviso.current(r.status, r.mensaje);
          return;
        }
        const nueva = r.datos.vigente;
        setFilas((previas) => fusionar(previas, [nueva]));
      } catch {
        if (generacion.current === mia) aviso.current(0, M.errorCarga);
      }
    },
    [clienteId, periodo, quitarFila],
  );

  /** Pone en la lista una fila que ya trae el servidor en la respuesta de una escritura (sin otro GET). */
  const aplicarFila = useCallback((fila: FilaCompraVista) => {
    porFila.current.set(fila.id, (porFila.current.get(fila.id) ?? 0) + 1);
    setFilas((previas) => fusionar(previas, [fila]));
  }, []);

  /** Vuelve a pedir el listado completo con los filtros vigentes y lo cambia de una vez (sin vaciar la grilla). */
  const recargarListado = useCallback(async () => {
    if (cargaActual.current !== "completa") return;
    const mia = generacion.current;
    const acumuladas: FilaCompraVista[] = [];
    try {
      const r = await cargarPeriodo(clienteId, periodo, filtrosActuales.current, {
        senal: new AbortController().signal,
        alBloque: (bloque) => {
          acumuladas.push(...bloque);
        },
      });
      if (generacion.current !== mia) return;
      if (r.estado !== "completa") {
        if (r.estado === "error") aviso.current(r.error.status, r.error.mensaje);
        return;
      }
      setFilas(fusionar([], acumuladas));
      const vivas = new Set(acumuladas.map((f) => f.id));
      setSeleccion((previa) => new Set([...previa].filter((id) => vivas.has(id))));
    } catch {
      if (generacion.current === mia) aviso.current(0, M.errorCarga);
    }
  }, [clienteId, periodo]);

  /** Recarga solo las filas ya cargadas (las que no están en este filtro no se agregan). */
  const recargarFilas = useCallback(
    async (ids: string[]) => {
      const cargadas = new Set(filasActuales.current.map((f) => f.id));
      const pedidas = [...new Set(ids)].filter((id) => cargadas.has(id));
      if (pedidas.length === 0) return;
      if (pedidas.length > UMBRAL_RECARGA_INDIVIDUAL) {
        await recargarListado();
        return;
      }
      for (let i = 0; i < pedidas.length; i += LOTE_RECARGA) {
        await Promise.all(pedidas.slice(i, i + LOTE_RECARGA).map(recargarFila));
      }
    },
    [recargarFila, recargarListado],
  );

  const seleccionarTodas = useCallback(() => {
    setSeleccion(new Set(filasActuales.current.map((f) => f.id)));
  }, []);

  const reintentar = useCallback(() => setReintento((n) => n + 1), []);

  return {
    filas,
    carga,
    errorCarga,
    seleccion,
    setSeleccion,
    seleccionarTodas,
    aplicarFila,
    recargarFila,
    recargarFilas,
    reintentar,
  };
}

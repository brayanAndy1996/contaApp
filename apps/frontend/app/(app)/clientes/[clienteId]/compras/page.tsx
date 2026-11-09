"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  DiferenciaComprasDto,
  EstadoPeriodoRespuesta,
  PropuestaComprasDto,
  ResumenComprasVista,
} from "@contapp/shared";
import { DescargaCompras } from "../../../../../components/compras/descarga-compras";
import { DiferenciasCompras } from "../../../../../components/compras/diferencias-compras";
import {
  EstadoPeriodo,
  calcularSoloLectura,
} from "../../../../../components/compras/estado-periodo";
import { ExportarCompras } from "../../../../../components/compras/exportar-compras";
import { ResumenCompras } from "../../../../../components/compras/resumen-compras";
import { MENSAJES, cargarYo, mensajeDeError, tiene } from "../../../../../lib/acceso";
import { obtenerCliente, type ClienteDto } from "../../../../../lib/clientes";
import {
  MENSAJES_COMPRAS as M,
  PERIODO_VALIDO,
  PERMISO_APROBAR_GENERAR,
  PERMISO_CLASIFICAR,
  PERMISO_DESCARGAR,
  PERMISO_VER,
  listarDiferenciasCompras,
  listarPropuestasCompras,
  obtenerResumenCompras,
  type ContextoCompras,
  type EstadoPeriodoCompras,
  type PermisosCompras,
} from "../../../../../lib/compras";
import { useSecuencia } from "../../../../../lib/secuencia";

// Compras del periodo de un cliente (spec 015, D-1, D-12 a D-16; RF-060, RF-068, RF-069, RF-071). El periodo
// (AAAAMM) se escribe aquí o llega en `?periodo=`. La página solo pide y muestra: resumen, estado, descarga y
// diferencias son del servidor y los montos se muestran como cadenas. Ocultar acciones según permiso es
// comodidad (RNF-007): el backend vuelve a validar y su 403/404/409 se muestra con su mensaje. La grilla la une
// T5 en el hueco marcado abajo; las piezas de escritura reciben `ContextoCompras` y `soloLectura`.

const SIN_PERMISOS: PermisosCompras = {
  ver: false,
  descargar: false,
  clasificar: false,
  aprobarGenerar: false,
};

/** Las acciones sobre filas (T5 en adelante) aún no existen: recargar una fila no hace nada hasta unir la grilla. */
const sinFilas = async (): Promise<void> => undefined;

function Compras() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const busqueda = useSearchParams();
  const [permisos, setPermisos] = useState<PermisosCompras | null>(null);
  const [cliente, setCliente] = useState<ClienteDto | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const [periodo, setPeriodo] = useState(busqueda.get("periodo") ?? "");
  const periodoValido = PERIODO_VALIDO.test(periodo);

  const [resumen, setResumen] = useState<ResumenComprasVista | null>(null);
  const [estado, setEstado] = useState<EstadoPeriodoCompras>("abierto");
  const [marca, setMarca] = useState<{
    estado: EstadoPeriodoCompras;
    en: string;
  } | null>(null);
  const [propuestas, setPropuestas] = useState<PropuestaComprasDto[] | null>(
    null,
  );
  const [diferencias, setDiferencias] = useState<DiferenciaComprasDto[] | null>(
    null,
  );

  const sResumen = useSecuencia();
  const sPropuestas = useSecuencia();

  const verCompras = permisos?.ver === true;
  const archivado = cliente?.archivado === true;

  // Permisos y cliente (una sola vez: `GET /acceso/yo` y `GET /clientes/:id`).
  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo, status } = await cargarYo();
      if (!vigente) return;
      if (!yo) {
        if (status !== 401) setErrorGeneral(mensajeDeError(status, null));
        setPermisos(SIN_PERMISOS);
        return;
      }
      const ver = tiene(yo, PERMISO_VER);
      setPermisos({
        ver,
        descargar: tiene(yo, PERMISO_DESCARGAR),
        clasificar: tiene(yo, PERMISO_CLASIFICAR),
        aprobarGenerar: tiene(yo, PERMISO_APROBAR_GENERAR),
      });
      if (!ver) return;
      const c = await obtenerCliente(clienteId);
      if (vigente && c.ok && c.datos) setCliente(c.datos);
    })().catch(() => {
      if (vigente) {
        setPermisos(SIN_PERMISOS);
        setErrorGeneral(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  const falla = useCallback((status: number, mensaje: string) => {
    if (status !== 401) setErrorGeneral(mensaje);
  }, []);

  const cargarResumen = useCallback(async () => {
    const id = sResumen.nueva();
    const r = await obtenerResumenCompras(clienteId, periodo);
    if (!sResumen.vigente(id)) return;
    if (r.ok) {
      setResumen(r.datos);
      setEstado(r.datos.estado);
    } else {
      falla(r.status, r.mensaje);
    }
    // `sResumen` es estable (solo envuelve un ref).
  }, [clienteId, periodo, falla]);

  const cargarPropuestas = useCallback(async () => {
    const id = sPropuestas.nueva();
    const r = await listarPropuestasCompras(clienteId, periodo);
    if (!sPropuestas.vigente(id)) return;
    if (!r.ok) {
      falla(r.status, r.mensaje);
      return;
    }
    setPropuestas(r.datos);
    const ultima = r.datos[0];
    if (!ultima) {
      setDiferencias(null);
      return;
    }
    const d = await listarDiferenciasCompras(clienteId, periodo, ultima.id);
    if (!sPropuestas.vigente(id)) return;
    if (d.ok) setDiferencias(d.datos);
    else falla(d.status, d.mensaje);
  }, [clienteId, periodo, falla]);

  const cargarTodo = useCallback(async () => {
    try {
      await Promise.all([cargarResumen(), cargarPropuestas()]);
    } catch {
      setErrorGeneral(MENSAJES.errorGeneral);
    }
  }, [cargarResumen, cargarPropuestas]);

  // Cambia el periodo o el cliente: lo anterior deja de valer y se vuelve a pedir todo.
  useEffect(() => {
    if (!verCompras || !periodoValido) return;
    void cargarTodo();
    return () => {
      sResumen.invalidar();
      sPropuestas.invalidar();
    };
  }, [verCompras, periodoValido, cargarTodo]);

  function cambiarPeriodo(valor: string) {
    setPeriodo(valor.trim());
    setResumen(null);
    setEstado("abierto");
    setMarca(null);
    setPropuestas(null);
    setDiferencias(null);
    setErrorGeneral(null);
  }

  /** El servidor cambió el estado (revisar o reabrir): se guarda y se recarga el resumen del periodo. */
  function alCambiarEstado(r: EstadoPeriodoRespuesta) {
    setEstado(r.estado);
    setMarca(r.en === null ? null : { estado: r.estado, en: r.en });
    void cargarResumen().catch(() => setErrorGeneral(MENSAJES.errorGeneral));
  }

  const permisosVigentes = permisos ?? SIN_PERMISOS;
  const soloLectura = calcularSoloLectura({
    archivado,
    permisos: permisosVigentes,
    estado,
  });
  const contexto = useMemo<ContextoCompras>(
    () => ({
      clienteId,
      periodo,
      permisos: permisosVigentes,
      estado,
      soloLectura,
      recargarFila: sinFilas,
      recargarFilas: sinFilas,
      recargarResumen: cargarResumen,
    }),
    [clienteId, periodo, permisosVigentes, estado, soloLectura, cargarResumen],
  );

  if (permisos === null) {
    return <main className="p-6">{M.cargandoPantalla}</main>;
  }

  if (!permisos.ver) {
    return (
      <main className="flex flex-col gap-4 p-6">
        <p role="alert" className="text-sm text-red-600">
          {errorGeneral ?? M.sinPermisoVer}
        </p>
      </main>
    );
  }

  const puedeDescargar = permisos.descargar && !archivado;
  const clienteHref = encodeURIComponent(clienteId);
  const hrefVentas = `/clientes/${clienteHref}/ventas${
    periodoValido ? `?periodo=${periodo}` : ""
  }`;

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{M.titulo}</h1>
        <p className="text-sm">{M.subtitulo}</p>
        {cliente && (
          <p className="text-sm">
            {cliente.razonSocial} · RUC {cliente.ruc}
          </p>
        )}
        <nav aria-label="Registros del cliente" className="flex gap-3 text-sm">
          <Link href={hrefVentas} className="underline">
            {M.enlaceVentas}
          </Link>
        </nav>
      </header>

      {soloLectura !== null && (
        <p
          role="status"
          className="w-full max-w-xl rounded bg-amber-50 p-3 text-sm text-amber-900"
        >
          {soloLectura}
        </p>
      )}
      {errorGeneral && (
        <p role="alert" className="text-sm text-red-600">
          {errorGeneral}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {M.etiquetaPeriodo}
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            autoComplete="off"
            value={periodo}
            onChange={(e) => cambiarPeriodo(e.target.value)}
            aria-describedby={
              periodo !== "" && !periodoValido ? "periodo-ayuda" : undefined
            }
            className="rounded border px-3 py-2"
          />
        </label>
        <ExportarCompras
          key={`exportar|${clienteId}|${periodo}`}
          clienteId={clienteId}
          periodo={periodo}
          periodoValido={periodoValido}
        />
      </div>
      {periodo !== "" && !periodoValido && (
        <p id="periodo-ayuda" className="text-sm text-red-600">
          {M.periodoInvalido}
        </p>
      )}

      {periodoValido && (
        <EstadoPeriodo
          key={`estado|${clienteId}|${periodo}`}
          contexto={contexto}
          archivado={archivado}
          en={marca !== null && marca.estado === estado ? marca.en : null}
          alCambiar={alCambiarEstado}
          alRecargar={() =>
            void cargarResumen().catch(() =>
              setErrorGeneral(MENSAJES.errorGeneral),
            )
          }
        />
      )}

      <DescargaCompras
        key={`descarga|${clienteId}|${periodo}`}
        clienteId={clienteId}
        periodo={periodo}
        puedeDescargar={puedeDescargar}
        periodoValido={periodoValido}
        ultimaPropuesta={propuestas?.[0]}
        cargadas={propuestas !== null}
        alCompletar={() => void cargarTodo()}
      />

      {periodoValido && (
        <>
          <ResumenCompras resumen={resumen} />

          {/* Hueco de la grilla de compras (T5 la une aquí con los filtros, la carga por cursor y la selección;
              recibe `contexto` y `soloLectura`). T3 no toca `grilla-compras.tsx`. */}

          {propuestas !== null && propuestas.length > 0 && (
            <DiferenciasCompras diferencias={diferencias} />
          )}
        </>
      )}
    </main>
  );
}

// `useParams()` y `useSearchParams()` son datos de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6">{M.cargandoPantalla}</main>}>
      <Compras />
    </Suspense>
  );
}

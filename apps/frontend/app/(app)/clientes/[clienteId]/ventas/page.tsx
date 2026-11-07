"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  TAMANOS_PAGINA_VENTAS,
  filtrosVentasSchema,
  type TamanoPaginaVentas,
} from "@contapp/shared";
import { CorrelatividadVentas } from "../../../../../components/ventas/correlatividad-ventas";
import { DescargaVentas } from "../../../../../components/ventas/descarga-ventas";
import { DiferenciasVentas } from "../../../../../components/ventas/diferencias-ventas";
import { GrillaVentas } from "../../../../../components/ventas/grilla-ventas";
import { ResumenVentas } from "../../../../../components/ventas/resumen-ventas";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
} from "../../../../../lib/acceso";
import { obtenerCliente, type ClienteDto } from "../../../../../lib/clientes";
import {
  MENSAJES_VENTAS as M,
  PERIODO_VALIDO,
  SIN_FILTROS,
  conMiles,
  listarDiferencias,
  listarPropuestas,
  listarVentas,
  obtenerCorrelatividad,
  obtenerResumenVentas,
  type CorrelatividadVentasDto,
  type DiferenciaVentasDto,
  type FiltrosGrilla,
  type PaginaVentasDto,
  type PropuestaVentasDto,
  type ResumenVentasDto,
} from "../../../../../lib/ventas";

// Ventas del periodo de un cliente (spec 013, D14; RF-050, RF-052, RF-053, RF-056). El periodo (AAAAMM) se
// escribe aquí o llega en `?periodo=`. La pantalla solo pide y muestra: grilla paginada y virtualizada, resumen
// en soles, correlatividad y diferencias de la última descarga son cálculos del servidor, y los montos se
// muestran como cadenas. Ocultar acciones según permiso es comodidad (RNF-007); el backend valida.

const TAMANO_INICIAL: TamanoPaginaVentas = 25;

/** Cuenta una petición por tipo de dato para descartar respuestas que llegan tarde (cambio de periodo o filtros). */
function useSecuencia() {
  const n = useRef(0);
  return {
    nueva: () => ++n.current,
    vigente: (id: number) => id === n.current,
    invalidar: () => {
      n.current += 1;
    },
  };
}

function Ventas() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const busqueda = useSearchParams();
  const [permisos, setPermisos] = useState<{
    ver: boolean;
    descargar: boolean;
    clasificar: boolean;
  } | null>(null);
  const [cliente, setCliente] = useState<ClienteDto | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  const [periodo, setPeriodo] = useState(busqueda.get("periodo") ?? "");
  const periodoValido = PERIODO_VALIDO.test(periodo);

  const [pagina, setPagina] = useState(1);
  const [tamano, setTamano] = useState<TamanoPaginaVentas>(TAMANO_INICIAL);
  const [borrador, setBorrador] = useState<FiltrosGrilla>(SIN_FILTROS);
  const [filtros, setFiltros] = useState<FiltrosGrilla>(SIN_FILTROS);
  const [filtrosInvalidos, setFiltrosInvalidos] = useState(false);

  const [datosPagina, setDatosPagina] = useState<PaginaVentasDto | null>(null);
  const [resumen, setResumen] = useState<ResumenVentasDto | null>(null);
  const [correlatividad, setCorrelatividad] =
    useState<CorrelatividadVentasDto | null>(null);
  const [propuestas, setPropuestas] = useState<PropuestaVentasDto[] | null>(
    null,
  );
  const [diferencias, setDiferencias] = useState<DiferenciaVentasDto[] | null>(
    null,
  );

  const sGrilla = useSecuencia();
  const sResumen = useSecuencia();
  const sCorrelatividad = useSecuencia();
  const sPropuestas = useSecuencia();

  const verVentas = permisos?.ver === true;
  const archivado = cliente?.archivado === true;

  // Permisos y cliente (una sola vez: `GET /acceso/yo` y `GET /clientes/:id`).
  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo, status } = await cargarYo();
      if (!vigente) return;
      if (!yo) {
        if (status !== 401) setErrorGeneral(mensajeDeError(status, null));
        setPermisos({ ver: false, descargar: false, clasificar: false });
        return;
      }
      const ver = tiene(yo, "clientes.ver");
      setPermisos({
        ver,
        descargar: tiene(yo, "sire.descargar"),
        clasificar: tiene(yo, "sire.clasificar"),
      });
      if (!ver) {
        setErrorGeneral(MENSAJES.sinPermiso);
        return;
      }
      const c = await obtenerCliente(clienteId);
      if (vigente && c.ok && c.datos) setCliente(c.datos);
    })().catch(() => {
      if (vigente) {
        setPermisos({ ver: false, descargar: false, clasificar: false });
        setErrorGeneral(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [clienteId]);

  const cargarGrilla = useCallback(async () => {
    const id = sGrilla.nueva();
    try {
      const r = await listarVentas(clienteId, periodo, pagina, tamano, filtros);
      if (!sGrilla.vigente(id)) return;
      if (r.ok && r.datos) {
        setDatosPagina(r.datos);
        setErrorGeneral(null);
      } else if (r.status !== 401) {
        setErrorGeneral(mensajeDeError(r.status, r.datos));
      }
    } catch {
      if (sGrilla.vigente(id)) setErrorGeneral(MENSAJES.errorGeneral);
    }
    // `sGrilla` es estable (solo envuelve un ref).
  }, [clienteId, periodo, pagina, tamano, filtros]);

  const cargarResto = useCallback(async () => {
    const idR = sResumen.nueva();
    const idC = sCorrelatividad.nueva();
    const idP = sPropuestas.nueva();
    const falla = (status: number, datos: unknown) => {
      if (status !== 401) setErrorGeneral(mensajeDeError(status, datos));
    };
    const resumenP = obtenerResumenVentas(clienteId, periodo).then((r) => {
      if (!sResumen.vigente(idR)) return;
      if (r.ok && r.datos) setResumen(r.datos);
      else falla(r.status, r.datos);
    });
    const correlatividadP = obtenerCorrelatividad(clienteId, periodo).then(
      (r) => {
        if (!sCorrelatividad.vigente(idC)) return;
        if (r.ok && r.datos) setCorrelatividad(r.datos);
        else falla(r.status, r.datos);
      },
    );
    const propuestasP = listarPropuestas(clienteId, periodo).then(async (r) => {
      if (!sPropuestas.vigente(idP)) return;
      if (!(r.ok && Array.isArray(r.datos))) {
        falla(r.status, r.datos);
        return;
      }
      setPropuestas(r.datos);
      const ultima = r.datos[0];
      if (!ultima) {
        setDiferencias(null);
        return;
      }
      const d = await listarDiferencias(clienteId, periodo, ultima.id);
      if (!sPropuestas.vigente(idP)) return;
      if (d.ok && Array.isArray(d.datos)) setDiferencias(d.datos);
      else falla(d.status, d.datos);
    });
    try {
      await Promise.all([resumenP, correlatividadP, propuestasP]);
    } catch {
      setErrorGeneral(MENSAJES.errorGeneral);
    }
    // Los `s…` son estables (solo envuelven un ref).
  }, [clienteId, periodo]);

  // Cambia el periodo o el cliente: lo anterior deja de valer y se vuelve a pedir todo.
  useEffect(() => {
    if (!verVentas || !periodoValido) return;
    void cargarResto();
    return () => {
      sResumen.invalidar();
      sCorrelatividad.invalidar();
      sPropuestas.invalidar();
    };
  }, [verVentas, periodoValido, cargarResto]);

  // Cambia la página, el tamaño o los filtros: solo la grilla.
  useEffect(() => {
    if (!verVentas || !periodoValido) return;
    void cargarGrilla();
    return () => sGrilla.invalidar();
  }, [verVentas, periodoValido, cargarGrilla]);

  function cambiarPeriodo(valor: string) {
    const nuevo = valor.trim();
    setPeriodo(nuevo);
    setPagina(1);
    setDatosPagina(null);
    setResumen(null);
    setCorrelatividad(null);
    setPropuestas(null);
    setDiferencias(null);
  }

  function aplicarFiltros(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const limpios: FiltrosGrilla = {
      q: borrador.q,
      tipo: borrador.tipo.trim(),
      serie: borrador.serie.trim(),
      min: borrador.min.trim(),
      max: borrador.max.trim(),
    };
    const consulta = Object.fromEntries(
      Object.entries(limpios).filter(([, v]) => v !== ""),
    );
    if (!filtrosVentasSchema.safeParse(consulta).success) {
      setFiltrosInvalidos(true);
      return;
    }
    setFiltrosInvalidos(false);
    setFiltros(limpios);
    setPagina(1);
  }

  function recargarTodo() {
    void cargarGrilla();
    void cargarResto();
  }

  if (permisos === null) return <main className="p-6">Cargando…</main>;

  if (!permisos.ver) {
    return (
      <main className="flex flex-col gap-4 p-6">
        {errorGeneral && (
          <p role="alert" className="text-sm text-red-600">
            {errorGeneral}
          </p>
        )}
      </main>
    );
  }

  const puedeDescargar = permisos.descargar && !archivado;
  const puedeClasificar = permisos.clasificar && !archivado;
  const total = datosPagina?.total ?? 0;
  const hayMas =
    datosPagina !== null &&
    tamano !== "todas" &&
    pagina * tamano < datosPagina.total;
  const hrefImportar = `/clientes/${encodeURIComponent(clienteId)}/ventas/importar${
    periodoValido ? `?periodo=${periodo}` : ""
  }`;

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{M.titulo}</h1>
        {cliente && (
          <p className="text-sm">
            {cliente.razonSocial} · RUC {cliente.ruc}
          </p>
        )}
      </header>

      {archivado && (
        <p
          role="status"
          className="w-full max-w-xl rounded bg-amber-50 p-3 text-sm text-amber-900"
        >
          {M.clienteArchivado}
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
        {puedeDescargar && (
          <Link href={hrefImportar} className="rounded border px-4 py-2 text-sm">
            {M.importar}
          </Link>
        )}
        {puedeClasificar && (
          <button
            type="button"
            disabled
            className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          >
            {M.agregarVentaManual}
          </button>
        )}
      </div>
      {periodo !== "" && !periodoValido && (
        <p id="periodo-ayuda" className="text-sm text-red-600">
          {M.periodoInvalido}
        </p>
      )}

      <DescargaVentas
        key={`${clienteId}|${periodo}`}
        clienteId={clienteId}
        periodo={periodo}
        puedeDescargar={puedeDescargar}
        periodoValido={periodoValido}
        ultimaPropuesta={propuestas?.[0]}
        cargadas={propuestas !== null}
        alCompletar={recargarTodo}
      />

      {periodoValido && (
        <>
          <ResumenVentas resumen={resumen} />

          <CorrelatividadVentas
            correlatividad={correlatividad}
            puedeClasificar={puedeClasificar}
          />

          <section aria-label={M.tablaVentas} className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">{M.tablaVentas}</h2>

            <form
              onSubmit={aplicarFiltros}
              noValidate
              className="flex flex-wrap items-end gap-3"
            >
              <label className="flex flex-col gap-1 text-sm">
                {M.buscar}
                <input
                  type="text"
                  value={borrador.q}
                  onChange={(e) => setBorrador({ ...borrador, q: e.target.value })}
                  className="rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {M.filtroTipo}
                <input
                  type="text"
                  value={borrador.tipo}
                  onChange={(e) =>
                    setBorrador({ ...borrador, tipo: e.target.value })
                  }
                  className="w-20 rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {M.filtroSerie}
                <input
                  type="text"
                  value={borrador.serie}
                  onChange={(e) =>
                    setBorrador({ ...borrador, serie: e.target.value })
                  }
                  className="w-24 rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {M.montoMinimo}
                <input
                  type="text"
                  inputMode="decimal"
                  value={borrador.min}
                  onChange={(e) =>
                    setBorrador({ ...borrador, min: e.target.value })
                  }
                  className="w-32 rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {M.montoMaximo}
                <input
                  type="text"
                  inputMode="decimal"
                  value={borrador.max}
                  onChange={(e) =>
                    setBorrador({ ...borrador, max: e.target.value })
                  }
                  className="w-32 rounded border px-3 py-2"
                />
              </label>
              <button type="submit" className="rounded border px-4 py-2 text-sm">
                {M.filtrar}
              </button>
            </form>
            {filtrosInvalidos && (
              <p className="text-sm text-red-600">{M.filtrosInvalidos}</p>
            )}

            {datosPagina?.avisos.includes("todas_limitada") && (
              <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
                {M.todasLimitada(conMiles(datosPagina.total))}
              </p>
            )}

            <GrillaVentas
              key={`${pagina}|${tamano}|${JSON.stringify(filtros)}`}
              filas={datosPagina?.filas ?? []}
            />

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                {M.filasPorPagina}
                <select
                  value={String(tamano)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTamano(v === "todas" ? "todas" : (Number(v) as TamanoPaginaVentas));
                    setPagina(1);
                  }}
                  className="rounded border px-2 py-1"
                >
                  {TAMANOS_PAGINA_VENTAS.map((t) => (
                    <option key={t} value={String(t)}>
                      {String(t)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={pagina <= 1}
                onClick={() => setPagina(pagina - 1)}
                className="rounded border px-3 py-1 disabled:opacity-50"
              >
                {M.anterior}
              </button>
              <span>
                Página {pagina} · {conMiles(total)} comprobantes
              </span>
              <button
                type="button"
                disabled={!hayMas}
                onClick={() => setPagina(pagina + 1)}
                className="rounded border px-3 py-1 disabled:opacity-50"
              >
                {M.siguiente}
              </button>
            </div>
          </section>

          {propuestas !== null && propuestas.length > 0 && (
            <DiferenciasVentas diferencias={diferencias} />
          )}
        </>
      )}
    </main>
  );
}

// `useParams()` y `useSearchParams()` son datos de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6">Cargando…</main>}>
      <Ventas />
    </Suspense>
  );
}

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
  type EstadoPeriodoRespuesta,
  type PrevioArchivoDto,
  type TamanoPaginaVentas,
} from "@contapp/shared";
import { PanelGenerar } from "../../../../../components/archivos/panel-generar";
import { AgregarVenta } from "../../../../../components/ventas/agregar-venta";
import { ConfirmarAccion } from "../../../../../components/ventas/confirmar-accion";
import {
  CorrelatividadVentas,
  type RevertirElegido,
  type SaltoElegido,
} from "../../../../../components/ventas/correlatividad-ventas";
import { DescargaVentas } from "../../../../../components/ventas/descarga-ventas";
import { DiferenciasVentas } from "../../../../../components/ventas/diferencias-ventas";
import { EstadoPeriodoVentas } from "../../../../../components/ventas/estado-periodo-ventas";
import { ExcluirVenta } from "../../../../../components/ventas/excluir-venta";
import { GrillaVentas } from "../../../../../components/ventas/grilla-ventas";
import { JustificarSalto } from "../../../../../components/ventas/justificar-salto";
import { ResumenVentas } from "../../../../../components/ventas/resumen-ventas";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
} from "../../../../../lib/acceso";
import { obtenerCliente, type ClienteDto } from "../../../../../lib/clientes";
import {
  MENSAJES_COMPRAS,
  PERMISO_APROBAR_GENERAR,
  type EstadoPeriodoCompras,
} from "../../../../../lib/compras";
import {
  MENSAJES_VENTAS as M,
  PERIODO_VALIDO,
  SIN_FILTROS,
  bloqueoPorEstado,
  conMiles,
  listarDiferencias,
  listarPropuestas,
  listarVentas,
  obtenerCorrelatividad,
  obtenerResumenVentas,
  quitarVenta,
  restaurarVenta,
  revertirJustificacion,
  type CorrelatividadVentasDto,
  type DiferenciaVentasDto,
  type FiltrosGrilla,
  type PaginaVentasDto,
  type PropuestaVentasDto,
  type ResumenVentasConEstado,
  type VentaDto,
} from "../../../../../lib/ventas";

// Ventas del periodo de un cliente (spec 013, D14; RF-050, RF-052, RF-053, RF-056). El periodo (AAAAMM) se
// escribe aquí o llega en `?periodo=`. La pantalla solo pide y muestra: grilla paginada y virtualizada, resumen
// en soles, correlatividad y diferencias de la última descarga son cálculos del servidor, y los montos se
// muestran como cadenas. Ocultar acciones según permiso es comodidad (RNF-007); el backend valida.

const TAMANO_INICIAL: TamanoPaginaVentas = 25;

/** Formulario abierto sobre la correlatividad: justificar un salto o agregar una venta (con o sin salto). */
type Formulario =
  | { tipo: "justificar"; salto: SaltoElegido }
  | { tipo: "agregar"; salto: SaltoElegido | null };

/** Acción que espera confirmación (D23): revertir una justificación o quitar una venta agregada a mano. */
type Confirmacion =
  | { tipo: "revertir"; clave: string; justificacionId: string }
  | { tipo: "quitar"; clave: string; ventaId: string };

/** Excluir o restaurar una venta (012b, D12): ambos se piden desde la grilla o desde el panel y salen en un diálogo. */
type AccionExclusion =
  | { tipo: "excluir"; ventaId: string; clave: string | null }
  | { tipo: "restaurar"; ventaId: string; clave: string };

/** Cuánto dura el resalte de la venta ubicada desde el panel. */
const DURACION_RESALTE_MS = 6000;

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
    aprobarGenerar: boolean;
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
  const [resumen, setResumen] = useState<ResumenVentasConEstado | null>(null);
  const [estado, setEstado] = useState<EstadoPeriodoCompras>("abierto");
  const [marca, setMarca] = useState<{
    estado: EstadoPeriodoCompras;
    en: string;
  } | null>(null);
  const [exclusion, setExclusion] = useState<AccionExclusion | null>(null);
  /** Ventas con un error `excluible` según el último previo que vio el panel (D12). */
  const [excluibles, setExcluibles] = useState<ReadonlySet<string>>(new Set());
  const [resaltada, setResaltada] = useState<string | null>(null);
  const [porUbicar, setPorUbicar] = useState<string | null>(null);
  const temporizadorResalte = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [correlatividad, setCorrelatividad] =
    useState<CorrelatividadVentasDto | null>(null);
  const [propuestas, setPropuestas] = useState<PropuestaVentasDto[] | null>(
    null,
  );
  const [diferencias, setDiferencias] = useState<DiferenciaVentasDto[] | null>(
    null,
  );
  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);
  const [ejecutando, setEjecutando] = useState(false);

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
        setPermisos({
          ver: false,
          descargar: false,
          clasificar: false,
          aprobarGenerar: false,
        });
        return;
      }
      const ver = tiene(yo, "clientes.ver");
      setPermisos({
        ver,
        descargar: tiene(yo, "sire.descargar"),
        clasificar: tiene(yo, "sire.clasificar"),
        aprobarGenerar: tiene(yo, PERMISO_APROBAR_GENERAR),
      });
      if (!ver) {
        setErrorGeneral(MENSAJES.sinPermiso);
        return;
      }
      const c = await obtenerCliente(clienteId);
      if (vigente && c.ok && c.datos) setCliente(c.datos);
    })().catch(() => {
      if (vigente) {
        setPermisos({
          ver: false,
          descargar: false,
          clasificar: false,
          aprobarGenerar: false,
        });
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

  const falla = useCallback((status: number, datos: unknown) => {
    if (status !== 401) setErrorGeneral(mensajeDeError(status, datos));
  }, []);

  const cargarResumen = useCallback(async () => {
    const id = sResumen.nueva();
    const r = await obtenerResumenVentas(clienteId, periodo);
    if (!sResumen.vigente(id)) return;
    if (r.ok && r.datos) {
      setResumen(r.datos);
      // Un servidor anterior a 012b no manda el estado: el periodo cuenta como abierto.
      setEstado(r.datos.estado ?? "abierto");
    } else falla(r.status, r.datos);
    // `sResumen` es estable (solo envuelve un ref).
  }, [clienteId, periodo, falla]);

  const cargarCorrelatividad = useCallback(async () => {
    const id = sCorrelatividad.nueva();
    const r = await obtenerCorrelatividad(clienteId, periodo);
    if (!sCorrelatividad.vigente(id)) return;
    if (r.ok && r.datos) setCorrelatividad(r.datos);
    else falla(r.status, r.datos);
  }, [clienteId, periodo, falla]);

  const cargarPropuestas = useCallback(async () => {
    const id = sPropuestas.nueva();
    const r = await listarPropuestas(clienteId, periodo);
    if (!sPropuestas.vigente(id)) return;
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
    if (!sPropuestas.vigente(id)) return;
    if (d.ok && Array.isArray(d.datos)) setDiferencias(d.datos);
    else falla(d.status, d.datos);
  }, [clienteId, periodo, falla]);

  const cargarResto = useCallback(async () => {
    try {
      await Promise.all([
        cargarResumen(),
        cargarCorrelatividad(),
        cargarPropuestas(),
      ]);
    } catch {
      setErrorGeneral(MENSAJES.errorGeneral);
    }
  }, [cargarResumen, cargarCorrelatividad, cargarPropuestas]);

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
    setEstado("abierto");
    setMarca(null);
    setExclusion(null);
    setExcluibles(new Set());
    setResaltada(null);
    setPorUbicar(null);
    setCorrelatividad(null);
    setPropuestas(null);
    setDiferencias(null);
    setFormulario(null);
    setAviso(null);
    setErrorAccion(null);
    setConfirmacion(null);
  }

  function abrirFormulario(f: Formulario) {
    setAviso(null);
    setErrorAccion(null);
    setConfirmacion(null);
    setFormulario(f);
  }

  function pedirConfirmacion(c: Confirmacion) {
    setAviso(null);
    setErrorAccion(null);
    setFormulario(null);
    setConfirmacion(c);
  }

  /** Confirmada la acción: llama a la API y recarga lo que cambia; un error del servidor sale en un aviso. */
  async function ejecutarConfirmacion() {
    const c = confirmacion;
    if (c === null || ejecutando) return;
    setEjecutando(true);
    try {
      const r =
        c.tipo === "revertir"
          ? await revertirJustificacion(clienteId, periodo, c.justificacionId)
          : await quitarVenta(clienteId, periodo, c.ventaId);
      setConfirmacion(null);
      if (r.ok) {
        setAviso(c.tipo === "revertir" ? M.justificacionRevertida : M.ventaQuitada);
        if (c.tipo === "quitar") {
          void cargarGrilla();
          void Promise.all([cargarResumen(), cargarCorrelatividad()]).catch(() =>
            setErrorGeneral(MENSAJES.errorGeneral),
          );
        } else {
          void cargarCorrelatividad().catch(() => setErrorGeneral(MENSAJES.errorGeneral));
        }
      } else if (r.status !== 401) {
        setErrorAccion(c.tipo === "revertir" ? M.errorRevertir : M.errorQuitar);
        // Lo que ve la persona debe ser lo que dice el servidor (p. ej. otra persona ya la revirtió).
        if (c.tipo === "revertir")
          void cargarCorrelatividad().catch(() => setErrorGeneral(MENSAJES.errorGeneral));
      }
    } catch {
      setConfirmacion(null);
      setErrorAccion(c.tipo === "revertir" ? M.errorRevertir : M.errorQuitar);
    } finally {
      setEjecutando(false);
    }
  }

  /** Justificada: se cierra el formulario y solo cambia la alerta de correlatividad. */
  function alJustificar() {
    setFormulario(null);
    void cargarCorrelatividad().catch(() => setErrorGeneral(MENSAJES.errorGeneral));
  }

  /** Agregada: cambian la grilla, el resumen y los saltos; la propuesta original no se toca. */
  function alAgregarVenta() {
    setFormulario(null);
    setAviso(M.ventaAgregada);
    void cargarGrilla();
    void Promise.all([cargarResumen(), cargarCorrelatividad()]).catch(() =>
      setErrorGeneral(MENSAJES.errorGeneral),
    );
  }

  /** El estado del periodo lo cambió esta persona (revisar o reabrir): se guarda y se recarga el resumen. */
  function alCambiarEstado(r: EstadoPeriodoRespuesta) {
    setEstado(r.estado);
    setMarca(r.en === null ? null : { estado: r.estado, en: r.en });
    void cargarResumen().catch(() => setErrorGeneral(MENSAJES.errorGeneral));
  }

  /** Excluir o restaurar cambió la venta: grilla, resumen (estado y excluidas) y saltos; el panel recarga su previo. */
  function recargarTrasExclusion() {
    void cargarGrilla();
    void Promise.all([cargarResumen(), cargarCorrelatividad()]).catch(() =>
      setErrorGeneral(MENSAJES.errorGeneral),
    );
  }

  function resaltar(id: string) {
    if (temporizadorResalte.current !== null) clearTimeout(temporizadorResalte.current);
    setResaltada(id);
    temporizadorResalte.current = setTimeout(() => setResaltada(null), DURACION_RESALTE_MS);
  }
  useEffect(
    () => () => {
      if (temporizadorResalte.current !== null) clearTimeout(temporizadorResalte.current);
    },
    [],
  );

  /** Ubica y resalta una venta (enlace de un error del panel): si no está en la página, se piden todas sin filtros. */
  function ubicarFila(id: string) {
    setAviso(null);
    setErrorAccion(null);
    if (datosPagina?.filas.some((f) => f.id === id)) {
      resaltar(id);
      return;
    }
    const sinFiltros = JSON.stringify(filtros) === JSON.stringify(SIN_FILTROS);
    if (tamano === "todas" && pagina === 1 && sinFiltros) {
      setErrorAccion(M.noSeUbico);
      return;
    }
    setBorrador(SIN_FILTROS);
    setFiltros(SIN_FILTROS);
    setFiltrosInvalidos(false);
    setTamano("todas");
    setPagina(1);
    setDatosPagina(null);
    setPorUbicar(id);
  }

  useEffect(() => {
    if (porUbicar === null || datosPagina === null) return;
    if (datosPagina.filas.some((f) => f.id === porUbicar)) resaltar(porUbicar);
    else setErrorAccion(M.noSeUbico);
    setPorUbicar(null);
    // `resaltar` solo usa un ref y setters.
  }, [porUbicar, datosPagina]);

  function pedirExclusion(a: AccionExclusion) {
    setAviso(null);
    setErrorAccion(null);
    setFormulario(null);
    setConfirmacion(null);
    setExclusion(a);
  }

  /** Para el diálogo de excluir del panel: la clave sale de la grilla si la venta está en la página cargada. */
  const claveDe = (id: string): string | null => {
    const v = datosPagina?.filas.find((f) => f.id === id);
    return v ? `${v.serie}-${v.numero}` : null;
  };

  async function ejecutarRestaurar() {
    const a = exclusion;
    if (a?.tipo !== "restaurar" || ejecutando) return;
    setEjecutando(true);
    try {
      const r = await restaurarVenta(clienteId, periodo, a.ventaId);
      setExclusion(null);
      if (r.ok) {
        setAviso(M.ventaRestaurada);
        recargarTrasExclusion();
      } else if (r.status !== 401) {
        setErrorAccion(r.mensaje || M.errorRestaurar);
        // Otra persona cambió el estado o la venta: se vuelve a pedir lo que ve la pantalla.
        recargarTrasExclusion();
      }
    } catch {
      setExclusion(null);
      setErrorAccion(M.errorRestaurar);
    } finally {
      setEjecutando(false);
    }
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
  // P-1, P-9: con `generado` nadie escribe; con `revisado`, solo quien tiene `sire.aprobar_generar`. Los botones
  // siguen a la vista pero deshabilitados, con este texto.
  const bloqueo = bloqueoPorEstado(estado, permisos.aprobarGenerar);
  const escribible = bloqueo === null;
  /** Una venta del SIRE que no cuadra, o con un error `excluible` en el último previo, se puede excluir (D12). */
  const puedeExcluirFila = (v: VentaDto): boolean =>
    v.origen === "sire" && (!v.cuadra || excluibles.has(v.id));
  const total = datosPagina?.total ?? 0;
  const hayMas =
    datosPagina !== null &&
    tamano !== "todas" &&
    pagina * tamano < datosPagina.total;
  const hrefCompras = `/clientes/${encodeURIComponent(clienteId)}/compras${
    periodoValido ? `?periodo=${periodo}` : ""
  }`;
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
        {/* Enlace entre Ventas y Compras (spec 015, D-1). */}
        <nav aria-label="Registros del cliente" className="flex gap-3 text-sm">
          <Link href={hrefCompras} className="underline">
            {MENSAJES_COMPRAS.enlaceCompras}
          </Link>
        </nav>
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
        {puedeDescargar &&
          (escribible ? (
            <Link href={hrefImportar} className="rounded border px-4 py-2 text-sm">
              {M.importar}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              title={bloqueo ?? undefined}
              className="rounded border px-4 py-2 text-sm opacity-50"
            >
              {M.importar}
            </span>
          ))}
        {puedeClasificar && (
          <button
            type="button"
            disabled={!periodoValido || !escribible}
            title={bloqueo ?? undefined}
            onClick={() => abrirFormulario({ tipo: "agregar", salto: null })}
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

      {periodoValido && (
        <EstadoPeriodoVentas
          key={`estado|${clienteId}|${periodo}`}
          clienteId={clienteId}
          periodo={periodo}
          estado={estado}
          clasificar={permisos.clasificar}
          aprobarGenerar={permisos.aprobarGenerar}
          archivado={archivado}
          en={marca !== null && marca.estado === estado ? marca.en : null}
          alCambiar={alCambiarEstado}
          alRecargar={() =>
            void cargarResumen().catch(() => setErrorGeneral(MENSAJES.errorGeneral))
          }
        />
      )}
      {periodoValido && bloqueo !== null && (
        <p role="status" className="w-full max-w-xl rounded bg-amber-50 p-3 text-sm text-amber-900">
          {bloqueo}
        </p>
      )}

      {periodoValido && (
        <PanelGenerar
          key={`archivo|${clienteId}|${periodo}`}
          clienteId={clienteId}
          periodo={periodo}
          libro="ventas"
          puedeVer={permisos.ver}
          puedeGenerar={permisos.aprobarGenerar && !archivado}
          recarga={resumen}
          bloqueo={bloqueo}
          alUbicarFila={ubicarFila}
          alGenerado={() =>
            void Promise.all([cargarGrilla(), cargarResumen()]).catch(() =>
              setErrorGeneral(MENSAJES.errorGeneral),
            )
          }
          alExcluir={
            puedeClasificar
              ? (id) => pedirExclusion({ tipo: "excluir", ventaId: id, clave: claveDe(id) })
              : undefined
          }
          alRestaurar={
            puedeClasificar
              ? (x) =>
                  pedirExclusion({
                    tipo: "restaurar",
                    ventaId: x.filaId,
                    clave: x.comprobante,
                  })
              : undefined
          }
          alPrevio={(p: PrevioArchivoDto) =>
            setExcluibles(
              new Set(
                p.errores
                  .filter((e) => e.excluible && e.filaId !== null)
                  .map((e) => e.filaId as string),
              ),
            )
          }
        />
      )}

      <DescargaVentas
        key={`${clienteId}|${periodo}`}
        clienteId={clienteId}
        periodo={periodo}
        puedeDescargar={puedeDescargar}
        bloqueo={bloqueo}
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
            alJustificar={
              escribible
                ? (salto) => abrirFormulario({ tipo: "justificar", salto })
                : undefined
            }
            alAgregar={
              escribible
                ? (salto) => abrirFormulario({ tipo: "agregar", salto })
                : undefined
            }
            alRevertir={
              escribible
                ? (r: RevertirElegido) => pedirConfirmacion({ tipo: "revertir", ...r })
                : undefined
            }
          />

          {aviso && (
            <p role="status" className="text-sm">
              {aviso}
            </p>
          )}
          {errorAccion && (
            <p role="alert" className="text-sm text-red-600">
              {errorAccion}
            </p>
          )}
          {puedeClasificar && escribible && confirmacion && (
            <ConfirmarAccion
              mensaje={
                confirmacion.tipo === "revertir"
                  ? M.confirmarRevertir(confirmacion.clave)
                  : M.confirmarQuitar(confirmacion.clave)
              }
              ocupado={ejecutando}
              alConfirmar={() => void ejecutarConfirmacion()}
              alCancelar={() => setConfirmacion(null)}
            />
          )}
          {puedeClasificar && escribible && formulario?.tipo === "justificar" && (
            <JustificarSalto
              key={`j|${periodo}|${formulario.salto.tipo}|${formulario.salto.serie}|${formulario.salto.desde}|${formulario.salto.hasta}`}
              clienteId={clienteId}
              periodo={periodo}
              salto={formulario.salto}
              alGuardar={alJustificar}
              alCancelar={() => setFormulario(null)}
            />
          )}
          {puedeClasificar && escribible && formulario?.tipo === "agregar" && (
            <AgregarVenta
              key={`a|${periodo}|${formulario.salto?.tipo}|${formulario.salto?.serie}|${formulario.salto?.desde}`}
              clienteId={clienteId}
              periodo={periodo}
              salto={formulario.salto}
              alAgregar={alAgregarVenta}
              alCancelar={() => setFormulario(null)}
            />
          )}

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
              resaltada={resaltada}
              bloqueo={bloqueo}
              puedeExcluir={puedeExcluirFila}
              alExcluir={
                puedeClasificar
                  ? (v: VentaDto) =>
                      pedirExclusion({
                        tipo: "excluir",
                        ventaId: v.id,
                        clave: `${v.serie}-${v.numero}`,
                      })
                  : undefined
              }
              alRestaurar={
                puedeClasificar
                  ? (v: VentaDto) =>
                      pedirExclusion({
                        tipo: "restaurar",
                        ventaId: v.id,
                        clave: `${v.serie}-${v.numero}`,
                      })
                  : undefined
              }
              alQuitar={
                puedeClasificar
                  ? (v: VentaDto) =>
                      pedirConfirmacion({
                        tipo: "quitar",
                        clave: `${v.serie}-${v.numero}`,
                        ventaId: v.id,
                      })
                  : undefined
              }
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

      {/* Excluir y restaurar salen en un diálogo sobre todo lo demás: el panel lateral no lo tapa. */}
      {puedeClasificar && escribible && exclusion !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          {exclusion.tipo === "excluir" ? (
            <ExcluirVenta
              key={`x|${exclusion.ventaId}`}
              clienteId={clienteId}
              periodo={periodo}
              ventaId={exclusion.ventaId}
              clave={exclusion.clave}
              alTerminar={() => {
                setExclusion(null);
                setAviso(M.ventaExcluida);
                recargarTrasExclusion();
              }}
              alCancelar={() => setExclusion(null)}
              alFallar={(status) => {
                if (status === 403 || status === 404 || status === 409) {
                  recargarTrasExclusion();
                }
              }}
            />
          ) : (
            <ConfirmarAccion
              key={`r|${exclusion.ventaId}`}
              mensaje={M.confirmarRestaurar(exclusion.clave)}
              ocupado={ejecutando}
              alConfirmar={() => void ejecutarRestaurar()}
              alCancelar={() => setExclusion(null)}
            />
          )}
        </div>
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

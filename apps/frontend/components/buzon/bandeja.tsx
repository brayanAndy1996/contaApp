"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, EncabezadoPagina } from "../ui";
import { AtenderLote } from "./atender-lote";
import { DetalleMensaje } from "./detalle-mensaje";
import { FiltrosBandeja, type ClienteOpcion } from "./filtros-bandeja";
import { ListaMensajes } from "./lista-mensajes";
import { RevisarBuzon } from "./revisar-buzon";
import { MENSAJES, mensajeDeError, usePuede } from "../../lib/acceso";
import {
  MENSAJES_BANDEJA as B,
  MENSAJES_BUZON as M,
  PERMISO_BUZON_ATENDER,
  hrefBandeja,
  listarBandeja,
  parametrosDeValores,
  valoresDeParametros,
  type EstadoBuzonVista,
  type FilaBandeja,
  type ValoresFiltros,
} from "../../lib/buzon";
import { listarClientes } from "../../lib/clientes";
import { fechaHoraLima } from "../../lib/fechas";
import { useEsMovil } from "../../lib/pantalla";
import { cn } from "../../lib/utils";

// Bandeja de buzones (spec 024, D-2 a D-4, D-10, CA-1 a CA-3, CA-7, CA-11): la lista de mensajes de todos los clientes
// visibles o, con `clienteFijo`, la de un cliente (`/clientes/:id/buzon`, con «Revisar buzón ahora» arriba). Los filtros
// viven en la URL con los mismos nombres que la API; abre en «Pendientes»; `?mensaje=<id>` abre el detalle de la bandeja
// fijada aunque el mensaje no esté en la página cargada. Los permisos solo ocultan (el backend valida).

export interface ClienteFijo {
  id: string;
  archivado: boolean;
}

export function Bandeja({ clienteFijo }: { clienteFijo?: ClienteFijo | undefined }) {
  const router = useRouter();
  const params = useSearchParams();
  const movil = useEsMovil();
  const puedeAtender = usePuede(PERMISO_BUZON_ATENDER) === true;
  const clienteId = clienteFijo?.id ?? null;
  const fijada = clienteId !== null;

  const textoParams = params.toString();
  const valores = useMemo(
    () => valoresDeParametros(new URLSearchParams(textoParams), fijada),
    [textoParams, fijada],
  );
  const mensajeId = fijada ? params.get("mensaje") : null;
  const claveLista = `${clienteId ?? ""}|${parametrosDeValores(valores).toString()}`;

  const [filas, setFilas] = useState<FilaBandeja[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoBuzonVista | null>(null);
  const [cargado, setCargado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [clientes, setClientes] = useState<ClienteOpcion[]>([]);

  const valoresRef = useRef(valores);
  valoresRef.current = valores;
  const generacion = useRef(0);
  const claveAnterior = useRef<string | null>(null);

  // Primera página: al abrir, al cambiar un filtro y al volver a leer (pestaña, lote, atención en el detalle).
  useEffect(() => {
    const miGeneracion = ++generacion.current;
    const cambioDeFiltro = claveAnterior.current !== claveLista;
    claveAnterior.current = claveLista;
    if (cambioDeFiltro) {
      setFilas([]);
      setSiguiente(null);
      setCargado(false);
      setSeleccion(new Set());
    }
    listarBandeja(clienteId, valoresRef.current, null)
      .then((r) => {
        if (miGeneracion !== generacion.current || r.status === 401) return;
        if (r.ok && r.datos) {
          const pagina = r.datos;
          setFilas(pagina.mensajes);
          setSiguiente(pagina.siguiente);
          if (pagina.estado) setEstado(pagina.estado);
          setSeleccion((previa) => {
            const presentes = new Set(pagina.mensajes.map((f) => f.id));
            return new Set([...previa].filter((id) => presentes.has(id)));
          });
          setError(null);
        } else {
          setError(r.status === 200 || r.status === 500 ? M.errorCarga : mensajeDeError(r.status, r.datos));
        }
      })
      .catch(() => {
        if (miGeneracion === generacion.current) setError(MENSAJES.errorGeneral);
      })
      .finally(() => {
        if (miGeneracion === generacion.current) setCargado(true);
      });
  }, [claveLista, clienteId, version]);

  // Al volver a la pestaña se vuelve a leer: lo que otra persona atendió mientras tanto sale de «Pendientes».
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === "visible") setVersion((v) => v + 1);
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, []);

  // Clientes del filtro «Cliente». Si no se pueden leer, el filtro solo ofrece «Todos los clientes».
  const incluirArchivados = valores.archivados || (clienteFijo?.archivado ?? false);
  useEffect(() => {
    let vigente = true;
    listarClientes(incluirArchivados ? { archivados: true } : {})
      .then((r) => {
        if (vigente && r.ok && r.datos) setClientes(r.datos.map((c) => ({ id: c.id, razonSocial: c.razonSocial })));
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [incluirArchivados]);

  const cargarMas = useCallback(async (): Promise<void> => {
    if (!siguiente || ocupado) return;
    const miGeneracion = generacion.current;
    setOcupado(true);
    try {
      const r = await listarBandeja(clienteId, valoresRef.current, siguiente);
      if (miGeneracion !== generacion.current || r.status === 401) return;
      if (r.ok && r.datos) {
        const pagina = r.datos;
        setFilas((previas) => [...previas, ...pagina.mensajes]);
        setSiguiente(pagina.siguiente);
        setError(null);
      } else {
        setError(r.status === 200 || r.status === 500 ? M.errorCarga : mensajeDeError(r.status, r.datos));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }, [clienteId, ocupado, siguiente]);

  function cambiarFiltros(nuevos: ValoresFiltros) {
    valoresRef.current = nuevos;
    router.replace(hrefBandeja(nuevos, clienteId, mensajeId ?? undefined));
  }

  function elegirCliente(id: string | null) {
    router.push(hrefBandeja(valoresRef.current, id));
  }

  function volverALista() {
    const q = new URLSearchParams(textoParams);
    q.delete("mensaje");
    const resto = q.toString();
    const ruta = clienteId ? `/clientes/${encodeURIComponent(clienteId)}/buzon` : "/buzon";
    router.push(resto ? `${ruta}?${resto}` : ruta);
  }

  const soloDetalle = movil && mensajeId !== null;
  const seleccionados = filas.filter((f) => seleccion.has(f.id));
  const chipPendientes = valores.atencion === "pendientes" && valores.categoria === "";
  const chipCriticos = valores.atencion === "pendientes" && valores.categoria === "criticos";

  const chip = (activo: boolean) =>
    cn("max-lg:h-11", activo && "border-primario bg-primario-suave text-primario hover:bg-primario-suave");

  const detalle = fijada && mensajeId !== null && (
    <div className="flex min-w-0 flex-col gap-3">
      <Button type="button" variant="secundario" onClick={volverALista} className="self-start max-lg:h-11">
        {B.volver}
      </Button>
      <DetalleMensaje
        key={mensajeId}
        clienteId={clienteId}
        mensajeId={mensajeId}
        archivado={clienteFijo?.archivado ?? false}
        alCambiarAtencion={() => setVersion((v) => v + 1)}
      />
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!fijada && <EncabezadoPagina titulo={B.tituloGlobal} />}
      {soloDetalle ? (
        detalle
      ) : (
        <>
          {fijada && <RevisarBuzon clienteId={clienteId} archivado={clienteFijo?.archivado ?? false} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secundario"
              aria-pressed={chipPendientes}
              onClick={() => cambiarFiltros({ ...valores, atencion: "pendientes", categoria: "" })}
              className={chip(chipPendientes)}
            >
              {B.chipPendientes}
            </Button>
            <Button
              type="button"
              variant="secundario"
              aria-pressed={chipCriticos}
              onClick={() => cambiarFiltros({ ...valores, atencion: "pendientes", categoria: "criticos" })}
              className={chip(chipCriticos)}
            >
              {B.chipCriticosPendientes}
            </Button>
          </div>
          <FiltrosBandeja
            valores={valores}
            clientes={clientes}
            clienteId={clienteId ?? undefined}
            alCambiar={cambiarFiltros}
            alElegirCliente={elegirCliente}
          />
          {puedeAtender && (
            <AtenderLote
              seleccionados={seleccionados}
              alTerminar={() => {
                setSeleccion(new Set());
                setVersion((v) => v + 1);
              }}
            />
          )}
          {error && <Alert tono="error">{error}</Alert>}
          {!cargado && !error && <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}
          <div className={cn("grid min-w-0 gap-4", mensajeId !== null && "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}>
            {cargado && !error && (
              <Card>
                {fijada && (
                  <p className="m-0 text-sm text-tinta-suave">
                    {estado?.ultimaCaptura ? M.ultimaCaptura(fechaHoraLima(estado.ultimaCaptura)) : M.nuncaRevisado}
                  </p>
                )}
                <ListaMensajes
                  mensajes={filas}
                  mostrarCliente={!fijada}
                  {...(puedeAtender ? { seleccion: { ids: seleccion, alCambiar: setSeleccion } } : {})}
                />
                {siguiente && (
                  <Button
                    type="button"
                    variant="secundario"
                    disabled={ocupado}
                    onClick={() => void cargarMas()}
                    className="self-start max-lg:h-11"
                  >
                    {M.cargarMas}
                  </Button>
                )}
              </Card>
            )}
            {detalle}
          </div>
        </>
      )}
    </div>
  );
}

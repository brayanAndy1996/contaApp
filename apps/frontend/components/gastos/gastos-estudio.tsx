"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PalabraGlobalVista, PalabraPropiaVista } from "@contapp/shared";
import { MENSAJES, cargarYo, tiene, type Yo } from "../../lib/acceso";
import {
  MENSAJES_GASTOS as M,
  PERMISO_GASTOS_GESTIONAR,
  fijarEstadoGlobal,
  fijarEstadoPalabra,
  fijarUmbral,
  leerGastosEstudio,
  normalizarBusqueda,
  type GastosEstudioVista,
  type ResultadoGastos,
} from "../../lib/gastos";
import { Alert, Card, Input } from "../ui";
import { AgregarPalabra } from "./agregar-palabra";
import { PalabrasGlobales } from "./palabras-globales";
import { PalabrasPropias } from "./palabras-propias";
import { Umbral } from "./umbral";

// Sección «Gastos no deducibles» de «Reglas del motor» (spec 027, R-4, R-11, D-3, CA-8, CA-10): umbral de sospecha, palabras
// globales (el estudio solo las desactiva o reactiva para sí) y palabras propias con su origen y autor. Sin actualización
// optimista: tras cada cambio del servidor se vuelve a leer la vista. Solo un Dueño o Administrador con alcance global y
// `reglas.gestionar` puede cambiar; el resto ve todo en solo lectura. El servidor valida: aquí solo se oculta.

export function GastosEstudio() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [vista, setVista] = useState<GastosEstudioVista | null>(null);
  const [cargado, setCargado] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const [{ yo: actual }, lectura] = await Promise.all([cargarYo(), leerGastosEstudio()]);
      if (!vigente) return;
      setYo(actual);
      if (lectura.ok) setVista(lectura.datos);
      else if (lectura.status !== 401) setErrorCarga(lectura.status === 403 ? MENSAJES.sinPermiso : M.errorCarga);
      setCargado(true);
    })().catch(() => {
      if (!vigente) return;
      setErrorCarga(M.errorCarga);
      setCargado(true);
    });
    return () => {
      vigente = false;
    };
  }, []);

  const releer = useCallback(async () => {
    try {
      const r = await leerGastosEstudio();
      if (r.ok) setVista(r.datos);
    } catch {
      // La vista que ya se muestra se conserva.
    }
  }, []);

  const puedeCambiar = tiene(yo, PERMISO_GASTOS_GESTIONAR) && yo?.alcance === "global";

  /** Un cambio: espera al servidor, anuncia y vuelve a leer. Un conflicto de versión también vuelve a leer. */
  const cambiar = useCallback(
    async (llamada: () => Promise<ResultadoGastos<unknown>>, exito: string): Promise<void> => {
      if (enCurso.current) return;
      enCurso.current = true;
      setOcupado(true);
      setError(null);
      setAnuncio("");
      try {
        const r = await llamada();
        if (r.ok) {
          setAnuncio(exito);
          await releer();
        } else if (r.status !== 401) {
          setError(r.mensaje);
          if (r.codigo === "version_cambiada") await releer();
        }
      } catch {
        setError(MENSAJES.errorGeneral);
      } finally {
        enCurso.current = false;
        setOcupado(false);
      }
    },
    [releer],
  );

  const q = normalizarBusqueda(busqueda);
  const coincide = (palabra: string): boolean => q === "" || normalizarBusqueda(palabra).includes(q);
  const globales = (vista?.globales ?? []).filter((p) => coincide(p.palabra));
  const propias = (vista?.propias ?? []).filter((p) => coincide(p.palabra));

  if (!cargado) return <p className="text-sm text-tinta-suave">{M.cargando}</p>;
  if (vista === null) {
    return errorCarga !== null ? (
      <Alert tono="error">{errorCarga}</Alert>
    ) : null;
  }

  const buscando = q !== "";
  const sinNada = buscando && globales.length === 0 && propias.length === 0;

  return (
    <section aria-labelledby="titulo-gastos-estudio" className="flex min-w-0 max-w-4xl flex-col gap-4">
      <h2 id="titulo-gastos-estudio" className="m-0 font-titulo text-xl font-bold text-tinta">
        {M.tituloSeccion}
      </h2>
      {error && <Alert tono="error">{error}</Alert>}
      {anuncio && <Alert tono="ok">{anuncio}</Alert>}
      {!puedeCambiar && (
        <p className="m-0 rounded-control border border-aviso-borde bg-aviso-fondo px-3.5 py-3 text-sm text-aviso">{M.soloLectura}</p>
      )}

      <Card className="gap-3 p-4 sm:p-5">
        <Umbral
          valor={vista.umbral}
          puedeCambiar={puedeCambiar}
          ocupado={ocupado}
          alInvalido={() => {
            setAnuncio("");
            setError(M.umbralInvalido);
          }}
          alGuardar={(umbral) => void cambiar(() => fijarUmbral(umbral, vista.versionUmbral), M.umbralGuardado)}
        />
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full max-w-sm min-w-0 flex-col">
          <Input
            type="text"
            autoComplete="off"
            aria-label={M.campoBuscar}
            placeholder={M.campoBuscar}
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className="max-lg:h-11"
          />
        </div>
        {puedeCambiar && (
          <AgregarPalabra
            alAgregada={() => {
              setError(null);
              setAnuncio(M.palabraAgregada);
              void releer();
            }}
          />
        )}
      </div>

      {sinNada && <p className="m-0 text-tinta-media">{M.sinCoincidencias}</p>}

      {globales.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 font-titulo text-base font-bold text-tinta">{M.tituloGlobales}</h3>
          <PalabrasGlobales
            palabras={globales}
            puedeCambiar={puedeCambiar}
            ocupado={ocupado}
            alCambiar={(p: PalabraGlobalVista, activa: boolean) =>
              void cambiar(() => fijarEstadoGlobal(p.id, activa), M.globalCambiada(p.palabra, activa))
            }
          />
        </div>
      )}

      {!sinNada && (!buscando || propias.length > 0) && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="m-0 font-titulo text-base font-bold text-tinta">{M.tituloPropias}</h3>
            <span className="cifras text-sm text-tinta-suave">{M.contador(vista.activasPropias)}</span>
          </div>
          {vista.propias.length === 0 ? (
            <p className="m-0 text-tinta-media">{M.sinPropias}</p>
          ) : (
            <PalabrasPropias
              palabras={propias}
              puedeCambiar={puedeCambiar}
              ocupado={ocupado}
              alCambiar={(p: PalabraPropiaVista, activa: boolean) =>
                void cambiar(() => fijarEstadoPalabra(p.id, activa, p.version), M.propiaCambiada(p.palabra, activa))
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

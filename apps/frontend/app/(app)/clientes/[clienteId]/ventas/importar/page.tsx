"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EncabezadoPagina,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  enlace,
} from "../../../../../../components/ui";
import { MENSAJES, cargarYo, tiene } from "../../../../../../lib/acceso";
import { obtenerCliente } from "../../../../../../lib/clientes";
import {
  PERMISO_APROBAR_GENERAR,
  type EstadoPeriodoCompras,
} from "../../../../../../lib/compras";
import {
  MENSAJES_VENTAS as M,
  PERIODO_VALIDO,
  bloqueoPorEstado,
  confirmarImportacion,
  mensajeDeErrorImportacionVentas,
  obtenerResumenVentas,
  vistaPreviaImportacion,
  type PropuestaVentasDto,
  type VistaPreviaVentas,
} from "../../../../../../lib/ventas";

// Asistente de importación de la propuesta de ventas (spec 013, D6, D3, D16; RF-051, CA-10): archivo → vista
// previa → confirmar. Es el asistente de 007b adaptado a ventas. El archivo vive solo en memoria (un `ref`),
// viaja como cuerpo crudo y nunca se lee ni se muestra aquí: la vista previa trae únicamente números de fila,
// estado y códigos de motivo. Todo o nada: con una fila con error no se puede confirmar; las advertencias (D22) no bloquean. Sin cálculos.

const ACEPTA = ".xlsx,.csv,.txt,text/csv,text/plain";
/** Filas válidas que se listan; las filas con error se muestran siempre todas. */
const MAX_VALIDAS_LISTADAS = 200;

type Permiso = "cargando" | "si" | "no";

function Importar() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const busqueda = useSearchParams();
  const [permiso, setPermiso] = useState<Permiso>("cargando");
  const [archivado, setArchivado] = useState(false);
  // Estado del periodo (012b, P-1, P-9): con `generado`, o `revisado` sin `sire.aprobar_generar`, no se importa.
  const [aprobarGenerar, setAprobarGenerar] = useState(false);
  const [estado, setEstado] = useState<EstadoPeriodoCompras>("abierto");
  const [periodo, setPeriodo] = useState(busqueda.get("periodo") ?? "");
  const periodoValido = PERIODO_VALIDO.test(periodo);

  const archivo = useRef<File | null>(null);
  const [haySeleccion, setHaySeleccion] = useState(false);
  const [vista, setVista] = useState<VistaPreviaVentas | null>(null);
  const [propuesta, setPropuesta] = useState<PropuestaVentasDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo } = await cargarYo();
      if (!vigente) return;
      const puede = tiene(yo, "sire.descargar");
      setPermiso(puede ? "si" : "no");
      setAprobarGenerar(tiene(yo, PERMISO_APROBAR_GENERAR));
      if (!puede) return;
      const c = await obtenerCliente(clienteId);
      if (vigente && c.ok && c.datos) setArchivado(c.datos.archivado === true);
    })().catch(() => {
      if (vigente) setPermiso("no");
    });
    return () => {
      vigente = false;
      archivo.current = null; // el archivo se descarta al salir
    };
  }, [clienteId]);

  // El estado sale del resumen del periodo; si no se puede leer, el servidor igual valida al importar.
  useEffect(() => {
    setEstado("abierto");
    if (permiso !== "si" || !periodoValido) return;
    let vigente = true;
    void obtenerResumenVentas(clienteId, periodo)
      .then((r) => {
        if (vigente && r.ok && r.datos) setEstado(r.datos.estado ?? "abierto");
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [permiso, clienteId, periodo, periodoValido]);
  const bloqueo = bloqueoPorEstado(estado, aprobarGenerar);

  if (permiso === "cargando") return <main className="p-6 text-tinta-suave">Cargando…</main>;
  if (permiso === "no") {
    return (
      <main className="p-6">
        <Alert tono="error">{MENSAJES.sinPermiso}</Alert>
      </main>
    );
  }

  function descartarResultados(): void {
    setVista(null);
    setPropuesta(null);
    setError(null);
  }

  function alElegir(e: ChangeEvent<HTMLInputElement>): void {
    archivo.current = e.target.files?.[0] ?? null;
    setHaySeleccion(archivo.current !== null);
    descartarResultados();
  }

  function cambiarPeriodo(valor: string): void {
    setPeriodo(valor.trim());
    descartarResultados();
  }

  async function revisar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || !periodoValido || ocupado) return;
    setOcupado(true);
    descartarResultados();
    try {
      const r = await vistaPreviaImportacion(clienteId, periodo, elegido);
      if (archivo.current !== elegido) return; // cambió el archivo mientras tanto
      if (r.ok && r.datos) setVista(r.datos);
      else setError(mensajeDeErrorImportacionVentas(r.status, r.datos));
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || !vista || !periodoValido || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await confirmarImportacion(clienteId, periodo, elegido);
      if (r.ok && r.datos) {
        archivo.current = null; // el archivo se descarta al confirmar
        setHaySeleccion(false);
        setVista(null);
        setPropuesta(r.datos.propuesta);
      } else {
        setError(mensajeDeErrorImportacionVentas(r.status, r.datos));
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  function cancelar(): void {
    archivo.current = null;
    setHaySeleccion(false);
    descartarResultados();
  }

  const hrefVentas = `/clientes/${encodeURIComponent(clienteId)}/ventas${
    periodoValido ? `?periodo=${periodo}` : ""
  }`;

  let filasListadas = vista?.filas ?? [];
  let omitidas = 0;
  if (vista) {
    let validas = 0;
    filasListadas = vista.filas.filter((f) => {
      if (f.estado !== "valida") return true;
      validas += 1;
      return validas <= MAX_VALIDAS_LISTADAS;
    });
    omitidas = vista.filas.length - filasListadas.length;
  }

  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <EncabezadoPagina
        titulo={M.tituloImportar}
        acciones={
          <Link
            href={hrefVentas}
            className={`${enlace} text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center`}
          >
            Volver a ventas
          </Link>
        }
      />

      {archivado ? (
        <Alert tono="aviso" role="status">
          {M.clienteArchivado}
        </Alert>
      ) : (
        <Card>
          <Label className="max-w-xs">
            {M.etiquetaPeriodo}
            <Input
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              value={periodo}
              onChange={(e) => cambiarPeriodo(e.target.value)}
              aria-describedby={
                periodo !== "" && !periodoValido ? "periodo-ayuda" : undefined
              }
              className="font-mono font-normal max-lg:h-11"
            />
          </Label>
          {periodo !== "" && !periodoValido && (
            <p id="periodo-ayuda" className="m-0 text-sm text-error">
              {M.periodoInvalido}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="archivo-ventas">{M.archivo}</Label>
            <input
              id="archivo-ventas"
              type="file"
              accept={ACEPTA}
              onChange={alElegir}
              className="text-sm text-tinta file:mr-3 file:h-10 file:cursor-pointer file:rounded-control file:border file:border-linea-control file:bg-hoja file:px-4 file:text-sm file:font-semibold file:text-tinta hover:file:bg-neutro-fondo max-lg:file:h-11"
            />
          </div>
          <div>
            <Button
              type="button"
              onClick={() => void revisar()}
              disabled={!haySeleccion || !periodoValido || ocupado || bloqueo !== null}
              title={bloqueo ?? undefined}
              className="max-lg:h-11"
            >
              {M.revisarArchivo}
            </Button>
          </div>
          {bloqueo !== null && <Alert tono="info">{bloqueo}</Alert>}
        </Card>
      )}

      {error && <Alert tono="error">{error}</Alert>}

      {vista && (
        <Card aria-label="Vista previa">
          <ul className="m-0 flex flex-col gap-1 p-0 text-sm text-tinta">
            <li>{M.validas(vista.validas)}</li>
            <li>{M.conError(vista.conError)}</li>
            {vista.conAdvertencia > 0 && (
              <li>{M.conAdvertencia(vista.conAdvertencia)}</li>
            )}
          </ul>
          {vista.conError > 0 && (
            <p className="m-0 text-sm text-tinta-media">{M.corregirFilas}</p>
          )}
          {vista.conAdvertencia > 0 && vista.conError === 0 && (
            <p className="m-0 text-sm text-tinta-media">{M.avisoAdvertencias}</p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fila</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Motivos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filasListadas.map((f) => (
                <TableRow key={f.n}>
                  <TableCell numerico className="align-top">
                    {f.n}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge
                      tono={
                        f.estado !== "valida"
                          ? "error"
                          : f.advertencias.length > 0
                            ? "aviso"
                            : "ok"
                      }
                    >
                      {f.estado !== "valida"
                        ? M.estadoFila.conError
                        : f.advertencias.length > 0
                          ? M.estadoFila.conAdvertencia
                          : M.estadoFila.valida}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    {f.motivos.map((m) => (
                      <p key={m} className="m-0">
                        {M.motivos[m] ?? M.archivoInvalido}
                      </p>
                    ))}
                    {f.advertencias.map((a) => (
                      <p key={a} className="m-0">
                        {M.advertencias[a]}
                      </p>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {omitidas > 0 && <p className="m-0 text-sm text-tinta-media">{M.filasOcultas(omitidas)}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void confirmar()}
              disabled={
                vista.conError > 0 || vista.validas === 0 || ocupado || bloqueo !== null
              }
              title={bloqueo ?? undefined}
              className="max-lg:h-11"
            >
              {M.confirmarImportacion}
            </Button>
            <Button
              type="button"
              variant="secundario"
              onClick={cancelar}
              disabled={ocupado}
              className="max-lg:h-11"
            >
              {M.cancelar}
            </Button>
          </div>
        </Card>
      )}

      {propuesta && (
        <Card aria-label="Resultado">
          <p className="m-0 text-sm text-tinta">
            {M.resumenDescarga(propuesta.filasNuevas, propuesta.filasDistintas)}
          </p>
          <Link
            href={hrefVentas}
            className={`${enlace} text-sm max-lg:inline-flex max-lg:min-h-11 max-lg:items-center`}
          >
            {M.verVentas}
          </Link>
        </Card>
      )}
    </main>
  );
}

// `useParams()` y `useSearchParams()` son datos de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">Cargando…</main>}>
      <Importar />
    </Suspense>
  );
}

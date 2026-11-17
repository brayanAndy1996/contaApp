"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EncabezadoPagina,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  buttonVariants,
  enlace,
} from "../../../../components/ui";
import { MENSAJES, usePuede } from "../../../../lib/acceso";
import {
  MASCARA_CLAVE,
  MENSAJES_IMPORTACION as M,
  URL_PLANTILLA,
  confirmarImportacion,
  revisarArchivo,
  textoMotivo,
  type InformeImportacion,
  type VistaPrevia,
} from "../../../../lib/importacion";
import { cn } from "../../../../lib/utils";

// Asistente de importación de clientes (spec 007b, D7–D9; CA-1, CA-8): subir → vista previa → informe.
// El archivo se conserva solo en memoria (referencia en un `ref`, nunca en estado ni almacenamiento) y se
// descarta al confirmar, al cambiarlo o al desmontar. Las claves del archivo nunca se muestran: el backend
// solo dice si la fila trae SOL/SIRE y aquí se pinta como «••••». Sin cálculos: solo se muestra lo recibido.

const ACEPTA =
  ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function ImportarClientes() {
  const puede = usePuede("clientes.crear");
  const archivo = useRef<File | null>(null);
  const [haySeleccion, setHaySeleccion] = useState(false);
  const [vista, setVista] = useState<VistaPrevia | null>(null);
  const [informe, setInforme] = useState<InformeImportacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (puede === undefined) return <main className="p-6 text-tinta-suave">Cargando…</main>;
  if (puede === false) {
    return (
      <main className="p-6">
        <Alert tono="error" role="alert">
          {MENSAJES.sinPermiso}
        </Alert>
      </main>
    );
  }

  function alElegir(e: ChangeEvent<HTMLInputElement>): void {
    archivo.current = e.target.files?.[0] ?? null;
    setHaySeleccion(archivo.current !== null);
    setVista(null);
    setInforme(null);
    setError(null);
  }

  async function revisar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || ocupado) return;
    setOcupado(true);
    setError(null);
    setVista(null);
    setInforme(null);
    try {
      const r = await revisarArchivo(elegido);
      if (archivo.current !== elegido) return; // cambió el archivo mientras tanto
      if (r.ok) setVista(r.datos);
      else setError(r.mensaje);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar(): Promise<void> {
    const elegido = archivo.current;
    if (!elegido || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await confirmarImportacion(elegido);
      if (r.ok) {
        archivo.current = null; // el archivo se descarta al confirmar
        setHaySeleccion(false);
        setVista(null);
        setInforme(r.datos);
      } else {
        setError(r.mensaje);
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
    setVista(null);
    setError(null);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <EncabezadoPagina
        titulo={M.titulo}
        acciones={
          <Link
            href="/clientes"
            className={cn(buttonVariants({ variant: "secundario" }), "max-lg:h-11")}
          >
            Volver a clientes
          </Link>
        }
      />

      <Card>
        <a href={URL_PLANTILLA} download className={cn(enlace, "self-start text-sm max-lg:flex max-lg:min-h-11 max-lg:items-center")}>
          {M.plantilla}
        </a>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="archivo-importacion">Archivo (.xlsx o .csv)</Label>
          <input
            id="archivo-importacion"
            type="file"
            accept={ACEPTA}
            onChange={alElegir}
            className="w-full min-w-0 cursor-pointer rounded-control border border-linea-control bg-hoja p-2 text-sm text-tinta file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-neutro-fondo file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-tinta max-lg:min-h-11"
          />
        </div>
        <Button
          type="button"
          onClick={() => void revisar()}
          disabled={!haySeleccion || ocupado}
          className="self-start max-lg:h-11"
        >
          Revisar archivo
        </Button>
      </Card>

      {error && (
        <Alert tono="error" role="alert">
          {error}
        </Alert>
      )}

      {vista && (
        <Card aria-label="Vista previa">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-tinta-media">
            <li>{M.validas(vista.validas)}</li>
            <li>{M.conError(vista.conError)}</li>
            <li>{M.cupoLibre(vista.cupoLibre)}</li>
            <li>{M.excedentes(vista.excedentes)}</li>
          </ul>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Fila</TableHead>
                <TableHead>RUC</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Claves</TableHead>
                <TableHead>Motivos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vista.filas.map((f) => (
                <TableRow key={f.n}>
                  <TableCell>{f.n}</TableCell>
                  <TableCell className="font-mono">{f.ruc}</TableCell>
                  <TableCell>
                    <Badge tono={f.estado === "valida" ? "ok" : "error"}>
                      {f.estado === "valida"
                        ? M.estadoFila.valida
                        : M.estadoFila.conError}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {[
                      f.tieneSol ? `SOL ${MASCARA_CLAVE}` : null,
                      f.tieneSire ? `SIRE ${MASCARA_CLAVE}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </TableCell>
                  <TableCell>
                    {f.motivos.map((m) => (
                      <p key={m} className="m-0">
                        {textoMotivo(m, f.archivado)}
                      </p>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void confirmar()}
              disabled={vista.validas === 0 || ocupado}
              className="max-lg:h-11"
            >
              Confirmar importación
            </Button>
            <Button
              type="button"
              variant="secundario"
              onClick={cancelar}
              disabled={ocupado}
              className="max-lg:h-11"
            >
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {informe && (
        <Card aria-label="Resultado">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-tinta-media">
            <li>{M.creadas(informe.creadas)}</li>
            <li>{M.consultasEncoladas(informe.consultasEncoladas)}</li>
            <li>{M.consultasOmitidas(informe.consultasOmitidas)}</li>
          </ul>
          {informe.noImportadas.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Fila</TableHead>
                  <TableHead>RUC</TableHead>
                  <TableHead>Motivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {informe.noImportadas.map((f) => (
                  <TableRow key={`${f.n}-${f.ruc}`}>
                    <TableCell>{f.n}</TableCell>
                    <TableCell className="font-mono">{f.ruc}</TableCell>
                    <TableCell>{textoMotivo(f.motivo, f.archivado)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Link href="/clientes" className={cn(enlace, "self-start text-sm")}>
            Ir a clientes
          </Link>
        </Card>
      )}
    </main>
  );
}

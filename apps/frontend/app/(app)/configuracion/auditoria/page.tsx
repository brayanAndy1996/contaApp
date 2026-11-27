"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { Autor } from "../../../../components/autor";
import { PanelFiltrosAuditoria } from "../../../../components/auditoria/filtros-auditoria";
import { usePuede } from "../../../../lib/acceso";
import {
  consultaDeFiltros,
  filtrosDeUrl,
  hayFiltros,
  lineasDetalle,
  listarAuditoria,
  urlDeFiltros,
  type FiltrosAuditoria,
  MENSAJES_AUDITORIA as M,
  textoAccion,
  textoActor,
  type FilaAuditoria,
} from "../../../../lib/auditoria";
import { fechaHoraLima } from "../../../../lib/fechas";
import {
  Alert,
  Button,
  EncabezadoPagina,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  enlace,
} from "../../../../components/ui";

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14; spec 031, CA-10): tabla paginada por fecha con filtros de
// usuario, cliente, acciones y fechas que viven en la URL (P-2: sin fechas, los últimos 30 días). Cambiar un filtro
// descarta el cursor y vuelve a consultar; «Cargar más» envía el cursor sin tocar la URL. Solo con
// `auditoria.ver` (el enlace de la barra se oculta sin el permiso; el backend responde 403). Todo es texto de React:
// una razón social con `<script>` se ve literal. Fechas en hora de Lima. La tabla se desplaza dentro de su propio
// contenedor en pantallas angostas (T18a, P-7) y «Cargar más» no pierde el foco (P-6).

/** P-3: `compra.operacion` enlaza al Historial del periodo (015) solo con cliente y periodo en los datos. */
function enlaceHistorialPeriodo(fila: FilaAuditoria): string | null {
  const periodo = fila.datos.periodo;
  if (fila.accion !== "compra.operacion" || !fila.cliente) return null;
  if (typeof periodo !== "string" || !/^\d{6}$/.test(periodo)) return null;
  return `/clientes/${encodeURIComponent(fila.cliente.id)}/compras?periodo=${periodo}`;
}

/** Detalle de una fila en líneas cortas (usuario afectado, antes → después, rol, estado…) y, si aplica, su enlace. */
function Detalle({ fila, puedeVerCompras }: { fila: FilaAuditoria; puedeVerCompras: boolean }) {
  const lineas = lineasDetalle(fila);
  const href = puedeVerCompras ? enlaceHistorialPeriodo(fila) : null;
  if (lineas.length === 0 && !href) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-tinta-media">
      {lineas.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
      {href && (
        <li>
          <Link href={href} className={enlace}>
            {M.enlaceHistorialPeriodo}
          </Link>
        </li>
      )}
    </ul>
  );
}

type Fallo = "carga" | "cliente" | "filtros";

const MENSAJE_FALLO: Record<Fallo, string> = {
  carga: M.errorCarga,
  cliente: M.clienteNoEncontrado,
  filtros: M.filtrosInvalidos,
};

function Auditoria() {
  const router = useRouter();
  const pathname = usePathname();
  const parametros = useSearchParams();
  const puedeVerCompras = usePuede("compras.ver") === true;

  // La URL es la fuente de los filtros. `consulta` (texto) es la clave estable que dispara cada nueva consulta.
  const filtros = useMemo(() => filtrosDeUrl(parametros), [parametros]);
  const consulta = consultaDeFiltros(filtros).toString();

  const [filas, setFilas] = useState<FilaAuditoria[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<Fallo | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);

  // P-6: tras «Cargar más» el foco pasa a la primera fila nueva; si la carga falla, se queda en el botón que sigue ahí.
  const cuerpo = useRef<HTMLTableSectionElement>(null);
  const botonMas = useRef<HTMLButtonElement>(null);
  const botonReintentar = useRef<HTMLButtonElement>(null);
  const primeraNueva = useRef<number | null>(null);
  // Una respuesta de filtros anteriores no pisa a la vigente.
  const secuencia = useRef(0);

  const cargar = useCallback(async (cursor: string | null, texto: string) => {
    const mia = ++secuencia.current;
    setCargando(true);
    setFallo(null);
    // Con filtros nuevos la tabla anterior se queda (marcada como ocupada) hasta que llegue la respuesta; si falla, se vacía.
    const vaciar = () => {
      if (cursor === null) {
        setFilas([]);
        setSiguiente(null);
      }
    };
    try {
      const r = await listarAuditoria(cursor, texto);
      if (mia !== secuencia.current) return;
      if (r.status === 403) {
        setSinPermiso(true);
        return;
      }
      if (!r.ok || !r.datos) {
        vaciar();
        if (r.status === 404) setFallo("cliente");
        else if (r.status === 400) setFallo("filtros");
        else if (r.status !== 401) setFallo("carga");
        return;
      }
      const nuevas = r.datos.items;
      setFilas((previas) => (cursor ? [...previas, ...nuevas] : nuevas));
      setSiguiente(r.datos.siguiente);
    } catch {
      if (mia === secuencia.current) {
        vaciar();
        setFallo("carga");
      }
    } finally {
      if (mia === secuencia.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    primeraNueva.current = null;
    void cargar(null, consulta);
  }, [cargar, consulta]);

  useEffect(() => {
    if (cargando || primeraNueva.current === null) return;
    const indice = primeraNueva.current;
    primeraNueva.current = null;
    const fila = filas.length > indice ? cuerpo.current?.rows[indice] : undefined;
    (fila ?? botonMas.current ?? botonReintentar.current)?.focus();
  }, [cargando, filas]);

  function cambiarFiltros(cambio: Partial<FiltrosAuditoria>) {
    const q = urlDeFiltros(filtros, cambio).toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  function cargarMas() {
    if (cargando || siguiente === null) return;
    primeraNueva.current = filas.length;
    void cargar(siguiente, consulta);
  }

  const conFiltros = hayFiltros(filtros);

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.titulo} />
      {sinPermiso ? (
        <Alert tono="aviso" role="alert">
          <CircleAlert aria-hidden="true" />
          <p className="m-0">{M.sinPermiso}</p>
        </Alert>
      ) : (
        <>
          <PanelFiltrosAuditoria filtros={filtros} onCambiar={cambiarFiltros} />
          {filtros.usuarioId && (
            <Alert tono="info" role="status">
              <p className="m-0">{M.avisoDescifrados}</p>
            </Alert>
          )}
          {filas.length === 0 && !cargando && !fallo && (
            <p className="m-0 text-tinta-suave">{conFiltros ? M.vacioFiltrado : M.vacio}</p>
          )}
          {filas.length > 0 && (
            <div aria-busy={cargando} className="rounded-tarjeta border border-linea bg-hoja shadow-tarjeta">
              <Table aria-label={M.tabla} className="min-w-[44rem]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className="px-2">{M.columnas.fecha}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.actor}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.accion}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.cliente}</TableHead>
                    <TableHead scope="col" className="px-2">{M.columnas.detalle}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody ref={cuerpo}>
                  {filas.map((f) => (
                    <TableRow
                      key={f.id}
                      tabIndex={-1}
                      className="align-top focus:outline-2 focus:-outline-offset-2 focus:outline-primario"
                    >
                      <TableCell className="whitespace-nowrap px-2 align-top">{fechaHoraLima(f.ocurridaEn)}</TableCell>
                      <TableCell className="px-2 align-top">
                        {f.actor.tipo === "usuario" ? (
                          <Autor autor={f.actor.autor} />
                        ) : (
                          textoActor(f.actor)
                        )}
                      </TableCell>
                      <TableCell className="px-2 align-top">{textoAccion(f.accion, f.datos)}</TableCell>
                      <TableCell className="px-2 align-top">
                        {f.cliente ? f.cliente.razonSocial : M.sinCliente}
                      </TableCell>
                      <TableCell className="px-2 align-top">
                        <Detalle fila={f} puedeVerCompras={puedeVerCompras} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div aria-live="polite">
            {cargando && (
              <p role="status" className="m-0 text-tinta-suave">
                {M.cargando}
              </p>
            )}
            {fallo && (
              <Alert tono="error" role="alert">
                <CircleAlert aria-hidden="true" />
                <p className="m-0">{MENSAJE_FALLO[fallo]}</p>
              </Alert>
            )}
          </div>
          {fallo === "carga" && (
            <Button
              ref={botonReintentar}
              variant="secundario"
              size="sm"
              onClick={() => {
                if (filas.length > 0) primeraNueva.current = filas.length;
                void cargar(filas.length > 0 ? siguiente : null, consulta);
              }}
              className="w-fit max-lg:h-11"
            >
              {M.reintentar}
            </Button>
          )}
          {siguiente !== null && !fallo && (
            <Button
              ref={botonMas}
              variant="secundario"
              size="sm"
              aria-disabled={cargando}
              onClick={cargarMas}
              className="w-fit max-lg:h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
            >
              {M.cargarMas}
            </Button>
          )}
        </>
      )}
    </main>
  );
}

// `useSearchParams()` es un dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function PaginaAuditoria() {
  return (
    <Suspense fallback={<main className="p-6 text-tinta-suave">{M.cargando}</main>}>
      <Auditoria />
    </Suspense>
  );
}

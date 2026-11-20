"use client";

import { SlidersHorizontal } from "lucide-react";
import { FILTROS_ATENCION } from "@contapp/shared";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "../ui";
import {
  FILTROS_INICIALES,
  MENSAJES_BANDEJA as B,
  OPCIONES_CATEGORIA,
  etiquetaCategoria,
  type FiltroCategoriaBandeja,
  type ValoresFiltros,
} from "../../lib/buzon";
import { useEsMovil } from "../../lib/pantalla";

// Filtros de la bandeja (spec 024, D-2, D-3, CA-2, CA-11). Controlado: la URL la guarda `Bandeja`. En escritorio, los
// controles van en línea y cada cambio se entrega al instante; a 390 px un botón «Filtros» abre un `Dialog` que no aplica
// nada hasta «Aplicar». «Cliente» no es un filtro de la lista: elegir uno lleva a la bandeja fijada en ese cliente.

export type { ValoresFiltros };

export interface ClienteOpcion {
  id: string;
  razonSocial: string;
}

const ETIQUETA_ATENCION: Record<(typeof FILTROS_ATENCION)[number], string> = {
  pendientes: "Pendientes",
  atendidos: "Atendidos",
  historicos: "Históricos",
  todos: "Todos",
};

const etiquetaCategoriaFiltro = (c: FiltroCategoriaBandeja): string =>
  c === "" ? "Todas" : c === "criticos" ? "Críticos (todas las categorías críticas)" : etiquetaCategoria(c);

const normalizar = (v: ValoresEntrada): ValoresFiltros => ({
  ...v,
  categoria: (OPCIONES_CATEGORIA as readonly string[]).includes(v.categoria) ? (v.categoria as FiltroCategoriaBandeja) : "",
});

const fechasInvertidas = (v: Pick<ValoresFiltros, "desde" | "hasta">): boolean =>
  v.desde !== "" && v.hasta !== "" && v.desde > v.hasta;

/** Lo aplicado: la categoría llega como texto (una desconocida se ve como «Todas»). */
type ValoresEntrada = Omit<ValoresFiltros, "categoria"> & { categoria: string };

interface Props {
  valores: ValoresEntrada;
  clientes: ClienteOpcion[];
  /** Con la bandeja fijada en un cliente: ese cliente aparece elegido y no hay filtros de alcance. */
  clienteId?: string | undefined;
  alCambiar: (valores: ValoresFiltros) => void;
  alElegirCliente: (id: string | null) => void;
}

interface CamposProps {
  valores: ValoresFiltros;
  clientes: ClienteOpcion[];
  clienteId: string | undefined;
  alCambiarCampo: (cambio: Partial<ValoresFiltros>) => void;
  alElegirCliente: (id: string | null) => void;
  /** Sufijo para que los ids de los controles no se repitan. */
  alto: string;
}

function Campos({ valores, clientes, clienteId, alCambiarCampo, alElegirCliente, alto }: CamposProps) {
  return (
    <>
      <Label className="w-full sm:w-auto">
        {B.filtroAtencion}
        <Select
          value={valores.atencion}
          onChange={(e) => alCambiarCampo({ atencion: e.target.value as ValoresFiltros["atencion"] })}
          className={`${alto} sm:w-40`}
        >
          {FILTROS_ATENCION.map((a) => (
            <option key={a} value={a}>
              {ETIQUETA_ATENCION[a]}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-full sm:w-auto">
        {B.filtroCategoria}
        <Select
          value={valores.categoria}
          onChange={(e) => alCambiarCampo({ categoria: e.target.value as FiltroCategoriaBandeja })}
          className={`${alto} sm:w-56`}
        >
          {OPCIONES_CATEGORIA.map((c) => (
            <option key={c} value={c}>
              {etiquetaCategoriaFiltro(c)}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-full sm:w-auto">
        {B.filtroLeido}
        <Select
          value={valores.leido}
          onChange={(e) => alCambiarCampo({ leido: e.target.value as ValoresFiltros["leido"] })}
          className={`${alto} sm:w-40`}
        >
          <option value="">Todos</option>
          <option value="si">Leídos</option>
          <option value="no">No leídos</option>
        </Select>
      </Label>
      <Label className="w-full sm:w-auto">
        {B.filtroDesde}
        <Input
          type="date"
          value={valores.desde}
          onChange={(e) => alCambiarCampo({ desde: e.target.value })}
          className={`${alto} sm:w-44`}
        />
      </Label>
      <Label className="w-full sm:w-auto">
        {B.filtroHasta}
        <Input
          type="date"
          value={valores.hasta}
          onChange={(e) => alCambiarCampo({ hasta: e.target.value })}
          className={`${alto} sm:w-44`}
        />
      </Label>
      <Label className="w-full sm:w-auto">
        {B.filtroCliente}
        <Select
          value={clienteId ?? ""}
          onChange={(e) => alElegirCliente(e.target.value === "" ? null : e.target.value)}
          className={`${alto} sm:w-56`}
        >
          <option value="">{B.todosLosClientes}</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.razonSocial}
            </option>
          ))}
        </Select>
      </Label>
      {clienteId === undefined && (
        <>
          <Casilla
            texto={B.filtroResponsable}
            marcada={valores.responsable}
            alCambiar={(responsable) => alCambiarCampo({ responsable })}
          />
          <Casilla
            texto={B.filtroArchivados}
            marcada={valores.archivados}
            alCambiar={(archivados) => alCambiarCampo({ archivados })}
          />
        </>
      )}
    </>
  );
}

function Casilla({ texto, marcada, alCambiar }: { texto: string; marcada: boolean; alCambiar: (v: boolean) => void }) {
  return (
    <Label className="min-h-10 w-full flex-row items-center gap-2 font-normal text-tinta max-lg:min-h-11 sm:w-auto">
      <input
        type="checkbox"
        checked={marcada}
        onChange={(e) => alCambiar(e.target.checked)}
        className="size-5 cursor-pointer accent-primario max-lg:size-6"
      />
      {texto}
    </Label>
  );
}

export function FiltrosBandeja({ valores, clientes, clienteId, alCambiar, alElegirCliente }: Props) {
  const movil = useEsMovil();
  const [abierto, setAbierto] = useState(false);
  const [borrador, setBorrador] = useState<ValoresFiltros>(normalizar(valores));
  const [invertidas, setInvertidas] = useState(false);
  const botonRef = useRef<HTMLButtonElement>(null);

  // Cada vez que el Dialog se abre parte de lo aplicado; cerrarlo sin «Aplicar» descarta lo tocado.
  useEffect(() => {
    if (abierto) {
      setBorrador(normalizar(valores));
      setInvertidas(false);
    }
    // Solo al abrir: los cambios de `valores` con el Dialog abierto no pisan lo que la persona está editando.
  }, [abierto]);

  // Un aviso de fechas ya no aplica cuando cambian los valores aplicados.
  useEffect(() => setInvertidas(false), [valores.desde, valores.hasta]);

  if (!movil) {
    return (
      <div role="group" aria-label={B.nombreFiltros} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <Campos
            valores={normalizar(valores)}
            clientes={clientes}
            clienteId={clienteId}
            alElegirCliente={alElegirCliente}
            alto=""
            alCambiarCampo={(cambio) => {
              const siguiente = { ...normalizar(valores), ...cambio };
              if (fechasInvertidas(siguiente)) {
                setInvertidas(true);
                return;
              }
              setInvertidas(false);
              alCambiar(siguiente);
            }}
          />
        </div>
        {invertidas && <Alert tono="aviso">{B.fechasInvertidas}</Alert>}
      </div>
    );
  }

  function aplicar() {
    if (fechasInvertidas(borrador)) {
      setInvertidas(true);
      return;
    }
    alCambiar(borrador);
    setAbierto(false);
  }

  return (
    <Dialog open={abierto} onOpenChange={setAbierto}>
      <Button
        ref={botonRef}
        type="button"
        variant="secundario"
        onClick={() => setAbierto(true)}
        className="h-11 self-start"
      >
        <SlidersHorizontal aria-hidden="true" />
        {B.abrirFiltros}
      </Button>
      <DialogContent
        mostrarCerrar={false}
        // El botón «Filtros» no es un `DialogTrigger`: al cerrar (Escape, Aplicar o Limpiar) el foco vuelve a él.
        onCloseAutoFocus={(e) => {
          if (botonRef.current) {
            e.preventDefault();
            botonRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{B.tituloFiltros}</DialogTitle>
          <DialogDescription>{B.descripcionFiltros}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Campos
            valores={borrador}
            clientes={clientes}
            clienteId={clienteId}
            alto="h-11"
            alElegirCliente={(id) => {
              setAbierto(false);
              alElegirCliente(id);
            }}
            alCambiarCampo={(cambio) => {
              setInvertidas(false);
              setBorrador((b) => ({ ...b, ...cambio }));
            }}
          />
        </div>
        {invertidas && <Alert tono="aviso">{B.fechasInvertidas}</Alert>}
        <DialogFooter>
          <Button
            type="button"
            variant="secundario"
            className="h-11"
            onClick={() => {
              alCambiar({ ...FILTROS_INICIALES });
              setAbierto(false);
            }}
          >
            {B.limpiar}
          </Button>
          <Button type="button" className="h-11" onClick={aplicar}>
            {B.aplicar}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

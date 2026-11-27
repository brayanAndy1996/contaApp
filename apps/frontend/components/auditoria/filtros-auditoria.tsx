"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ACCIONES_FILTRABLES,
  MAX_ACCIONES_FILTRO,
  MENSAJES_AUDITORIA as M,
  opcionesAuditoria,
  type FiltrosAuditoria,
  type OpcionesAuditoria,
} from "../../lib/auditoria";
import { Alert, Button, Input, Label, Select } from "../ui";

// Filtros de la auditoría (spec 031, CA-10; P-1 a P-3). La URL es la fuente de verdad: este componente solo pinta los
// `filtros` que recibe y avisa cada cambio con `onCambiar`; la página actualiza la URL y vuelve a consultar. El cliente
// se busca en `GET /auditoria/opciones?q=` (el backend aplica el alcance); al recargar, el cliente de la URL se pinta
// pidiéndolo con `clienteId`. Montos y rangos no se calculan aquí.

type Miembro = OpcionesAuditoria["miembros"][number];
type ClienteOpcion = OpcionesAuditoria["clientes"][number];

const RETARDO_BUSQUEDA_MS = 250;
const MAX_BUSQUEDA = 60;

const etiquetaCliente = (c: ClienteOpcion): string => `${c.razonSocial} (${c.ruc})`;

interface Props {
  filtros: FiltrosAuditoria;
  onCambiar: (cambio: Partial<FiltrosAuditoria>) => void;
}

export function PanelFiltrosAuditoria({ filtros, onCambiar }: Props) {
  const idLista = useId();
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [errorOpciones, setErrorOpciones] = useState(false);
  // Clientes ya vistos (por id): permite pintar el elegido sin volver a pedirlo.
  const [conocidos, setConocidos] = useState<Record<string, ClienteOpcion>>({});
  // `null` = el campo muestra el cliente elegido; texto = lo que la persona está escribiendo.
  const [texto, setTexto] = useState<string | null>(null);
  const [resultados, setResultados] = useState<ClienteOpcion[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(-1);
  const secuenciaBusqueda = useRef(0);
  const { clienteId } = filtros;

  const recordar = (lista: ClienteOpcion[]) =>
    setConocidos((previos) => {
      const siguiente = { ...previos };
      for (const c of lista) siguiente[c.id] = c;
      return siguiente;
    });

  // Miembros (y el cliente de la URL, para pintarlo al recargar). Se repite solo si el cliente de la URL no se conoce.
  const conocido = clienteId !== "" && conocidos[clienteId] !== undefined;
  const yaTraje = useRef(false);
  useEffect(() => {
    if (yaTraje.current && (clienteId === "" || conocido)) return;
    yaTraje.current = true;
    let vigente = true;
    opcionesAuditoria(clienteId ? { clienteId } : {})
      .then((r) => {
        if (!vigente) return;
        if (!r.ok || !r.datos) {
          if (r.status !== 401) setErrorOpciones(true);
          return;
        }
        setErrorOpciones(false);
        setMiembros(r.datos.miembros);
        recordar(r.datos.clientes);
      })
      .catch(() => {
        if (vigente) setErrorOpciones(true);
      });
    return () => {
      vigente = false;
    };
  }, [clienteId, conocido]);

  // Búsqueda de clientes con un pequeño retardo; una respuesta vieja no pisa a la nueva.
  useEffect(() => {
    const q = (texto ?? "").trim().slice(0, MAX_BUSQUEDA);
    if (q === "") {
      setResultados(null);
      setBuscando(false);
      return;
    }
    const mia = ++secuenciaBusqueda.current;
    setBuscando(true);
    const temporizador = setTimeout(() => {
      opcionesAuditoria({ q })
        .then((r) => {
          if (mia !== secuenciaBusqueda.current) return;
          setBuscando(false);
          if (!r.ok || !r.datos) {
            setResultados([]);
            return;
          }
          recordar(r.datos.clientes);
          setResultados(r.datos.clientes);
        })
        .catch(() => {
          if (mia !== secuenciaBusqueda.current) return;
          setBuscando(false);
          setResultados([]);
        });
    }, RETARDO_BUSQUEDA_MS);
    return () => clearTimeout(temporizador);
  }, [texto]);

  const elegido = clienteId ? conocidos[clienteId] : undefined;
  const valorCampo = texto ?? (elegido ? etiquetaCliente(elegido) : "");
  const lista = resultados ?? [];
  const listaVisible = abierto && texto !== null && texto.trim() !== "";

  function elegir(c: ClienteOpcion) {
    recordar([c]);
    setTexto(null);
    setAbierto(false);
    setActivo(-1);
    onCambiar({ clienteId: c.id });
  }

  function alEscribir(valor: string) {
    setTexto(valor);
    setAbierto(true);
    setActivo(-1);
    // Vaciar el campo quita el cliente del filtro.
    if (valor === "" && clienteId) onCambiar({ clienteId: "" });
  }

  function alTeclear(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setAbierto(false);
      setTexto(null);
    } else if (e.key === "ArrowDown" && lista.length > 0) {
      e.preventDefault();
      setAbierto(true);
      setActivo((i) => (i + 1) % lista.length);
    } else if (e.key === "ArrowUp" && lista.length > 0) {
      e.preventDefault();
      setActivo((i) => (i <= 0 ? lista.length - 1 : i - 1));
    } else if (e.key === "Enter" && listaVisible) {
      // Dentro del formulario, Enter no recarga la página; si hay una opción resaltada, se elige.
      e.preventDefault();
      const c = lista[activo];
      if (c) elegir(c);
    }
  }

  function alternarAccion(accion: string, marcada: boolean) {
    onCambiar({
      acciones: marcada ? [...filtros.acciones, accion] : filtros.acciones.filter((a) => a !== accion),
    });
  }

  const llenoDeAcciones = filtros.acciones.length >= MAX_ACCIONES_FILTRO;
  const hayAlgo = Boolean(filtros.usuarioId || filtros.clienteId || filtros.acciones.length > 0);

  return (
    <form
      aria-label={M.filtros.titulo}
      onSubmit={(e) => e.preventDefault()}
      className="flex flex-col gap-4 rounded-tarjeta border border-linea bg-hoja p-4 shadow-tarjeta"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Label>
          {M.filtros.usuario}
          <Select
            value={filtros.usuarioId}
            onChange={(e) => onCambiar({ usuarioId: e.target.value })}
            className="max-lg:h-11"
          >
            <option value="">{M.filtros.todosUsuarios}</option>
            {miembros.map((m) => (
              <option key={m.id} value={m.id}>
                {m.activo ? m.nombre : `${m.nombre} ${M.filtros.inactivo}`}
              </option>
            ))}
          </Select>
        </Label>

        <div
          className="relative flex flex-col gap-1.5"
          onBlur={(e) => {
            if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
            setAbierto(false);
            setTexto(null);
          }}
        >
          <Label>
            {M.filtros.cliente}
            <Input
              type="text"
              role="combobox"
              autoComplete="off"
              aria-expanded={listaVisible}
              aria-controls={idLista}
              aria-autocomplete="list"
              aria-activedescendant={activo >= 0 ? `${idLista}-${activo}` : undefined}
              placeholder={M.filtros.clientePlaceholder}
              value={valorCampo}
              maxLength={MAX_BUSQUEDA + 20}
              onChange={(e) => alEscribir(e.target.value)}
              onFocus={() => setAbierto(true)}
              onKeyDown={alTeclear}
              className="max-lg:h-11"
            />
          </Label>
          {listaVisible && (
            <ul
              id={idLista}
              role="listbox"
              aria-label={M.filtros.listaClientes}
              // Evita que el campo pierda el foco (y cierre la lista) antes de registrar el clic en una opción.
              onMouseDown={(e) => e.preventDefault()}
              className="absolute left-0 right-0 top-full z-20 m-0 mt-1 max-h-60 list-none overflow-auto rounded-control border border-linea-control bg-hoja p-1 shadow-tarjeta"
            >
              {lista.map((c, i) => (
                <li
                  key={c.id}
                  id={`${idLista}-${i}`}
                  role="option"
                  aria-selected={i === activo}
                  onClick={() => elegir(c)}
                  className="cursor-pointer rounded-control px-2 py-2 text-sm aria-selected:bg-primario/10 hover:bg-primario/10 max-lg:min-h-11"
                >
                  {etiquetaCliente(c)}
                  {c.archivado ? ` · ${M.filtros.archivado}` : ""}
                </li>
              ))}
              {lista.length === 0 && (
                <li role="presentation" className="px-2 py-2 text-sm text-tinta-suave">
                  {buscando || resultados === null ? M.filtros.clienteBuscando : M.filtros.clienteSinResultados}
                </li>
              )}
            </ul>
          )}
        </div>

        <Label>
          {M.filtros.desde}
          <Input
            type="date"
            value={filtros.desde}
            max={filtros.hasta || undefined}
            onChange={(e) => onCambiar({ desde: e.target.value })}
            className="max-lg:h-11"
          />
        </Label>
        <Label>
          {M.filtros.hasta}
          <Input
            type="date"
            value={filtros.hasta}
            min={filtros.desde || undefined}
            onChange={(e) => onCambiar({ hasta: e.target.value })}
            className="max-lg:h-11"
          />
        </Label>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2 max-lg:min-h-11">
          <input
            type="checkbox"
            checked={filtros.todo}
            onChange={(e) => onCambiar({ todo: e.target.checked })}
            className="size-4"
          />
          {M.filtros.todo}
        </label>
        <span className="text-tinta-suave">{M.filtros.ayudaFechas}</span>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] font-semibold text-tinta-media">{M.filtros.acciones}</legend>
        <div className="grid max-h-48 gap-x-4 gap-y-1 overflow-auto rounded-control border border-linea p-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {ACCIONES_FILTRABLES.map(({ valor, texto: nombre }) => {
            const marcada = filtros.acciones.includes(valor);
            return (
              <label key={valor} className="flex items-start gap-2 max-lg:min-h-11 max-lg:items-center">
                <input
                  type="checkbox"
                  checked={marcada}
                  disabled={!marcada && llenoDeAcciones}
                  onChange={(e) => alternarAccion(valor, e.target.checked)}
                  className="mt-0.5 size-4 shrink-0"
                />
                {nombre}
              </label>
            );
          })}
        </div>
        {llenoDeAcciones && <p className="m-0 text-xs text-tinta-suave">{M.filtros.limiteAcciones}</p>}
      </fieldset>

      {errorOpciones && (
        <Alert tono="info" role="status">
          {M.filtros.errorOpciones}
        </Alert>
      )}

      {hayAlgo && (
        <Button
          type="button"
          variant="secundario"
          size="sm"
          onClick={() => onCambiar({ usuarioId: "", clienteId: "", acciones: [] })}
          className="w-fit max-lg:h-11"
        >
          {M.filtros.limpiar}
        </Button>
      )}
    </form>
  );
}

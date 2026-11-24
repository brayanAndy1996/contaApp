"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  cuerpoPreferencias,
  guardarPreferenciasCorreo,
  leerPreferenciasCorreo,
  MENSAJES_CORREO as M,
  type CuerpoPreferenciasCorreo,
  type PreferenciasCorreoVista,
} from "../../lib/correo";
import { fechaCorta } from "../../lib/fechas";
import { Alert, Button, Card, Switch } from "../ui";
import { TarjetaInvitacionResumen } from "./invitacion-resumen";

// «Mi cuenta → Correo» (spec 028, R-9, R-13, R-15, D-3). Los cambios se hacen en pantalla y solo «Guardar» llama a la API.
// El rol no se lee aquí: el servidor decide si se ofrece «todos los clientes» (`todosDisponible`) y responde 403 o 409.

type Valores = CuerpoPreferenciasCorreo;
type Mensaje = { tono: "ok" | "error"; texto: string } | null;

const CLAVES = ["buzonCritico", "credencialInvalida", "planLimite", "resumen"] as const;

const valoresDe = (v: PreferenciasCorreoVista): Valores => ({
  buzonCritico: v.buzonCritico,
  credencialInvalida: v.credencialInvalida,
  planLimite: v.planLimite,
  resumen: v.resumen,
  todosClientes: v.todosClientes,
});

interface FilaProps {
  id: string;
  texto: string;
  valor: boolean;
  alCambiar: (valor: boolean) => void;
}

function Fila({ id, texto, valor, alCambiar }: FilaProps) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-3">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm text-tinta">
        {texto}
      </label>
      <Switch id={id} checked={valor} onCheckedChange={alCambiar} />
    </li>
  );
}

export function PreferenciasCorreo() {
  const base = useId();
  const [vista, setVista] = useState<PreferenciasCorreoVista | null>(null);
  const [fallo, setFallo] = useState(false);
  const [valores, setValores] = useState<Valores | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<Mensaje>(null);
  const [errorInvitacion, setErrorInvitacion] = useState(false);
  const ocupado = useRef(false);

  useEffect(() => {
    let vigente = true;
    leerPreferenciasCorreo().then((v) => {
      if (!vigente) return;
      if (v) {
        setVista(v);
        setValores(valoresDe(v));
      } else setFallo(true);
    });
    return () => {
      vigente = false;
    };
  }, []);

  /** Un solo `PUT` a la vez; devuelve lo que respondió el servidor para que cada botón decida su mensaje. */
  async function enviar(cuerpo: Valores, todosDisponible: boolean) {
    if (ocupado.current) return null;
    ocupado.current = true;
    setGuardando(true);
    const r = await guardarPreferenciasCorreo(cuerpoPreferencias(cuerpo, todosDisponible));
    if (r.tipo === "ok" && r.vista) {
      setVista(r.vista);
      setValores(valoresDe(r.vista));
    } else if (r.tipo === "ok") {
      // Guardado, pero la respuesta no se pudo leer: se queda lo que el usuario ve y se apaga la invitación.
      setVista((v) => (v ? { ...v, ...cuerpo, invitacionResumen: false } : v));
    }
    ocupado.current = false;
    setGuardando(false);
    return r;
  }

  async function guardar() {
    if (!vista || !valores) return;
    setMensaje(null);
    const r = await enviar(valores, vista.todosDisponible);
    if (!r) return;
    if (r.tipo === "ok") setMensaje({ tono: "ok", texto: M.guardado });
    else if (r.tipo === "sin_permiso") setMensaje({ tono: "error", texto: M.sinPermisoTodos });
    else if (r.tipo === "todos_no_disponible") setMensaje({ tono: "error", texto: M.todosNoDisponible });
    else setMensaje({ tono: "error", texto: M.errorGuardar });
  }

  async function elegirInvitacion(activar: boolean) {
    if (!vista || !valores) return;
    setErrorInvitacion(false);
    const r = await enviar({ ...valores, resumen: activar }, vista.todosDisponible);
    if (r && r.tipo !== "ok") setErrorInvitacion(true);
  }

  if (fallo) return <Alert tono="error">{M.errorCarga}</Alert>;
  if (!vista || !valores) return <p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>;

  return (
    <div className="flex flex-col gap-4">
      {vista.invitacionResumen && (
        <TarjetaInvitacionResumen enviando={guardando} error={errorInvitacion} alElegir={elegirInvitacion} />
      )}
      {vista.ultimoEnvioFallido && (
        <Alert tono="aviso">
          <TriangleAlert aria-hidden="true" />
          {M.fallo(fechaCorta(vista.ultimoEnvioFallido))}
        </Alert>
      )}
      <Card className="gap-2">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {CLAVES.map((clave) => (
            <Fila
              key={clave}
              id={`${base}-${clave}`}
              texto={M.interruptores[clave]}
              valor={valores[clave]}
              alCambiar={(v) => setValores({ ...valores, [clave]: v })}
            />
          ))}
          {vista.todosDisponible && (
            <Fila
              id={`${base}-todos`}
              texto={M.todos}
              valor={valores.todosClientes}
              alCambiar={(v) => setValores({ ...valores, todosClientes: v })}
            />
          )}
        </ul>
        {vista.todosIgnorado && <Alert tono="info">{M.todosIgnorado}</Alert>}
      </Card>
      {mensaje && <Alert tono={mensaje.tono}>{mensaje.texto}</Alert>}
      <div>
        <Button className="h-11 max-lg:w-full" disabled={guardando} onClick={guardar}>
          {M.guardar}
        </Button>
      </div>
    </div>
  );
}

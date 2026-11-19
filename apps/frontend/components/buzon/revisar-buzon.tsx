"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, enlace } from "../ui";
import { mensajeDeError } from "../../lib/acceso";
import {
  MENSAJES_BUZON as M,
  listarMensajes,
  minutosHasta,
  revisarBuzon,
  textoConflictoBuzon,
} from "../../lib/buzon";
import { alCambiarCredenciales, listarCredenciales } from "../../lib/credenciales";
import { cn } from "../../lib/utils";

// Botón «Revisar buzón ahora» de la ficha del cliente (spec 023, CA-2, P-6). Lee por su cuenta el estado de la
// credencial SOL: sin configurar o inválida, o con el cliente archivado, queda deshabilitado con el motivo a la
// vista. El backend valida de todos modos (409). El 429 trae solo `{codigo}`: los minutos salen de `revisarDesde`.

type EstadoSol = "cargando" | "no_configurada" | "invalida" | "lista";

type Resultado =
  | { tipo: "encolada" }
  | { tipo: "en_curso" }
  | { tipo: "reciente"; minutos: number }
  | { tipo: "error"; texto: string };

export function RevisarBuzon({ clienteId, archivado }: { clienteId: string; archivado: boolean }) {
  const [sol, setSol] = useState<EstadoSol>("cargando");
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  // Sube cuando la ficha guarda o verifica una credencial: el estado se vuelve a leer sin recargar (T23a-1).
  const [lectura, setLectura] = useState(0);
  const enCurso = useRef(false);

  useEffect(
    () =>
      alCambiarCredenciales((id) => {
        if (id === clienteId) setLectura((n) => n + 1);
      }),
    [clienteId],
  );

  useEffect(() => {
    let vigente = true;
    listarCredenciales(clienteId)
      .then((r) => {
        if (!vigente) return;
        const estado = r.ok ? r.datos?.find((c) => c.tipo === "sol")?.estado : undefined;
        // Si no se pudo leer, el botón queda disponible: el backend responde 409 con el motivo.
        setSol(estado === "no_configurada" ? "no_configurada" : estado === "invalida" ? "invalida" : "lista");
      })
      .catch(() => {
        if (vigente) setSol("lista");
      });
    return () => {
      vigente = false;
    };
  }, [clienteId, lectura]);

  const motivo = archivado
    ? M.archivado
    : sol === "no_configurada"
      ? M.sinCredencial
      : sol === "invalida"
        ? M.credencialInvalida
        : null;
  const deshabilitado = motivo !== null || sol === "cargando";

  // Mientras se revisa, el botón usa `aria-disabled` y no `disabled`: así conserva el foco del teclado (T23a-3b).
  async function revisar() {
    if (enCurso.current) return;
    enCurso.current = true;
    setOcupado(true);
    setResultado(null);
    try {
      const r = await revisarBuzon(clienteId);
      if (r.status === 401) return;
      if (r.ok) {
        setResultado({ tipo: r.status === 202 ? "encolada" : "en_curso" });
      } else if (r.status === 429) {
        const pagina = await listarMensajes(clienteId, { limite: 1 });
        const desde = pagina.ok ? (pagina.datos?.estado.revisarDesde ?? null) : null;
        setResultado({ tipo: "reciente", minutos: minutosHasta(desde) });
      } else {
        const texto =
          r.status === 409
            ? textoConflictoBuzon((r.datos as { codigo?: string } | null)?.codigo)
            : null;
        setResultado({ tipo: "error", texto: texto ?? mensajeDeError(r.status, r.datos) });
      }
    } catch {
      setResultado({ tipo: "error", texto: mensajeDeError(0, null) });
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-3">
      <Button
        type="button"
        variant="secundario"
        disabled={deshabilitado}
        aria-disabled={ocupado || undefined}
        onClick={() => void revisar()}
        className="self-start max-lg:h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
      >
        {M.revisar}
      </Button>
      {motivo && <p className="m-0 text-sm text-tinta-suave">{motivo}</p>}
      {resultado?.tipo === "error" && <Alert tono="error">{resultado.texto}</Alert>}
      {resultado?.tipo === "reciente" && <Alert tono="aviso">{M.recienteEn(resultado.minutos)}</Alert>}
      {(resultado?.tipo === "encolada" || resultado?.tipo === "en_curso") && (
        <Alert tono="ok" role="status" className="flex-wrap">
          <span>{resultado.tipo === "encolada" ? M.encolada : M.enCurso}</span>
          <Link href="/trabajos" className={cn(enlace, "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center")}>
            {M.enlacePanel}
          </Link>
        </Alert>
      )}
    </div>
  );
}

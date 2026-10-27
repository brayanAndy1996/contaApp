"use client";

import { useParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  type Miembro,
} from "../../../../lib/acceso";
import { api } from "../../../../lib/api";

// Detalle de un cliente y su asignación individual (spec 005, CA-5, CA-7, CA-15, D18). El 404 es el
// mismo para cliente inexistente, ajeno o no asignado: no se distingue en pantalla.

interface Cliente {
  id: string;
  ruc: string;
  razonSocial: string;
}

interface Asignacion {
  usuarioId: string;
  nombre: string;
  tipo: "responsable" | "colaborador";
}

type Tipo = "colaborador" | "responsable";
type Anterior = "colaborador" | "retirar";

const ETIQUETA_TIPO: Record<Asignacion["tipo"], string> = {
  responsable: "Responsable",
  colaborador: "Colaborador",
};

function DetalleCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [cargado, setCargado] = useState(false);
  const [asigna, setAsigna] = useState(false);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [ocupado, setOcupado] = useState(false);

  const recargarAsignaciones = useCallback(async () => {
    const r = await api<Asignacion[]>(`/clientes/${clienteId}/asignaciones`);
    if (r.ok && r.datos) setAsignaciones(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, [clienteId]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo, status } = await cargarYo();
      if (!vigente) return;
      if (!yo) {
        if (status !== 401) setError(mensajeDeError(status, null));
        setCargado(true);
        return;
      }
      if (!tiene(yo, "clientes.ver")) {
        setError(MENSAJES.sinPermiso);
        setCargado(true);
        return;
      }
      const c = await api<Cliente>(`/clientes/${clienteId}`);
      if (!vigente) return;
      setCargado(true);
      if (!c.ok || !c.datos) {
        if (c.status !== 401) setError(mensajeDeError(c.status, c.datos));
        return;
      }
      setCliente(c.datos);
      if (!tiene(yo, "clientes.asignar")) return;
      setAsigna(true);
      await Promise.all([
        recargarAsignaciones(),
        api<Miembro[]>("/usuarios").then((r) => {
          if (vigente && r.ok && r.datos) setMiembros(r.datos);
        }),
      ]);
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [clienteId, recargarAsignaciones]);

  const hayOtroResponsable = asignaciones.some(
    (a) => a.tipo === "responsable" && a.usuarioId !== usuarioId,
  );

  async function asignar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!usuarioId) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string }>(
        `/clientes/${clienteId}/asignaciones/${usuarioId}`,
        {
          method: "PUT",
          body: {
            tipo,
            ...(tipo === "responsable" && hayOtroResponsable
              ? { anterior }
              : {}),
          },
        },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      await recargarAsignaciones();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(id: string) {
    setOcupado(true);
    setError(null);
    try {
      const r = await api<{ codigo?: string }>(
        `/clientes/${clienteId}/asignaciones/${id}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      await recargarAsignaciones();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  if (!cargado) return <main className="p-6">Cargando…</main>;

  return (
    <main className="flex flex-col gap-6 p-6">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {cliente && (
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{cliente.razonSocial}</h1>
          <p className="text-sm">RUC {cliente.ruc}</p>
        </header>
      )}
      {cliente && asigna && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Asignaciones</h2>
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {asignaciones.map((a) => (
                <tr key={a.usuarioId}>
                  <td>{a.nombre}</td>
                  <td>{ETIQUETA_TIPO[a.tipo]}</td>
                  <td>
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => void quitar(a.usuarioId)}
                      className="rounded border px-2 py-1"
                    >
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form onSubmit={asignar} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Usuario
              <select
                value={usuarioId}
                onChange={(e) => setUsuarioId(e.target.value)}
                className="rounded border px-3 py-2"
              >
                <option value="">Elige un usuario</option>
                {miembros
                  .filter((m) => m.activo)
                  .map((m) => (
                    <option key={m.usuarioId} value={m.usuarioId}>
                      {m.nombre}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Tipo
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value as Tipo)}
                className="rounded border px-3 py-2"
              >
                <option value="colaborador">Colaborador</option>
                <option value="responsable">Responsable</option>
              </select>
            </label>
            {tipo === "responsable" && hayOtroResponsable && (
              <label className="flex flex-col gap-1 text-sm">
                Responsable anterior
                <select
                  value={anterior}
                  onChange={(e) => setAnterior(e.target.value as Anterior)}
                  className="rounded border px-3 py-2"
                >
                  <option value="colaborador">Pasa a colaborador</option>
                  <option value="retirar">Se retira</option>
                </select>
              </label>
            )}
            <button
              type="submit"
              disabled={ocupado || !usuarioId}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Asignar
            </button>
          </form>
        </section>
      )}
    </main>
  );
}

// `useParams()` es un dato de la URL en tiempo de petición: Next exige un límite de Suspense.
export default function Pagina() {
  return (
    <Suspense fallback={<main className="p-6">Cargando…</main>}>
      <DetalleCliente />
    </Suspense>
  );
}

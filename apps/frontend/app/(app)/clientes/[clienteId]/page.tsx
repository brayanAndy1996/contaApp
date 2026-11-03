"use client";

import { useParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { clienteEditarSchema, type PerfilFiscal } from "@contapp/shared";
import {
  DatosFiscales,
  DatosFiscalesLectura,
} from "../../../../components/datos-fiscales";
import { UsoPlan } from "../../../../components/uso-plan";
import { api } from "../../../../lib/api";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  usePuede,
  type Miembro,
} from "../../../../lib/acceso";
import {
  archivarCliente,
  editarCliente,
  reactivarCliente,
  type ClienteDto,
} from "../../../../lib/clientes";
import { MENSAJES_PLAN } from "../../../../lib/planes";

// Detalle de un cliente (spec 005, CA-5, CA-7, CA-15, D18; spec 007a, D1, D3, D5; CA-4, CA-5, CA-9).
// El 404 es el mismo para cliente inexistente, ajeno o no asignado: no se distingue en pantalla.
// Datos fiscales: editables con `clientes.editar` mientras el cliente esté activo; si no, en texto.
// Archivar y reactivar piden confirmación (`clientes.archivar`). Archivado = solo lectura (D5): sin
// formulario de asignación ni «Quitar», pero la lista de asignados sigue visible.

const MENSAJES_DETALLE = {
  clienteArchivado: "El cliente está archivado y es de solo lectura.",
  datosInvalidos: "Revisa los datos fiscales.",
  datosGuardados: "Datos guardados.",
} as const;

type Accion = "archivar" | "reactivar";

const TEXTO_ACCION: Record<Accion, { titulo: string; cuerpo: string }> = {
  archivar: {
    titulo: "¿Archivar este cliente?",
    cuerpo:
      "Libera su lugar en el cupo de RUCs. Quedará de solo lectura hasta que lo reactives; sus credenciales se conservan.",
  },
  reactivar: {
    titulo: "¿Reactivar este cliente?",
    cuerpo:
      "Volverá a ocupar un lugar en el cupo de RUCs de tu plan. Si no hay cupo libre, no se reactiva.",
  },
};

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

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

/** Formulario de datos fiscales, solo con cliente activo y `clientes.editar`. Su borrador arranca del DTO. */
function FormularioFiscal({
  cliente,
  onCambio,
}: {
  cliente: ClienteDto;
  onCambio: (cliente: ClienteDto) => void;
}) {
  const [razonSocial, setRazonSocial] = useState(cliente.razonSocial);
  const [perfil, setPerfil] = useState<PerfilFiscal>(cliente.perfil);
  const [ocupado, setOcupado] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setGuardado(false);
    const valido = clienteEditarSchema.safeParse({
      razonSocial: razonSocial.trim(),
      perfil,
    });
    if (!valido.success) {
      setError(MENSAJES_DETALLE.datosInvalidos);
      return;
    }
    setOcupado(true);
    setError(null);
    try {
      const r = await editarCliente(cliente.id, valido.data);
      if (r.ok && r.datos) {
        setRazonSocial(r.datos.razonSocial);
        setPerfil(r.datos.perfil);
        setGuardado(true);
        onCambio(r.datos);
      } else if (r.status === 409 && codigoDe(r.datos) === "cliente_archivado") {
        onCambio({ ...cliente, archivado: true });
      } else if (r.status !== 401) {
        setError(
          r.status === 400
            ? MENSAJES_DETALLE.datosInvalidos
            : mensajeDeError(r.status, r.datos),
        );
      }
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={guardar} noValidate className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Razón social
        <input
          type="text"
          value={razonSocial}
          disabled={ocupado}
          onChange={(e) => setRazonSocial(e.target.value)}
          className="rounded border px-3 py-2"
        />
      </label>

      <DatosFiscales
        perfil={perfil}
        onChange={setPerfil}
        deshabilitado={ocupado}
      />

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {guardado && (
        <p role="status" className="text-sm">
          {MENSAJES_DETALLE.datosGuardados}
        </p>
      )}

      <button
        type="submit"
        disabled={ocupado}
        className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        Guardar datos fiscales
      </button>
    </form>
  );
}

function DetalleCliente() {
  const { clienteId } = useParams<{ clienteId: string }>();
  const puedeEditar = usePuede("clientes.editar");
  const puedeArchivar = usePuede("clientes.archivar");
  const [cliente, setCliente] = useState<ClienteDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [asigna, setAsigna] = useState(false);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [ocupado, setOcupado] = useState(false);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [ocupadoAccion, setOcupadoAccion] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [mostrarUso, setMostrarUso] = useState(false);

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
      const c = await api<ClienteDto>(`/clientes/${clienteId}`);
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

  const archivado = cliente?.archivado === true;
  const editable = cliente !== null && !archivado && puedeEditar === true;

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

  async function ejecutarAccion() {
    if (!accion) return;
    setOcupadoAccion(true);
    setErrorAccion(null);
    setMostrarUso(false);
    try {
      const r =
        accion === "archivar"
          ? await archivarCliente(clienteId)
          : await reactivarCliente(clienteId);
      if (r.ok && r.datos) {
        setCliente(r.datos);
      } else if (r.status === 409 && codigoDe(r.datos) === "cupo_rucs") {
        setErrorAccion(MENSAJES_PLAN.limiteRucs);
        setMostrarUso(true);
      } else if (r.status !== 401) {
        setErrorAccion(mensajeDeError(r.status, r.datos));
      }
    } catch {
      setErrorAccion(MENSAJES.errorGeneral);
    } finally {
      setAccion(null);
      setOcupadoAccion(false);
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
      {archivado && (
        <p
          role="status"
          className="w-full max-w-xl rounded bg-amber-50 p-3 text-sm text-amber-900"
        >
          {MENSAJES_DETALLE.clienteArchivado}
        </p>
      )}
      {cliente && puedeArchivar === true && (
        <div className="flex w-full max-w-xl flex-col gap-3">
          <button
            type="button"
            disabled={ocupadoAccion}
            onClick={() => setAccion(archivado ? "reactivar" : "archivar")}
            className="self-start rounded border px-4 py-2"
          >
            {archivado ? "Reactivar" : "Archivar"}
          </button>
          {errorAccion && (
            <p role="alert" className="text-sm text-red-600">
              {errorAccion}
            </p>
          )}
          {mostrarUso && <UsoPlan />}
        </div>
      )}
      {cliente?.perfil && (
        <section
          aria-label="Datos fiscales"
          className="flex w-full max-w-xl flex-col gap-4"
        >
          <h2 className="text-lg font-medium">Datos fiscales</h2>
          {editable ? (
            <FormularioFiscal cliente={cliente} onCambio={setCliente} />
          ) : (
            <DatosFiscalesLectura perfil={cliente.perfil} />
          )}
        </section>
      )}
      {cliente && asigna && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Asignaciones</h2>
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                {!archivado && <th>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {asignaciones.map((a) => (
                <tr key={a.usuarioId}>
                  <td>{a.nombre}</td>
                  <td>{ETIQUETA_TIPO[a.tipo]}</td>
                  {!archivado && (
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
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {!archivado && (
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
          )}
        </section>
      )}

      {accion && (
        <div
          role="alertdialog"
          aria-labelledby="titulo-accion"
          aria-describedby="cuerpo-accion"
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="flex w-full max-w-md flex-col gap-4 rounded bg-white p-6 text-neutral-900 shadow-lg">
            <h2 id="titulo-accion" className="text-lg font-medium">
              {TEXTO_ACCION[accion].titulo}
            </h2>
            <p id="cuerpo-accion" className="text-sm">
              {TEXTO_ACCION[accion].cuerpo}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                disabled={ocupadoAccion}
                onClick={() => setAccion(null)}
                className="rounded border px-4 py-2"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={ocupadoAccion}
                onClick={() => void ejecutarAccion()}
                className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
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

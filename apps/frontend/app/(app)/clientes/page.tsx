"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  type Miembro,
  type Yo,
} from "../../../lib/acceso";
import { api } from "../../../lib/api";
import { ETIQUETA_ESTADO, listarClientes } from "../../../lib/clientes";
import {
  FILTROS_VACIOS,
  FiltrosClientes,
  filtrosDeEstado,
  type EstadoFiltros,
} from "../../../components/filtros-clientes";
import type { ClienteDto } from "@contapp/shared";

// Clientes visibles para el usuario (el backend ya filtra por alcance), filtros (spec 007a, D7, CA-9) y
// asignación masiva (spec 005, CA-5, CA-8, CA-15, D20). Sin cálculos: solo muestra y envía lo elegido.

const ESPERA_BUSQUEDA_MS = 400;

// Fila del listado: `ClienteDto`; credenciales y archivado se leen con tolerancia (las pruebas de 005
// responden filas mínimas sin ellos).
type Fila = Omit<ClienteDto, "credenciales" | "archivado"> &
  Partial<Pick<ClienteDto, "credenciales" | "archivado">>;

type Tipo = "colaborador" | "responsable";
type Anterior = "colaborador" | "retirar";

export default function Clientes() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [clientes, setClientes] = useState<Fila[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [enviando, setEnviando] = useState(false);

  const [filtros, setFiltros] = useState<EstadoFiltros>(FILTROS_VACIOS);
  const [qEnviada, setQEnviada] = useState("");
  const [version, setVersion] = useState(0);

  const puedeVerClientes = tiene(yo, "clientes.ver");
  const { responsable, credencial, archivados } = filtros;

  // La búsqueda por texto se envía un momento después de dejar de escribir.
  useEffect(() => {
    const t = setTimeout(
      () => setQEnviada(filtros.q.trim()),
      ESPERA_BUSQUEDA_MS,
    );
    return () => clearTimeout(t);
  }, [filtros.q]);

  // Pide el listado con los filtros activos; una respuesta tardía de una consulta anterior se descarta.
  useEffect(() => {
    if (!puedeVerClientes) return;
    let vigente = true;
    listarClientes(
      filtrosDeEstado({ responsable, credencial, archivados, q: qEnviada }),
    )
      .then((r) => {
        if (!vigente) return;
        if (r.ok && r.datos) {
          const lista = r.datos;
          setClientes(lista);
          setSeleccion((previa) => {
            const visibles = new Set(lista.map((c) => c.id));
            return new Set([...previa].filter((id) => visibles.has(id)));
          });
        } else if (r.status !== 401) {
          setError(mensajeDeError(r.status, r.datos));
        }
      })
      .catch(() => {
        if (vigente) setError(MENSAJES.errorGeneral);
      });
    return () => {
      vigente = false;
    };
  }, [
    puedeVerClientes,
    responsable,
    credencial,
    archivados,
    qEnviada,
    version,
  ]);

  useEffect(() => {
    let vigente = true;
    (async () => {
      const { yo: actual, status } = await cargarYo();
      if (!vigente) return;
      setYo(actual);
      setCargado(true);
      if (!actual) {
        if (status !== 401) setError(mensajeDeError(status, null));
        return;
      }
      if (!tiene(actual, "clientes.ver")) return;
      if (tiene(actual, "clientes.asignar") || tiene(actual, "usuarios.ver")) {
        const r = await api<Miembro[]>("/usuarios");
        if (vigente && r.ok && r.datos) setMiembros(r.datos);
      }
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, []);

  function alternar(id: string) {
    setSeleccion((previa) => {
      const nueva = new Set(previa);
      if (nueva.has(id)) nueva.delete(id);
      else nueva.add(id);
      return nueva;
    });
  }

  async function asignar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (seleccion.size === 0 || !usuarioId) return;
    setEnviando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await api<{ asignados: number; codigo?: string }>(
        "/asignaciones/por-usuario",
        {
          method: "POST",
          body: {
            usuarioId,
            clienteIds: [...seleccion],
            tipo,
            ...(tipo === "responsable" ? { anterior } : {}),
          },
        },
      );
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return;
      }
      setAviso(`Clientes asignados: ${r.datos?.asignados ?? seleccion.size}`);
      setSeleccion(new Set());
      setVersion((v) => v + 1);
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  if (!cargado) return <main className="p-6">Cargando…</main>;

  const puedeVer = puedeVerClientes;
  const asigna = tiene(yo, "clientes.asignar");
  const crea = tiene(yo, "clientes.crear");
  const archiva = tiene(yo, "clientes.archivar");
  const activos = miembros.filter((m) => m.activo);

  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Clientes</h1>
        {crea && (
          <div className="flex gap-2">
            <Link
              href="/clientes/importar"
              className="rounded border px-4 py-2 text-sm"
            >
              Importar clientes
            </Link>
            <Link
              href="/clientes/nuevo"
              className="rounded bg-black px-4 py-2 text-sm text-white"
            >
              Nuevo cliente
            </Link>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {aviso && <p role="status">{aviso}</p>}
      {yo && !puedeVer && <p>{MENSAJES.sinPermiso}</p>}
      {yo && puedeVer && (
        <FiltrosClientes
          valor={filtros}
          onCambio={setFiltros}
          responsables={activos}
        />
      )}
      {yo && puedeVer && (
        <form onSubmit={asignar} className="flex flex-col gap-4">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {asigna && <th aria-label="Selección" />}
                <th>RUC</th>
                <th>Razón social</th>
                <th>Responsable</th>
                <th>Credenciales</th>
                {archiva && <th>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {clientes.map((c) => (
                <tr key={c.id}>
                  {asigna && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Seleccionar ${c.razonSocial}`}
                        checked={seleccion.has(c.id)}
                        disabled={c.archivado}
                        onChange={() => alternar(c.id)}
                      />
                    </td>
                  )}
                  <td>{c.ruc}</td>
                  <td>
                    <Link href={`/clientes/${c.id}`} className="underline">
                      {c.razonSocial}
                    </Link>
                  </td>
                  <td>{c.responsable?.nombre ?? MENSAJES.sinResponsable}</td>
                  <td>
                    {c.archivado && <p>Archivado</p>}
                    {c.credenciales && (
                      <>
                        <p>SOL: {ETIQUETA_ESTADO[c.credenciales.sol]}</p>
                        <p>
                          SIRE API: {ETIQUETA_ESTADO[c.credenciales.sire_api]}
                        </p>
                      </>
                    )}
                  </td>
                  {archiva && (
                    <td>
                      <Link href={`/clientes/${c.id}`} className="underline">
                        {c.archivado ? "Reactivar" : "Archivar"}
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {asigna && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Usuario
                <select
                  value={usuarioId}
                  onChange={(e) => setUsuarioId(e.target.value)}
                  className="rounded border px-3 py-2"
                >
                  <option value="">Elige un usuario</option>
                  {activos.map((m) => (
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
              {tipo === "responsable" && (
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
                disabled={enviando || seleccion.size === 0 || !usuarioId}
                className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
              >
                Asignar seleccionados
              </button>
            </div>
          )}
        </form>
      )}
    </main>
  );
}

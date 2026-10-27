"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  MENSAJES,
  cargarYo,
  mensajeDeError,
  tiene,
  type Miembro,
  type Yo,
} from "../../../lib/acceso";
import { api } from "../../../lib/api";

// Clientes visibles para el usuario (el backend ya filtra por alcance) y asignación masiva
// (spec 005, CA-5, CA-8, CA-15, D20). Sin cálculos: solo muestra y envía lo elegido.

interface ClienteFila {
  id: string;
  ruc: string;
  razonSocial: string;
  responsable: { usuarioId: string; nombre: string } | null;
}

type Tipo = "colaborador" | "responsable";
type Anterior = "colaborador" | "retirar";

export default function Clientes() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [clientes, setClientes] = useState<ClienteFila[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [usuarioId, setUsuarioId] = useState("");
  const [tipo, setTipo] = useState<Tipo>("colaborador");
  const [anterior, setAnterior] = useState<Anterior>("colaborador");
  const [enviando, setEnviando] = useState(false);

  const recargar = useCallback(async () => {
    const r = await api<ClienteFila[]>("/clientes");
    if (r.ok && r.datos) setClientes(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, []);

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
      const pedidos: Promise<void>[] = [recargar()];
      if (tiene(actual, "clientes.asignar")) {
        pedidos.push(
          api<Miembro[]>("/usuarios").then((r) => {
            if (vigente && r.ok && r.datos) setMiembros(r.datos);
          }),
        );
      }
      await Promise.all(pedidos);
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [recargar]);

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
      await recargar();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setEnviando(false);
    }
  }

  if (!cargado) return <main className="p-6">Cargando…</main>;

  const puedeVer = tiene(yo, "clientes.ver");
  const asigna = tiene(yo, "clientes.asignar");

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Clientes</h1>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {aviso && <p role="status">{aviso}</p>}
      {yo && !puedeVer && <p>{MENSAJES.sinPermiso}</p>}
      {yo && puedeVer && (
        <form onSubmit={asignar} className="flex flex-col gap-4">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {asigna && <th aria-label="Selección" />}
                <th>RUC</th>
                <th>Razón social</th>
                <th>Responsable</th>
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

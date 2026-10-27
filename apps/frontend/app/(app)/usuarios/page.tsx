"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ETIQUETA_ROL,
  MENSAJES,
  ROLES,
  cargarYo,
  fechaCorta,
  mensajeDeError,
  puedeOtorgar,
  puedeTocar,
  tiene,
  type Miembro,
  type Rol,
  type Yo,
} from "../../../lib/acceso";
import { api, type RespuestaApi } from "../../../lib/api";

// Usuarios del estudio (spec 005, CA-15): miembros, invitaciones y sus acciones. Todo se decide en
// el servidor; aquí solo se oculta lo que el rol no puede hacer (RNF-007).

interface Invitacion {
  id: string;
  correo: string;
  rol: Rol;
  creadaEn: string;
  venceEn: string;
  vencida: boolean;
}

const INVITACION_ENVIADA = "Invitación enviada.";

export default function Usuarios() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargado, setCargado] = useState(false);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [invitaciones, setInvitaciones] = useState<Invitacion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [correo, setCorreo] = useState("");
  const [rolNuevo, setRolNuevo] = useState<Rol>("lectura");
  const [ocupado, setOcupado] = useState(false);

  const recargarMiembros = useCallback(async () => {
    const r = await api<Miembro[]>("/usuarios");
    if (r.ok && r.datos) setMiembros(r.datos);
    else if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
  }, []);

  const recargarInvitaciones = useCallback(async () => {
    const r = await api<Invitacion[]>("/invitaciones");
    if (r.ok && r.datos) setInvitaciones(r.datos);
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
      if (!tiene(actual, "usuarios.ver")) return;
      await Promise.all([recargarMiembros(), recargarInvitaciones()]);
    })().catch(() => {
      if (vigente) {
        setCargado(true);
        setError(MENSAJES.errorGeneral);
      }
    });
    return () => {
      vigente = false;
    };
  }, [recargarMiembros, recargarInvitaciones]);

  /** Ejecuta una acción; si sale bien recarga lo indicado, si no muestra un mensaje genérico. */
  async function ejecutar(
    accion: () => Promise<RespuestaApi<{ codigo?: string }>>,
    recargar: Array<() => Promise<void>>,
    exito?: string,
  ): Promise<boolean> {
    setError(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await accion();
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDeError(r.status, r.datos));
        return false;
      }
      if (exito) setAviso(exito);
      await Promise.all(recargar.map((f) => f()));
      return true;
    } catch {
      setError(MENSAJES.errorGeneral);
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function invitar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const ok = await ejecutar(
      () =>
        api("/invitaciones", {
          method: "POST",
          body: { correo, rol: rolNuevo },
        }),
      [recargarInvitaciones],
      INVITACION_ENVIADA,
    );
    if (ok) setCorreo("");
  }

  if (!cargado) return <main className="p-6">Cargando…</main>;

  const puedeVer = tiene(yo, "usuarios.ver");
  const gestiona = tiene(yo, "usuarios.gestionar");
  const rolActor = yo?.rol ?? "lectura";
  const rolesOtorgables = ROLES.filter((r) => puedeOtorgar(rolActor, r));

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Usuarios</h1>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {aviso && <p role="status">{aviso}</p>}
      {yo && !puedeVer && <p>{MENSAJES.sinPermiso}</p>}
      {yo && puedeVer && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Miembros</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Correo</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  {gestiona && <th>Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {miembros.map((m) => {
                  const accionable =
                    gestiona && !m.esYo && puedeTocar(rolActor, m.rol);
                  return (
                    <tr key={m.usuarioId}>
                      <td>{m.nombre}</td>
                      <td>{m.correo}</td>
                      <td>{ETIQUETA_ROL[m.rol]}</td>
                      <td>{m.activo ? "Activo" : "Desactivado"}</td>
                      {gestiona && (
                        <td className="flex gap-2">
                          {accionable && m.activo && (
                            <>
                              <select
                                aria-label="Cambiar rol"
                                value={m.rol}
                                disabled={ocupado}
                                onChange={(e) =>
                                  void ejecutar(
                                    () =>
                                      api(`/usuarios/${m.usuarioId}/rol`, {
                                        method: "PATCH",
                                        body: { rol: e.target.value },
                                      }),
                                    [recargarMiembros],
                                  )
                                }
                                className="rounded border px-2 py-1"
                              >
                                {rolesOtorgables.map((r) => (
                                  <option key={r} value={r}>
                                    {ETIQUETA_ROL[r]}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                disabled={ocupado}
                                onClick={() =>
                                  void ejecutar(
                                    () =>
                                      api(
                                        `/usuarios/${m.usuarioId}/desactivar`,
                                        { method: "POST" },
                                      ),
                                    [recargarMiembros],
                                  )
                                }
                                className="rounded border px-2 py-1"
                              >
                                Desactivar
                              </button>
                            </>
                          )}
                          {accionable && !m.activo && (
                            <button
                              type="button"
                              disabled={ocupado}
                              onClick={() =>
                                void ejecutar(
                                  () =>
                                    api(`/usuarios/${m.usuarioId}/reactivar`, {
                                      method: "POST",
                                    }),
                                  [recargarMiembros],
                                )
                              }
                              className="rounded border px-2 py-1"
                            >
                              Reactivar
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">Invitaciones</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Correo</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Vence</th>
                  {gestiona && <th>Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {invitaciones.map((i) => (
                  <tr key={i.id}>
                    <td>{i.correo}</td>
                    <td>{ETIQUETA_ROL[i.rol]}</td>
                    <td>{i.vencida ? "Vencida" : "Pendiente"}</td>
                    <td>{fechaCorta(i.venceEn)}</td>
                    {gestiona && (
                      <td className="flex gap-2">
                        {puedeTocar(rolActor, i.rol) && (
                          <>
                            <button
                              type="button"
                              disabled={ocupado}
                              onClick={() =>
                                void ejecutar(
                                  () =>
                                    api(`/invitaciones/${i.id}/reenviar`, {
                                      method: "POST",
                                    }),
                                  [recargarInvitaciones],
                                )
                              }
                              className="rounded border px-2 py-1"
                            >
                              Reenviar
                            </button>
                            <button
                              type="button"
                              disabled={ocupado}
                              onClick={() =>
                                void ejecutar(
                                  () =>
                                    api(`/invitaciones/${i.id}/revocar`, {
                                      method: "POST",
                                    }),
                                  [recargarInvitaciones],
                                )
                              }
                              className="rounded border px-2 py-1"
                            >
                              Revocar
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {gestiona && (
            <form onSubmit={invitar} className="flex max-w-sm flex-col gap-3">
              <h2 className="text-lg font-medium">Invitar a una persona</h2>
              <label className="flex flex-col gap-1 text-sm">
                Correo
                <input
                  type="email"
                  autoComplete="off"
                  required
                  value={correo}
                  onChange={(e) => setCorreo(e.target.value)}
                  className="rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Rol
                <select
                  value={rolNuevo}
                  onChange={(e) => setRolNuevo(e.target.value as Rol)}
                  className="rounded border px-3 py-2"
                >
                  {rolesOtorgables.map((r) => (
                    <option key={r} value={r}>
                      {ETIQUETA_ROL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={ocupado}
                className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
              >
                Invitar
              </button>
            </form>
          )}
        </>
      )}
    </main>
  );
}

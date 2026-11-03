"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PlanDto } from "@contapp/shared";
import { MENSAJES } from "../../../../lib/acceso";
import { api, type RespuestaApi } from "../../../../lib/api";
import {
  FORMULARIO_VACIO,
  MENSAJES_PLATAFORMA,
  cuerpoDePlan,
  entradaDePlan,
  formularioDe,
  mensajeDePlan,
  mensajeGeneral,
  useAccesoPlataforma,
  type FormularioPlan,
} from "../../../../lib/plataforma";

// Planes de suscripción de la plataforma (spec 006, D5, CA-10): lista, alta, edición y activación. Antes
// de enviar, los valores se validan con los esquemas de shared; el servidor vuelve a validarlos y su
// detalle nunca se muestra.

const CAMPOS: ReadonlyArray<{
  campo: Exclude<keyof FormularioPlan, "features">;
  etiqueta: string;
  modo?: "decimal" | "numeric";
}> = [
  { campo: "codigo", etiqueta: "Código" },
  { campo: "nombre", etiqueta: "Nombre" },
  { campo: "precioMensual", etiqueta: "Precio mensual", modo: "decimal" },
  { campo: "precioAnual", etiqueta: "Precio anual", modo: "decimal" },
  { campo: "maxRucs", etiqueta: "Máximo de RUCs", modo: "numeric" },
  { campo: "maxUsuarios", etiqueta: "Máximo de usuarios", modo: "numeric" },
  {
    campo: "precioRucExtra",
    etiqueta: "Precio por RUC extra",
    modo: "decimal",
  },
  { campo: "maxRucsExtra", etiqueta: "Máximo de RUCs extra", modo: "numeric" },
  {
    campo: "frecuenciaBuzonMin",
    etiqueta: "Frecuencia del buzón (min)",
    modo: "numeric",
  },
];

export default function AdminPlanes() {
  const acceso = useAccesoPlataforma();
  const [planes, setPlanes] = useState<PlanDto[]>([]);
  const [formulario, setFormulario] =
    useState<FormularioPlan>(FORMULARIO_VACIO);
  const [editando, setEditando] = useState<PlanDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargarPlanes = useCallback(async () => {
    const r = await api<PlanDto[]>("/plataforma/planes");
    if (r.ok && r.datos) setPlanes(r.datos);
    else if (r.status !== 401) setError(mensajeGeneral(r.status));
  }, []);

  useEffect(() => {
    if (acceso !== "admin") return;
    cargarPlanes().catch(() => setError(MENSAJES.errorGeneral));
  }, [acceso, cargarPlanes]);

  /** Escritura (alta, edición o activación): aviso y recarga si sale bien; mensaje si no. */
  async function escribir(
    peticion: () => Promise<RespuestaApi>,
    exito: string,
    alTerminar: () => void,
  ) {
    setError(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await peticion();
      if (!r.ok) {
        if (r.status !== 401) setError(mensajeDePlan(r.status, r.datos));
        return;
      }
      setAviso(exito);
      alTerminar();
      await cargarPlanes();
    } catch {
      setError(MENSAJES.errorGeneral);
    } finally {
      setOcupado(false);
    }
  }

  function cambiar(campo: keyof FormularioPlan, valor: string) {
    setFormulario((actual) => ({ ...actual, [campo]: valor }));
  }

  function editar(plan: PlanDto) {
    setError(null);
    setAviso(null);
    setEditando(plan);
    setFormulario(formularioDe(plan));
  }

  function cancelarEdicion() {
    setError(null);
    setEditando(null);
    setFormulario(FORMULARIO_VACIO);
  }

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const entrada = entradaDePlan(
      formulario,
      editando !== null,
      editando?.activo ?? true,
    );
    if (!entrada.ok) {
      setAviso(null);
      setError(entrada.error);
      return;
    }
    const cuerpo = entrada.cuerpo;
    if (editando) {
      await escribir(
        () =>
          api(`/plataforma/planes/${editando.id}`, {
            method: "PUT",
            body: cuerpo,
          }),
        MENSAJES_PLATAFORMA.planGuardado,
        cancelarEdicion,
      );
      return;
    }
    await escribir(
      () => api("/plataforma/planes", { method: "POST", body: cuerpo }),
      MENSAJES_PLATAFORMA.planCreado,
      () => setFormulario(FORMULARIO_VACIO),
    );
  }

  async function alternarActivo(plan: PlanDto) {
    await escribir(
      () =>
        api(`/plataforma/planes/${plan.id}`, {
          method: "PUT",
          body: cuerpoDePlan(plan, !plan.activo),
        }),
      MENSAJES_PLATAFORMA.planGuardado,
      () => {
        if (editando?.id === plan.id) cancelarEdicion();
      },
    );
  }

  if (acceso === undefined) return <main className="p-6">Cargando…</main>;
  if (acceso !== "admin") {
    return (
      <main className="p-6">
        <p>
          {acceso === "sin_permiso"
            ? MENSAJES.sinPermiso
            : MENSAJES.errorGeneral}
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Planes de suscripción</h1>
      <nav className="text-sm">
        <Link href="/admin" className="underline">
          Estudios
        </Link>
      </nav>
      {error && (
        <div role="alert" className="text-sm text-red-600">
          <p>{error}</p>
        </div>
      )}
      {aviso && (
        <p role="status" className="text-sm">
          {aviso}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Planes</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Precio mensual</th>
              <th>Máximo de RUCs</th>
              <th>Máximo de usuarios</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {planes.map((p) => (
              <tr key={p.id}>
                <td>{p.codigo}</td>
                <td>{p.nombre}</td>
                <td>{p.precioMensual}</td>
                <td>{p.maxRucs}</td>
                <td>{p.maxUsuarios ?? "Ilimitado"}</td>
                <td>{p.activo ? "Activo" : "Inactivo"}</td>
                <td className="flex gap-2">
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => editar(p)}
                    className="rounded border px-2 py-1"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => void alternarActivo(p)}
                    className="rounded border px-2 py-1"
                  >
                    {p.activo ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form
        onSubmit={(e) => void enviar(e)}
        noValidate
        className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <h2 className="text-lg font-medium sm:col-span-2">
          {editando ? `Editar plan ${editando.codigo}` : "Nuevo plan"}
        </h2>
        {CAMPOS.map(({ campo, etiqueta, modo }) => (
          <label key={campo} className="flex flex-col gap-1 text-sm">
            {etiqueta}
            <input
              type="text"
              inputMode={modo}
              value={formulario[campo]}
              disabled={ocupado}
              onChange={(e) => cambiar(campo, e.target.value)}
              className="rounded border px-3 py-2"
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Características (JSON)
          <textarea
            rows={5}
            value={formulario.features}
            disabled={ocupado}
            onChange={(e) => cambiar("features", e.target.value)}
            className="rounded border px-3 py-2 font-mono text-xs"
          />
        </label>
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={ocupado}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {editando ? "Guardar cambios" : "Crear plan"}
          </button>
          {editando && (
            <button
              type="button"
              disabled={ocupado}
              onClick={cancelarEdicion}
              className="rounded border px-4 py-2"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { PlanDto } from "@contapp/shared";
import { MENSAJES } from "../../../../lib/acceso";
import { api, type RespuestaApi } from "../../../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EncabezadoPagina,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui";
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

  if (acceso === undefined) return <main className="p-4 text-tinta-suave sm:p-6">Cargando…</main>;
  if (acceso !== "admin") {
    return (
      <main className="p-4 sm:p-6">
        <p className="m-0 text-tinta-media">
          {acceso === "sin_permiso"
            ? MENSAJES.sinPermiso
            : MENSAJES.errorGeneral}
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina
        titulo="Planes de suscripción"
        acciones={
          <nav>
            <Button asChild variant="secundario" className="max-lg:h-11">
              <Link href="/admin">Estudios</Link>
            </Button>
          </nav>
        }
      />
      {error && (
        <Alert tono="error" role="alert">
          <CircleAlert aria-hidden="true" />
          <p className="m-0">{error}</p>
        </Alert>
      )}
      {aviso && (
        <Alert tono="ok" role="status">
          <CircleCheck aria-hidden="true" />
          <p className="m-0">{aviso}</p>
        </Alert>
      )}

      <Card className="p-4 sm:p-6">
        <CardTitle>Planes</CardTitle>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead className="text-right">Precio mensual</TableHead>
              <TableHead>Máximo de RUCs</TableHead>
              <TableHead>Máximo de usuarios</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {planes.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono">{p.codigo}</TableCell>
                <TableCell>{p.nombre}</TableCell>
                <TableCell numerico>{p.precioMensual}</TableCell>
                <TableCell>{p.maxRucs}</TableCell>
                <TableCell>{p.maxUsuarios ?? "Ilimitado"}</TableCell>
                <TableCell>
                  <Badge tono={p.activo ? "ok" : "neutro"}>{p.activo ? "Activo" : "Inactivo"}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secundario"
                      size="sm"
                      disabled={ocupado}
                      onClick={() => editar(p)}
                      className="max-lg:h-11"
                    >
                      Editar
                    </Button>
                    <Button
                      variant="secundario"
                      size="sm"
                      disabled={ocupado}
                      onClick={() => void alternarActivo(p)}
                      className="max-lg:h-11"
                    >
                      {p.activo ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="max-w-3xl p-4 sm:p-6">
        <form
          onSubmit={(e) => void enviar(e)}
          noValidate
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <CardTitle className="sm:col-span-2">
            {editando ? `Editar plan ${editando.codigo}` : "Nuevo plan"}
          </CardTitle>
          {CAMPOS.map(({ campo, etiqueta, modo }) => (
            <Label key={campo}>
              {etiqueta}
              <Input
                type="text"
                inputMode={modo}
                value={formulario[campo]}
                disabled={ocupado}
                onChange={(e) => cambiar(campo, e.target.value)}
                className="max-lg:h-11"
              />
            </Label>
          ))}
          <Label className="sm:col-span-2">
            Características (JSON)
            <textarea
              rows={5}
              value={formulario.features}
              disabled={ocupado}
              onChange={(e) => cambiar("features", e.target.value)}
              className="w-full min-w-0 rounded-control border border-linea-control bg-hoja px-3 py-2 font-mono text-xs text-tinta focus-visible:border-primario focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primario/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </Label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={ocupado} className="max-lg:h-11">
              {editando ? "Guardar cambios" : "Crear plan"}
            </Button>
            {editando && (
              <Button
                variant="secundario"
                disabled={ocupado}
                onClick={cancelarEdicion}
                className="max-lg:h-11"
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      </Card>
    </main>
  );
}

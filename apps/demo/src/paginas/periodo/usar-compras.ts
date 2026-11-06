import { useMemo } from "react";
import type { Confirmacion, Destino, Hallazgo } from "@contapp/domain";
import { HISTORIAL } from "../../datos/semilla";
import type { FilaCompra, XmlDemo } from "../../datos/tipos";
import { useDemo } from "../../estado/store";
import { aplicar, claveHallazgo, destinoDe, evaluar, moverADestino } from "../../motor/dominio";
import { puede } from "../../ui/permisos";

/** Sugerencia del historial aprendido (R-HIS, R2): no está en el dominio aún, la arma la demo. */
export interface SugerenciaHistorial {
  filaId: string;
  destino: Destino;
  clave: string;
}

export const EXPLICACION_REGLA: Record<string, string> = {
  "R-ISC": "ISC mal ubicado",
  "R-MIX": "Factura mixta",
  "R-RED": "Redondeo / cuadre",
  "R-NEW": "Proveedor nuevo",
  "R-GP": "Posible gasto personal",
  "R-HIS": "Según historial",
};

export const TONO_REGLA: Record<string, "rojo" | "ambar" | "azul" | "violeta" | "teal"> = {
  "R-ISC": "rojo",
  "R-MIX": "ambar",
  "R-RED": "azul",
  "R-NEW": "violeta",
  "R-GP": "rojo",
  "R-HIS": "teal",
};

export function useCompras(clienteId: string) {
  const demo = useDemo();
  const { estado, periodo, cambiarCompras, resolver, usuario, recordarProveedor, actualizarAprendida } = demo;
  const p = periodo(clienteId);
  const conocidos = useMemo(() => Object.keys(HISTORIAL[clienteId] ?? {}), [clienteId]);
  const xmlDisponibles = useMemo(() => {
    const r: Record<string, XmlDemo | undefined> = {};
    for (const [id, x] of Object.entries(p.xml)) if (p.xmlEstado[id] === "disponible") r[id] = x;
    return r;
  }, [p.xml, p.xmlEstado]);

  const ev = useMemo(() => evaluar(p.compras, xmlDisponibles, conocidos, estado.emisoresIsc), [p.compras, xmlDisponibles, conocidos, estado.emisoresIsc]);
  const resueltos = useMemo(() => new Set(p.resueltos), [p.resueltos]);
  const aprendidas = estado.aprendidas[clienteId] ?? [];

  const pendientes = (filaId: string): Hallazgo[] => (ev.porFila.get(filaId) ?? []).filter((h) => !resueltos.has(claveHallazgo(h)));

  const historial = (f: FilaCompra): SugerenciaHistorial | null => {
    if (f.excluida) return null;
    const a = aprendidas.find((x) => x.activa && x.proveedorRuc === f.proveedorRuc);
    if (!a) return null;
    const d = destinoDe(f.montos);
    const clave = `${f.id}:R-HIS:${a.destino}`;
    if (d === a.destino || d === null || resueltos.has(clave)) return null;
    // Si hay un hallazgo de montos pendiente, primero se corrigen los montos.
    if (pendientes(f.id).some((h) => h.regla === "R-ISC" || h.regla === "R-MIX" || h.regla === "R-RED")) return null;
    return { filaId: f.id, destino: a.destino, clave };
  };

  const bloqueado = p.revisado && !puede(usuario?.rol, "sire.aprobar_generar");
  const totalPendientes = p.compras.reduce((n, f) => n + (f.excluida ? 0 : pendientes(f.id).length + (historial(f) ? 1 : 0)), 0);

  /** Aplica un hallazgo del motor real (aplicarSugerencia con el entorno de evaluarReglas). */
  const aplicarHallazgo = (h: Hallazgo, confirmacion?: Confirmacion, recordar?: boolean): string | null => {
    const fila = p.compras.find((f) => f.id === h.filaId);
    if (!fila) return "Fila no encontrada";
    try {
      const r = aplicar(fila, h, confirmacion, ev.entorno);
      const motivo = h.sugerencia?.tipo === "excluir" ? `Gasto personal: la glosa dice «${h.sugerencia.palabra}»` : undefined;
      cambiarCompras(
        clienteId,
        (filas) => filas.map((f) => (f.id === h.filaId ? { ...f, montos: r.montos, ...(r.excluir ? { excluida: true, motivoExclusion: motivo } : {}) } : f)),
        `${fila.serie}-${fila.numero}: aplicada ${h.regla} (${h.explicacion})`,
      );
      if (h.regla === "R-NEW" || h.regla === "R-GP" || h.sugerencia === null) resolver(clienteId, [claveHallazgo(h)]);
      if (recordar && confirmacion && "destino" in confirmacion) recordarProveedor(clienteId, fila.proveedorRuc, confirmacion.destino);
      return null;
    } catch (e) {
      const err = e as { codigo?: string; message?: string };
      return `${err.codigo ?? "ERROR"}: ${err.message ?? "no se pudo aplicar"}`;
    }
  };

  const aplicarHistorial = (s: SugerenciaHistorial) => {
    const fila = p.compras.find((f) => f.id === s.filaId);
    if (!fila) return;
    cambiarCompras(clienteId, (filas) => filas.map((f) => (f.id === s.filaId ? { ...f, montos: moverADestino(f.montos, s.destino) } : f)), `${fila.serie}-${fila.numero}: clasificada ${s.destino} según historial`);
    resolver(clienteId, [s.clave]);
    const a = aprendidas.find((x) => x.proveedorRuc === fila.proveedorRuc);
    if (a) actualizarAprendida(clienteId, a.proveedorRuc, { aplicada: a.aplicada + 1, aceptada: a.aceptada + 1 });
  };

  const descartar = (claves: string[]) => resolver(clienteId, claves);

  const clasificar = (ids: string[], d: Destino) => {
    const etiqueta = ids.length === 1 ? (p.compras.find((f) => f.id === ids[0])?.serie ?? "") + "-" + (p.compras.find((f) => f.id === ids[0])?.numero ?? "") : `${ids.length} filas`;
    cambiarCompras(clienteId, (filas) => filas.map((f) => (ids.includes(f.id) && !f.excluida ? { ...f, montos: moverADestino(f.montos, d) } : f)), `${etiqueta}: clasificación → ${d}`);
    // Clasificar a mano resuelve R-NEW (el contador eligió destino).
    resolver(
      clienteId,
      ids.map((id) => `${id}:R-NEW:-`),
    );
  };

  const excluir = (ids: string[], motivo: string) =>
    cambiarCompras(clienteId, (filas) => filas.map((f) => (ids.includes(f.id) ? { ...f, excluida: true, motivoExclusion: motivo || "No deducible" } : f)), `${ids.length} fila(s) excluida(s): ${motivo || "No deducible"}`);

  const restaurar = (ids: string[]) => cambiarCompras(clienteId, (filas) => filas.map((f) => (ids.includes(f.id) ? { ...f, excluida: false, motivoExclusion: undefined } : f)), `${ids.length} fila(s) restaurada(s)`);

  const editarFila = (id: string, cambios: Partial<FilaCompra>, descripcion: string) => cambiarCompras(clienteId, (filas) => filas.map((f) => (f.id === id ? { ...f, ...cambios } : f)), descripcion);

  return { ...demo, p, ev, pendientes, historial, aplicarHallazgo, aplicarHistorial, descartar, clasificar, excluir, restaurar, editarFila, conocidos, bloqueado, totalPendientes, xmlDisponibles };
}

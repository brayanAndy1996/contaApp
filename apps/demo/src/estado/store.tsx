// Estado de la demo: vive en el navegador (localStorage). Simula lo que en el producto hacen el
// backend (API + RLS), el worker (BullMQ) y SUNAT (mocks): aquí todo es local y ficticio.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  APRENDIDAS,
  CLIENTES,
  MENSAJES,
  PADRON_RUC,
  PERIODO_ACTUAL,
  PRORRATA,
  PROVEEDORES,
  USUARIOS,
  propuestaDe,
} from "../datos/semilla";
import type {
  Aprendida,
  Cliente,
  EstadoPeriodo,
  EventoAuditoria,
  FilaCompra,
  FilaVenta,
  Mensaje,
  MesProrrata,
  Notificacion,
  Trabajo,
  Usuario,
  VersionArchivo,
  XmlDemo,
} from "../datos/tipos";

const CLAVE = "contapp-demo-v1";

export interface EstadoDemo {
  usuarioId: string | null;
  clientes: Cliente[];
  periodos: Record<string, EstadoPeriodo>;
  aprendidas: Record<string, Aprendida[]>;
  mensajes: Mensaje[];
  prorrata: Record<string, MesProrrata[]>;
  auditoria: EventoAuditoria[];
  notificaciones: Notificacion[];
  trabajos: Trabajo[];
  usuarios: Usuario[];
  emisoresIsc: string[];
  proveedoresExtra: { ruc: string; razonSocial: string; rubro: string }[];
}

function inicial(): EstadoDemo {
  return {
    usuarioId: null,
    clientes: structuredClone(CLIENTES),
    periodos: {},
    aprendidas: structuredClone(APRENDIDAS),
    mensajes: structuredClone(MENSAJES),
    prorrata: structuredClone(PRORRATA),
    auditoria: [],
    notificaciones: [
      { id: "n0", fecha: new Date().toISOString(), texto: "Credencial SOL inválida: FERRETERÍA EL PERNO DEMO E.I.R.L.", tipo: "alerta", leida: false, enlace: "#/clientes/c3" },
      { id: "n00", fecha: new Date().toISOString(), texto: "4 mensajes críticos nuevos en los buzones SOL", tipo: "alerta", leida: false, enlace: "#/buzones" },
    ],
    trabajos: [],
    usuarios: structuredClone(USUARIOS),
    emisoresIsc: PROVEEDORES.filter((p) => p.emisorIsc).map((p) => p.ruc),
    proveedoresExtra: [],
  };
}

function cargar(): EstadoDemo {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return inicial();
    const e = JSON.parse(crudo) as EstadoDemo;
    // Los trabajos en curso no sobreviven a una recarga (como un worker reiniciado).
    e.trabajos = e.trabajos.map((t) => (t.estado === "ejecutando" || t.estado === "en_cola" ? { ...t, estado: "fallido" as const, detalle: "Interrumpido al recargar la página" } : t));
    return e;
  } catch {
    return inicial();
  }
}

export const clavePeriodo = (clienteId: string, periodo: string) => `${clienteId}:${periodo}`;

function periodoVacio(): EstadoPeriodo {
  return {
    ventasCargadas: false,
    comprasCargadas: false,
    ventas: [],
    comprasOriginales: [],
    compras: [],
    xmlEstado: {},
    xml: {},
    resueltos: [],
    deshacer: [],
    rehacer: [],
    revisado: false,
    versiones: [],
  };
}

let secuencia = 0;
const nuevoId = (p: string) => `${p}${Date.now().toString(36)}${(secuencia++).toString(36)}`;

interface Acciones {
  estado: EstadoDemo;
  usuario: Usuario | null;
  ingresar(usuarioId: string): void;
  salir(): void;
  reiniciar(): void;
  periodo(clienteId: string, periodo?: string): EstadoPeriodo;
  cliente(id: string): Cliente | undefined;
  razonSocial(ruc: string): string;
  auditar(accion: string, detalle: string, cliente?: string): void;
  notificar(texto: string, tipo?: Notificacion["tipo"], enlace?: string): void;
  marcarNotificacionesLeidas(): void;
  trabajo(tipo: string, pasos: string[], opciones: { cliente?: string; ms?: number; alTerminar?: () => void; falla?: string }): string;
  // clientes
  crearCliente(c: Omit<Cliente, "id">): Cliente;
  actualizarCliente(id: string, cambios: Partial<Cliente>): void;
  consultarRuc(ruc: string): Promise<(typeof PADRON_RUC)[string] | null>;
  // periodo
  descargarPropuesta(clienteId: string, libro: "ventas" | "compras"): void;
  cambiarCompras(clienteId: string, f: (filas: FilaCompra[]) => FilaCompra[], descripcion: string, extra?: (p: EstadoPeriodo) => Partial<EstadoPeriodo>): void;
  deshacer(clienteId: string): void;
  rehacer(clienteId: string): void;
  resolver(clienteId: string, claves: string[]): void;
  agregarVenta(clienteId: string, v: FilaVenta): void;
  reintentarXml(clienteId: string, filaId: string): void;
  subirXml(clienteId: string, filaId: string, xml: XmlDemo): void;
  marcarRevisado(clienteId: string, revisado: boolean): void;
  guardarVersion(clienteId: string, v: Omit<VersionArchivo, "version">): VersionArchivo;
  enviarSunat(clienteId: string, version: number): void;
  // aprendizaje, buzones, prorrata
  recordarProveedor(clienteId: string, ruc: string, destino: Aprendida["destino"]): void;
  actualizarAprendida(clienteId: string, ruc: string, cambios: Partial<Aprendida> | null): void;
  revisarBuzones(): void;
  atenderMensaje(id: string, comentario: string): void;
  abrirMensaje(id: string): void;
  editarMesProrrata(clienteId: string, periodo: string, gravadas: string, noGravadas: string): void;
}

const Contexto = createContext<Acciones | null>(null);

export function ProveedorEstado({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoDemo>(cargar);
  const ref = useRef(estado);
  ref.current = estado;

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CLAVE, JSON.stringify(estado));
      } catch {
        /* sin almacenamiento: la demo sigue en memoria */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [estado]);

  const usuario = estado.usuarios.find((u) => u.id === estado.usuarioId) ?? null;
  const nombreUsuario = usuario?.nombre ?? "Sistema";

  const auditar = useCallback(
    (accion: string, detalle: string, cliente?: string) =>
      setEstado((e) => ({
        ...e,
        auditoria: [{ id: nuevoId("a"), fecha: new Date().toISOString(), usuario: e.usuarios.find((u) => u.id === e.usuarioId)?.nombre ?? "Sistema", accion, detalle, cliente }, ...e.auditoria].slice(0, 500),
      })),
    [],
  );

  const notificar = useCallback(
    (texto: string, tipo: Notificacion["tipo"] = "info", enlace?: string) =>
      setEstado((e) => ({ ...e, notificaciones: [{ id: nuevoId("n"), fecha: new Date().toISOString(), texto, tipo, leida: false, enlace }, ...e.notificaciones].slice(0, 50) })),
    [],
  );

  const trabajo = useCallback<Acciones["trabajo"]>((tipo, pasos, op) => {
    const id = nuevoId("t");
    const ms = op.ms ?? 650;
    setEstado((e) => ({ ...e, trabajos: [{ id, tipo, cliente: op.cliente, pasos, paso: 0, estado: "en_cola" as const, inicio: new Date().toISOString() }, ...e.trabajos].slice(0, 40) }));
    let paso = 0;
    const avanzar = () => {
      paso += 1;
      const fin = paso >= pasos.length;
      const fallo = fin && op.falla;
      setEstado((e) => ({
        ...e,
        trabajos: e.trabajos.map((t) => (t.id === id ? { ...t, paso: Math.min(paso, pasos.length), estado: fin ? (fallo ? "fallido" : "completado") : "ejecutando", detalle: fallo ? op.falla : t.detalle } : t)),
      }));
      if (!fin) setTimeout(avanzar, ms + Math.round(Math.random() * 250));
      else op.alTerminar?.();
    };
    setTimeout(avanzar, 350);
    return id;
  }, []);

  const periodoDe = useCallback((e: EstadoDemo, clienteId: string, periodo = PERIODO_ACTUAL) => e.periodos[clavePeriodo(clienteId, periodo)] ?? periodoVacio(), []);

  const mutarPeriodo = useCallback(
    (clienteId: string, f: (p: EstadoPeriodo) => EstadoPeriodo) =>
      setEstado((e) => ({ ...e, periodos: { ...e.periodos, [clavePeriodo(clienteId, PERIODO_ACTUAL)]: f(periodoDe(e, clienteId)) } })),
    [periodoDe],
  );

  const nombreCliente = (id: string) => ref.current.clientes.find((c) => c.id === id)?.razonSocial ?? id;

  const acciones: Acciones = useMemo(
    () => ({
      estado,
      usuario,
      ingresar(usuarioId) {
        setEstado((e) => ({ ...e, usuarioId }));
        setTimeout(() => auditar("Inicio de sesión", "Ingreso a la demo"), 0);
      },
      salir() {
        auditar("Cierre de sesión", "Salida de la demo");
        setEstado((e) => ({ ...e, usuarioId: null }));
      },
      reiniciar() {
        try {
          localStorage.removeItem(CLAVE);
        } catch {
          /* nada */
        }
        setEstado({ ...inicial(), usuarioId: ref.current.usuarioId });
      },
      periodo: (clienteId, periodo) => periodoDe(estado, clienteId, periodo),
      cliente: (id) => estado.clientes.find((c) => c.id === id),
      razonSocial(ruc) {
        return (
          PROVEEDORES.find((p) => p.ruc === ruc)?.razonSocial ??
          estado.proveedoresExtra.find((p) => p.ruc === ruc)?.razonSocial ??
          PADRON_RUC[ruc]?.razonSocial ??
          estado.clientes.find((c) => c.ruc === ruc)?.razonSocial ??
          `PROVEEDOR ${ruc}`
        );
      },
      auditar,
      notificar,
      marcarNotificacionesLeidas: () => setEstado((e) => ({ ...e, notificaciones: e.notificaciones.map((n) => ({ ...n, leida: true })) })),
      trabajo,
      crearCliente(c) {
        const nuevo: Cliente = { ...c, id: nuevoId("c") };
        setEstado((e) => ({ ...e, clientes: [...e.clientes, nuevo] }));
        auditar("Alta de cliente", `${c.ruc} · ${c.razonSocial}`, c.razonSocial);
        return nuevo;
      },
      actualizarCliente(id, cambios) {
        setEstado((e) => ({ ...e, clientes: e.clientes.map((c) => (c.id === id ? { ...c, ...cambios } : c)) }));
      },
      consultarRuc(ruc) {
        return new Promise((ok) => setTimeout(() => ok(PADRON_RUC[ruc] ?? null), 700));
      },
      descargarPropuesta(clienteId, libro) {
        const c = nombreCliente(clienteId);
        const pasos =
          libro === "compras"
            ? ["Descifrando credenciales SIRE en el worker", "Autenticando en la API SIRE (token OAuth)", "Solicitando ticket de la propuesta RCE", "Esperando que SUNAT procese el ticket", "Descargando y leyendo la propuesta", "Obteniendo XML de los comprobantes (MockXmlProvider)", "Evaluando el motor de reglas"]
            : ["Descifrando credenciales SIRE en el worker", "Autenticando en la API SIRE (token OAuth)", "Solicitando ticket de la propuesta RVIE", "Descargando y leyendo la propuesta", "Auditando correlatividad"];
        trabajo(`Descarga propuesta ${libro === "compras" ? "RCE (compras)" : "RVIE (ventas)"}`, pasos, {
          cliente: c,
          ms: 600,
          alTerminar: () => {
            const prop = propuestaDe(clienteId);
            mutarPeriodo(clienteId, (p) => {
              if (libro === "ventas") return { ...p, ventasCargadas: true, ventas: prop.ventas };
              const xmlEstado: EstadoPeriodo["xmlEstado"] = {};
              for (const f of prop.compras) xmlEstado[f.id] = prop.xml[f.id] ? "disponible" : "no_encontrado";
              return { ...p, comprasCargadas: true, compras: prop.compras, comprasOriginales: structuredClone(prop.compras), xml: prop.xml, xmlEstado, resueltos: [], deshacer: [], rehacer: [] };
            });
            auditar(`Descarga propuesta ${libro}`, `Periodo ${PERIODO_ACTUAL}`, c);
            notificar(`Propuesta de ${libro} descargada: ${c}`, "exito", `#/clientes/${clienteId}/${libro}`);
          },
        });
      },
      cambiarCompras(clienteId, f, descripcion, extra) {
        mutarPeriodo(clienteId, (p) => {
          const nuevas = f(p.compras);
          return { ...p, compras: nuevas, deshacer: [...p.deshacer, p.compras].slice(-50), rehacer: [], ...(extra ? extra(p) : {}) };
        });
        auditar("Cambio en compras", descripcion, nombreCliente(clienteId));
      },
      deshacer(clienteId) {
        mutarPeriodo(clienteId, (p) => {
          const anterior = p.deshacer.at(-1);
          if (!anterior) return p;
          return { ...p, compras: anterior, deshacer: p.deshacer.slice(0, -1), rehacer: [...p.rehacer, p.compras] };
        });
      },
      rehacer(clienteId) {
        mutarPeriodo(clienteId, (p) => {
          const sig = p.rehacer.at(-1);
          if (!sig) return p;
          return { ...p, compras: sig, rehacer: p.rehacer.slice(0, -1), deshacer: [...p.deshacer, p.compras] };
        });
      },
      resolver(clienteId, claves) {
        mutarPeriodo(clienteId, (p) => ({ ...p, resueltos: [...new Set([...p.resueltos, ...claves])] }));
      },
      agregarVenta(clienteId, v) {
        mutarPeriodo(clienteId, (p) => ({ ...p, ventas: [...p.ventas, v] }));
        auditar("Venta agregada", `${v.tipo} ${v.serie}-${v.numero} · total ${v.total}`, nombreCliente(clienteId));
      },
      reintentarXml(clienteId, filaId) {
        mutarPeriodo(clienteId, (p) => ({ ...p, xmlEstado: { ...p.xmlEstado, [filaId]: "pendiente" } }));
        trabajo("Descarga de XML", ["Consultando comprobante en SOL (consulta de emitidos por sistema propio)", "Descargando XML", "Guardando XML (una vez por comprobante)"], {
          cliente: nombreCliente(clienteId),
          ms: 500,
          alTerminar: () => {
            const p = periodoDe(ref.current, clienteId);
            const fila = p.compras.find((f) => f.id === filaId);
            if (!fila) return;
            const m = fila.montos;
            const xml: XmlDemo = propuestaDe(clienteId).xmlReintento[filaId] ?? {
              moneda: "PEN",
              items: [{ descripcion: "Bienes y servicios (XML simulado desde el SIRE)", cantidad: "1", unidad: "UND", precioUnitario: m.biDg, valor: m.biDg, afectacion: "Gravado", igv: m.igvDg, isc: "0.00", icbper: "0.00" }],
              gravado: m.biDg,
              igv: m.igvDg,
              noGravado: m.noGravado,
              isc: m.isc,
              icbper: m.icbper,
              total: m.total,
            };
            mutarPeriodo(clienteId, (q) => ({ ...q, xml: { ...q.xml, [filaId]: xml }, xmlEstado: { ...q.xmlEstado, [filaId]: "disponible" } }));
          },
        });
      },
      subirXml(clienteId, filaId, xml) {
        mutarPeriodo(clienteId, (p) => ({ ...p, xml: { ...p.xml, [filaId]: xml }, xmlEstado: { ...p.xmlEstado, [filaId]: "disponible" } }));
        auditar("XML subido manualmente", filaId, nombreCliente(clienteId));
      },
      marcarRevisado(clienteId, revisado) {
        mutarPeriodo(clienteId, (p) => ({ ...p, revisado }));
        auditar(revisado ? "Periodo marcado como revisado" : "Periodo reabierto", `Compras ${PERIODO_ACTUAL}`, nombreCliente(clienteId));
      },
      guardarVersion(clienteId, v) {
        const p = periodoDe(ref.current, clienteId);
        const version: VersionArchivo = { ...v, version: p.versiones.length + 1 };
        mutarPeriodo(clienteId, (q) => ({ ...q, versiones: [...q.versiones, version] }));
        auditar("Archivo generado", `${v.nombreZip} · v${version.version} · SHA-256 ${v.sha256Zip.slice(0, 12)}…`, nombreCliente(clienteId));
        return version;
      },
      enviarSunat(clienteId, version) {
        const ticket = String(20261100000 + Math.floor(Math.random() * 99999));
        const poner = (estadoT: NonNullable<VersionArchivo["ticket"]>["estado"]) =>
          mutarPeriodo(clienteId, (p) => ({ ...p, versiones: p.versiones.map((v) => (v.version === version ? { ...v, ticket: { numero: ticket, estado: estadoT } } : v)) }));
        poner("enviado");
        trabajo("Envío a SUNAT (API SIRE)", ["Subiendo ZIP a la API SIRE", `Ticket ${ticket} recibido`, "Consultando estado del ticket", "SUNAT procesando el archivo", "Estado final: Procesado"], {
          cliente: nombreCliente(clienteId),
          ms: 900,
          alTerminar: () => {
            poner("procesado");
            notificar(`Ticket ${ticket} procesado sin errores · ${nombreCliente(clienteId)}`, "exito", `#/clientes/${clienteId}/generar`);
          },
        });
        auditar("Envío a SUNAT", `Versión ${version} · ticket ${ticket}`, nombreCliente(clienteId));
      },
      recordarProveedor(clienteId, ruc, destino) {
        setEstado((e) => {
          const lista = e.aprendidas[clienteId] ?? [];
          const existe = lista.find((a) => a.proveedorRuc === ruc);
          const nueva = existe ? lista.map((a) => (a.proveedorRuc === ruc ? { ...a, destino, activa: true } : a)) : [...lista, { proveedorRuc: ruc, destino, aplicada: 0, aceptada: 0, activa: true }];
          return { ...e, aprendidas: { ...e.aprendidas, [clienteId]: nueva } };
        });
        auditar("Regla aprendida", `${ruc} → ${destino}`, nombreCliente(clienteId));
      },
      actualizarAprendida(clienteId, ruc, cambios) {
        setEstado((e) => {
          const lista = e.aprendidas[clienteId] ?? [];
          return { ...e, aprendidas: { ...e.aprendidas, [clienteId]: cambios === null ? lista.filter((a) => a.proveedorRuc !== ruc) : lista.map((a) => (a.proveedorRuc === ruc ? { ...a, ...cambios } : a)) } };
        });
      },
      revisarBuzones() {
        trabajo("Revisión de buzones SOL", ["Descifrando credenciales SOL", "Ingresando a SOL de cada cliente activo", "Leyendo bandejas (sin marcar como leído en SUNAT)", "Clasificando mensajes críticos"], {
          ms: 700,
          alTerminar: () => {
            const m: Mensaje = { id: nuevoId("m"), clienteId: "c1", buzon: "SOL", asunto: "Orden de Pago N.° 023-001-DEMO-NUEVA", tipo: "Notificación", fecha: new Date().toISOString(), leidoSunat: false, critico: false, contenido: "Se emite orden de pago por el saldo de IGV del periodo 2026-09 (dato ficticio)." };
            setEstado((e) => (e.mensajes.some((x) => x.asunto === m.asunto) ? e : { ...e, mensajes: [m, ...e.mensajes] }));
            notificar("Buzones revisados: 1 mensaje nuevo", "info", "#/buzones");
          },
        });
      },
      atenderMensaje(id, comentario) {
        setEstado((e) => ({ ...e, mensajes: e.mensajes.map((m) => (m.id === id ? { ...m, atendido: { usuario: nombreUsuario, fecha: new Date().toISOString(), comentario } } : m)) }));
        auditar("Mensaje de buzón atendido", comentario || id);
      },
      abrirMensaje(id) {
        setEstado((e) => ({ ...e, mensajes: e.mensajes.map((m) => (m.id === id ? { ...m, leidoSunat: true } : m)) }));
      },
      editarMesProrrata(clienteId, periodo, gravadas, noGravadas) {
        setEstado((e) => ({
          ...e,
          prorrata: { ...e.prorrata, [clienteId]: (e.prorrata[clienteId] ?? []).map((m) => (m.periodo === periodo ? { ...m, gravadas, noGravadas, origen: "Manual" } : m)) },
        }));
        auditar("Prorrata: mes editado", `${periodo}`, nombreCliente(clienteId));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estado, usuario],
  );

  return <Contexto.Provider value={acciones}>{children}</Contexto.Provider>;
}

export function useDemo(): Acciones {
  const c = useContext(Contexto);
  if (!c) throw new Error("useDemo fuera del proveedor");
  return c;
}

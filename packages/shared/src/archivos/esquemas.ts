import { esquemaPendiente } from "./pendiente.js";

// Stub de T2 (012b): cuerpo de `POST …/archivos` (plan, Contratos: HTTP). Lo implementa T8.
export const generarArchivoSchema = esquemaPendiente<{ estadoVisto: "abierto" | "revisado"; huella: string }>();
export type GenerarArchivo = { estadoVisto: "abierto" | "revisado"; huella: string };

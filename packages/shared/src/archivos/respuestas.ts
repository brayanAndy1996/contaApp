import { esquemaPendiente } from "./pendiente.js";

// Stub de T2 (012b): DTOs de respuesta del previo y de las versiones. Los implementa T8.
export const previoArchivoSchema = esquemaPendiente<Record<string, unknown>>();
export type PrevioArchivoDto = Record<string, unknown>;
export const versionArchivoSchema = esquemaPendiente<Record<string, unknown>>();
export type VersionArchivoDto = Record<string, unknown>;

// Los fixtures XML se importan con `?raw` (Vite/Vitest): domain no puede leer archivos (sin `node:fs`).
declare module "*.xml?raw" {
  const contenido: string;
  export default contenido;
}

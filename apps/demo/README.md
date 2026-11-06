# ContApp · Demo navegable

Prototipo del producto final de ContApp con **datos 100 % ficticios**. Simula los procesos principales de punta a punta en el navegador, sin backend ni SUNAT:

1. Acceso por rol (Administrador, Contador, Asistente) y plan con límite de RUC.
2. Clientes: alta con consulta RUC, importación CSV con vista previa y cupo, y credenciales de solo escritura con verificación en segundo plano.
3. Ventas (RVIE): descarga de la propuesta, auditoría de correlatividad (falta la B001-291), resumen por tipo y agregar una venta faltante.
4. Compras (RCE):
   - descarga de la propuesta, XML simulados, grilla editable tipo Excel con cuadre en vivo;
   - clasificación DG/DGNG/DNG individual y masiva, exclusiones, deshacer/rehacer, compras con y sin IGV;
   - resumen por casillero y exportación.
5. Motor de correcciones (**el real**, `packages/domain`): R-ISC, R-MIX, R-RED, R-NEW y R-GP. Ninguna sugerencia se aplica sin aceptarla.
6. Lupa 🔍:
   - cabecera, ítems del XML en lenguaje humano y comparación SIRE vs XML;
   - fila corregida propuesta e historial;
   - ver, descargar o subir el XML, PDF simulado y navegación ← → Enter.
7. Generación:
   - resumen de cambios (`resumirCambios`) y prevalidación SUNAT (`prevalidar`), que bloquea si algo no cuadra;
   - TXT (`generarTxt`, formato provisional), ZIP con SHA-256 y versiones;
   - envío simulado con ticket (R2).
8. R2 (vista previa): R-HIS según historial, reglas aprendidas, buzones SOL, prorrata e IGV estimado.
9. Auditoría, notificaciones y panel de trabajos (lo que hará el worker con BullMQ).

## Qué es real y qué es simulado

- **Real**: la demo importa el código fuente de `packages/domain` y `packages/shared` sin cambios (alias en `vite.config.ts`). El dinero se maneja con `Money`/`decimal.js`.
- **Simulado**: API SIRE, SOL, XML, cola y base de datos. El estado vive en `localStorage` y el botón «Reiniciar demo» lo borra.

## Comandos

```bash
pnpm install --filter "@contapp/demo..."
pnpm --filter @contapp/demo dev      # http://localhost:5173
pnpm --filter @contapp/demo build    # apps/demo/dist
```

El despliegue en Netlify lo define `netlify.toml` en la raíz de esta rama.

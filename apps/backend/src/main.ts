import { crearApp } from "./app.js";

const app = await crearApp();
// Cierre ordenado con SIGTERM/SIGINT (H-008-1b-9): onModuleDestroy termina los streams SSE y el suscriptor Redis
// antes de cerrar el servidor HTTP; luego sale con código 0.
app.enableShutdownHooks([], { useProcessExit: true });
await app.listen(process.env.PORT ?? 4000);

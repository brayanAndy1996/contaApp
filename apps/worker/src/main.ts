import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  // useProcessExit: sale con código 0 tras el cierre (sin re-lanzar la señal; en Windows daba 1).
  app.enableShutdownHooks([], { useProcessExit: true });
}
await bootstrap();

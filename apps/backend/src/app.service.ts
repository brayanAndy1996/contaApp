import { Injectable } from '@nestjs/common';
import { saludoSchema } from '@contapp/shared';

@Injectable()
export class AppService {
  getHello(): string {
    return saludoSchema.parse({ mensaje: 'Hello World!' }).mensaje;
  }
}

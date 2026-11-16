import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: the Paystack webhook signature is checked against the exact bytes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.set('trust proxy', 1);
  app.use(helmet());
  app.useBodyParser('json', { limit: '256kb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4500);
  await app.listen(port);
  Logger.log(`alcance-pay listening on port ${port}`, 'Bootstrap');
}

void bootstrap();

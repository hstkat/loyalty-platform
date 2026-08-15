import 'reflect-metadata';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import express from 'express';
import { AppModule } from '../src/app.module';
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter';

// Vercel serverless functions are re-invoked per request but the
// container is reused between invocations — caching the Nest app
// across calls avoids re-bootstrapping (and re-connecting Prisma) on
// every single request.
let cachedApp: INestApplication | null = null;

async function getApp(): Promise<INestApplication> {
  if (cachedApp) return cachedApp;

  const expressInstance = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressInstance));

  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new PrismaExceptionFilter());

  await app.init();
  cachedApp = app;
  return app;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await getApp();
  const instance = app.getHttpAdapter().getInstance();
  instance(req, res);
}

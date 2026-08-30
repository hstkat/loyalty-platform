import 'reflect-metadata';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import express from 'express';
import path from 'path';
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

  // De backoffice-pagina's (dashboard.html, financieel.html, etc.) zijn
  // gewone statische HTML-bestanden — GEEN NestJS-routes. Ze worden hier
  // rechtstreeks via Express geserveerd, vóórdat NestJS zelf routing
  // registreert, zodat een aanvraag als /backoffice/dashboard.html nooit
  // bij NestJS' eigen 404-afhandeling terechtkomt. `includeFiles` in
  // vercel.json zorgt dat de map ook daadwerkelijk in de serverless
  // functie terechtkomt (Vercel bundelt normaliter alleen bestanden die
  // via require/import bereikbaar zijn, en deze HTML-bestanden worden
  // nergens geïmporteerd).
  expressInstance.use('/backoffice', express.static(path.join(process.cwd(), 'backoffice')));
  expressInstance.get(['/backoffice', '/backoffice/'], (_req, res) => res.redirect('/backoffice/dashboard.html'));

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

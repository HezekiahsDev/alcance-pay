import { Injectable } from '@nestjs/common';
import { App } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { sha256 } from '../common/crypto';

const CACHE_MS = 60_000;

/** Looks up registered apps by API key and by payment reference prefix. */
@Injectable()
export class AppsService {
  private byKey = new Map<string, { app: App; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async findByApiKey(apiKey: string): Promise<App | null> {
    const hash = sha256(apiKey);
    const cached = this.byKey.get(hash);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.app;
    const app = await this.prisma.app.findUnique({
      where: { apiKeyHash: hash },
    });
    if (app?.active) this.byKey.set(hash, { app, at: Date.now() });
    return app?.active ? app : null;
  }

  findById(id: string) {
    return this.prisma.app.findUnique({ where: { id } });
  }

  /** The active app whose reference prefix matches (longest prefix wins). */
  async findByReference(reference: string): Promise<App | null> {
    const apps = await this.prisma.app.findMany({ where: { active: true } });
    return matchPrefix(apps, reference);
  }
}

export function matchPrefix<T extends { referencePrefixes: string[] }>(
  apps: T[],
  reference: string,
): T | null {
  let best: { app: T; len: number } | null = null;
  for (const app of apps) {
    for (const prefix of app.referencePrefixes) {
      if (
        prefix &&
        reference.startsWith(prefix) &&
        (!best || prefix.length > best.len)
      ) {
        best = { app, len: prefix.length };
      }
    }
  }
  return best?.app ?? null;
}

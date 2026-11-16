import { Injectable, Logger } from '@nestjs/common';
import { App, Prisma, WebhookEvent } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AppsService } from '../apps/apps.service';
import { PaymentsService } from '../payments/payments.service';
import { PaystackTransaction } from '../paystack/paystack.client';
import { DeliveryService } from './delivery.service';

interface PaystackEvent {
  event?: string;
  data?: PaystackTransaction & {
    id?: number | string;
    reference?: string;
    transfer_code?: string;
    metadata?: unknown;
  };
}

/**
 * The one Paystack webhook for every Alcance app: records each event once,
 * updates payments started through this service, and routes the event to
 * the app that owns it.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: AppsService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
  ) {}

  async ingest(
    rawBody: string,
    signature: string,
  ): Promise<{ duplicate: boolean }> {
    const body = JSON.parse(rawBody) as PaystackEvent;
    const event = body.event ?? 'unknown';
    const data = body.data ?? {};
    const reference = data.reference ?? null;
    const dedupeKey = `${event}:${data.id ?? reference ?? data.transfer_code ?? rawBody.length}`;

    let stored: WebhookEvent;
    try {
      stored = await this.prisma.webhookEvent.create({
        data: {
          dedupeKey,
          event,
          reference,
          payload: body as Prisma.InputJsonValue,
          rawBody,
          signature,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        return { duplicate: true };
      throw err;
    }

    try {
      await this.process(stored, body, reference);
    } catch (err) {
      // Forget the event so Paystack's retry is processed instead of being
      // dropped as a duplicate.
      await this.prisma.webhookEvent
        .delete({ where: { id: stored.id } })
        .catch(() => undefined);
      throw err;
    }
    return { duplicate: false };
  }

  private async process(
    stored: WebhookEvent,
    body: PaystackEvent,
    reference: string | null,
  ) {
    const app = await this.route(body, reference);
    if (!app) {
      this.logger.warn(
        `Unrouted Paystack event ${stored.event} (reference ${reference ?? 'none'})`,
      );
      return;
    }
    await this.prisma.webhookEvent.update({
      where: { id: stored.id },
      data: { appId: app.id },
    });

    // Keep our own payment record current for charge events.
    if (reference && stored.event.startsWith('charge.')) {
      const payment = await this.prisma.payment.findUnique({
        where: { reference },
      });
      if (payment) await this.payments.applyResult(payment, body.data ?? {});
    }
    // ... and transfer records for payout events.
    if (
      reference &&
      stored.event.startsWith('transfer.') &&
      body.data?.status
    ) {
      await this.prisma.transfer.updateMany({
        where: { reference },
        data: { status: body.data.status },
      });
    }

    if (app.webhookUrl) await this.delivery.schedule(stored, app);
  }

  /**
   * Owner of an event: the app that started the payment here, else the app
   * named in metadata.app, else the app whose reference prefix matches
   * (e.g. dali's own DALI-… checkouts and transfers).
   */
  private async route(
    body: PaystackEvent,
    reference: string | null,
  ): Promise<App | null> {
    if (reference) {
      const payment = await this.prisma.payment.findUnique({
        where: { reference },
        include: { app: true },
      });
      if (payment) return payment.app;
      const transfer = await this.prisma.transfer.findUnique({
        where: { reference },
        include: { app: true },
      });
      if (transfer) return transfer.app;
    }
    const metaApp = metadataApp(body.data?.metadata);
    if (metaApp) {
      const app = await this.apps.findById(metaApp);
      if (app?.active) return app;
    }
    return reference ? this.apps.findByReference(reference) : null;
  }
}

/** metadata.app from a Paystack payload (metadata may be an object or JSON string). */
export function metadataApp(metadata: unknown): string | null {
  let m = metadata;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  const app = (m as { app?: unknown } | null)?.app;
  return typeof app === 'string' && app ? app : null;
}

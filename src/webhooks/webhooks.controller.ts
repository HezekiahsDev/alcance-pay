import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaystackClient } from '../paystack/paystack.client';
import { WebhooksService } from './webhooks.service';

/** Set this URL as the webhook on the Alcance Paystack account. */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(
    private readonly paystack: PaystackClient,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('paystack')
  @HttpCode(200)
  async paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string | undefined,
  ) {
    const raw = req.rawBody;
    if (!raw || !this.paystack.verifySignature(raw, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }
    // Errors propagate as 5xx so Paystack retries; duplicates are ignored.
    const result = await this.webhooks.ingest(raw.toString('utf8'), signature!);
    return { received: true, ...result };
  }
}

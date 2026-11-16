import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { App } from '@prisma/client';
import { AppAuthGuard, CurrentApp } from '../apps/app-auth.guard';
import { PaymentsService } from './payments.service';
import { ChargeCardDto, CreateCheckoutDto } from './payments.dto';

/** App-facing API. Every call is authenticated with the app's API key. */
@Controller('v1')
@UseGuards(AppAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Start a checkout; send the customer to `authorizationUrl`. */
  @Post('payments')
  create(@CurrentApp() app: App, @Body() dto: CreateCheckoutDto) {
    return this.payments.createCheckout(app, dto);
  }

  /** Latest status from Paystack (call after the customer returns). */
  @Get('payments/:reference/verify')
  verify(@CurrentApp() app: App, @Param('reference') reference: string) {
    return this.payments.verify(app, reference);
  }

  /** Stored status, without calling Paystack. */
  @Get('payments/:reference')
  get(@CurrentApp() app: App, @Param('reference') reference: string) {
    return this.payments.get(app, reference);
  }

  /** Charge a saved card (e.g. a subscription renewal). */
  @Post('charges')
  charge(@CurrentApp() app: App, @Body() dto: ChargeCardDto) {
    return this.payments.chargeCard(app, dto);
  }

  @Get('cards')
  cards(@CurrentApp() app: App, @Query('customerId') customerId: string) {
    return this.payments.listCards(app, String(customerId ?? ''));
  }

  @Delete('cards/:id')
  removeCard(
    @CurrentApp() app: App,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payments.removeCard(app, id);
  }
}

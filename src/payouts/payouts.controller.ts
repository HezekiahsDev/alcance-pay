import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { App } from '@prisma/client';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { AppAuthGuard, CurrentApp } from '../apps/app-auth.guard';
import { PayoutsService } from './payouts.service';

const ACCOUNT = /^\d{10}$/;
const BANK = /^[A-Za-z0-9-]{2,20}$/;
const REFERENCE = /^[A-Za-z0-9._=-]{6,100}$/;

export class ResolveQuery {
  @Matches(ACCOUNT, { message: 'accountNumber must be 10 digits' })
  accountNumber: string;

  @Matches(BANK, { message: 'bankCode is invalid' })
  bankCode: string;
}

export class RecipientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @Matches(ACCOUNT, { message: 'accountNumber must be 10 digits' })
  accountNumber: string;

  @Matches(BANK, { message: 'bankCode is invalid' })
  bankCode: string;
}

export class TransferDto {
  /** Amount in kobo. */
  @IsInt()
  @Min(100)
  amount: number;

  @IsString()
  @Matches(/^RCP_[A-Za-z0-9]+$/, { message: 'recipientCode is invalid' })
  recipientCode: string;

  @Matches(REFERENCE, { message: 'reference: 6–100 letters, digits, . _ = -' })
  reference: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;
}

/** Bank lookups and payouts. Authenticated with the app's API key. */
@Controller('v1')
@UseGuards(AppAuthGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  /** Banks that can receive payouts (NGN). */
  @Get('banks')
  banks() {
    return this.payouts.banks();
  }

  /** Account holder's name for an account number (never trust a client name). */
  @Get('banks/resolve')
  resolve(@Query() q: ResolveQuery) {
    return this.payouts.resolve(q.accountNumber, q.bankCode);
  }

  @Post('transfers/recipients')
  recipient(@Body() dto: RecipientDto) {
    return this.payouts.createRecipient(dto);
  }

  /** Start a payout. Same reference again = the same payout, never a second. */
  @Post('transfers')
  transfer(@CurrentApp() app: App, @Body() dto: TransferDto) {
    return this.payouts.transfer(app, dto);
  }

  /** success | pending | failed | reversed | not_found (from Paystack). */
  @Get('transfers/:reference')
  status(@CurrentApp() app: App, @Param('reference') reference: string) {
    return this.payouts.status(app, reference);
  }
}

/**
 * Manage the apps that use alcance-pay.
 *
 *   pnpm apps list
 *   pnpm apps create <id> --name "Grow" [--webhook-url URL] [--mode ALCANCE|PAYSTACK]
 *                         [--prefix GROW-]... [--origin https://grow.alcance.ng]...
 *                         [--subaccount ACCT_xxx]
 *   pnpm apps update <id> [same flags; --prefix/--origin replace the lists]
 *   pnpm apps rotate-key <id>       new API key (old one stops working)
 *   pnpm apps rotate-secret <id>    new webhook signing secret
 *   pnpm apps disable <id> | enable <id>
 *
 * New API keys and webhook secrets are printed once; only the key's hash is
 * stored. Uses DATABASE_URL from the environment.
 */
import { ForwardMode, PrismaClient } from '@prisma/client';
import { newApiKey, newWebhookSecret, sha256 } from '../src/common/crypto';

type Flags = {
  name?: string;
  webhookUrl?: string;
  mode?: ForwardMode;
  prefixes?: string[];
  origins?: string[];
  subaccount?: string;
};

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    switch (flag) {
      case '--name':
        flags.name = value;
        break;
      case '--webhook-url':
        flags.webhookUrl = new URL(value).toString();
        break;
      case '--mode':
        if (value !== 'ALCANCE' && value !== 'PAYSTACK')
          throw new Error('--mode must be ALCANCE or PAYSTACK');
        flags.mode = value;
        break;
      case '--prefix':
        (flags.prefixes ??= []).push(value);
        break;
      case '--origin':
        (flags.origins ??= []).push(new URL(value).origin);
        break;
      case '--subaccount':
        flags.subaccount = value;
        break;
      default:
        throw new Error(`Unknown flag ${flag}`);
    }
  }
  return flags;
}

const data = (f: Flags) => ({
  ...(f.name !== undefined ? { name: f.name } : {}),
  ...(f.webhookUrl !== undefined ? { webhookUrl: f.webhookUrl } : {}),
  ...(f.mode !== undefined ? { forwardMode: f.mode } : {}),
  ...(f.prefixes !== undefined ? { referencePrefixes: f.prefixes } : {}),
  ...(f.origins !== undefined ? { callbackOrigins: f.origins } : {}),
  ...(f.subaccount !== undefined ? { subaccountCode: f.subaccount } : {}),
});

async function main() {
  const [command, id, ...rest] = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    switch (command) {
      case 'list': {
        const apps = await prisma.app.findMany({ orderBy: { id: 'asc' } });
        console.table(
          apps.map((a) => ({
            id: a.id,
            name: a.name,
            active: a.active,
            mode: a.forwardMode,
            webhookUrl: a.webhookUrl,
            prefixes: a.referencePrefixes.join(' '),
            origins: a.callbackOrigins.join(' '),
            subaccount: a.subaccountCode,
            key: `${a.apiKeyPrefix}…`,
          })),
        );
        break;
      }
      case 'create': {
        if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id))
          throw new Error('id: lowercase letters, digits, dashes');
        const flags = parseFlags(rest);
        const apiKey = newApiKey(id);
        const webhookSecret = newWebhookSecret();
        await prisma.app.create({
          data: {
            id,
            name: flags.name ?? id,
            apiKeyHash: sha256(apiKey),
            apiKeyPrefix: apiKey.slice(0, 12),
            webhookSecret,
            ...data(flags),
          },
        });
        console.log(
          `Created app "${id}". Store these now; they are not shown again:`,
        );
        console.log(`  API key:        ${apiKey}`);
        console.log(`  Webhook secret: ${webhookSecret}`);
        break;
      }
      case 'update':
        await prisma.app.update({
          where: { id },
          data: data(parseFlags(rest)),
        });
        console.log(`Updated app "${id}".`);
        break;
      case 'rotate-key': {
        const apiKey = newApiKey(id);
        await prisma.app.update({
          where: { id },
          data: {
            apiKeyHash: sha256(apiKey),
            apiKeyPrefix: apiKey.slice(0, 12),
          },
        });
        console.log(
          `New API key for "${id}" (the old key stops working within a minute):\n  ${apiKey}`,
        );
        break;
      }
      case 'rotate-secret': {
        const webhookSecret = newWebhookSecret();
        await prisma.app.update({ where: { id }, data: { webhookSecret } });
        console.log(`New webhook secret for "${id}":\n  ${webhookSecret}`);
        break;
      }
      case 'disable':
      case 'enable':
        await prisma.app.update({
          where: { id },
          data: { active: command === 'enable' },
        });
        console.log(`App "${id}" ${command}d.`);
        break;
      default:
        console.log(
          'Usage: pnpm apps list | create <id> | update <id> | rotate-key <id> | rotate-secret <id> | enable|disable <id>',
        );
        process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

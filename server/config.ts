import { z } from 'zod';

const schema = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().default(3001),

    /** Where chart candles and quotes come from. */
    MARKET_DATA: z.enum(['demo', 'oanda', 'metaapi']).default('demo'),
    /** Where orders go. `paper` keeps them in memory and never touches a broker. */
    EXECUTION: z.enum(['paper', 'oanda', 'metaapi']).default('paper'),

    OANDA_TOKEN: z.string().optional(),
    OANDA_ACCOUNT_ID: z.string().optional(),
    OANDA_ENV: z.enum(['practice', 'live']).default('practice'),
    OANDA_UNITS_PER_LOT: z.coerce.number().positive().default(100_000),

    METAAPI_TOKEN: z.string().optional(),
    METAAPI_ACCOUNT_ID: z.string().optional(),
    /** Appended to symbols for brokers that use suffixes, e.g. `.m` turns EURUSD into EURUSD.m. */
    METAAPI_SYMBOL_SUFFIX: z.string().default(''),
    /** Set to true when the MetaApi account is a live (real money) account. */
    METAAPI_LIVE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    const uses = (name: string) => env.MARKET_DATA === name || env.EXECUTION === name;
    const need = (key: keyof typeof env, provider: string) => {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `required when using ${provider}` });
    };
    if (uses('oanda')) {
      need('OANDA_TOKEN', 'oanda');
      need('OANDA_ACCOUNT_ID', 'oanda');
    }
    if (uses('metaapi')) {
      need('METAAPI_TOKEN', 'metaapi');
      need('METAAPI_ACCOUNT_ID', 'metaapi');
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (see .env.example):\n${issues}`);
  }
  return parsed.data;
}

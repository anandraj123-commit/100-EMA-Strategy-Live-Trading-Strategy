import { config } from './lib/config';
console.log('--- ENV CHECK ---');
console.log('Environment:', config.env);
console.log('Symbol:', config.symbol);
console.log('API key present:', Boolean(config.apiKey));
console.log('API secret present:', Boolean(config.apiSecret));
if (!config.apiKey || !config.apiSecret) {
  process.exitCode = 1;
  console.error('Missing credentials. Make sure .env.local is in:', process.cwd());
} else {
  console.log('Credentials loaded successfully.');
}

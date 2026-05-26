import dotenv from 'dotenv';
dotenv.config();

const environmentError = (name: string) => new Error(`Environment error: ${name} not set. Check .env file`);

if (!process.env.INFURA_URL) {
  throw environmentError('INFURA_URL');
}

if (!process.env.INFURA_WS) {
  throw environmentError('INFURA_WS');
}

if (!process.env.BLOCK_TOLERANCE) {
  throw environmentError('BLOCK_TOLERANCE');
}

export default {
  INFURA_URL: process.env.INFURA_URL || '',
  INFURA_WS: process.env.INFURA_WS || '',
  BLOCK_TOLERANCE: +process.env.BLOCK_TOLERANCE || '',
  
  /* Backrun execution configuration */
  BOT_PRIVATE_KEY: process.env.BOT_PRIVATE_KEY || '',
  BOT_ADDRESS: process.env.BOT_ADDRESS || '',
  DRY_RUN_MODE: process.env.DRY_RUN_MODE === 'true' || true, // Default to dry-run
  
  /* Aave configuration */
  AAVE_POOL_ADDRESS: process.env.AAVE_POOL_ADDRESS || '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', // Ethereum mainnet
  AAVE_DATA_PROVIDER: process.env.AAVE_DATA_PROVIDER || '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d', // Ethereum mainnet
  
  /* HTTP config */
  httpConfig: {
    headers: {
      'Content-Type': 'application/json',
    },
  },
};

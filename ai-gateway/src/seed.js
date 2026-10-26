import { seed } from './search.js';

const n = await seed();
console.log(`seeded ${n} products`);
process.exit(0);

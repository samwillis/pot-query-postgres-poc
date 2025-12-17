import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 120000, // 2 minutes for container startup
    hookTimeout: 120000,
    pool: 'forks', // Use forks for better isolation with containers
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to avoid container conflicts
      },
    },
  },
});

#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerTools } from './tools.js';
import { YazioClient } from './yazio.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const username = process.env.YAZIO_USERNAME ?? process.env.YAZIO_EMAIL;
const password = process.env.YAZIO_PASSWORD;
if (!username || !password) {
  console.error('YAZIO_USERNAME and YAZIO_PASSWORD environment variables are required.');
  process.exit(1);
}

// Authentication is lazy: the first tool call logs in, and login errors surface as tool errors.
const yazio = new YazioClient({ username, password, apiVersion: process.env.YAZIO_API_VERSION });

const server = new McpServer(
  { name: 'yazio-mcp', version },
  {
    instructions:
      "Access to the user's YAZIO nutrition diary. Dates are local days (YYYY-MM-DD) and default to today. " +
      'To log food: search_products, optionally get_product for servings, then add_food_entry; use add_quick_entry ' +
      'when only calories/macros are known. To remove something, look up the entry id first (get_diary, get_exercises, get_body_values).',
  }
);
registerTools(server, yazio);

await server.connect(new StdioServerTransport());
console.error(`yazio-mcp ${version} running on stdio`);

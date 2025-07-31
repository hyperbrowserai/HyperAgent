import { HyperAgent, CDPBrowserProvider, CDPBrowserConfig } from './src';
import { ChatOpenAI } from '@langchain/openai';

// Test that types are properly exported and work
const config: CDPBrowserConfig = {
  wsEndpoint: 'ws://localhost:9222/devtools/browser',
  debug: true
};

const cdpProvider = new CDPBrowserProvider(config);

// Test that HyperAgent accepts CDP type
const agent = new HyperAgent({
  browserProvider: 'CDP' as const,
  cdpConfig: config,
  debug: true,
  llm: new ChatOpenAI({ apiKey: 'test-key', modelName: 'gpt-4o' })
});

console.log('✅ All types compile correctly!');
console.log('✅ CDPBrowserProvider instantiated successfully');
console.log('✅ CDPBrowserConfig interface works correctly');
console.log('✅ HyperAgent with CDP browserProvider type works correctly');

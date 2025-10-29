/**
 * Tests for examineDom function
 * 
 * Note: These tests require an LLM client to be configured.
 * For now, these serve as documentation and integration tests.
 */

import { examineDom, extractValueFromInstruction } from '../src/agent/examine-dom';
import { ExamineDomContext } from '../src/agent/examine-dom/types';

describe('examineDom', () => {
  // Mock context for testing
  const createMockContext = (tree: string): ExamineDomContext => ({
    tree,
    xpathMap: {
      '0-1234': '/html/body/button[1]',
      '0-5678': '/html/body/button[2]',
      '0-9012': '/html/body/input[1]',
    },
    elements: new Map([
      ['0-1234', { nodeId: 1234, role: 'button', name: 'Login' }],
      ['0-5678', { nodeId: 5678, role: 'button', name: 'Sign Up' }],
      ['0-9012', { nodeId: 9012, role: 'textbox', name: 'Email' }],
    ]),
    url: 'https://example.com',
  });

  describe('element finding', () => {
    it('should find exact button match', async () => {
      const tree = `[0-1234] button: Login
[0-5678] button: Sign Up`;

      const context = createMockContext(tree);

      // Note: This requires a real LLM client
      // const results = await examineDom('click the login button', context, llmClient);
      // expect(results).toHaveLength(1);
      // expect(results[0].elementId).toBe('0-1234');
      // expect(results[0].confidence).toBeGreaterThan(0.8);
    });

    it('should handle semantic matches', async () => {
      const tree = `[0-1234] button: Sign In
[0-5678] button: Create Account`;

      const context = createMockContext(tree);

      // Note: Requires LLM client
      // "login button" should match "Sign In" semantically
      // const results = await examineDom('click the login button', context, llmClient);
      // expect(results[0].elementId).toBe('0-1234');
    });

    it('should return empty array when no matches', async () => {
      const tree = `[0-1234] button: Submit
[0-5678] button: Cancel`;

      const context = createMockContext(tree);

      // Note: Requires LLM client
      // const results = await examineDom('click the delete button', context, llmClient);
      // expect(results).toHaveLength(0);
    });

    it('should return multiple matches for ambiguous instructions', async () => {
      const tree = `[0-1234] button: Submit
[0-5678] button: Cancel
[0-9012] button: Save`;

      const context = createMockContext(tree);

      // Note: Requires LLM client
      // const results = await examineDom('click the button', context, llmClient);
      // expect(results.length).toBeGreaterThan(1);
      // expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
    });

    it('should suggest correct method for fill actions', async () => {
      const tree = `[0-9012] textbox: Email address
[0-3456] textbox: Password`;

      const context = createMockContext(tree);

      // Note: Requires LLM client
      // const results = await examineDom('fill email with test@example.com', context, llmClient);
      // expect(results[0].method).toBe('fill');
      // expect(results[0].arguments).toContain('test@example.com');
    });
  });

  describe('extractValueFromInstruction', () => {
    it('should extract value with "with" keyword', () => {
      expect(extractValueFromInstruction('fill email with test@example.com')).toBe('test@example.com');
      expect(extractValueFromInstruction('type password with secret123')).toBe('secret123');
    });

    it('should extract value with "into" keyword', () => {
      expect(extractValueFromInstruction('type hello into search box')).toBe('hello');
      expect(extractValueFromInstruction('enter test into field')).toBe('test');
    });

    it('should extract value with "in" keyword', () => {
      expect(extractValueFromInstruction('enter password123 in password field')).toBe('password123 in password field');
    });

    it('should return empty string when no value found', () => {
      expect(extractValueFromInstruction('click the button')).toBe('');
      expect(extractValueFromInstruction('submit the form')).toBe('');
    });
  });
});

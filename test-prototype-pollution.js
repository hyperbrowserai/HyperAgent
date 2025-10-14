#!/usr/bin/env node

/**
 * Security Test: Can JSON.parse cause prototype pollution?
 *
 * This test validates whether parsing JSON with __proto__, constructor,
 * or prototype properties can pollute JavaScript prototypes.
 */

console.log("=== Prototype Pollution Test via JSON.parse ===\n");

// Test 1: __proto__ pollution attempt
console.log("Test 1: Attempting __proto__ pollution");
const testObj1 = JSON.parse('{"__proto__": {"polluted": true}}');
console.log("Parsed object:", testObj1);
console.log("Object.prototype.polluted:", Object.prototype.polluted);
console.log("testObj1.polluted:", testObj1.polluted);
console.log("Result: Object.prototype is " + (Object.prototype.polluted ? "POLLUTED ❌" : "SAFE ✅"));
console.log();

// Test 2: constructor.prototype pollution attempt
console.log("Test 2: Attempting constructor.prototype pollution");
const testObj2 = JSON.parse('{"constructor": {"prototype": {"polluted2": true}}}');
console.log("Parsed object:", testObj2);
console.log("Object.prototype.polluted2:", Object.prototype.polluted2);
console.log("Result: Object.prototype is " + (Object.prototype.polluted2 ? "POLLUTED ❌" : "SAFE ✅"));
console.log();

// Test 3: Nested __proto__ pollution attempt
console.log("Test 3: Attempting nested __proto__ pollution");
const testObj3 = JSON.parse('{"a": {"__proto__": {"polluted3": true}}}');
console.log("Parsed object:", testObj3);
console.log("Object.prototype.polluted3:", Object.prototype.polluted3);
console.log("Result: Object.prototype is " + (Object.prototype.polluted3 ? "POLLUTED ❌" : "SAFE ✅"));
console.log();

// Test 4: Tool call simulation (actual use case in the code)
console.log("Test 4: Simulating tool call parsing (actual use case)");
const maliciousToolCall = {
  function: {
    name: "test_tool",
    arguments: '{"__proto__": {"isAdmin": true}, "normalArg": "value"}'
  }
};
const parsedArgs = JSON.parse(maliciousToolCall.function.arguments);
console.log("Parsed arguments:", parsedArgs);
console.log("Object.prototype.isAdmin:", Object.prototype.isAdmin);
console.log("parsedArgs.isAdmin:", parsedArgs.isAdmin);
console.log("Result: Object.prototype is " + (Object.prototype.isAdmin ? "POLLUTED ❌" : "SAFE ✅"));
console.log();

// Test 5: Check if __proto__ is in the parsed object
console.log("Test 5: Checking if __proto__ exists in parsed object");
const testObj5 = JSON.parse('{"__proto__": {"test": true}, "normal": "value"}');
console.log("Has __proto__ own property:", Object.hasOwnProperty.call(testObj5, "__proto__"));
console.log("Keys:", Object.keys(testObj5));
console.log("Own property names:", Object.getOwnPropertyNames(testObj5));
console.log();

// Test 6: What DOES cause prototype pollution (for comparison)
console.log("Test 6: What ACTUALLY causes prototype pollution (for comparison)");
const safeObj = {};
console.log("Before: Object.prototype.actuallyPolluted =", Object.prototype.actuallyPolluted);
// This WOULD pollute if uncommented:
// safeObj.__proto__.actuallyPolluted = true;
console.log("Note: Direct assignment to __proto__ WOULD cause pollution");
console.log("But JSON.parse does NOT do this.");
console.log();

console.log("=== CONCLUSION ===");
console.log("JSON.parse() is SAFE from prototype pollution.");
console.log("It treats __proto__, constructor, etc. as regular string keys.");
console.log("The JavaScript engine does NOT interpret them as special properties.");

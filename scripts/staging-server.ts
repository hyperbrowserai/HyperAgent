/**
 * Staging Server for HyperAgent Testing
 *
 * Provides deterministic test pages for agent validation without
 * relying on external websites that may change.
 *
 * Usage:
 *   yarn staging:start
 *   # Then run tests with STAGING=true yarn test
 */

import * as http from "http";
import * as path from "path";
import * as fs from "fs";

const PORT = process.env.STAGING_PORT || 3456;
const HOST = "localhost";

// Test pages for deterministic agent testing
const testPages: Record<string, string> = {
  "/": `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HyperAgent Staging - Home</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    nav { display: flex; gap: 1rem; margin-bottom: 2rem; }
    nav a { color: #0066cc; }
    .card { border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; border-radius: 8px; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    input { padding: 0.5rem; margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>HyperAgent Staging Server</h1>
  <nav>
    <a href="/">Home</a>
    <a href="/form">Form Test</a>
    <a href="/products">Products</a>
    <a href="/dynamic">Dynamic Content</a>
    <a href="/nested">Nested Elements</a>
  </nav>
  <div class="card">
    <h2>Welcome</h2>
    <p>This server provides deterministic test pages for HyperAgent validation.</p>
    <button id="clickMe" onclick="alert('Button clicked!')">Click Me</button>
  </div>
</body>
</html>
  `,

  "/form": `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Form Test - HyperAgent Staging</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin: 1rem 0 0.25rem; }
    input, select, textarea { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.75rem 1.5rem; }
    #result { margin-top: 1rem; padding: 1rem; background: #f0f0f0; display: none; }
  </style>
</head>
<body>
  <h1>Form Test Page</h1>
  <form id="testForm" onsubmit="handleSubmit(event)">
    <label for="name">Name:</label>
    <input type="text" id="name" name="name" placeholder="Enter your name" required>

    <label for="email">Email:</label>
    <input type="email" id="email" name="email" placeholder="Enter your email" required>

    <label for="category">Category:</label>
    <select id="category" name="category">
      <option value="">Select a category</option>
      <option value="general">General Inquiry</option>
      <option value="support">Technical Support</option>
      <option value="sales">Sales</option>
    </select>

    <label for="message">Message:</label>
    <textarea id="message" name="message" rows="4" placeholder="Enter your message"></textarea>

    <label>
      <input type="checkbox" id="subscribe" name="subscribe"> Subscribe to newsletter
    </label>

    <button type="submit">Submit Form</button>
  </form>
  <div id="result"></div>

  <script>
    function handleSubmit(e) {
      e.preventDefault();
      const data = new FormData(e.target);
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.innerHTML = '<strong>Form submitted!</strong><br>' +
        'Name: ' + data.get('name') + '<br>' +
        'Email: ' + data.get('email') + '<br>' +
        'Category: ' + data.get('category') + '<br>' +
        'Subscribe: ' + (data.get('subscribe') ? 'Yes' : 'No');
    }
  </script>
</body>
</html>
  `,

  "/products": `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Products - HyperAgent Staging</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; }
    .products { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem; }
    .product { border: 1px solid #ddd; padding: 1rem; border-radius: 8px; }
    .product h3 { margin-top: 0; }
    .price { color: #2a5; font-weight: bold; font-size: 1.25rem; }
    button { width: 100%; padding: 0.5rem; margin-top: 0.5rem; cursor: pointer; }
    #cart { margin-top: 2rem; padding: 1rem; background: #f5f5f5; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Products</h1>
  <div class="products">
    <div class="product" data-id="1">
      <h3>Laptop Pro X</h3>
      <p>High-performance laptop for professionals</p>
      <div class="price">$1,299.00</div>
      <button onclick="addToCart(1, 'Laptop Pro X', 1299)">Add to Cart</button>
    </div>
    <div class="product" data-id="2">
      <h3>Wireless Mouse</h3>
      <p>Ergonomic wireless mouse with precision tracking</p>
      <div class="price">$49.99</div>
      <button onclick="addToCart(2, 'Wireless Mouse', 49.99)">Add to Cart</button>
    </div>
    <div class="product" data-id="3">
      <h3>USB-C Hub</h3>
      <p>7-in-1 USB-C hub with HDMI and card reader</p>
      <div class="price">$79.99</div>
      <button onclick="addToCart(3, 'USB-C Hub', 79.99)">Add to Cart</button>
    </div>
    <div class="product" data-id="4">
      <h3>Mechanical Keyboard</h3>
      <p>RGB mechanical keyboard with Cherry MX switches</p>
      <div class="price">$149.00</div>
      <button onclick="addToCart(4, 'Mechanical Keyboard', 149)">Add to Cart</button>
    </div>
  </div>
  <div id="cart">
    <h2>Shopping Cart</h2>
    <div id="cartItems">Your cart is empty</div>
    <div id="cartTotal"></div>
  </div>

  <script>
    let cart = [];
    function addToCart(id, name, price) {
      cart.push({ id, name, price });
      updateCart();
    }
    function updateCart() {
      const items = document.getElementById('cartItems');
      const total = document.getElementById('cartTotal');
      if (cart.length === 0) {
        items.innerHTML = 'Your cart is empty';
        total.innerHTML = '';
      } else {
        items.innerHTML = cart.map(item => '<div>' + item.name + ' - $' + item.price.toFixed(2) + '</div>').join('');
        const sum = cart.reduce((acc, item) => acc + item.price, 0);
        total.innerHTML = '<strong>Total: $' + sum.toFixed(2) + '</strong>';
      }
    }
  </script>
</body>
</html>
  `,

  "/dynamic": `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dynamic Content - HyperAgent Staging</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    .loading { color: #666; font-style: italic; }
    #content { margin-top: 1rem; padding: 1rem; border: 1px solid #ddd; min-height: 100px; }
    button { margin: 0.25rem; padding: 0.5rem 1rem; }
  </style>
</head>
<body>
  <h1>Dynamic Content Test</h1>
  <p>Test agent handling of dynamically loaded content:</p>
  <div>
    <button onclick="loadContent('fast')">Load Fast (100ms)</button>
    <button onclick="loadContent('slow')">Load Slow (2s)</button>
    <button onclick="loadContent('error')">Load with Error</button>
    <button onclick="clearContent()">Clear</button>
  </div>
  <div id="content">
    <p class="loading">Click a button to load content...</p>
  </div>

  <script>
    function loadContent(type) {
      const content = document.getElementById('content');
      content.innerHTML = '<p class="loading">Loading...</p>';

      const delay = type === 'slow' ? 2000 : 100;

      setTimeout(() => {
        if (type === 'error') {
          content.innerHTML = '<p style="color: red;">Error: Failed to load content. Please try again.</p>';
        } else {
          content.innerHTML = '<h3>Loaded Content</h3><p>This content was loaded dynamically after ' +
            (type === 'slow' ? '2 seconds' : '100ms') +
            '.</p><ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>';
        }
      }, delay);
    }

    function clearContent() {
      document.getElementById('content').innerHTML = '<p class="loading">Click a button to load content...</p>';
    }
  </script>
</body>
</html>
  `,

  "/nested": `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nested Elements - HyperAgent Staging</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    .level { margin-left: 1.5rem; padding: 0.5rem; border-left: 2px solid #ddd; }
    .level-1 { border-color: #e74c3c; }
    .level-2 { border-color: #3498db; }
    .level-3 { border-color: #2ecc71; }
    .level-4 { border-color: #f39c12; }
    button { margin: 0.25rem; }
  </style>
</head>
<body>
  <h1>Nested Elements Test</h1>
  <p>Test agent handling of deeply nested DOM structures:</p>

  <div class="level level-1">
    <h2>Level 1</h2>
    <button onclick="alert('Level 1 button')">Level 1 Button</button>
    <div class="level level-2">
      <h3>Level 2</h3>
      <button onclick="alert('Level 2 button')">Level 2 Button</button>
      <div class="level level-3">
        <h4>Level 3</h4>
        <button onclick="alert('Level 3 button')">Level 3 Button</button>
        <div class="level level-4">
          <h5>Level 4</h5>
          <button id="deepButton" onclick="alert('Deep button clicked!')">Deep Nested Button</button>
          <input type="text" id="deepInput" placeholder="Deep nested input">
        </div>
      </div>
    </div>
  </div>

  <h2>Shadow DOM Test</h2>
  <div id="shadowHost"></div>

  <script>
    // Create shadow DOM for testing
    const host = document.getElementById('shadowHost');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>button { padding: 0.5rem 1rem; }</style>' +
      '<div><p>Content inside Shadow DOM</p>' +
      '<button id="shadowButton">Shadow DOM Button</button></div>';
  </script>
</body>
</html>
  `,
};

// Create HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // CORS headers for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const page = testPages[pathname];
  if (page) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  } else {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
<!DOCTYPE html>
<html>
<head><title>404 Not Found</title></head>
<body>
  <h1>404 - Page Not Found</h1>
  <p>The requested page "${pathname}" does not exist.</p>
  <a href="/">Go to Home</a>
</body>
</html>
    `);
  }
});

server.listen(Number(PORT), HOST, () => {
  console.log(`\n🚀 HyperAgent Staging Server running at http://${HOST}:${PORT}\n`);
  console.log("Available test pages:");
  Object.keys(testPages).forEach((path) => {
    console.log(`  • http://${HOST}:${PORT}${path}`);
  });
  console.log("\nPress Ctrl+C to stop the server\n");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down staging server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export const EXAMPLE_ACTIONS = `# Action Examples

## Element Interaction (actElement)
- Click: {"type": "actElement", "params": {"instruction": "click the Login button"}}
- Fill input: {"type": "actElement", "params": {"instruction": "fill 'john@example.com' into email field"}}
- Type text: {"type": "actElement", "params": {"instruction": "type 'search query' into search box"}}
- Press key: {"type": "actElement", "params": {"instruction": "press Enter"}}
- Select dropdown: {"type": "actElement", "params": {"instruction": "select 'California' from state dropdown"}}
- Check checkbox: {"type": "actElement", "params": {"instruction": "check the terms checkbox"}}
- Uncheck checkbox: {"type": "actElement", "params": {"instruction": "uncheck the newsletter checkbox"}}
- Hover: {"type": "actElement", "params": {"instruction": "hover over profile menu"}}
- Scroll to position: {"type": "actElement", "params": {"instruction": "scroll to 50% of the page"}}
- Scroll down: {"type": "actElement", "params": {"instruction": "scroll down one page"}}
- Scroll up: {"type": "actElement", "params": {"instruction": "scroll up one page"}}

## Other Actions
- Navigate: {"type": "goToUrl", "params": {"url": "https://example.com"}}
- Extract content: {"type": "extract", "params": {"objective": "extract the product price and title"}}
- Wait: {"type": "wait", "params": {"reason": "Waiting for page to finish loading"}}
- Think: {"type": "thinking", "params": {"thought": "I need to find the login form first before attempting to log in"}}
- Complete: {"type": "complete", "params": {"success": true, "output": "Task completed successfully"}}`;

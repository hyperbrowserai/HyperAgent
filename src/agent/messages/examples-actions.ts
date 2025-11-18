export const EXAMPLE_ACTIONS = `# Action Examples

## Element Interaction (actElement)
- Click: {"type": "actElement", "params": {"instruction": "Click the Login button to open the form", "elementId": "0-42", "method": "click", "arguments": [], "confidence": 0.92}}
- Fill input: {"type": "actElement", "params": {"instruction": "Fill in the email field", "elementId": "0-515", "method": "fill", "arguments": ["john@example.com"], "confidence": 0.88}}
- Type text: {"type": "actElement", "params": {"instruction": "Type in the search box", "elementId": "1-77", "method": "type", "arguments": ["coffee shop"], "confidence": 0.84}}
- Press key: {"type": "actElement", "params": {"instruction": "Submit the form", "elementId": "0-515", "method": "press", "arguments": ["Enter"], "confidence": 0.73}}
- Select dropdown: {"type": "actElement", "params": {"instruction": "Choose the California option", "elementId": "2-103", "method": "selectOptionFromDropdown", "arguments": ["California"], "confidence": 0.81}}
- Check checkbox: {"type": "actElement", "params": {"instruction": "Accept the terms", "elementId": "0-901", "method": "check", "arguments": [], "confidence": 0.79}}
- Uncheck checkbox: {"type": "actElement", "params": {"instruction": "Disable the newsletter opt-in", "elementId": "0-902", "method": "uncheck", "arguments": [], "confidence": 0.76}}
- Hover: {"type": "actElement", "params": {"instruction": "Reveal the profile menu", "elementId": "0-1201", "method": "hover", "arguments": [], "confidence": 0.8}}
- Scroll to element: {"type": "actElement", "params": {"instruction": "Scroll to the pricing section", "elementId": "0-2000", "method": "scrollToElement", "arguments": [], "confidence": 0.7}}
- Scroll to percentage: {"type": "actElement", "params": {"instruction": "Scroll halfway down the page", "elementId": "0-0", "method": "scrollToPercentage", "arguments": ["50%"], "confidence": 0.7}}
- Scroll down: {"type": "actElement", "params": {"instruction": "Scroll down one viewport to see more results", "elementId": "0-0", "method": "nextChunk", "arguments": [], "confidence": 0.68}}
- Scroll up: {"type": "actElement", "params": {"instruction": "Scroll back up", "elementId": "0-0", "method": "prevChunk", "arguments": [], "confidence": 0.66}}

## Other Actions
- Navigate: {"type": "goToUrl", "params": {"url": "https://example.com"}}
- Extract content: {"type": "extract", "params": {"objective": "extract the product price and title"}}
- Wait: {"type": "wait", "params": {"reason": "Waiting for page to finish loading"}}
- Complete: {"type": "complete", "params": {"success": true, "text": "Task completed successfully"}}`;

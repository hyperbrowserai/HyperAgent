export const EXAMPLE_ACTIONS = `- Search: [
    {"type": "textInput", "params": {"text": "search query"}},
    {"type": "keyPress", "params": {"key": "Enter"}}
]
- Clicking on an element: [
    {"type": "clickElement", "params": {"index": 1}}
]
- Extracting content (MANDATORY when gathering information for later use): [
    {"type": "extract", "params": {"objective": "what specifically you need to extract", "variableName": "descriptive_name"}}
]
- Forms: [
    {"type": "inputText", "params": {"index": 1, "text": "first name"}},
    {"type": "inputText", "params": {"index": 2, "text": "last name"}},
    {"type": "inputText", "params": {"index": 2, "text": "job title"}},
    {"type": "clickElement", "params": {"index": 3}}
]
- Using extracted variables (IMPORTANT): [
    {"type": "extract", "params": {"objective": "get top two countries", "variableName": "extracted_countries"}},
    {"type": "inputText", "params": {"index": 1, "text": "Capital of <<top_country_1>>"}},
    {"type": "extract", "params": {"objective": "Extract the capital of <<top_country_1>>", "variableName": "capital_1"}}
]`;

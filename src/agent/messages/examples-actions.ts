export const EXAMPLE_ACTIONS = `- Search: [
    {"type": "textInput", "params": {"text": "search query"}},
    {"type": "keyPress", "params": {"key": "Enter"}}
]
- Clicking on an element: [
    {"type": "clickElement", "params": {"index": 1, "indexElementDescription": "Submit button"}}
]
- Extracting content (MANDATORY when gathering information for later use): [
    {"type": "extract", "params": {"objective": "Extract the top two countries from the list", "variables": ["top_country_1", "top_country_2"]}}
]
- Forms: [
    {"type": "inputText", "params": {"index": 1, "indexElementDescription": "First name field", "text": "first name"}},
    {"type": "inputText", "params": {"index": 2, "indexElementDescription": "Last name field", "text": "last name"}},
    {"type": "inputText", "params": {"index": 3, "indexElementDescription": "Job title field", "text": "job title"}},
    {"type": "clickElement", "params": {"index": 4, "indexElementDescription": "Submit form button"}}
]
- Using extracted variables (IMPORTANT): [
    {"type": "extract", "params": {"objective": "Extract the top two countries from the list", "variables": ["top_country_1", "top_country_2"]}},
    {"type": "inputText", "params": {"index": 1, "indexElementDescription": "Search box", "text": "Capital of <<top_country_1>>"}},
    {"type": "extract", "params": {"objective": "Extract the capital of <<top_country_1>>", "variables": ["capital_of_top_country_1"]}}
]`;

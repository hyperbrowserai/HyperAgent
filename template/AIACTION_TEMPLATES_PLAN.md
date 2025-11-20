# aiAction Template Generation Plan

## Table of Contents
1. [Overview](#overview)
2. [aiAction Command Reference](#aiaction-command-reference)
3. [10 Template Categories](#10-template-categories)
4. [Template Code Structure](#template-code-structure)
5. [Testing Strategy](#testing-strategy)
6. [Code Generator Requirements](#code-generator-requirements)

---

## Overview

This document outlines a comprehensive plan for generating templatized Playwright automation code using HyperAgent's `aiAction()` API. The goal is to create 10 diverse, functionally-correct code templates across different use case categories that demonstrate single-step LLM-driven browser automation.

### Key Differences from agent.execute() / page.ai()

| Feature | `page.aiAction()` | `page.ai()` / `agent.executeTask()` |
|---------|------------------|-------------------------------------|
| **Execution Model** | Single action, no agent loop | Multi-step agent loop |
| **LLM Calls** | 1 per action | Multiple (iterative) |
| **Mode** | Accessibility tree (text-based) | Visual (screenshots + overlays) |
| **Speed** | Fast | Slower |
| **Cost** | Cheap (text tokens only) | Expensive (image tokens) |
| **Use Case** | Granular single actions | Complex workflows |

### Philosophy

Templates should use `page.aiAction()` for **precise, single-step operations** that are:
- **Deterministic**: "click login button" not "log me in"
- **Granular**: One action per call
- **Composable**: Chain multiple aiActions for workflows
- **Reliable**: Leverage built-in 10x retry logic

---

## aiAction Command Reference

### Complete Command Set (11 Commands)

Based on `/src/agent/examine-dom/schema.ts` and implementation in `/src/agent/index.ts`:

#### 1. `click` - Click an Element
```typescript
await page.aiAction("click the login button");
await page.aiAction("click the first search result");
await page.aiAction("click the Submit button");
```

#### 2. `fill` - Fill a Form Field (clears first, then types)
```typescript
await page.aiAction("fill the email field with test@example.com");
await page.aiAction("fill the search box with 'typescript tutorial'");
```

#### 3. `type` - Type into a Field (alias for fill)
```typescript
await page.aiAction("type 'San Francisco' into the location field");
await page.aiAction("type cats into the search box");
```

#### 4. `press` - Press a Keyboard Key
```typescript
await page.aiAction("press Enter");
await page.aiAction("press Tab");
await page.aiAction("press Escape");
```

#### 5. `hover` - Hover Over an Element
```typescript
await page.aiAction("hover over the profile menu");
await page.aiAction("hover over the tooltip icon");
```

#### 6. `check` - Check a Checkbox
```typescript
await page.aiAction("check the terms and conditions checkbox");
await page.aiAction("check the newsletter subscription box");
```

#### 7. `uncheck` - Uncheck a Checkbox
```typescript
await page.aiAction("uncheck the remember me checkbox");
```

#### 8. `selectOptionFromDropdown` - Select Dropdown Option
```typescript
await page.aiAction("select 'United States' from the country dropdown");
await page.aiAction("select '2024' from the year dropdown");
```

#### 9. `scrollTo` - Scroll to Percentage Position
```typescript
await page.aiAction("scroll to 50%");
await page.aiAction("scroll to 75%");
await page.aiAction("scroll to bottom"); // 100%
```

#### 10. `nextChunk` - Scroll Down One Viewport
```typescript
await page.aiAction("scroll to next page");
await page.aiAction("scroll down one page");
```

#### 11. `prevChunk` - Scroll Up One Viewport
```typescript
await page.aiAction("scroll to previous page");
await page.aiAction("scroll up one page");
```

### Best Practices

1. **Be Specific**: Use exact labels/text when possible
   - Good: `"click the Sign In button"`
   - Bad: `"click button"`

2. **One Action Per Call**: Don't combine actions
   - Good: Two calls for fill + click
   - Bad: `"fill email and click submit"`

3. **Wait for DOM**: aiAction waits for DOM to settle automatically
   - No need for manual `waitForTimeout()`

4. **Leverage Retry Logic**: Built-in 10x retry for dynamic content
   - Dropdowns that appear on click
   - Lazy-loaded elements

5. **Combine with extract()**: Get structured data after navigation
   ```typescript
   await page.aiAction("scroll to 50%");
   const data = await page.extract("Extract all product names", schema);
   ```

---

## 10 Template Categories

Each template includes:
- **Use Case Description**
- **Target Website(s)**
- **aiAction Sequence**
- **Extract Schema**
- **Expected Output**
- **Testing Verification Steps**

---

### Template 1: Social Media Feed Extraction

**Category**: Social Media Data Collection
**Use Case**: Extract posts from Twitter/X user feed
**Target Site**: x.com (Twitter)

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function extractTwitterFeed() {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Twitter
  await page.goto('https://x.com');

  // Click on timeline/feed
  await page.aiAction('click on the Home timeline link');

  // Scroll to load more posts
  await page.aiAction('scroll to 50%');
  await page.waitForTimeout(1000); // Allow lazy load

  // Extract posts
  const schema = z.object({
    posts: z.array(z.object({
      author: z.string(),
      content: z.string(),
      timestamp: z.string().optional(),
      likes: z.string().optional(),
      retweets: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all visible tweets/posts including author, content, timestamp, likes, and retweets',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const TwitterFeedSchema = z.object({
  posts: z.array(z.object({
    author: z.string().describe('Username or display name'),
    content: z.string().describe('Tweet text content'),
    timestamp: z.string().optional().describe('Relative or absolute time'),
    likes: z.string().optional().describe('Like count'),
    retweets: z.string().optional().describe('Retweet count'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to x.com
- [ ] Clicks on correct feed/timeline element
- [ ] Scroll action loads additional posts
- [ ] Extract returns array with at least 5 posts
- [ ] Each post has author and content fields
- [ ] No errors during execution

---

### Template 2: E-commerce Product Search

**Category**: E-commerce Product Search
**Use Case**: Search Amazon for products and extract details
**Target Site**: amazon.com

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function searchAmazonProducts(searchQuery: string) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Amazon
  await page.goto('https://www.amazon.com');

  // Search for product
  await page.aiAction(`fill the search box with ${searchQuery}`);
  await page.aiAction('click the search button');

  // Wait for results to load
  await page.waitForTimeout(2000);

  // Scroll to see more products
  await page.aiAction('scroll to 50%');

  // Extract product details
  const schema = z.object({
    products: z.array(z.object({
      title: z.string(),
      price: z.string().optional(),
      rating: z.string().optional(),
      reviewCount: z.string().optional(),
      prime: z.boolean().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all product listings including title, price, rating, review count, and whether Prime eligible',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const AmazonProductSchema = z.object({
  products: z.array(z.object({
    title: z.string().describe('Product name/title'),
    price: z.string().optional().describe('Price as string (e.g., "$29.99")'),
    rating: z.string().optional().describe('Star rating (e.g., "4.5")'),
    reviewCount: z.string().optional().describe('Number of reviews'),
    prime: z.boolean().optional().describe('Amazon Prime eligible'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to amazon.com
- [ ] Search box is filled with query
- [ ] Search button is clicked
- [ ] Results page loads
- [ ] Scroll reveals more products
- [ ] Extract returns at least 10 products
- [ ] Products have title and price
- [ ] No errors during execution

---

### Template 3: Form Submission & Validation

**Category**: Form Submission
**Use Case**: Fill out a multi-field contact form
**Target Site**: Generic contact form (e.g., TypeForm, Google Forms)

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';

interface FormData {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  subscribe?: boolean;
}

async function submitContactForm(formUrl: string, data: FormData) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to form
  await page.goto(formUrl);

  // Fill form fields
  await page.aiAction(`fill the name field with ${data.name}`);
  await page.aiAction(`fill the email field with ${data.email}`);

  if (data.phone) {
    await page.aiAction(`fill the phone field with ${data.phone}`);
  }

  await page.aiAction(`fill the subject field with ${data.subject}`);
  await page.aiAction(`fill the message field with ${data.message}`);

  // Handle optional checkbox
  if (data.subscribe) {
    await page.aiAction('check the newsletter subscription checkbox');
  }

  // Submit form
  await page.aiAction('click the Submit button');

  // Wait for confirmation
  await page.waitForTimeout(2000);

  // Extract confirmation message
  const confirmation = await page.extract(
    'Extract the success/confirmation message after form submission'
  );

  await agent.close();
  return confirmation;
}
```

#### Testing Verification
- [ ] All form fields are filled correctly
- [ ] Checkbox state matches input
- [ ] Submit button is clicked
- [ ] Confirmation message appears
- [ ] No validation errors
- [ ] Form data is properly submitted

---

### Template 4: News Aggregation

**Category**: News & Content Aggregation
**Use Case**: Scroll through news site and extract article headlines
**Target Site**: news.ycombinator.com (Hacker News)

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function extractHackerNewsStories() {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Hacker News
  await page.goto('https://news.ycombinator.com');

  // Scroll to load more stories
  await page.aiAction('scroll to 50%');
  await page.waitForTimeout(1000);

  // Extract stories
  const schema = z.object({
    stories: z.array(z.object({
      title: z.string(),
      url: z.string().optional(),
      points: z.string().optional(),
      author: z.string().optional(),
      commentCount: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all story listings including title, URL, points, author, and comment count',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const HackerNewsSchema = z.object({
  stories: z.array(z.object({
    title: z.string().describe('Story headline'),
    url: z.string().optional().describe('Link to article'),
    points: z.string().optional().describe('Upvote count'),
    author: z.string().optional().describe('Username who posted'),
    commentCount: z.string().optional().describe('Number of comments'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to Hacker News
- [ ] Scroll action works
- [ ] Extract returns array with at least 30 stories
- [ ] Stories have title field
- [ ] Points and comment counts are captured
- [ ] No errors during execution

---

### Template 5: Job Board Search & Filter

**Category**: Job Search
**Use Case**: Search LinkedIn Jobs with filters and extract listings
**Target Site**: linkedin.com/jobs

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

interface JobSearchParams {
  keyword: string;
  location: string;
  jobType?: 'Full-time' | 'Part-time' | 'Contract';
}

async function searchLinkedInJobs(params: JobSearchParams) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to LinkedIn Jobs
  await page.goto('https://www.linkedin.com/jobs');

  // Fill search fields
  await page.aiAction(`fill the job title search box with ${params.keyword}`);
  await page.aiAction(`fill the location search box with ${params.location}`);

  // Click search
  await page.aiAction('click the Search button');

  // Wait for results
  await page.waitForTimeout(2000);

  // Apply job type filter if specified
  if (params.jobType) {
    await page.aiAction('click the Job Type filter');
    await page.aiAction(`check the ${params.jobType} checkbox`);
    await page.aiAction('click the Apply filters button');
    await page.waitForTimeout(1000);
  }

  // Scroll to load more jobs
  await page.aiAction('scroll to 50%');

  // Extract job listings
  const schema = z.object({
    jobs: z.array(z.object({
      title: z.string(),
      company: z.string(),
      location: z.string(),
      postedDate: z.string().optional(),
      salary: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all job listings including title, company, location, posted date, and salary if available',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const LinkedInJobSchema = z.object({
  jobs: z.array(z.object({
    title: z.string().describe('Job title'),
    company: z.string().describe('Company name'),
    location: z.string().describe('Job location'),
    postedDate: z.string().optional().describe('When posted (e.g., "2 days ago")'),
    salary: z.string().optional().describe('Salary range if listed'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to LinkedIn Jobs
- [ ] Search fields are filled correctly
- [ ] Search executes successfully
- [ ] Filters apply correctly (if specified)
- [ ] Scroll loads more jobs
- [ ] Extract returns at least 10 jobs
- [ ] Jobs have title, company, location
- [ ] No errors during execution

---

### Template 6: Real Estate Listings

**Category**: Real Estate
**Use Case**: Search Zillow for properties with criteria
**Target Site**: zillow.com

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

interface PropertySearchParams {
  location: string;
  minPrice?: string;
  maxPrice?: string;
  bedrooms?: string;
}

async function searchZillowProperties(params: PropertySearchParams) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Zillow
  await page.goto('https://www.zillow.com');

  // Enter location
  await page.aiAction(`fill the search box with ${params.location}`);
  await page.aiAction('click the Search button');

  // Wait for results
  await page.waitForTimeout(2000);

  // Apply filters if specified
  if (params.minPrice || params.maxPrice) {
    await page.aiAction('click the Price filter');

    if (params.minPrice) {
      await page.aiAction(`fill the minimum price field with ${params.minPrice}`);
    }
    if (params.maxPrice) {
      await page.aiAction(`fill the maximum price field with ${params.maxPrice}`);
    }

    await page.aiAction('click the Apply button');
    await page.waitForTimeout(1000);
  }

  if (params.bedrooms) {
    await page.aiAction('click the Beds & Baths filter');
    await page.aiAction(`select ${params.bedrooms} from the bedrooms dropdown`);
    await page.aiAction('click the Apply button');
    await page.waitForTimeout(1000);
  }

  // Scroll to load more properties
  await page.aiAction('scroll to 50%');

  // Extract property listings
  const schema = z.object({
    properties: z.array(z.object({
      address: z.string(),
      price: z.string(),
      bedrooms: z.string().optional(),
      bathrooms: z.string().optional(),
      sqft: z.string().optional(),
      propertyType: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all property listings including address, price, bedrooms, bathrooms, square footage, and property type',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const ZillowPropertySchema = z.object({
  properties: z.array(z.object({
    address: z.string().describe('Property address'),
    price: z.string().describe('Listing price'),
    bedrooms: z.string().optional().describe('Number of bedrooms'),
    bathrooms: z.string().optional().describe('Number of bathrooms'),
    sqft: z.string().optional().describe('Square footage'),
    propertyType: z.string().optional().describe('House, Condo, Townhouse, etc.'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to Zillow
- [ ] Location search works
- [ ] Price filters apply correctly
- [ ] Bedroom filters apply correctly
- [ ] Scroll loads more properties
- [ ] Extract returns at least 10 properties
- [ ] Properties have address and price
- [ ] No errors during execution

---

### Template 7: Financial Data Collection

**Category**: Financial Data
**Use Case**: Extract stock quotes and crypto prices
**Target Site**: finance.yahoo.com

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function getStockQuote(symbol: string) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Yahoo Finance
  await page.goto('https://finance.yahoo.com');

  // Search for stock symbol
  await page.aiAction(`fill the search box with ${symbol}`);
  await page.aiAction('press Enter');

  // Wait for quote page to load
  await page.waitForTimeout(2000);

  // Extract stock data
  const schema = z.object({
    symbol: z.string(),
    price: z.string(),
    change: z.string().optional(),
    changePercent: z.string().optional(),
    volume: z.string().optional(),
    marketCap: z.string().optional(),
    peRatio: z.string().optional(),
  });

  const result = await page.extract(
    'Extract the stock quote including symbol, current price, change, change percent, volume, market cap, and P/E ratio',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const StockQuoteSchema = z.object({
  symbol: z.string().describe('Stock ticker symbol'),
  price: z.string().describe('Current price'),
  change: z.string().optional().describe('Price change'),
  changePercent: z.string().optional().describe('Percent change'),
  volume: z.string().optional().describe('Trading volume'),
  marketCap: z.string().optional().describe('Market capitalization'),
  peRatio: z.string().optional().describe('Price-to-earnings ratio'),
});
```

#### Testing Verification
- [ ] Successfully navigates to Yahoo Finance
- [ ] Search works for stock symbol
- [ ] Quote page loads
- [ ] Extract returns stock data
- [ ] Price field is present
- [ ] Symbol matches input
- [ ] No errors during execution

---

### Template 8: Restaurant/Food Delivery Search

**Category**: Food & Dining
**Use Case**: Search DoorDash for restaurants in area
**Target Site**: doordash.com

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function searchDoorDashRestaurants(location: string, cuisine?: string) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to DoorDash
  await page.goto('https://www.doordash.com');

  // Enter delivery address
  await page.aiAction(`fill the address field with ${location}`);
  await page.aiAction('press Enter');

  // Wait for restaurants to load
  await page.waitForTimeout(2000);

  // Filter by cuisine if specified
  if (cuisine) {
    await page.aiAction(`fill the search for restaurants field with ${cuisine}`);
    await page.waitForTimeout(1000);
  }

  // Scroll to see more restaurants
  await page.aiAction('scroll to 50%');

  // Extract restaurant listings
  const schema = z.object({
    restaurants: z.array(z.object({
      name: z.string(),
      rating: z.string().optional(),
      deliveryTime: z.string().optional(),
      deliveryFee: z.string().optional(),
      cuisine: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all restaurant listings including name, rating, delivery time, delivery fee, and cuisine type',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const DoorDashRestaurantSchema = z.object({
  restaurants: z.array(z.object({
    name: z.string().describe('Restaurant name'),
    rating: z.string().optional().describe('Customer rating (e.g., "4.5")'),
    deliveryTime: z.string().optional().describe('Estimated delivery time'),
    deliveryFee: z.string().optional().describe('Delivery fee amount'),
    cuisine: z.string().optional().describe('Type of cuisine'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to DoorDash
- [ ] Address field accepts location
- [ ] Restaurants load for location
- [ ] Cuisine filter works (if specified)
- [ ] Scroll reveals more restaurants
- [ ] Extract returns at least 10 restaurants
- [ ] Restaurants have name field
- [ ] No errors during execution

---

### Template 9: Event Discovery & Details

**Category**: Events & Activities
**Use Case**: Search Eventbrite for events in area
**Target Site**: eventbrite.com

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

interface EventSearchParams {
  keyword: string;
  location: string;
  date?: string;
}

async function searchEventbriteEvents(params: EventSearchParams) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to Eventbrite
  await page.goto('https://www.eventbrite.com');

  // Search for events
  await page.aiAction(`fill the search for events field with ${params.keyword}`);
  await page.aiAction(`fill the location field with ${params.location}`);
  await page.aiAction('click the Search button');

  // Wait for results
  await page.waitForTimeout(2000);

  // Apply date filter if specified
  if (params.date) {
    await page.aiAction('click the Date filter');
    await page.aiAction(`select ${params.date} from the date options`);
    await page.waitForTimeout(1000);
  }

  // Scroll to load more events
  await page.aiAction('scroll down one page');

  // Extract event listings
  const schema = z.object({
    events: z.array(z.object({
      title: z.string(),
      date: z.string(),
      time: z.string().optional(),
      location: z.string(),
      price: z.string().optional(),
      organizer: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all event listings including title, date, time, location, price, and organizer',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const EventbriteEventSchema = z.object({
  events: z.array(z.object({
    title: z.string().describe('Event name/title'),
    date: z.string().describe('Event date'),
    time: z.string().optional().describe('Event time'),
    location: z.string().describe('Event venue/location'),
    price: z.string().optional().describe('Ticket price or "Free"'),
    organizer: z.string().optional().describe('Event organizer name'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to Eventbrite
- [ ] Search fields are filled correctly
- [ ] Search executes successfully
- [ ] Date filter works (if specified)
- [ ] Scroll loads more events
- [ ] Extract returns at least 10 events
- [ ] Events have title, date, location
- [ ] No errors during execution

---

### Template 10: Government/Public Records

**Category**: Government & Public Data
**Use Case**: Navigate gov site and extract public information
**Target Site**: usa.gov or specific state/local gov sites

#### Workflow
```typescript
import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

async function searchGovernmentServices(query: string) {
  const agent = await Agent.start({
    headless: false,
    debug: true
  });

  const page = await agent.newPage();

  // Navigate to USA.gov
  await page.goto('https://www.usa.gov');

  // Search for government service
  await page.aiAction(`fill the search box with ${query}`);
  await page.aiAction('click the Search button');

  // Wait for results
  await page.waitForTimeout(2000);

  // Scroll to see more results
  await page.aiAction('scroll to 50%');

  // Extract search results
  const schema = z.object({
    results: z.array(z.object({
      title: z.string(),
      description: z.string().optional(),
      url: z.string().optional(),
      agency: z.string().optional(),
    }))
  });

  const result = await page.extract(
    'Extract all search results including title, description, URL, and government agency',
    schema
  );

  await agent.close();
  return result;
}
```

#### Extract Schema
```typescript
const GovSearchResultSchema = z.object({
  results: z.array(z.object({
    title: z.string().describe('Result title/heading'),
    description: z.string().optional().describe('Brief description'),
    url: z.string().optional().describe('Link to resource'),
    agency: z.string().optional().describe('Government agency responsible'),
  }))
});
```

#### Testing Verification
- [ ] Successfully navigates to USA.gov
- [ ] Search box is filled with query
- [ ] Search executes successfully
- [ ] Results page loads
- [ ] Scroll reveals more results
- [ ] Extract returns at least 5 results
- [ ] Results have title field
- [ ] No errors during execution

---

## Template Code Structure

All templates should follow this standardized structure:

### Standard Template Format

```typescript
/**
 * Template: [Template Name]
 * Category: [Category]
 * Use Case: [Brief description]
 * Target Site: [website.com]
 */

import { Agent } from '@hyperagent/hyperagent';
import { z } from 'zod';

// Type definitions
interface [TemplateParams] {
  // Input parameters
}

// Extract schema
const [TemplateName]Schema = z.object({
  // Schema definition
});

/**
 * [Function description]
 * @param params - [Parameter description]
 * @returns Promise with extracted data
 */
async function [templateFunction](params: [TemplateParams]) {
  // Initialize agent
  const agent = await Agent.start({
    headless: false,  // Set to true for production
    debug: true       // Set to false for production
  });

  try {
    const page = await agent.newPage();

    // Navigation
    await page.goto('[target-url]');

    // aiAction sequence
    // ... granular actions

    // Data extraction
    const result = await page.extract(
      '[extraction instruction]',
      [TemplateName]Schema
    );

    return result;

  } catch (error) {
    console.error(`Error in ${templateFunction.name}:`, error);
    throw error;
  } finally {
    await agent.close();
  }
}

// Example usage
if (require.main === module) {
  [templateFunction]({
    // Example parameters
  }).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error('Failed:', error);
    process.exit(1);
  });
}

export { [templateFunction], [TemplateName]Schema };
```

### Error Handling Patterns

```typescript
// Pattern 1: Retry with timeout
try {
  await page.aiAction('click the submit button');
} catch (error) {
  console.warn('First attempt failed, retrying...');
  await page.waitForTimeout(2000);
  await page.aiAction('click the submit button');
}

// Pattern 2: Conditional actions
const hasLoginButton = await page.evaluate(() => {
  return document.querySelector('[data-testid="login"]') !== null;
});

if (hasLoginButton) {
  await page.aiAction('click the login button');
}

// Pattern 3: Graceful degradation
try {
  await page.aiAction('select Premium from the plan dropdown');
} catch (error) {
  console.warn('Premium plan not available, selecting default');
  await page.aiAction('select Basic from the plan dropdown');
}
```

### Debug Configuration

```typescript
// Development mode
const agent = await Agent.start({
  headless: false,
  debug: true,
  // Optional: custom debug path
  debugPath: './debug-output'
});

// Production mode
const agent = await Agent.start({
  headless: true,
  debug: false
});
```

---

## Testing Strategy

### Functional Correctness Validation

Each template must pass the following testing phases:

#### Phase 1: Manual Verification Checklist

For each template:

1. **Setup**
   - [ ] Clone HyperAgent repository
   - [ ] Install dependencies (`yarn install`)
   - [ ] Set environment variables (API keys)
   - [ ] Create test file in `template/tests/`

2. **Execution**
   - [ ] Run template with debug mode enabled
   - [ ] Observe browser automation in real-time
   - [ ] Check debug output files
   - [ ] Verify no errors in console

3. **Validation**
   - [ ] All aiAction commands execute successfully
   - [ ] Target elements are found and interacted with
   - [ ] Extract returns data in expected schema format
   - [ ] Data quality: fields are populated correctly
   - [ ] Data quantity: minimum expected records returned

4. **Edge Cases**
   - [ ] Test with invalid inputs (expect graceful failure)
   - [ ] Test with slow network (increase timeouts)
   - [ ] Test with different screen sizes
   - [ ] Test with different locales (if applicable)

#### Phase 2: Automated Test Structure

```typescript
import { describe, it, expect } from '@jest/globals';
import { [templateFunction], [TemplateName]Schema } from '../[template-file]';

describe('[Template Name] Template', () => {
  it('should extract data in correct schema format', async () => {
    const result = await [templateFunction]({
      // Test parameters
    });

    // Validate schema
    const parsed = [TemplateName]Schema.parse(result);
    expect(parsed).toBeDefined();
  }, 60000); // 60s timeout

  it('should return minimum expected records', async () => {
    const result = await [templateFunction]({
      // Test parameters
    });

    expect(result.[dataField].length).toBeGreaterThanOrEqual(5);
  }, 60000);

  it('should handle errors gracefully', async () => {
    await expect(async () => {
      await [templateFunction]({
        // Invalid parameters
      });
    }).rejects.toThrow();
  }, 30000);
});
```

#### Phase 3: Performance Benchmarks

Track and optimize for:

| Metric | Target | Notes |
|--------|--------|-------|
| **Total Execution Time** | < 30s | Navigation + actions + extract |
| **LLM Calls** | Minimize | One per aiAction + one for extract |
| **Network Requests** | N/A | Depends on target site |
| **Memory Usage** | < 500MB | Monitor with debug mode |
| **Success Rate** | > 95% | Across 20 test runs |

### Known Limitations & Edge Cases

#### General Limitations
1. **Authentication**: Templates don't handle login (add manually if needed)
2. **CAPTCHA**: Cannot bypass CAPTCHA challenges
3. **Rate Limiting**: Target sites may rate limit requests
4. **Dynamic Content**: Some lazy-loaded content may need additional waits
5. **Regional Differences**: Site layouts may vary by locale
6. **Mobile vs Desktop**: Templates assume desktop layout

#### Site-Specific Issues
- **Amazon**: Frequent CAPTCHA challenges
- **LinkedIn**: Requires login for most features
- **Twitter/X**: Rate limits aggressive without auth
- **DoorDash**: Location permissions may be required
- **Zillow**: May require account for some filters

#### Mitigation Strategies
```typescript
// Add longer waits for slow-loading content
await page.waitForTimeout(3000);

// Use explicit selectors as fallback
if (!success) {
  await page.click('button[data-testid="submit"]');
}

// Retry with exponential backoff
for (let i = 0; i < 3; i++) {
  try {
    await page.aiAction('click the button');
    break;
  } catch (error) {
    await page.waitForTimeout(1000 * Math.pow(2, i));
  }
}
```

---

## Code Generator Requirements

### Goal
Create an LLM-based code generator that produces consistent, functional aiAction templates for arbitrary use cases.

### Input Specification

```typescript
interface CodeGenerationRequest {
  useCase: string;           // "Extract Yelp reviews for a restaurant"
  targetSite: string;        // "yelp.com"
  category?: string;         // Optional category hint
  parameters?: string[];     // Expected input params
  outputFields?: string[];   // Expected output fields
}
```

### Output Specification

```typescript
interface CodeGenerationOutput {
  code: string;              // Full TypeScript code
  schema: string;            // Zod schema definition
  testCases: string[];       // Example test inputs
  estimatedActions: number;  // Number of aiAction calls
  estimatedTime: number;     // Estimated execution time (seconds)
}
```

### LLM Prompt Design

```typescript
const SYSTEM_PROMPT = `
You are an expert code generator for HyperAgent aiAction templates.

Your task is to generate TypeScript code that uses the aiAction API to automate browser tasks.

## Available aiAction Commands (11 total):
1. click - Click an element
2. fill - Fill a form field
3. type - Type into a field (alias for fill)
4. press - Press a keyboard key
5. hover - Hover over an element
6. check - Check a checkbox
7. uncheck - Uncheck a checkbox
8. selectOptionFromDropdown - Select from dropdown
9. scrollTo - Scroll to percentage (e.g., "50%")
10. nextChunk - Scroll down one viewport
11. prevChunk - Scroll up one viewport

## Rules:
- Use ONLY aiAction for DOM interactions (never direct Playwright methods)
- One action per aiAction call (don't combine)
- Be specific with element descriptions
- Always include extract() with proper Zod schema
- Follow the standard template structure
- Include error handling and timeouts
- Add TypeScript types for all parameters

## Output Format:
Generate complete, runnable TypeScript code following the standard template structure.
`;

const USER_PROMPT = `
Generate an aiAction template for the following use case:

Use Case: {useCase}
Target Site: {targetSite}
Category: {category}
Input Parameters: {parameters}
Expected Output Fields: {outputFields}

Generate the complete code including:
1. Type definitions
2. Zod schema
3. Main function with aiAction sequence
4. Error handling
5. Example usage
6. Export statements
`;
```

### Validation Rules

Generated code must:
1. **Compile**: No TypeScript errors
2. **Import**: Correct import statements for HyperAgent and Zod
3. **Schema**: Valid Zod schema matching output fields
4. **Actions**: Only use valid aiAction commands
5. **Structure**: Follow standard template format
6. **Documentation**: Include JSDoc comments
7. **Error Handling**: Include try-catch blocks
8. **Cleanup**: Always close agent in finally block

### Post-Generation Processing

```typescript
async function validateGeneratedCode(code: string): Promise<boolean> {
  // 1. TypeScript compilation check
  const tsCheck = await compileTypeScript(code);
  if (!tsCheck.success) {
    console.error('TypeScript errors:', tsCheck.errors);
    return false;
  }

  // 2. aiAction command validation
  const actions = extractAiActions(code);
  const validCommands = [
    'click', 'fill', 'type', 'press', 'hover',
    'check', 'uncheck', 'selectOptionFromDropdown',
    'scrollTo', 'nextChunk', 'prevChunk'
  ];

  for (const action of actions) {
    // Parse action to extract command type
    // Ensure it matches valid commands
  }

  // 3. Schema validation
  const hasSchema = code.includes('z.object(');
  if (!hasSchema) {
    console.error('Missing Zod schema');
    return false;
  }

  // 4. Structure validation
  const hasImports = code.includes('import { Agent }');
  const hasFunction = code.includes('async function');
  const hasExport = code.includes('export');

  return hasImports && hasFunction && hasExport;
}
```

### Integration with HyperAgent

```typescript
import { generateTemplate } from './template-generator';

// Generate template
const request: CodeGenerationRequest = {
  useCase: 'Extract top GitHub repositories for a programming language',
  targetSite: 'github.com',
  category: 'Developer Tools',
  parameters: ['language'],
  outputFields: ['name', 'description', 'stars', 'forks', 'url']
};

const output = await generateTemplate(request);

// Save to file
fs.writeFileSync(
  `templates/github-repos-${Date.now()}.ts`,
  output.code
);

// Validate
const isValid = await validateGeneratedCode(output.code);
console.log('Code is valid:', isValid);

// Test
if (isValid) {
  // Execute generated code
  const result = await executeGeneratedTemplate(output.code, {
    language: 'typescript'
  });
  console.log('Test result:', result);
}
```

---

## Appendix

### A. Example aiAction Patterns Library

Common patterns for reuse:

```typescript
// Pattern: Login flow
await page.aiAction('fill the email field with user@example.com');
await page.aiAction('fill the password field with password123');
await page.aiAction('click the Sign In button');

// Pattern: Search and filter
await page.aiAction('fill the search box with query');
await page.aiAction('press Enter');
await page.aiAction('click the Filters button');
await page.aiAction('check the In Stock checkbox');
await page.aiAction('click the Apply button');

// Pattern: Pagination
for (let i = 0; i < 3; i++) {
  await page.aiAction('scroll down one page');
  await page.waitForTimeout(1000);
}

// Pattern: Dropdown selection
await page.aiAction('click the Country dropdown');
await page.aiAction('select United States from the dropdown');

// Pattern: Modal interaction
await page.aiAction('click the Open Modal button');
await page.waitForTimeout(500);
await page.aiAction('click the Confirm button in the modal');
```

### B. Debug Output Structure

When `debug: true`, expect this output structure:

```
debug/
└── aiAction/
    └── session-{timestamp}/
        ├── action-1/
        │   ├── metadata.json
        │   ├── dom-tree.txt
        │   ├── screenshot.png
        │   ├── found-element.json
        │   └── llm-response.json
        ├── action-2/
        │   └── ...
        └── extract-1/
            ├── metadata.json
            ├── screenshot.png
            └── extracted-data.json
```

### C. Common Gotchas

1. **Element Not Found**: Use more specific descriptions
   - Bad: `"click button"`
   - Good: `"click the blue Submit button at the bottom"`

2. **Timing Issues**: Add explicit waits for dynamic content
   ```typescript
   await page.aiAction('click the dropdown');
   await page.waitForTimeout(500); // Let dropdown render
   await page.aiAction('select option');
   ```

3. **Iframes**: aiAction doesn't handle iframes automatically
   ```typescript
   // Need to switch to iframe first
   const frame = page.frameLocator('iframe[title="Login"]');
   // Then use standard Playwright methods
   ```

4. **Shadow DOM**: aiAction may not find elements in shadow DOM
   ```typescript
   // Use piercing selectors or standard Playwright
   await page.locator('>>> button').click();
   ```

### D. Performance Optimization Tips

1. **Minimize Navigation**: Group actions on same page
2. **Batch Scrolling**: Use `scrollTo` with percentage instead of multiple `nextChunk`
3. **Reduce Waits**: Only add timeouts when necessary
4. **Parallel Extraction**: Extract multiple schemas in one call if possible
5. **Reuse Pages**: Don't create new page for every action

### E. Future Enhancements

Potential improvements to template system:

1. **Visual Regression Testing**: Compare screenshots across runs
2. **Automatic Retry Logic**: Wrap templates with retry decorator
3. **Template Marketplace**: Share community templates
4. **Performance Monitoring**: Track execution metrics
5. **A/B Testing**: Compare aiAction vs traditional selectors
6. **Multi-Language Support**: Generate Python/Java equivalents
7. **Cloud Execution**: Run templates on distributed browsers
8. **Scheduling**: Cron-like template execution
9. **Data Pipeline Integration**: Export to databases/APIs
10. **Template Composition**: Combine multiple templates into workflows

---

## Conclusion

This plan provides a comprehensive framework for generating consistent, reliable aiAction templates across 10 diverse use case categories. By following the standardized structure, testing methodology, and code generation requirements, we can create a robust library of reusable automation templates that leverage the speed and cost-effectiveness of the aiAction API.

Next steps:
1. Implement templates 1-10 in separate files
2. Build test suite for each template
3. Create code generator with LLM integration
4. Validate functional correctness across all templates
5. Document learnings and optimize patterns

---

**Document Version**: 1.0
**Last Updated**: 2025-10-31
**Author**: HyperAgent Team
**Status**: Planning Phase

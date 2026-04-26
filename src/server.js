const express = require("express");
const { HyperAgent } = require("@hyperbrowser/agent");

const app = express();
app.use(express.json());

app.post("/run", async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: "No task provided" });

  const agent = new HyperAgent({
    llm: { provider: "gemini", model: "gemini-3.1-flash-lite-preview", apiKey: process.env.LLM_API_KEY }, // or anthropic / gemini
  });

  try {
    const result = await agent.executeTask(task);
    await agent.closeAgent();
    res.json({ output: result.output });
  } catch (err) {
    await agent.closeAgent();
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HyperAgent server running on port ${PORT}`));
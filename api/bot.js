// api/chat.js - A single-file Express-style API for Vercel with Vercel AI SDK
import express from 'express';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import 'dotenv/config';

const app = express();
app.use(express.json());

// Enable CORS for development (adjust as needed for production)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main streaming chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    
    // Validate input
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Initialize OpenAI client with optional custom base URL for AI Gateway or proxies
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Optional: use Vercel AI Gateway or a custom proxy
      baseURL: process.env.OPENAI_BASE_URL,
    });

    // Define tools (functions) the AI can call
    const tools = {
      // Example: Get current time tool
      get_current_time: {
        description: 'Get the current date and time',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'Timezone (e.g., UTC, America/New_York)',
            },
          },
        },
        execute: async ({ timezone }) => {
          const now = new Date();
          return {
            time: now.toISOString(),
            timezone: timezone || 'UTC',
            formatted: now.toLocaleString(),
          };
        },
      },
      // Example: Echo tool
      echo: {
        description: 'Echo back the input message',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        execute: async ({ message }) => ({ echoed: message }),
      },
    };

    // Stream the AI response
    const result = streamText({
      model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
      system: `You are a helpful AI assistant. You can use tools to get current time or echo messages. 
               Always be concise and friendly.`,
      messages: messages,
      tools: tools,
      maxSteps: 5, // Allow multiple tool calls
    });

    // Pipe the streaming response to the HTTP response
    return result.pipeDataStreamToResponse(res, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Vercel-AI-Data-Stream': 'v1',
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle OPTIONS for CORS preflight
app.options('/api/chat', (req, res) => {
  res.status(204).send();
});

// For Vercel serverless functions, export the Express app
export default app;

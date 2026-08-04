<a href="https://csvtochat.com/">
<img alt="CSV2Chat" src="./public/og.jpg">
</a>

<div align="center">
    <h1>CSV2Chat</h1>
    <p>
        Chat with your CSV files using AI. Upload a CSV, ask questions, and get instant, code-backed answers and visualizations.
    </p>
</div>

## Tech Stack

- **Frontend**: Next.js, Typescript, Tailwind CSS, Shadcn UI
- **Together AI LLM**: Generates Python code to answer questions and visualize data
- [**Together Code Interpreter**: Executes Python code and returns results](https://www.together.ai/code-interpreter)
- **Braintrust**: Privacy-safe LLM tracing and observability

## How it works

1. User uploads a CSV file
2. The app analyzes the CSV headers and suggests insightful questions
3. User asks a question about the data
4. Together.ai generates Python code to answer the question, runs it, and returns results (including charts) using Together Code Interpreter
5. All chats and results are stored in Upstash Redis for fast retrieval

## Cloning & running

1. Fork or clone the repo
2. Create accounts at [Together.ai](https://together.ai/) and [Upstash](https://upstash.com/) for LLM and Redis
3. Create a `.env` file and add your API keys:
   - `TOGETHER_API_KEY`
   - `BRAINTRUST_API_KEY` (optional)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Run `pnpm install` and `pnpm run dev` to install dependencies and start the app locally

Open [http://localhost:3000](http://localhost:3000) to use CSV2Chat.

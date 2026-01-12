# AGENTS.md

## Project Overview
CSV2Chat is a web application that allows users to upload CSV files and interact with their data through AI-powered chat. Users can ask questions about their data, and the AI generates Python code to analyze, answer, and visualize the data using Together AI's Code Interpreter. The app stores chat sessions and results in Upstash Redis for persistence.

## Commands
- `pnpm dev` - Start dev server with Turbopack
- `pnpm build` - Build for production
- `pnpm lint` - Run ESLint
- No test framework configured

## Architecture
- **Next.js 16** app with App Router, React 19, TypeScript, Tailwind CSS v4
- **src/app/** - Pages and API routes (chat/, api/chat/, api/coding/, api/generate-questions/, etc.)
- **src/components/** - React components, uses shadcn/ui (new-york style) with Radix primitives
- **src/lib/** - Utilities: chat-store.ts, csvUtils.ts, models.ts, prompts.ts, clients.ts
- **src/hooks/** - Custom React hooks (useLLMModel)
- **External services**: Together AI (LLM), Upstash Redis (rate limiting), S3 (file uploads via next-s3-upload)

## Code Style
- Use `@/*` path aliases for imports (e.g., `@/components`, `@/lib`)
- Functional components with hooks; `"use client"` directive for client components
- TypeScript strict mode enabled; use Zod for runtime validation
- Icons from lucide-react; toast notifications via sonner
- Component files use PascalCase; utility files use kebab-case
- Tailwind for styling with CSS variables; use `cn()` from `@/lib/utils` for class merging

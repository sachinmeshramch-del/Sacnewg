# Overview

This project is a pnpm monorepo using TypeScript, designed to build and deploy AI-driven trading applications. It includes an Express API server and multiple React-Vite web applications, each focusing on different gold trading strategies (scalping, intraday, and Smart Money Concepts). The core purpose is to provide real-time trading signals, market analysis, and risk management tools to users.

The project aims to develop sophisticated trading algorithms, leveraging technical indicators and market structure analysis to identify high-probability trade setups. The architecture supports efficient development and deployment of new trading strategies and user interfaces.

# User Preferences

I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the folder `artifacts/gold-intraday`.
Do not make changes to the folder `artifacts/smart-gold`.

# System Architecture

## Monorepo Structure
The project is organized as a pnpm workspace monorepo. It includes:
- `artifacts/`: Deployable applications (e.g., `api-server`, `gold-scalper`, `gold-intraday`, `smart-gold`).
- `lib/`: Shared libraries and generated code (`api-spec`, `api-client-react`, `api-zod`, `db`).
- `scripts/`: Utility scripts.

## Core Technologies
- **Node.js**: Version 24
- **TypeScript**: Version 5.9, utilizing composite projects for efficient type-checking and build processes.
- **Package Manager**: pnpm
- **API Framework**: Express 5 for `api-server`.
- **Database**: PostgreSQL with Drizzle ORM.
- **Validation**: Zod, with `drizzle-zod` for schema generation from OpenAPI.
- **API Codegen**: Orval, generating React Query hooks and Zod schemas from an OpenAPI specification.
- **Bundler**: esbuild for CJS bundles.
- **Frontend**: React + Vite for all web applications.

## API Server (`artifacts/api-server`)
- An Express 5 server handling API requests.
- Routes are organized under `src/routes/`.
- Uses `@workspace/api-zod` for request/response validation and `@workspace/db` for persistence.
- Includes services for various trading strategies (e.g., `goldService.ts` for Gold Scalper AI, `smcService.ts` for Smart Money Concepts).

## Database Layer (`lib/db`)
- Manages database interactions using Drizzle ORM with PostgreSQL.
- Exports a Drizzle client instance and schema models.
- Drizzle Kit is used for migrations.

## API Specification and Codegen (`lib/api-spec`, `lib/api-zod`, `lib/api-client-react`)
- An OpenAPI 3.1 specification (`openapi.yaml`) defines the API contract.
- Orval generates:
    - React Query hooks and a fetch client (`lib/api-client-react`).
    - Zod schemas for validation (`lib/api-zod`).

## Frontend Applications
- **Gold Scalper AI (`artifacts/gold-scalper`)**: A React + Vite web app providing 5-15 minute scalping signals. Features include RSI/EMA/MACD/ATR analysis, live price data, TradingView charts, signal history, risk calculator, and Telegram alerts.
    - Implements a sophisticated **Pullback Entry Engine** for refined signal generation.
    - Features a **Risk/Reward Engine** for consistent SL/TP calculations.
    - Incorporates **Trend Memory + Strict Sideways + Pullback States** for accurate trend classification.
    - Includes a **Decision Layer** (Regime, Conflict, Chop, Permission) to refine signals based on market context and indicator agreement.
    - Utilizes a **Score-Based Decision Engine** where various checks contribute weighted votes to determine signal strength and confidence, replacing hard-blocking conditions.
- **Gold Intraday AI Trader (`artifacts/gold-intraday`)**: A React + Vite web app for 1-4 hour intraday signals using EMA20/EMA50 and multi-timeframe analysis.
- **Smart Gold AI Pro (`artifacts/smart-gold`)**: A React + Vite web app for Smart Money Concepts (SMC) based XAUUSD intraday trading, detecting BOS, CHoCH, Liquidity Grab, Order Blocks, and FVG.

## UI/UX Design
- Each web application has its own dedicated React + Vite frontend.
- Vite's dev server proxies `/api` requests to the `api-server`.
- Replit's public preview proxy is configured to route specific paths to corresponding artifact ports (e.g., `/` to Gold Scalper, `/api/*` to API server).
- User interfaces dynamically display signal information, market context, conflict reasons, and permission levels with clear badges and messages. Trade level grids are conditionally displayed based on signal permission.

# External Dependencies

- **PostgreSQL**: Primary database for data persistence.
- **Drizzle ORM**: Object-relational mapper for database interactions.
- **Express**: Node.js web application framework for the API server.
- **Orval**: API client and schema generator from OpenAPI specifications.
- **React**: Frontend library for building user interfaces.
- **Vite**: Frontend build tool for React applications.
- **Zod**: Schema declaration and validation library.
- **esbuild**: Fast JavaScript bundler.
- **React Query**: For data fetching, caching, and state management in React applications (via generated hooks).
- **Yahoo Finance API**: For live price data (integrated into Gold Scalper).
- **TradingView Widget**: For displaying charts in Gold Scalper.
- **Telegram API**: For sending alerts (integrated into Gold Scalper).
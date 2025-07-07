# Stage 1: Build
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Copy dependency definitions
COPY package.json package-lock.json* ./

# Install dependencies (use npm install to avoid lockfile mismatch)
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package.json for production install
COPY package.json package-lock.json* ./

# Install only production dependencies (use npm install to avoid lockfile issues)
RUN npm install --omit=dev

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Copy environment file (optional, ensure .env is in .dockerignore if sensitive)
COPY .env .env

# Expose default port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/main.js"]

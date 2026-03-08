# ── Stage 1: deps ─────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# curl is used by the HEALTHCHECK below
RUN apk add --no-cache curl

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Port the load balancer talks to
EXPOSE 5271

ENV NODE_ENV=production \
    PORT=5271

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:5271/health || exit 1

CMD ["node", "index.js"]

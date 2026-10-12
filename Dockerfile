# LedgerPilot — container image for the hosted demo.
#
# Build:  docker build -t ledgerpilot .
# Run:    docker run --rm -p 3000:3000 ledgerpilot
# Then open http://127.0.0.1:3000/judge (Judge Mode, mock mode).
#
# The image deploys in the default mock mode, exactly like the
# Render Blueprint (render.yaml): Judge Mode works the moment the
# container is up — no PayPal account, no keys. Sandbox mode is a
# runtime decision, never an image decision: pass your own
# variables with `docker run -e PAYPAL_MODE=sandbox -e ...`;
# no credential value is ever baked into this file or the image.
# The container health check probes GET /api/health, the same
# readiness route the Render Blueprint health-checks.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PAYPAL_MODE=mock
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]

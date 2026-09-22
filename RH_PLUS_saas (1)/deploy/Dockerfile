# RH PLUS — image de production
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production RHPLUS_DATA_DIR=/data PORT=3000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "src/server.js"]

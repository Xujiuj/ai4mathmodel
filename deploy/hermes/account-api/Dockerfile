FROM mirror.ccs.tencentyun.com/library/node@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.cjs billing.cjs migrate.cjs schema.sql ./
USER node
EXPOSE 18090
CMD ["node", "server.cjs"]

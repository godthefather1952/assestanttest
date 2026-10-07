FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chown -R pwuser:pwuser /app

ENV NODE_ENV=production
ENV PORT=10000

USER pwuser

EXPOSE 10000

CMD ["npm", "start"]

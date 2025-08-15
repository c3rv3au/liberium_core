FROM node:20-alpine

# Installer les outils réseau pour debug
RUN apk add --no-cache \
    dumb-init \
    curl \
    netcat-openbsd \
    bind-tools

# Créer un utilisateur non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S moleculer -u 1001

# Définir le répertoire de travail
WORKDIR /usr/src/app

# Copier les fichiers package
COPY package*.json ./

# Installer les dépendances
RUN npm install --only=production && \
    npm cache clean --force

# Copier le code source
COPY --chown=moleculer:nodejs . .

# Créer le répertoire de données
RUN mkdir -p data && \
    chown -R moleculer:nodejs data

# Exposer les ports
EXPOSE 3001 4000 4445/udp

# Passer à l'utilisateur non-root
USER moleculer

# Utiliser dumb-init pour une gestion propre des signaux
ENTRYPOINT ["dumb-init", "--"]

# Script de santé pour vérifier la connectivité
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3001/brain/health || exit 1

# Commande par défaut
CMD ["npm", "run", "web"]
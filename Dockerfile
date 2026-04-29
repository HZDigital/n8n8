FROM n8nio/n8n:latest

USER root

# Create a custom modules folder
WORKDIR /data/custom

# Initialize a minimal package.json
RUN npm init -y

# Install your package here (NOT inside n8n)
RUN npm install pdf-lib

# Make Node able to resolve it
ENV NODE_PATH=/data/custom/node_modules

# Allow n8n to use it
ENV NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib

USER node

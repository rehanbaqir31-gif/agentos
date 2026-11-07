FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
COPY opencode.mjs /opt/agentos/opencode.mjs
COPY opencode /usr/local/bin/opencode
RUN sed -i 's/\r$//' /usr/local/bin/opencode && chmod 0555 /usr/local/bin/opencode /opt/agentos/opencode.mjs

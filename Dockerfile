# Single deployable image: web + worker + beat (all the backend's app/ code, one Python
# environment, three processes under supervisor) plus the built frontend, served by FastAPI
# itself. Build context is the repo root (needs both backend/ and frontend/) — this is NOT the
# same image as backend/Dockerfile or frontend/Dockerfile, which still exist for local
# docker-compose development with hot-reload-friendly separate containers.

FROM node:22-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

FROM python:3.12-slim
WORKDIR /app

# Stamped at build time (docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD)) so a
# running container can say exactly what it is — surfaced at /api/version and in the UI footer.
# Without it there's no way to tell a deployed image apart from the one before it, which makes
# "did my update actually land?" unanswerable.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend-build /frontend/dist ./static
COPY supervisord.conf /etc/supervisor/supervisord.conf

EXPOSE 5173
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]

# Pit Wall — one command resets the world, one runs the demo.
# All Python runs through `uv` so there's nothing to activate.

SHELL := /bin/bash
UV := uv

.DEFAULT_GOAL := help

.PHONY: help env venv up down nuke wait-db migrate generate reset demo eval psql answer-key fmt retrieval

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from template if missing
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")

venv: ## Create the uv virtualenv and install deps (Python pinned by .python-version)
	$(UV) venv
	$(UV) sync

up: env ## Start TimescaleDB (docker)
	docker compose up -d

down: ## Stop TimescaleDB (keep data)
	docker compose down

nuke: ## Stop TimescaleDB and DELETE its volume (full wipe)
	docker compose down -v

wait-db: ## Block until the database accepts connections
	@echo "waiting for database..."
	@until docker compose exec -T db pg_isready -U $${PITWALL_DB_SUPERUSER:-postgres} -d $${PITWALL_DB_NAME:-pitwall} >/dev/null 2>&1; do sleep 1; done
	@echo "database ready."

migrate: env ## Apply the full schema (idempotent)
	$(UV) run pitwall db migrate

generate: env ## Generate the deterministic world + answer_key.json
	$(UV) run pitwall world generate

seed: env ## Seed demo work items the explainer narrates (fraud hold, add-on reject)
	$(UV) run pitwall explain seed-demo

retrieval: env ## (Re)build the Moss semantic indexes from Tiger (no-op if Moss unconfigured)
	$(UV) run pitwall retrieval build

tickets: env ## Load matchday/season ticket sales + forecast snapshots into golden (no world-regen)
	$(UV) run python scripts/seed_tickets_forecast.py

payroll: env ## Recalibrate player wages + add managers/coaching staff (payroll, no world-regen)
	$(UV) run python scripts/seed_payroll.py

reset: env nuke up wait-db migrate generate seed retrieval ## FULL reset: wipe, start, migrate, world, seed, index (LOCAL docker)
	@echo ""
	@echo "world reset complete — $$(date)"

cloud-reset: env migrate generate seed retrieval ## Migrate + load world + seed + index against PITWALL_DATABASE_URL (no docker)
	@echo ""
	@echo "cloud reset complete — targeting PITWALL_DATABASE_URL"

explain: env ## Build + play the fraud-hold explanation, export the browser plan
	$(UV) run pitwall explain plan WI-5602
	$(UV) run pitwall explain export WI-5602 -o voice/plan.js

fc: env ## Run the scenario control room (backend + live trail UI) at :4055
	$(UV) run uvicorn api.app:app --port 4055 --reload

voice: env ## Run the LiveKit finance-report agent (the 📺 REPORT billboard). Needs voice deps + LIVEKIT_* in .env
	$(UV) pip install -r voice/requirements.txt
	EXPLAIN_SOURCE=pitwall $(UV) run python voice/agent.py dev

demo: env ## Run the scripted demo scenario (final whistle cascade)
	$(UV) run pitwall demo run

eval: env ## Run Pit Wall over the whole timeline and score vs the answer key
	$(UV) run pitwall eval run

psql: ## Open a psql shell in the database container (superuser)
	docker compose exec db psql -U $${PITWALL_DB_SUPERUSER:-postgres} -d $${PITWALL_DB_NAME:-pitwall}

answer-key: ## Pretty-print the planted-issue answer key
	$(UV) run pitwall world answer-key

fmt: ## Format Python with ruff
	$(UV) run ruff format pitwall

# fang-image-processing

A browser-based sprite/background-removal editor: upload an image, use GIMP-style selection tools (fuzzy select, gradient select, free select, brush, etc.) to select a background or subject, then export a transparent PNG. See [DESIGN.md](DESIGN.md) for the full architecture.

The app is split into two runtimes that run side by side:

- **Rails** (this repo's root) — UI, session/state management, uploads. Ruby `3.4.7`, SQLite.
- **Python microservice** (`python_service/`) — stateless pixel math (flood-fill, masking, etc.) via FastAPI.

## Prerequisites

- Ruby `3.4.7` (see `.ruby-version` — a version manager like `rbenv`/`asdf`/`mise` will pick this up automatically)
- Python `3.9+`
- SQLite 3
- [Foreman](https://github.com/ddollar/foreman) (installed automatically as a gem dependency; used by `bin/dev` to run both processes together)

## Setup on a fresh machine

Clone the repo, then from the repo root:

```bash
# Ruby/Rails side
bundle install
bin/rails db:prepare

# Python side
cd python_service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

The `python_service/.venv` folder is a local virtual environment — it is **not** committed to GitHub (see `.gitignore`). It's regenerated from `python_service/requirements.txt`/`pyproject.toml` by the commands above, the same way `bundle install` regenerates gems from the `Gemfile` rather than committing `vendor/bundle`.

## Running the app

```bash
bin/dev
```

This uses `Procfile.dev` (via `foreman`) to start both the Rails server and the Python service (`uvicorn ... --reload`) together. Rails runs on port 3000, the Python service on port 5001.

To run either side in isolation for debugging:

```bash
bin/rails server                                                  # Rails only
cd python_service && .venv/bin/uvicorn app:app --port 5001 --reload  # Python only
```

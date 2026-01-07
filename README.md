Running Claude Code in Docker container, using GCloud Vertex AI. 

1. Copy `.env.example` to `.env` and fill in your variables.
2. Store the Vertex AI Service Account JSON at `~/.config/claude-vertex/sa.json`. 
3. `make build`
4. `make claude` - run Docker container containing Claude Code.
5. `claude` - open Claude Code inside container.


Mounted at `../claude-workspace` directory - use this for persisting code across container restarts.

Global Claude config is stored in `./claude-config`, for perisisting across container restarts.
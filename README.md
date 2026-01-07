Running Claude Code in Docker container, using GCloud Vertex AI. 

1. Copy `.env.example` to `.env` and fill in your variables.
2. Store the Vertex AI Service Account JSON at `~/.config/claude-vertex/sa.json`. 
3. Run `make build` - build Docker image.
4. Run `make claude` - run Docker container containing Claude Code.
5. Run `claude` - open Claude Code inside container.


Mounted at `../claude-workspace` directory - use this for persisting artifacts across container restarts.

Global Claude config is stored in `./claude-config`, for persisting across container restarts.
